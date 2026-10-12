/** TEST ONLY: synthetic model and intercepted Telegram delivery, no external I/O. */
import { appendFileSync } from "node:fs";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function fixture(pi: ExtensionAPI): void {
  const logPath = process.env.TG_TEST_LOG;
  if (!logPath) throw new Error("TG_TEST_LOG is required for the test fixture");
  const log = (event: string, extra = {}) =>
    appendFileSync(logPath, JSON.stringify({ event, ...extra }) + "\n");
  const originalFetch = globalThis.fetch;
  const originalSpawn = childProcess.spawn;
  childProcess.spawn = new Proxy(originalSpawn, {
    apply(target, thisArg, args) {
      if (args[0] === "flock") throw new Error("Real Telegram collector forbidden in tests");
      return Reflect.apply(target, thisArg, args);
    },
  });
  syncBuiltinESMExports();
  let failure = false;
  let continued = false;
  let retried = false;
  let prompt = "";
  let calls = 0;
  let deliveries = 0;

  globalThis.fetch = async (input, init) => {
    if (String(input).startsWith("https://api.telegram.org/bot")) {
      const messageId = process.pid * 10000 + ++deliveries;
      log("telegram", { body: JSON.parse(String(init?.body)), failure, messageId });
      if (failure) throw new Error("test network failure; token must never appear");
      return new Response(JSON.stringify({ ok: true, result: { message_id: messageId } }));
    }
    throw new Error("External network is forbidden in the Telegram TUI fixture");
  };
  pi.on("session_shutdown", () => {
    globalThis.fetch = originalFetch;
    childProcess.spawn = originalSpawn;
    syncBuiltinESMExports();
  });
  pi.on("agent_end", () => { log("agent_end"); });
  pi.on("agent_settled", () => { log("agent_settled"); });
  pi.on("agent_before_settle", () => {
    if (prompt === "continue" && !continued) {
      continued = true;
      log("continuation");
      return {
        continue: true,
        entries: [{
          type: "custom_message" as const, customType: "tg-test-continuation",
          content: "Synthetic continuation test.", display: false,
        }],
      };
    }
  });

  pi.registerProvider("tg-smoke", {
    baseUrl: "https://invalid.test",
    api: "tg-smoke-api",
    apiKey: "test-key",
    models: [{
      id: "synthetic", name: "Telegram smoke model", reasoning: false,
      input: ["text"], contextWindow: 100000, maxTokens: 100,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }],
    streamSimple: (model, context, options) => {
      const stream = createAssistantMessageEventStream();
      const user = context.messages.filter((m) => m.role === "user").at(-1);
      const content = user?.content;
      prompt = typeof content === "string" ? content :
        content?.filter((c) => c.type === "text").map((c) => c.text).join("") ?? "";
      failure = prompt === "failure";
      const shouldRetry = prompt === "retry" && !retried;
      if (shouldRetry) retried = true;
      const number = ++calls;
      log("model_start", { number, remote: prompt.startsWith("remote-") });
      const output: AssistantMessage = {
        role: "assistant", api: model.api, provider: model.provider, model: model.id,
        content: [{ type: "text", text: "" }],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
          totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop", timestamp: Date.now(),
      };
      stream.push({ type: "start", partial: output });
      setTimeout(() => {
        if (options?.signal?.aborted) {
          output.stopReason = "aborted";
          stream.push({ type: "error", reason: "aborted", error: output });
        } else if (shouldRetry) {
          output.stopReason = "error";
          output.errorMessage = "429 rate limit exceeded";
          stream.push({ type: "error", reason: "error", error: output });
        } else {
          const text = `SMOKE_RESULT_${number}`;
          output.content = [{ type: "text", text }];
          stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: output });
          stream.push({ type: "done", reason: "stop", message: output });
        }
        stream.end();
      }, 700);
      return stream;
    },
  });
}
