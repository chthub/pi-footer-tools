import assert from "node:assert/strict";
import { existsSync, realpathSync, mkdtempSync, readFileSync, readdirSync, statSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

// Keep regression tests independent of personal configuration.
process.env.PI_FOOTER_TOOLS_CONFIG = new URL("../config.json", import.meta.url).pathname;

let host = dirname(realpathSync(join(dirname(process.execPath), "pi")));
while (!existsSync(join(host, "package.json"))) host = dirname(host);
const { createJiti } = createRequire(join(host, "package.json"))("jiti");
const jiti = createJiti(import.meta.url, { alias: { "@earendil-works/pi-coding-agent": join(host, "dist/index.js") } });
const base = new URL("../cache-diagnostics/", import.meta.url).pathname;
const { Recorder, rawUsage } = await jiti.import(join(base, "core.ts"));
const { JsonlWriter } = await jiti.import(join(base, "writer.ts"));
const { registerCacheDiagnostics } = await jiti.import(join(base, "index.ts"));
const { loadDefaults, DEFAULT_CONFIG_PATH } = await jiti.import(join(base, "config.ts"));
const META = { session: "private-session-sentinel", provider: "openai-codex", api: "openai-codex-responses", model: "gpt-6-astra" };
const PAYLOAD = {
  model: META.model, instructions: "PRIVATE_PROMPT_SENTINEL", input: [{ role: "user", content: "PRIVATE_INPUT_SENTINEL".repeat(2000) }],
  tools: [{ name: "tool", description: "PRIVATE_TOOL_SENTINEL", parameters: { type: "object" } }],
  reasoning: { effort: "high" }, text: { verbosity: "low" }, prompt_cache_key: "PRIVATE_CACHE_KEY_SENTINEL",
  api_key: "PRIVATE_AUTH_SENTINEL",
};
function raw(id, read, { input = 10000, details = true, write, status = "completed" } = {}) {
  const usage = { input_tokens: input, output_tokens: 10, total_tokens: input + 10 };
  if (details) usage.input_tokens_details = { ...(read === undefined ? {} : { cached_tokens: read }), ...(write === undefined ? {} : { cache_write_tokens: write }) };
  return { type: status === "failed" ? "response.failed" : status === "incomplete" ? "response.incomplete" : "response.completed", response: { id, status, usage, output: [{ content: "PRIVATE_OUTPUT_SENTINEL" }] } };
}
function setup() {
  const rows = [];
  const recorder = new Recorder((channel, row) => rows.push({ channel, ...structuredClone(row) }), () => "2026-10-03T00:00:00Z");
  const run = (id, read, payload = PAYLOAD, options) => { recorder.begin(META, payload); recorder.stream(META, raw(id, read, options)); };
  return { rows, recorder, run, anomalies: () => rows.filter(r => r.kind === "anomaly") };
}
function frozen(value) {
  if (value && typeof value === "object") { for (const child of Object.values(value)) frozen(child); Object.freeze(value); }
  return value;
}

test("read field presence is distinct from zero, null and invalid numbers", () => {
  for (const [value, state] of [[0, "value"], [undefined, "missing"], [null, "null"], [-1, "invalid"], [NaN, "invalid"], [Infinity, "invalid"], [1.5, "invalid"]]) {
    assert.equal(rawUsage(raw("resp_a", value).response).cacheRead.state, state);
  }
  assert.equal(rawUsage(raw("resp_a", 0, { details: false }).response).cacheRead.state, "missing");
});

test("normal cold start is recorded, not called a disappearance; positive baseline follows", () => {
  const h = setup(); h.run("resp_cold", 0); h.run("resp_warm", 9000);
  assert.equal(h.anomalies().length, 0);
  assert.equal(h.rows.filter(r => r.kind === "request_start").length, 2);
  assert.equal(h.rows.filter(r => r.kind === "request_end").length, 2);
});

test("zero after read saves before/current/after, including changed tool fingerprint", () => {
  const h = setup(); h.run("resp_before", 9000);
  h.run("resp_zero", 0, { ...PAYLOAD, tools: [...PAYLOAD.tools, { name: "added" }] });
  const a = h.anomalies()[0];
  assert.ok(a.reasons.includes("zero_after_read"));
  assert.equal(a.comparison.toolsChanged, true);
  h.run("resp_after", 9500);
  assert.ok(h.rows.some(r => r.kind === "anomaly_context" && r.position === "before"));
  assert.ok(h.rows.some(r => r.kind === "anomaly_context" && r.position === "after"));
});

test("severe partial drop is captured even though cache read stays positive", () => {
  const h = setup(); h.run("resp_a", 9000); h.run("resp_b", 4000);
  assert.deepEqual(h.anomalies()[0].reasons, ["cache_ratio_drop_ge30pp"]);
});

test("continued zeros are recorded without inventing a new previous-positive pair", () => {
  const h = setup(); h.run("resp_a", 9000); h.run("resp_b", 0); h.run("resp_c", 0);
  assert.ok(h.anomalies().at(-1).reasons.includes("continued_or_unclassified_zero"));
  assert.ok(!h.anomalies().at(-1).reasons.includes("zero_after_read"));
});

test("missing raw field remains unknown even if normalized usage defaults to zero", () => {
  const h = setup(); h.run("resp_a", 9000); h.run("resp_b", undefined);
  h.recorder.normalized(META, { responseId: "resp_b", stopReason: "stop", usage: { cacheRead: 0, cacheWrite: 0, output: 10 } });
  assert.equal(h.rows.find(r => r.kind === "request_end" && r.responseId === "resp_b").rawUsage.cacheRead.state, "missing");
  assert.deepEqual(h.anomalies()[0].reasons, ["cache_read_unknown"]);
  assert.deepEqual(h.rows.at(-1).mismatches, []);
});

test("positive raw counter versus normalized zero identifies conversion mismatch", () => {
  const h = setup(); h.run("resp_a", 9000);
  h.recorder.normalized(META, { responseId: "resp_a", stopReason: "stop", usage: { cacheRead: 0, cacheWrite: 0, output: 10 } });
  assert.ok(h.anomalies().some(r => r.reasons.includes("raw_normalized_mismatch")));
  assert.deepEqual(h.rows.find(r => r.kind === "normalized_usage").mismatches, ["cacheRead"]);
});

test("incomplete or failed requests are not cache disappearance alerts", () => {
  for (const status of ["failed", "incomplete"]) {
    const h = setup(); h.run("resp_a", 9000); h.run("resp_b", 0, PAYLOAD, { status });
    assert.equal(h.anomalies().length, 0);
  }
});

test("no raw terminal, shutdown and compaction never synthesize a zero", () => {
  const h = setup(); h.recorder.begin(META, PAYLOAD);
  h.recorder.normalized(META, { stopReason: "aborted", usage: { cacheRead: 0 } });
  assert.equal(h.anomalies().length, 0);
  assert.ok(h.rows.some(r => r.reason === "raw_terminal_not_observed"));
  h.run("resp_before", 9000); h.recorder.reset("session_compact"); h.run("resp_after", 0);
  assert.equal(h.anomalies().length, 0);
  h.recorder.begin(META, PAYLOAD); h.recorder.boundary("shutdown");
  assert.ok(h.rows.some(r => r.reason === "shutdown"));
});

test("stream event type response.done and duplicate terminal updates preserve ambiguity", () => {
  const h = setup(); h.recorder.begin(META, PAYLOAD);
  const first = raw("resp_a", 9000); first.type = "response.done";
  h.recorder.stream(META, first); h.recorder.stream(META, raw("resp_a", undefined));
  assert.equal(h.recorder.counts.completions, 1);
  assert.ok(h.rows.some(r => r.kind === "raw_terminal_update"));
  assert.ok(h.anomalies().some(r => r.reasons.includes("terminal_usage_changed")));
});

test("created-response correlation is retained; concurrent calls fail closed", () => {
  const h = setup(); h.recorder.begin(META, PAYLOAD);
  h.recorder.stream(META, { type: "response.created", response: { id: "resp_a" } });
  h.recorder.begin(META, PAYLOAD);
  h.recorder.stream(META, raw("resp_b", 0)); h.recorder.stream(META, raw("resp_a", 9000));
  assert.ok(h.rows.filter(r => r.kind === "request_end").every(r => r.correlation === "ambiguous"));
  assert.ok(!h.anomalies().some(r => r.reasons.includes("zero_after_read")));
  h.recorder.boundary("agent_end");
});

test("unmatched stream/normalized records never steal a known different response", () => {
  const h = setup(); h.recorder.begin(META, PAYLOAD);
  h.recorder.stream(META, { type: "response.created", response: { id: "resp_a" } });
  h.recorder.normalized(META, { responseId: "resp_other", usage: { cacheRead: 0 } });
  assert.equal(h.rows.at(-1).kind, "unmatched_normalized_usage");
  h.recorder.stream(META, raw("resp_a", 9000));
  assert.equal(h.rows.at(-1).correlation, "single_pending");
});

test("large appended history preserves leading segment comparison; no secret strings survive", () => {
  const h = setup(); h.run("resp_a", 9000, frozen(structuredClone(PAYLOAD)));
  const appended = structuredClone(PAYLOAD); appended.input.push({ role: "user", content: "NEW_PRIVATE_SENTINEL" });
  h.run("resp_b", 0, frozen(appended));
  assert.ok(h.anomalies()[0].comparison.equalLeadingBytesLowerBound > 16384);
  const text = JSON.stringify(h.rows);
  for (const secret of ["PRIVATE_PROMPT_SENTINEL", "PRIVATE_INPUT_SENTINEL", "PRIVATE_TOOL_SENTINEL", "PRIVATE_CACHE_KEY_SENTINEL", "PRIVATE_AUTH_SENTINEL", "PRIVATE_OUTPUT_SENTINEL", "NEW_PRIVATE_SENTINEL", META.session]) assert.ok(!text.includes(secret));
});

test("HMAC fingerprints cannot be compared across activation; per-capture keys are ephemeral", () => {
  const a = setup(), b = setup(); a.run("resp_a", 0); b.run("resp_b", 0);
  assert.notEqual(a.rows[0].snapshot.instructions, b.rows[0].snapshot.instructions);
});

test("no token deltas or arbitrary diagnostics/headers are persisted", () => {
  const h = setup(); h.recorder.begin(META, PAYLOAD);
  for (let i = 0; i < 1000; i++) h.recorder.stream(META, { type: "response.output_text.delta", delta: "PRIVATE_DELTA_SENTINEL" });
  assert.equal(h.rows.length, 1);
  const terminal = raw("resp_a", 9000);
  terminal.response.prompt_cache_diagnostics = { type: "cache_miss", reason: "tools_changed", secret: "PRIVATE_DIAG_SENTINEL", cache_missed_tokens: 1000 };
  h.recorder.stream(META, terminal);
  h.recorder.http(200, { authorization: "PRIVATE_AUTH_SENTINEL", "set-cookie": "PRIVATE_COOKIE_SENTINEL", "x-request-id": "req_test" });
  const text = JSON.stringify(h.rows);
  assert.ok(!text.includes("PRIVATE_DIAG_SENTINEL")); assert.ok(!text.includes("PRIVATE_COOKIE_SENTINEL"));
  assert.equal(h.rows.find(r => r.kind === "request_end").diagnostic.reason, "tools_changed");
});

test("unsupported APIs are not interpreted as missing Responses cache fields", () => {
  const h = setup(); const m = { ...META, api: "anthropic-messages" };
  h.recorder.begin(m, PAYLOAD); h.recorder.stream(m, { type: "message_stop" });
  assert.equal(h.rows.length, 0);
});

test("a different provider/model cannot take the only pending payload", () => {
  const h = setup(); h.recorder.begin(META, PAYLOAD);
  h.recorder.stream({ ...META, model: "gpt-6.1-sol" }, raw("resp_other", 0));
  assert.equal(h.rows.at(-1).correlation, "unmatched");
  assert.equal(h.rows.at(-1).snapshot, undefined);
  h.recorder.boundary("end");
  assert.ok(h.rows.some(r => r.kind === "request_incomplete"));
});

test("unknown terminal status and inconsistent usage never produce a valid ratio drop", () => {
  const h = setup(); h.run("resp_a", 9000);
  const event = raw("resp_b", 0); event.response.status = "cancelled";
  h.recorder.begin(META, PAYLOAD); h.recorder.stream(META, event);
  assert.equal(h.rows.at(-1).status, "unknown"); assert.equal(h.anomalies().length, 0);
  h.run("resp_c", 20000);
  assert.ok(h.anomalies().at(-1).reasons.includes("inconsistent_input_usage"));
  assert.ok(!h.anomalies().at(-1).reasons.includes("cache_ratio_drop_ge30pp"));
});

test("normalization detects missing normalized counters and explicit input component mismatch", () => {
  const h = setup(); h.run("resp_a", 9000, PAYLOAD, { write: 100 });
  h.recorder.normalized(META, { responseId: "resp_a", usage: { input: 0, output: 10, cacheWrite: 100 } });
  const row = h.rows.find(r => r.kind === "normalized_usage");
  assert.deepEqual(row.mismatches, ["cacheRead", "input"]);
});

test("pending state is bounded and unstructured payloads do not fabricate prefix fingerprints", () => {
  const h = setup();
  for (let i = 0; i < 40; i++) h.recorder.begin(META, PAYLOAD);
  assert.equal(h.rows.filter(r => r.reason === "pending_limit").length, 24);
  const other = setup(); other.recorder.begin(META, "unstructured private payload");
  assert.equal(other.rows[0].snapshot, undefined);
  assert.ok(!JSON.stringify(other.rows).includes("unstructured private payload"));
});

test("fingerprint truncation is explicit at the 16 MiB observed-input limit", () => {
  const h = setup(); h.run("resp_big", 0, { ...PAYLOAD, input: "x".repeat(17 * 1024 * 1024) });
  assert.equal(h.rows[0].snapshot.complete, false);
  assert.ok(h.rows[0].snapshot.inputBytes > 16 * 1024 * 1024);
});

function harness(root, flag, setupFactory, configPath = join(root, "unused-test-config.json")) {
  const handlers = new Map(), commands = new Map(), notices = [];
  const pi = { on(n, f) {
    const a = handlers.get(n) ?? []; a.push(f); handlers.set(n, a);
    return () => { const index = a.indexOf(f); if (index >= 0) a.splice(index, 1); if (!a.length) handlers.delete(n); };
  }, registerCommand(n, c) { commands.set(n, c); }, registerFlag() {}, getFlag() { return flag; } };
  const ctx = { hasUI: true, mode: "tui", model: { id: META.model, provider: META.provider, api: META.api }, sessionManager: { getSessionId: () => META.session }, getContextUsage: () => undefined, ui: { notify: t => notices.push(t), theme: { fg: (_color, text) => text } } };
  const controller = setupFactory ? setupFactory(pi) : registerCacheDiagnostics(pi, { root, configPath });
  const fire = async (n, event = {}) => { for (const f of [...handlers.get(n) ?? []]) await f(event, ctx); };
  const command = args => commands.get("cache-diagnostics").handler(args, ctx);
  return { fire, command, controller, notices, ctx, handlers };
}
function readRows(dir) {
  return readdirSync(dir).filter(n => n.endsWith(".jsonl")).flatMap(n => readFileSync(join(dir, n), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)));
}

