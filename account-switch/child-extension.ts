import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CHANNEL_ENV, readAccountChannel, registerChildLaunch } from "./channel.ts";
import { attachFollowingRouting } from "./routing.ts";

/** Explicitly injected into child RPC processes; ordinary RPC/print runs are unchanged. */
export function registerChildAccountRouting(pi: ExtensionAPI, path = process.env[CHANNEL_ENV]) {
  if (!path) return;
  let routing: ReturnType<typeof attachFollowingRouting> | undefined;
  let unsubscribe: (() => void) | undefined;
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "rpc") return;
    try {
      routing = attachFollowingRouting(ctx.modelRegistry, () => readAccountChannel(path));
      unsubscribe = registerChildLaunch(pi, () => path);
    } catch {
      // A lifecycle-handler exception alone would leave launch authentication active.
      // Stop this child rather than silently spend the wrong account's quota.
      ctx.shutdown();
      throw new Error("Codex account synchronization unavailable; reload the parent window.");
    }
  });
  pi.on("session_shutdown", () => {
    unsubscribe?.();
    unsubscribe = undefined;
    routing?.detach();
    routing = undefined;
  });
}

export default function (pi: ExtensionAPI) {
  registerChildAccountRouting(pi);
}
