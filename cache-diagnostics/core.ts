import { createHmac, randomBytes } from "node:crypto";

export type JsonRecord = Record<string, unknown>;
export type Channel = "summary" | "anomalies";
export type Emit = (channel: Channel, record: JsonRecord) => void;
export interface Meta { session: string; provider: string; api: string; model: string }
export interface NumberField { state: "missing" | "null" | "invalid" | "value"; value?: number }
export interface RawUsage {
  present: boolean;
  input: NumberField;
  output: NumberField;
  total: NumberField;
  cacheRead: NumberField;
  cacheWrite: NumberField;
  reasoning: NumberField;
}
export interface Snapshot {
  stage: "before_provider_request";
  instructions: string;
  tools: string;
  settings: string;
  cacheKey: string;
  input: string;
  inputBytes: number;
  complete: boolean;
  parameters: JsonRecord;
  segments: string[];
}
interface Call {
  id: string;
  meta: Meta;
  startedAt: string;
  snapshot?: Snapshot;
  responseId?: string;
  responseModel?: string;
  correlation: "single_pending" | "response_id" | "unmatched" | "ambiguous";
  ambiguous?: boolean;
  ended?: boolean;
  normalized?: boolean;
  raw?: RawUsage;
  terminalCount: number;
  status?: string;
}
const SEGMENT_BYTES = 16 * 1024;
const MAX_INPUT_BYTES = 16 * 1024 * 1024;
const MAX_PENDING = 16;
const MAX_COMPLETED = 32;
const REASONS = new Set(["model_changed", "prompt_cache_key_changed", "service_tier_changed", "tools_changed", "text_format_changed", "reasoning_effort_changed", "verbosity_changed", "context_compacted", "input_changed"]);
export const object = (value: unknown): JsonRecord | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : undefined;
export function numeric(source: unknown, key: string): NumberField {
  const value = object(source);
  if (!value || !Object.hasOwn(value, key)) return { state: "missing" };
  const n = value[key];
  if (n === null) return { state: "null" };
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? { state: "value", value: n } : { state: "invalid" };
}
export function rawUsage(response: unknown): RawUsage {
  const usage = object(object(response)?.usage);
  const details = usage?.input_tokens_details;
  return {
    present: !!usage, input: numeric(usage, "input_tokens"), output: numeric(usage, "output_tokens"),
    total: numeric(usage, "total_tokens"), cacheRead: numeric(details, "cached_tokens"),
    cacheWrite: numeric(details, "cache_write_tokens"), reasoning: numeric(usage?.output_tokens_details, "reasoning_tokens"),
  };
}
export const label = (value: unknown): string => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,127}$/.test(value) ? value : "unknown";
export const responseId = (value: unknown): string | undefined => typeof value === "string" && /^resp_[a-zA-Z0-9_-]{1,160}$/.test(value) ? value : undefined;
export const trackedApi = (api: string): boolean => ["openai-responses", "openai-codex-responses", "azure-openai-responses"].includes(api);
function normalizedUsage(value: unknown): JsonRecord {
  const result: JsonRecord = {};
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "reasoning", "totalTokens"]) result[key] = numeric(value, key);
  // Logged estimates are not invoices or subscription allowance measurements.
  const cost = object(object(value)?.cost);
  if (cost) {
    const estimates: JsonRecord = {};
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"]) {
      const n = cost[key];
      if (typeof n === "number" && Number.isFinite(n) && n >= 0) estimates[key] = n;
    }
    result.loggedEstimate = estimates;
  }
  return result;
}
function diagnostic(value: unknown): JsonRecord | undefined {
  const d = object(value);
  if (!d) return undefined;
  const result: JsonRecord = {};
  result.type = ["cache_hit", "cache_miss", "comparison_response_not_found", "unavailable"].includes(String(d.type)) ? d.type : "unrecognized";
  if (REASONS.has(String(d.reason))) result.reason = d.reason;
  for (const key of ["comparison_reusable_tokens", "cache_missed_tokens"]) result[key] = numeric(d, key);
  return result;
}
export function compareSnapshots(before?: Snapshot, after?: Snapshot): JsonRecord {
  if (!before || !after) return { available: false };
  let equalSegments = 0;
  while (equalSegments < Math.min(before.segments.length, after.segments.length) && before.segments[equalSegments] === after.segments[equalSegments]) equalSegments++;
  return {
    available: true, instructionsChanged: before.instructions !== after.instructions,
    toolsChanged: before.tools !== after.tools, settingsChanged: before.settings !== after.settings,
    cacheKeyChanged: before.cacheKey !== after.cacheKey,
    equalLeadingSegments: equalSegments,
    equalLeadingBytesLowerBound: Math.min(equalSegments * SEGMENT_BYTES, before.inputBytes, after.inputBytes),
    beforeInputBytes: before.inputBytes, afterInputBytes: after.inputBytes,
    complete: before.complete && after.complete,
    semantics: "serialized payload input, not tokenizer/cache boundary equivalence",
  };
}

