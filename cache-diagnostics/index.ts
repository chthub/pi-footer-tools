import { join, resolve } from "node:path";
import { getAgentDir, VERSION, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Recorder, trackedApi, type Meta } from "./core.ts";
import { JsonlWriter } from "./writer.ts";
import { loadDefaults, type Defaults } from "./config.ts";
import { resolveConfigPath } from "../config-path.ts";

export interface CaptureOptions { root?: string; configPath?: string }

/** Optional observer only: no tools, prompt injection, request mutation or extra calls. */
export function registerCacheDiagnostics(pi: ExtensionAPI, options: CaptureOptions = {}) {
  let enabled = false;
  let readDefaults = false;
  const configPath = options.configPath ?? resolveConfigPath();
  let defaults: Defaults | undefined;
  let defaultSource: "cli" | "config" | undefined;
  let writer: JsonlWriter | undefined;
  let recorder: Recorder | undefined;
  let fault: "storage" | "capture" | undefined;
  let lastStatus: Record<string, unknown> = {};
  let closing: Promise<void> = Promise.resolve();
  let unsubscribe: (() => void)[] = [];
  function detach() {
    for (const remove of unsubscribe) remove();
    unsubscribe = [];
  }

  function notify(ctx: ExtensionContext, text: string, kind: "info" | "warning" | "error" = "info") {
    // Never add a conversation message or alter the speed footer.
    if (ctx.hasUI) ctx.ui.notify(text, kind);
  }
  function meta(ctx: ExtensionContext, override?: Partial<Meta>): Meta {
    return {
      session: ctx.sessionManager.getSessionId(), provider: ctx.model?.provider ?? "unknown",
      api: ctx.model?.api ?? "unknown", model: ctx.model?.id ?? "unknown", ...override,
    };
  }
  async function stop(reason: string): Promise<void> {
    detach();
    const old = writer;
    recorder?.boundary(reason);
    old?.emit("summary", { kind: "capture_end", at: new Date().toISOString(), reason, counts: recorder?.counts,
      writer: { failed: old.failed, dropped: old.dropped, written: old.written, rotatedFiles: old.rotatedFiles } });
    recorder = undefined; writer = undefined;
    if (old) closing = closing.then(async () => { await old.close(); lastStatus = old.status(); });
    await closing;
  }
  async function start(ctx: ExtensionContext): Promise<void> {
    if (writer && recorder && !writer.failed) return;
    const agentDir = getAgentDir();
    const root = resolve(options.root || process.env.PI_CACHE_DIAGNOSTICS_DIR || join(agentDir, "cache-diagnostics"));
    let created: JsonlWriter;
    created = new JsonlWriter(root, () => {
      if (writer === created) { detach(); enabled = false; fault = "storage"; recorder = undefined; }
      void created.close().catch(() => {});
      notify(ctx, "缓存诊断因日志写入失败已停用；正常模型请求不受影响。", "warning");
    });
    writer = created;
    await created.ready;
    if (created.failed) { lastStatus = created.status(); return; }
    fault = undefined;
    recorder = new Recorder((channel, record) => created.emit(channel, record));
    attachObservers();
    created.emit("summary", {
      kind: "capture_start", at: new Date().toISOString(), scope: "Responses provider hooks only",
      observerVersion: "1", piSdkVersion: VERSION, nodeVersion: process.version, piAiVersion: "not_exposed",
      configuredDefault: defaults?.enabledByDefault, configState: defaults?.state, startupDefaultSource: defaultSource,
      fingerprintStage: "before_provider_request; later handlers/transport may still transform payload",
      hash: "per-capture HMAC-SHA256; key is not stored", requestBehaviorChanged: false,
    });
  }
  function observe(ctx: ExtensionContext, handler: (r: Recorder) => void): void {
    if (!enabled || !recorder || !writer || writer.failed) return;
    try { handler(recorder); }
    catch {
      fault = "capture"; enabled = false;
      writer.emit("summary", { kind: "capture_error", at: new Date().toISOString(), reason: "observer_failed" });
      // Do not print exception text: it could contain a prompt, path or credential.
      void stop("capture_error").catch(() => {});
      notify(ctx, "缓存诊断记录失败，已停用；正常模型请求继续。", "warning");
    }
  }
  pi.registerFlag("cache-diagnostics", {
    type: "boolean", description: "Enable metadata-only Responses cache diagnostics (otherwise use config.json)",
  });
  pi.registerCommand("cache-diagnostics", {
    description: "缓存诊断：on / off / status（默认开关由 config.json 设置，不改变请求）",
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase() || "status";
      if (action === "on") {
        enabled = true;
        await start(ctx);
        if (writer && !writer.failed && recorder) notify(ctx, `缓存诊断已开启：${writer.directory}\n仅记录Responses请求；不改变模型请求。`);
      } else if (action === "off") {
        enabled = false;
        await stop("capture_disabled");
        notify(ctx, "缓存诊断已关闭，日志已排空；测速功能保持不变。");
      } else if (action === "status") {
        const s = writer?.status() ?? lastStatus;
        const c = recorder?.counts;
        notify(ctx, `缓存诊断：${enabled && recorder ? "开启" : "关闭"}${fault ? `（${fault}故障）` : ""}\n已加载的配置默认：${defaults ? defaults.enabledByDefault ? "开启" : "关闭" : "未读取"}（${defaults?.state ?? "未读取"}）；启动默认来源：${defaultSource ?? "未读取"}\n配置：${configPath}\n目录：${s.directory ?? "尚无"}\n记录 ${s.written ?? 0}，待写 ${s.queued ?? 0}，丢弃 ${s.dropped ?? 0}，已轮换删除 ${s.rotatedFiles ?? 0} 文件${c ? `；完成 ${c.completions}，异常记录 ${c.anomalies}` : ""}`);
      } else notify(ctx, "用法：/cache-diagnostics on | off | status", "warning");
    },
  });
  pi.on("session_start", async (_event, ctx) => {
    if (!readDefaults) {
      defaults = await loadDefaults(configPath);
      const flag = pi.getFlag("cache-diagnostics");
      enabled = typeof flag === "boolean" ? flag : defaults.enabledByDefault;
      defaultSource = typeof flag === "boolean" ? "cli" : "config";
      readDefaults = true;
      if (defaults.state === "invalid") notify(ctx, "缓存诊断配置无法读取或格式错误，配置默认按关闭处理；显式命令行开关仍优先。", "warning");
    }
    await stop("session_changed");
    if (enabled) await start(ctx);
  });
  function attachObservers() {
    // Subscribe only while enabled: default-off does not add per-stream dispatch work.
    unsubscribe.push(
      pi.on("before_provider_request", (event, ctx) => {
        if (!enabled) return;
        observe(ctx, r => r.begin(meta(ctx), event.payload));
        // Return undefined, never a replacement provider payload.
      }),
      pi.on("provider_stream_event", (event, ctx) => {
        observe(ctx, r => r.stream(meta(ctx, { provider: event.provider, api: event.api, model: event.model }), event.data));
      }),
      pi.on("after_provider_response", (event, ctx) => {
        if (!enabled || !trackedApi(ctx.model?.api ?? "unknown")) return;
        observe(ctx, r => r.http(event.status, event.headers));
      }),
      pi.on("message_end", (event, ctx) => {
        const message = event.message;
        if (!enabled || message.role !== "assistant" || !trackedApi(message.api)) return;
        observe(ctx, r => r.normalized(meta(ctx, { provider: message.provider, api: message.api, model: message.model }), message));
      }),
      pi.on("agent_end", (_event, ctx) => observe(ctx, r => r.boundary("agent_end_without_terminal"))),
      pi.on("session_before_compact", (_event, ctx) => observe(ctx, r => r.reset("session_before_compact"))),
      pi.on("session_compact_failed", (_event, ctx) => observe(ctx, r => r.reset("session_compact_failed"))),
      pi.on("session_before_tree", (_event, ctx) => observe(ctx, r => r.reset("session_before_tree"))),
      pi.on("cache_warming_decision", (event, ctx) => observe(ctx, r => r.warmingDecision(event.action))),
      pi.on("session_tree", (_event, ctx) => observe(ctx, r => r.reset("session_tree"))),
      pi.on("model_select", (_event, ctx) => observe(ctx, r => r.reset("model_select"))),
      pi.on("session_compact", (_event, ctx) => observe(ctx, r => r.reset("session_compact"))),
    );
  }
  pi.on("session_shutdown", async () => { enabled = false; await stop("session_shutdown"); });
  return { accountChanged: (ctx: ExtensionContext) => observe(ctx, r => r.reset("account_switch")), flush: async () => { await writer?.flush(); await closing; }, status: () => ({ enabled, fault, configPath, defaults, defaultSource, ...writer?.status(), counts: recorder?.counts }) };
}