test("default config resolves beside the extension, not the working directory", () => {
  assert.equal(DEFAULT_CONFIG_PATH, new URL("../config.json", import.meta.url).pathname);
  assert.equal(typeof JSON.parse(readFileSync(DEFAULT_CONFIG_PATH, "utf8")).cacheDiagnostics.enabledByDefault, "boolean");
});

test("config loader accepts true/false but never coerces strings, numbers or missing keys", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "pi-cache-config-test-")), file = join(tmp, "config.json");
  try {
    assert.deepEqual(await loadDefaults(file), { enabledByDefault: false, state: "missing" });
    for (const enabledByDefault of [false, true]) {
      writeFileSync(file, JSON.stringify({ cacheDiagnostics: { enabledByDefault } }));
      assert.deepEqual(await loadDefaults(file), { enabledByDefault, state: "loaded" });
    }
    for (const text of ["{broken", "null", "[]", "{}", '{"cacheDiagnostics":{"enabledByDefault":"true"}}', '{"cacheDiagnostics":{"enabledByDefault":1}}', " ".repeat(9000)]) {
      writeFileSync(file, text);
      assert.deepEqual(await loadDefaults(file), { enabledByDefault: false, state: "invalid" });
    }
    assert.deepEqual(await loadDefaults(tmp), { enabledByDefault: false, state: "invalid" });
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test("configured on survives a fresh instance; temporary off does not rewrite the file", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "pi-cache-config-test-")), file = join(tmp, "config.json");
  const text = '{"cacheDiagnostics":{"enabledByDefault":true}}\n';
  let first, second;
  try {
    writeFileSync(file, text);
    first = harness(join(tmp, "logs-first"), undefined, undefined, file);
    await first.fire("session_start");
    assert.equal(first.controller.status().enabled, true);
    assert.equal(first.controller.status().defaultSource, "config");
    await first.command("status"); assert.ok(first.notices.at(-1).includes("已加载的配置默认：开启"));
    await first.command("off"); assert.equal(first.controller.status().enabled, false);
    await first.fire("session_start"); assert.equal(first.controller.status().enabled, false);
    assert.equal(readFileSync(file, "utf8"), text);
    second = harness(join(tmp, "logs-second"), undefined, undefined, file);
    await second.fire("session_start"); assert.equal(second.controller.status().enabled, true);
  } finally {
    await first?.fire("session_shutdown"); await second?.fire("session_shutdown");
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("configured off creates no logs; file changes apply only to a fresh instance", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "pi-cache-config-test-")), file = join(tmp, "config.json");
  const root = join(tmp, "logs"); let h;
  try {
    writeFileSync(file, '{"cacheDiagnostics":{"enabledByDefault":false}}');
    h = harness(root, undefined, undefined, file); await h.fire("session_start");
    assert.equal(h.controller.status().enabled, false); assert.equal(existsSync(root), false);
    writeFileSync(file, '{"cacheDiagnostics":{"enabledByDefault":true}}');
    await h.fire("session_start"); assert.equal(h.controller.status().enabled, false);
    await h.command("on"); assert.equal(h.controller.status().enabled, true);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).cacheDiagnostics.enabledByDefault, true);
  } finally { await h?.fire("session_shutdown"); rmSync(tmp, { recursive: true, force: true }); }
});

