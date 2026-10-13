/**
 * Pi footer tools: per-model-request speed and opt-in companion features.
 * Speed stays allocation-light; diagnostics, context-cost comparison,
 * live Codex account switching, Telegram and the sticky note are independently switched in config.
 * Speed itself uses no tokenizer, extra model requests, transcript writes or custom footer.
 * Opt-in Telegram replies become normal user messages and can start model runs.
 */
import { performance } from "node:perf_hooks";
import { registerCacheDiagnostics } from "./cache-diagnostics/index.ts";
import { registerContextCost } from "./context-cost/index.ts";
import { registerAccountSwitch } from "./account-switch/index.ts";
import { registerTelegramNotify } from "./telegram-notify/index.ts";
import { registerStickyNote } from "./sticky-note/index.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "footer-tools.token-speed";

type SpeedMode = "overall" | "stream";

interface Measurement {
  requestStartedAt?: number;
  firstOutputAt?: number;
}

type SpeedResult = Record<SpeedMode, string>;

export default function footerTools(pi: ExtensionAPI) {
  const diagnostics = registerCacheDiagnostics(pi);
  registerContextCost(pi);
  registerAccountSwitch(pi, { onSwitch: diagnostics.accountChanged });
  registerTelegramNotify(pi);
  registerStickyNote(pi);
  let active: Measurement | undefined;
  let mode: SpeedMode = "overall";
  let lastResult: SpeedResult | undefined;

  function show(ctx: ExtensionContext, text: string | undefined) {
    if (ctx.mode === "tui") ctx.ui.setStatus(STATUS_KEY, text);
  }

  function render(ctx: ExtensionContext) {
    show(ctx, lastResult ? `Avg ${mode} ${lastResult[mode]} tok/s` : undefined);
  }

  function reset(ctx: ExtensionContext) {
    active = undefined;
    lastResult = undefined;
    show(ctx, undefined);
  }

  pi.registerCommand("token-speed", {
    description: "Switch token speed: overall (request to end) or stream (first output to end)",
    getArgumentCompletions: (prefix) => {
      const options = ["overall", "stream", "status"].filter((value) => value.startsWith(prefix));
      return options.length ? options.map((value) => ({ value, label: value })) : null;
    },
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") return;
      const choice = args.trim().toLowerCase();
      if (choice === "status") {
        ctx.ui.notify(`Token speed: ${mode}`, "info");
        return;
      }
      if (choice && choice !== "overall" && choice !== "stream") {
        ctx.ui.notify("Usage: /token-speed [overall|stream|status]", "warning");
        return;
      }
      mode = choice === "overall" || choice === "stream"
        ? choice
        : (mode === "overall" ? "stream" : "overall");
      render(ctx); // Reuse both measurements of the last request; no new model call.
      ctx.ui.notify(`Token speed: ${mode}`, "info");
    },
  });

  pi.on("session_start", (_event, ctx) => reset(ctx));
  pi.on("session_tree", (_event, ctx) => reset(ctx));
  pi.on("model_select", (_event, ctx) => reset(ctx));

  pi.on("turn_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    active = {};
    // Keep the previous result visible until this request finishes.
  });

  pi.on("before_provider_request", () => {
    // Earliest request-payload hook, not an exact socket-send timestamp.
    // Keep the first timestamp so retries within this message include their waits.
    if (active) active.requestStartedAt ??= performance.now();
  });

  pi.on("message_update", (event) => {
    if (!active || event.message.role !== "assistant") return;
    const update = event.assistantMessageEvent;
    if ((update.type === "text_delta" || update.type === "thinking_delta" || update.type === "toolcall_delta")
      && update.delta.length > 0) {
      // Match usage.output: thinking and generated tool arguments count as output too.
      active.firstOutputAt ??= performance.now();
    }
  });

  pi.on("message_end", (event, ctx) => {
    if (!active || event.message.role !== "assistant") return;
    const measurement = active;
    active = undefined; // Stop BEFORE tool execution; keep the completed result in the footer.
    const message = event.message;
    const endedAt = performance.now();
    const tokens = message.usage.output;
    const complete = ["stop", "length", "toolUse"].includes(message.stopReason);
    const knownTokens = Number.isSafeInteger(tokens) && tokens > 0;
    const speed = (startedAt: number | undefined) => {
      const seconds = startedAt === undefined ? 0 : (endedAt - startedAt) / 1000;
      return complete && knownTokens && seconds > 0
        ? (tokens / seconds).toFixed(1)
        : "--";
    };
    lastResult = {
      overall: speed(measurement.requestStartedAt),
      stream: speed(measurement.firstOutputAt),
    };
    render(ctx);
  });

  pi.on("agent_end", () => {
    // Without message_end there is no new result; leave the previous one untouched.
    active = undefined;
  });

  pi.on("session_shutdown", (_event, ctx) => reset(ctx));
}