/** Stores hashes/allowlisted metadata only; never retains prompts, outputs or headers. */
export class Recorder {
  private readonly secret = randomBytes(32);
  private sequence = 0;
  private pending: Call[] = [];
  private responses = new Map<string, Call>();
  private previous = new Map<string, Call>();
  private seenPositive = new Set<string>();
  private following = new Map<string, string>();
  readonly counts = { starts: 0, completions: 0, anomalies: 0, ambiguous: 0 };
  constructor(private readonly emit: Emit, private readonly now = () => new Date().toISOString()) {}
  private hash(value: unknown): string {
    return createHmac("sha256", this.secret).update(JSON.stringify(value) ?? "undefined").digest("hex");
  }
  private scope(meta: Meta): string { return this.hash([meta.session, meta.provider, meta.api, meta.model]); }
  private publicMeta(meta: Meta): JsonRecord {
    return { sessionFingerprint: this.hash(meta.session), provider: label(meta.provider), api: label(meta.api), model: label(meta.model) };
  }
  private snapshot(payload: unknown): Snapshot {
    const p = object(payload) ?? {};
    const settings: JsonRecord = {};
    for (const key of ["model", "reasoning", "text", "tool_choice", "parallel_tool_calls", "service_tier", "temperature", "max_output_tokens", "store"]) settings[key] = p[key];
    const options = object(p.prompt_cache_options);
    settings.prompt_cache_options = options ? { mode: options.mode, ttl: options.ttl } : undefined;
    const parameters: JsonRecord = { requestModel: label(p.model) };
    const allowed = {
      reasoningEffort: [object(p.reasoning)?.effort, ["none", "minimal", "low", "medium", "high", "xhigh", "max"]],
      verbosity: [object(p.text)?.verbosity, ["low", "medium", "high"]],
      serviceTier: [p.service_tier, ["auto", "default", "flex", "priority", "fast", "standard", "scale"]],
      cacheMode: [options?.mode, ["implicit", "explicit"]],
      cacheTtl: [options?.ttl, ["30m", "24h", "in_memory"]],
    } as const;
    for (const [key, [value, choices]] of Object.entries(allowed)) {
      if (typeof value === "string" && (choices as readonly string[]).includes(value)) parameters[key] = value;
    }
    if (typeof p.parallel_tool_calls === "boolean") parameters.parallelToolCalls = p.parallel_tool_calls;
    if (Array.isArray(p.tools)) parameters.toolCount = p.tools.length;
    const input = Buffer.from(JSON.stringify(p.input) ?? "undefined");
    const limit = Math.min(input.length, MAX_INPUT_BYTES);
    const segments: string[] = [];
    for (let offset = 0; offset < limit; offset += SEGMENT_BYTES) segments.push(createHmac("sha256", this.secret).update(input.subarray(offset, Math.min(offset + SEGMENT_BYTES, limit))).digest("hex"));
    return {
      stage: "before_provider_request", instructions: this.hash(p.instructions), tools: this.hash(p.tools), settings: this.hash(settings),
      cacheKey: this.hash(p.prompt_cache_key), input: createHmac("sha256", this.secret).update(input.subarray(0, limit)).digest("hex"),
      inputBytes: input.length, complete: input.length <= MAX_INPUT_BYTES, parameters, segments,
    };
  }
  private compact(call: Call): JsonRecord {
    const { segments: _segments, ...snapshot } = call.snapshot ?? {};
    return { id: call.id, ...this.publicMeta(call.meta), startedAt: call.startedAt, responseId: call.responseId, responseModel: call.responseModel,
      correlation: call.correlation, snapshot: call.snapshot ? snapshot : undefined, rawUsage: call.raw, status: call.status };
  }
  private detail(call: Call): JsonRecord { return { ...this.compact(call), inputSegments: call.snapshot?.segments }; }
  private anomaly(call: Call, reasons: string[], previous?: Call): void {
    if (!reasons.length) return;
    this.counts.anomalies++;
    this.emit("anomalies", { kind: "anomaly", at: this.now(), reasons, current: this.detail(call), comparison: compareSnapshots(previous?.snapshot, call.snapshot) });
    if (previous) this.emit("anomalies", { kind: "anomaly_context", anomalyId: call.id, position: "before", request: this.detail(previous) });
    this.following.set(this.scope(call.meta), call.id);
  }
  begin(meta: Meta, payload: unknown): void {
    if (!trackedApi(meta.api)) return;
    const call: Call = { id: `call-${++this.sequence}`, meta: { ...meta }, startedAt: this.now(), snapshot: object(payload) ? this.snapshot(payload) : undefined, correlation: "single_pending", terminalCount: 0 };
    if (this.pending.some(c => !c.ended)) {
      call.ambiguous = true; call.correlation = "ambiguous";
      for (const p of this.pending) if (!p.ended) { p.ambiguous = true; p.correlation = "ambiguous"; }
      this.counts.ambiguous++;
    }
    this.pending.push(call);
    this.counts.starts++;
    this.emit("summary", { kind: "request_start", ...this.compact(call) });
    while (this.pending.length > MAX_PENDING) this.incomplete(this.pending.shift()!, "pending_limit");
  }
  private bind(meta: Meta, id?: string): Call {
    if (id && this.responses.has(id)) return this.responses.get(id)!;
    const candidates = this.pending.filter(c => !c.ended && !c.responseId && !c.ambiguous && c.meta.session === meta.session && c.meta.api === meta.api && c.meta.provider === meta.provider && c.meta.model === meta.model);
    let call: Call;
    if (candidates.length === 1) {
      call = candidates[0];
      call.meta = { ...meta };
    } else {
      call = { id: `call-${++this.sequence}`, meta: { ...meta }, startedAt: this.now(), correlation: candidates.length > 1 || this.pending.some(c => c.ambiguous) ? "ambiguous" : "unmatched", terminalCount: 0 };
    }
    if (id) { call.responseId = id; this.responses.set(id, call); }
    return call;
  }
  stream(meta: Meta, value: unknown): void {
    if (!trackedApi(meta.api)) return;
    const event = object(value);
    const type = event?.type;
    if (type !== "response.created" && type !== "response.completed" && type !== "response.done" && type !== "response.incomplete" && type !== "response.failed") return;
    const response = object(event?.response);
    const id = responseId(response?.id);
    const call = this.bind(meta, id);
    if (type === "response.created") return;
    const oldRaw = call.raw;
    call.raw = rawUsage(response);
    call.responseModel = response?.model === undefined ? undefined : label(response.model);
    call.status = type === "response.failed" || response?.status === "failed" ? "failed"
      : type === "response.incomplete" || response?.status === "incomplete" ? "incomplete"
      : response?.status === undefined || ["completed", "success", "done"].includes(String(response.status)) ? "completed" : "unknown";
    call.terminalCount++;
    const scope = this.scope(meta);
    const comparable = call.correlation === "single_pending" || call.correlation === "response_id";
    const previous = comparable ? this.previous.get(scope) : undefined;
    const reasons: string[] = [];
    const validRatio = (u?: RawUsage) => !!u && u.input.state === "value" && u.input.value! > 0 && u.cacheRead.state === "value" && u.cacheRead.value! <= u.input.value!
      && (u.cacheWrite.state !== "value" || u.cacheRead.value! + u.cacheWrite.value! <= u.input.value!);
    if (call.status === "completed") {
      if (call.raw.cacheRead.state === "value" && call.raw.input.state === "value" && !validRatio(call.raw)) reasons.push("inconsistent_input_usage");
      if (call.raw.cacheRead.state !== "value") reasons.push("cache_read_unknown");
      else if (call.raw.cacheRead.value === 0 && previous?.raw?.cacheRead.state === "value" && previous.raw.cacheRead.value! > 0 && previous.status === "completed") reasons.push("zero_after_read");
      else if (call.raw.cacheRead.value === 0 && comparable && this.seenPositive.has(scope)) reasons.push("continued_or_unclassified_zero");
      if (previous?.status === "completed" && validRatio(previous.raw) && validRatio(call.raw) && previous.raw!.cacheRead.value! / previous.raw!.input.value! - call.raw.cacheRead.value! / call.raw.input.value! >= 0.30 - 1e-12) reasons.push("cache_ratio_drop_ge30pp");
    }
    if (oldRaw && JSON.stringify(oldRaw) !== JSON.stringify(call.raw)) reasons.push("terminal_usage_changed");
    this.emit("summary", { kind: call.ended ? "raw_terminal_update" : "request_end", at: this.now(), ...this.compact(call), terminalCount: call.terminalCount,
      diagnostic: diagnostic(response?.prompt_cache_diagnostics), serviceTier: label(response?.service_tier), reasons });
    if (!call.ended) {
      this.counts.completions++;
      const afterFor = this.following.get(scope);
      if (afterFor) { this.emit("anomalies", { kind: "anomaly_context", anomalyId: afterFor, position: "after", request: this.detail(call) }); this.following.delete(scope); }
      call.ended = true;
      this.pending = this.pending.filter(c => c !== call);
      if (call.correlation === "single_pending" || call.correlation === "response_id") {
        this.anomaly(call, reasons, previous);
        this.previous.set(scope, call);
        if (call.raw.cacheRead.state === "value" && call.raw.cacheRead.value! > 0) this.seenPositive.add(scope);
      } else if (reasons.length) this.anomaly(call, reasons); // No invented prefix/adjacency comparison.
    } else this.anomaly(call, reasons.filter(r => r === "terminal_usage_changed"));
    while (this.responses.size > MAX_COMPLETED) this.responses.delete(this.responses.keys().next().value!);
    while (this.previous.size > 8) this.previous.delete(this.previous.keys().next().value!);
    if (this.seenPositive.size > 8) this.seenPositive.delete(this.seenPositive.values().next().value!);
    while (this.following.size > 8) this.following.delete(this.following.keys().next().value!);
  }
  http(status: number, headers: Record<string, unknown>): void {
    const id = Object.entries(headers).find(([key]) => key.toLowerCase() === "x-request-id")?.[1];
    const safeId = typeof id === "string" && /^(req_[a-zA-Z0-9_-]{1,160}|[a-fA-F0-9-]{32,36})$/.test(id) ? id : undefined;
    const candidates = this.pending.filter(c => !c.ended && !c.ambiguous);
    this.emit("summary", { kind: "http_response", at: this.now(), id: candidates.length === 1 ? candidates[0].id : undefined,
      correlation: candidates.length === 1 ? "single_pending_http_observation" : "unattributed", status: Number.isInteger(status) ? status : undefined, requestId: safeId });
  }
  normalized(meta: Meta, value: unknown): void {
    const message = object(value);
    const id = responseId(message?.responseId);
    let call = id ? this.responses.get(id) : undefined;
    if (!call) {
      const candidates = this.pending.filter(c => !c.ended && !c.ambiguous && !c.responseId && c.meta.api === meta.api && c.meta.provider === meta.provider && c.meta.model === meta.model);
      if (candidates.length === 1) call = candidates[0];
    }
    if (!call) { this.emit("summary", { kind: "unmatched_normalized_usage", at: this.now(), ...this.publicMeta(meta), responseId: id, usage: normalizedUsage(message?.usage) }); return; }
    const usage = normalizedUsage(message?.usage);
    const mismatches: string[] = [];
    for (const key of ["cacheRead", "cacheWrite", "output"] as const) {
      const n = numeric(message?.usage, key);
      const r = call.raw?.[key];
      if (r?.state === "value" && (n.state !== "value" || r.value !== n.value)) mismatches.push(key);
    }
    const raw = call.raw;
    if (raw?.input.state === "value" && raw.cacheRead.state === "value" && raw.cacheWrite.state === "value" && raw.input.value! >= raw.cacheRead.value! + raw.cacheWrite.value!) {
      const n = numeric(message?.usage, "input");
      if (n.state !== "value" || n.value !== raw.input.value! - raw.cacheRead.value! - raw.cacheWrite.value!) mismatches.push("input");
    }
    this.emit("summary", { kind: "normalized_usage", at: this.now(), id: call.id, responseId: id, ...this.publicMeta(meta), usage, mismatches,
      stopReason: ["stop", "length", "toolUse", "error", "aborted", "deferred"].includes(String(message?.stopReason)) ? message?.stopReason : "unknown" });
    call.normalized = true;
    if (mismatches.length) this.anomaly(call, ["raw_normalized_mismatch"]);
    if (!call.ended) this.incomplete(call, "raw_terminal_not_observed");
    this.pending = this.pending.filter(c => !c.ended);
  }
  private incomplete(call: Call, reason: string): void {
    if (call.ended) return;
    call.ended = true;
    this.emit("summary", { kind: "request_incomplete", at: this.now(), ...this.compact(call), reason });
  }
  warmingDecision(action: "warm" | "stop"): void {
    this.emit("summary", { kind: "cache_warming_decision", at: this.now(), observedAction: action, finalActionKnown: false });
  }
  boundary(reason: string): void {
    for (const call of this.pending) this.incomplete(call, reason);
    this.pending = [];
  }
  reset(reason: string): void {
    this.boundary(reason);
    this.previous.clear(); this.seenPositive.clear(); this.following.clear(); this.responses.clear();
    this.emit("summary", { kind: "comparison_reset", at: this.now(), reason });
  }
}
