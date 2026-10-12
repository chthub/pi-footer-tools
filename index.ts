/**
 * Per-model-request speed in Pi's existing footer.
 * Speed stays allocation-light; diagnostics, context-cost comparison,
 * live Codex account switching and Telegram are independently switched in config.
 * Speed itself uses no tokenizer, extra model requests, transcript writes or custom footer.
 * Opt-in Telegram replies become normal user messages and can start model runs.
 */
import { performance } from "node:perf_hooks";
import { registerCacheDiagnostics } from "./cache-diagnostics/index.ts";
import { registerContextCost } from "./context-cost/index.ts";
import { registerAccountSwitch } from "./account-switch/index.ts";
import { registerTelegramNotify } from "./telegram-notify/index.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "token-speed";

interface Measurement {
  firstOutputAt?: number;
}

export default function tokenSpeed(pi: ExtensionAPI) {
  const diagnostics = registerCacheDiagnostics(pi);
  registerContextCost(pi);
  registerAccountSwitch(pi, { onSwitch: diagnostics.accountChanged });
  registerTelegramNotify(pi);
  let active: Measurement | undefined;

  function show(ctx: ExtensionContext, text: string | undefined) {
    if (ctx.mode === "tui") ctx.ui.setStatus(STATUS_KEY, text);
  }

  function reset(ctx: ExtensionContext) {
    active = undefined;
    show(ctx, undefined);
  }

  pi.on("session_start", (_event, ctx) => reset(ctx));
  pi.on("session_tree", (_event, ctx) => reset(ctx));
  pi.on("model_select", (_event, ctx) => reset(ctx));

  pi.on("turn_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    active = {};
    // Keep the previous result visible until this request finishes.
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
    const outputSeconds = measurement.firstOutputAt === undefined
      ? 0
      : (performance.now() - measurement.firstOutputAt) / 1000;
    const tokens = message.usage.output;
    const complete = ["stop", "length", "toolUse"].includes(message.stopReason);
    const knownTokens = Number.isSafeInteger(tokens) && tokens > 0;
    const speed = complete && knownTokens && outputSeconds > 0
      ? (tokens / outputSeconds).toFixed(1)
      : "--";
    show(ctx, `Avg ${speed} tok/s`);
  });

  pi.on("agent_end", () => {
    // Without message_end there is no new result; leave the previous one untouched.
    active = undefined;
  });

  pi.on("session_shutdown", (_event, ctx) => {
    active = undefined;
    show(ctx, undefined);
  });
}