test("explicit CLI boolean overrides the file in both directions", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "pi-cache-config-test-")), file = join(tmp, "config.json");
  try {
    for (const flag of [false, true]) {
      writeFileSync(file, JSON.stringify({ cacheDiagnostics: { enabledByDefault: !flag } }));
      const h = harness(join(tmp, String(flag)), flag, undefined, file);
      try {
        await h.fire("session_start"); assert.equal(h.controller.status().enabled, flag);
        assert.equal(h.controller.status().defaultSource, "cli");
      } finally { await h.fire("session_shutdown"); }
    }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test("invalid config fails closed and warns without exposing its contents", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "pi-cache-config-test-")), file = join(tmp, "config.json");
  const root = join(tmp, "logs"); let h;
  try {
    writeFileSync(file, "PRIVATE_CONFIG_SENTINEL invalid json");
    h = harness(root, undefined, undefined, file); await h.fire("session_start");
    assert.equal(h.controller.status().enabled, false); assert.equal(existsSync(root), false);
    assert.equal(h.notices.length, 1); assert.ok(!h.notices.join().includes("PRIVATE_CONFIG_SENTINEL"));
    await h.fire("session_start"); assert.equal(h.notices.length, 1);
  } finally { await h?.fire("session_shutdown"); rmSync(tmp, { recursive: true, force: true }); }
});

