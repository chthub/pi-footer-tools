import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

/** Offline synthetic provider for the real-RPC account synchronization test. */
export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    const base = ctx.modelRegistry.getProvider("openai-codex");
    if (!base) throw new Error("Missing synthetic test provider");
    pi.registerProvider({ ...base, streamSimple(model, context, options) {
      if (!/^access-(personal|backup)$/.test(options?.apiKey ?? "")) throw new Error("Non-synthetic test credential");
      const stream = createAssistantMessageEventStream();
      const users = context.messages.filter(message => message.role === "user");
      const quota = options?.apiKey === "access-personal" && users.some(message => JSON.stringify(message.content).includes("quota"));
      const message = {
        role: "assistant" as const, content: [{ type: "text" as const, text: `${options?.apiKey};users=${users.length}` }],
        api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
        stopReason: quota ? "error" as const : "stop" as const,
        ...(quota ? { errorMessage: "Synthetic account quota exceeded" } : {}),
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      if (quota) stream.push({ type: "error", reason: "error", error: message });
      else stream.push({ type: "done", reason: "stop", message });
      stream.end(message);
      return stream;
    } });
  });
}
