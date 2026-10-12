import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { estimate, formatStatus, type PriceModel } from "./core.ts";
import { DEFAULT_CONFIG_PATH, loadContextCostConfig } from "./config.ts";

const STATUS_KEY = "context-cost";

export interface ContextCostOptions { configPath?: string }

/** Read-only footer comparison; no requests, timers, compaction or model changes. */
export function registerContextCost(pi: ExtensionAPI, options: ContextCostOptions = {}) {
  const config = loadContextCostConfig(options.configPath ?? DEFAULT_CONFIG_PATH);
  if (config.state === "invalid") {
    let warned = false;
    pi.on("session_start", (_event, ctx) => {
      if (warned || ctx.mode !== "tui") return;
      warned = true;
      ctx.ui.notify("Context cost: contextCost in config.json is unreadable or malformed; feature is off.", "warning");
    });
  }
  if (!config.enabled) return;

  let shown: string | undefined;
  function show(ctx: ExtensionContext, text: string | undefined, force = false) {
    if (ctx.mode !== "tui") return;
    // Same dim gray as Pi's own footer lines. No theme-change event exists, so the colour is
    // re-applied from the current theme on each refresh; comparing styled text repaints after a switch.
    const styled = text === undefined ? undefined : ctx.ui.theme.fg("dim", text);
    if (!force && styled === shown) return;
    shown = styled;
    ctx.ui.setStatus(STATUS_KEY, styled);
  }

  function refresh(ctx: ExtensionContext, model: PriceModel | undefined = ctx.model, force = false) {
    if (ctx.mode !== "tui") return;
    if (!model) return show(ctx, undefined, force);
    // First version: H ≈ T ≈ current context estimate C; null right after compaction stays unknown.
    const tokens = ctx.getContextUsage()?.tokens;
    const result = estimate({
      model, historyTokens: tokens, nextTotalInputTokens: tokens,
      startupTokens: config.startupTokens, startupMode: config.startupMode,
    });
    show(ctx, formatStatus(result), force);
  }

  pi.on("session_start", (_event, ctx) => refresh(ctx, ctx.model, true));
  // ctx.model may still be the previous model while this event is dispatched.
  pi.on("model_select", (event, ctx) => refresh(ctx, event.model));
  // message_end fires before the message is persisted; these run after the context updates.
  pi.on("turn_end", (_event, ctx) => refresh(ctx));
  pi.on("agent_end", (_event, ctx) => refresh(ctx));
  pi.on("session_compact", (_event, ctx) => refresh(ctx));
  pi.on("session_tree", (_event, ctx) => refresh(ctx));
  pi.on("session_shutdown", (_event, ctx) => {
    show(ctx, undefined, true);
    shown = undefined;
  });
}