test("disabled addon does no filesystem creation; command on/off is independent of model calls", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "pi-cache-test-")), root = join(tmp, "logs");
  try {
    const h = harness(root); await h.fire("session_start");
    const poison = { get payload() { throw new Error("disabled observer accessed payload"); } };
    await h.fire("before_provider_request", poison);
    await h.fire("provider_stream_event", { ...META, data: raw("resp_ignored", 0) });
    assert.equal(existsSync(root), false);
    assert.equal(h.handlers.has("provider_stream_event"), false);
    await h.command("on");
    assert.equal(h.handlers.has("provider_stream_event"), true);
    const p = frozen(structuredClone(PAYLOAD));
    await h.fire("before_provider_request", { payload: p });
    await h.fire("provider_stream_event", { ...META, data: frozen(raw("resp_live", 9000)) });
    await h.fire("message_end", { message: { role: "assistant", api: META.api, provider: META.provider, model: META.model, responseId: "resp_live", stopReason: "stop", usage: { input: 1000, cacheRead: 9000, cacheWrite: 0, output: 10 } } });
    await h.controller.flush(); const dir = h.controller.status().directory;
    assert.ok(readRows(dir).some(r => r.kind === "request_end"));
    await h.command("off"); assert.equal(h.controller.status().enabled, false);
    assert.equal(h.handlers.has("provider_stream_event"), false);
    const before = readRows(dir).length;
    await h.fire("before_provider_request", { payload: p }); assert.equal(readRows(dir).length, before);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test("CLI flag activates on session_start, rotates session state, and shutdown drains writes", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "pi-cache-test-"));
  try {
    const h = harness(tmp, true); await h.fire("session_start");
    assert.equal(h.controller.status().enabled, true);
    await h.fire("before_provider_request", { payload: PAYLOAD });
    await h.fire("provider_stream_event", { ...META, data: raw("resp_flag", 0) });
    const dir = h.controller.status().directory;
    await h.fire("session_shutdown");
    assert.ok(readRows(dir).some(r => r.responseId === "resp_flag"));
    assert.equal(h.controller.status().enabled, false);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test("account switch resets an enabled comparison baseline and is a no-op when diagnostics are off", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "pi-cache-account-test-"));
  let h;
  try {
    const off = harness(join(tmp, "off"), false);
    await off.fire("session_start");
    off.controller.accountChanged(off.ctx);
    assert.equal(existsSync(join(tmp, "off")), false);
    h = harness(join(tmp, "on"), true);
    await h.fire("session_start");
    const run = async (id, read) => {
      await h.fire("before_provider_request", { payload: PAYLOAD });
      await h.fire("provider_stream_event", { ...META, data: raw(id, read) });
    };
    await run("resp_old_account", 9000);
    h.controller.accountChanged(h.ctx);
    await run("resp_new_account", 0);
    const dir = h.controller.status().directory;
    await h.fire("session_shutdown");
    const rows = readRows(dir);
    assert.ok(rows.some(row => row.kind === "comparison_reset" && row.reason === "account_switch"));
    assert.ok(!rows.some(row => row.kind === "anomaly"));
  } finally {
    await h?.fire("session_shutdown");
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("compaction before-hook prevents cold summarizer/main calls from becoming misses", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "pi-cache-test-"));
  try {
    const h = harness(tmp, true); await h.fire("session_start");
    const run = async (id, read) => { await h.fire("before_provider_request", { payload: PAYLOAD }); await h.fire("provider_stream_event", { ...META, data: raw(id, read) }); };
    await run("resp_main", 9000);
    await h.fire("session_before_compact", frozen({ reason: "manual" }));
    await run("resp_summary", 0); await h.fire("session_compact"); await run("resp_newmain", 0);
    const decision = frozen({ action: "warm" }); await h.fire("cache_warming_decision", decision);
    assert.equal(decision.action, "warm");
    const dir = h.controller.status().directory; await h.fire("session_shutdown");
    assert.ok(!readRows(dir).some(r => r.kind === "anomaly"));
    assert.ok(readRows(dir).some(r => r.kind === "cache_warming_decision" && r.finalActionKnown === false));
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test("enabled diagnostics leave speed footer and other status entries intact", async t => {
  const factory = (await jiti.import(new URL("../index.ts", import.meta.url).pathname)).default;
  const tmp = mkdtempSync(join(tmpdir(), "pi-cache-test-")), previous = process.env.PI_CACHE_DIAGNOSTICS_DIR;
  process.env.PI_CACHE_DIAGNOSTICS_DIR = tmp;
  let now = 0; t.mock.method(performance, "now", () => now);
  const statuses = new Map([["other-extension", "kept"]]);
  const h = harness(tmp, false, factory);
  h.ctx.ui.setStatus = (key, text) => statuses.set(key, text);
  try {
    await h.fire("session_start"); await h.command("on");
    await h.fire("turn_start"); await h.fire("before_provider_request", { payload: frozen(structuredClone(PAYLOAD)) });
    await h.fire("message_start", { message: { role: "assistant" } });
    now = 2000;
    await h.fire("message_update", { message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", delta: "private output" } });
    now = 10000; await h.fire("provider_stream_event", { ...META, data: raw("resp_footer", 9000) });
    await h.fire("message_end", { message: { role: "assistant", api: META.api, provider: META.provider, model: META.model, responseId: "resp_footer", stopReason: "stop", usage: { output: 500, cacheRead: 9000, cacheWrite: 0 } } });
    assert.equal(statuses.get("footer-tools.token-speed"), "Avg overall 50.0 tok/s");
    assert.equal(statuses.get("other-extension"), "kept");
  } finally {
    await h.command("off");
    if (previous === undefined) delete process.env.PI_CACHE_DIAGNOSTICS_DIR; else process.env.PI_CACHE_DIAGNOSTICS_DIR = previous;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("private bounded writer rotates only its own files and preserves complete JSON lines", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "pi-cache-test-"));
  try {
    writeFileSync(join(tmp, "unrelated.txt"), "keep");
    const w = new JsonlWriter(tmp, () => assert.fail("unexpected writer failure"), { maxFileBytes: 180, maxFiles: 2, maxQueueBytes: 10000 });
    await w.ready;
    for (let i = 0; i < 12; i++) w.emit("summary", { i, filler: "x".repeat(30) });
    const closing = w.close(); assert.equal(w.close(), closing); await closing;
    assert.equal(readFileSync(join(tmp, "unrelated.txt"), "utf8"), "keep");
    const files = readdirSync(w.directory);
    assert.ok(files.length <= 2);
    assert.equal(statSync(w.directory).mode & 0o777, 0o700);
    for (const f of files) { assert.equal(statSync(join(w.directory, f)).mode & 0o777, 0o600); assert.ok(statSync(join(w.directory, f)).size <= 180); }
    assert.ok(readRows(w.directory).every(r => r.schemaVersion === 1));
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test("queue/line limits expose drops, and storage failure is contained", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "pi-cache-test-"));
  try {
    const w = new JsonlWriter(tmp, () => {}, { maxFileBytes: 100, maxQueueBytes: 100, maxLineBytes: 100 });
    for (let i = 0; i < 100; i++) w.emit("summary", { huge: "x".repeat(1000) });
    await w.close(); assert.equal(w.dropped, 100);
    const root = join(tmp, "not-a-directory"); writeFileSync(root, "keep");
    let failures = 0; const bad = new JsonlWriter(root, () => { failures++; });
    bad.emit("summary", { x: 1 }); await bad.close();
    assert.equal(bad.failed, true); assert.equal(failures, 1);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test("cyclic payload cannot break model hooks: recorder disables itself without leaking error text", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "pi-cache-test-"));
  try {
    const h = harness(tmp, true); await h.fire("session_start");
    const p = { input: null }; p.input = p;
    await h.fire("before_provider_request", { payload: p });
    assert.equal(h.controller.status().enabled, false);
    assert.ok(h.notices.some(s => s.includes("正常模型请求继续")));
    await h.controller.flush();
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test("real installed Pi API allows dynamic on/off subscription without model tools or calls", async () => {
  const { loadExtensions } = await import(pathToFileURL(join(host, "dist/core/extensions/loader.js")).href);
  const { createEventBus } = await import(pathToFileURL(join(host, "dist/core/event-bus.js")).href);
  const tmp = mkdtempSync(join(tmpdir(), "pi-cache-test-"));
  const previous = process.env.PI_CACHE_DIAGNOSTICS_DIR;
  process.env.PI_CACHE_DIAGNOSTICS_DIR = tmp;
  let extension;
  try {
    const result = await loadExtensions([new URL("../index.ts", import.meta.url).pathname], tmp, createEventBus());
    assert.equal(result.errors.length, 0);
    extension = result.extensions[0];
    assert.equal(extension.tools.size, 0);
    assert.equal(extension.handlers.has("provider_stream_event"), false);
    const ctx = harness(tmp).ctx;
    await extension.commands.get("cache-diagnostics").handler("on", ctx);
    assert.equal(extension.handlers.get("provider_stream_event").length, 1);
    await extension.commands.get("cache-diagnostics").handler("off", ctx);
    assert.equal(extension.handlers.has("provider_stream_event"), false);
    assert.ok(readdirSync(tmp).some(n => n.startsWith("capture-")));
  } finally {
    if (extension) await extension.commands.get("cache-diagnostics").handler("off", harness(tmp).ctx);
    if (previous === undefined) delete process.env.PI_CACHE_DIAGNOSTICS_DIR; else process.env.PI_CACHE_DIAGNOSTICS_DIR = previous;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("fingerprinting benchmark uses synthetic input only", () => {
  const h = setup(); const p = { ...PAYLOAD, input: "abcd".repeat(500000) };
  const start = performance.now(); h.recorder.begin(META, p);
  const ms = performance.now() - start;
  const count = h.rows[0].snapshot.inputBytes;
  assert.ok(count >= 2000000);
  console.log(`Synthetic fingerprint: ${count} bytes in ${ms.toFixed(1)} ms; not model latency.`);
});
