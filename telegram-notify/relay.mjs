// Private local collector. No credentials, conversation, or switch state on disk.
import { createHash } from "node:crypto";
import { chmodSync, unlinkSync } from "node:fs";
import { createServer } from "node:net";
import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

export function authorized(message, registration) {
  if (!message || message.business_connection_id || message.guest_query_id ||
      message.sender_chat || !message.from || message.from.is_bot ||
      String(message.chat?.id) !== registration.chatId ||
      typeof message.text !== "string" || !message.text.trim() || message.text.length > 4096) return false;
  if (message.chat.type === "private") {
    return String(message.from.id) === registration.chatId;
  }
  return ["group", "supergroup"].includes(message.chat.type) &&
    registration.allowedUserIds.includes(String(message.from.id));
}

/** Main invocation must be protected by flock before replacing a stale socket. */
export async function createRelay({ socketPath, tokenHash, fetchImpl = fetch,
  idleMs = 2000, pollSeconds = 25, initialIdleMs = 5000 }) {
  const registrations = new Map();
  let token;
  let running = false;
  let closed = false;
  let pause;
  let idle;
  let state = "WAIT";
  const allSockets = new Set();
  const server = createServer();

  function write(socket, value) {
    if (socket.destroyed) return;
    if (socket.writableLength > 65536) socket.destroy();
    else socket.write(JSON.stringify(value) + "\n");
  }
  function status(value) {
    state = value;
    for (const socket of registrations.keys()) write(socket, { op: "status", status: value });
  }
  function armIdle(ms) {
    clearTimeout(idle);
    idle = setTimeout(() => { void close(); }, ms);
  }
  async function api(body, signal) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const timeout = setTimeout(abort, (body.timeout + 5) * 1000);
    timeout.unref();
    try {
      const response = await fetchImpl(`https://api.telegram.org/bot${encodeURIComponent(token)}/getUpdates`, {
        method: "POST", redirect: "error", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body), signal: controller.signal,
      });
      const value = await response.json();
      if (!response.ok || value?.ok !== true || !Array.isArray(value.result)) throw new Error();
      return value.result;
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
    }
  }

  function dispatch(update) {
    const message = update.message;
    const replyId = message?.reply_to_message?.message_id;
    if (!Number.isSafeInteger(replyId)) return; // Never guess/broadcast an unaddressed prompt.
    const matches = [...registrations].filter(([, registration]) =>
      registration.ids.includes(replyId) && authorized(message, registration));
    if (matches.length !== 1) return; // Ambiguous targets fail closed.
    write(matches[0][0], { op: "text", id: update.update_id, text: message.text });
  }

  async function poll() {
    running = true;
    const operation = new AbortController();
    pause = operation;
    let offset = -1;
    let initialized = false;
    let delay = 1000;
    try {
      while (!closed && registrations.size && !operation.signal.aborted) {
        try {
          const updates = await api({ offset, timeout: initialized ? pollSeconds : 0,
            allowed_updates: ["message"] }, operation.signal);
          if (operation.signal.aborted) break;
          // Drop pre-activation backlog. Old remote prompts must not execute later.
          if (!initialized) {
            offset = updates.reduce((next, u) => Number.isSafeInteger(u.update_id)
              ? Math.max(next, u.update_id + 1) : next, 0);
            initialized = true;
          } else {
            for (const update of updates) {
              if (!Number.isSafeInteger(update.update_id) || update.update_id < offset) continue;
              offset = update.update_id + 1; // Mark before dispatch: no replay into models.
              dispatch(update);
            }
          }
          status("READY");
          delay = 1000;
          // Avoid hot loops if the server/mock returns empty results immediately.
          await sleep(200, undefined, { signal: operation.signal });
        } catch {
          if (operation.signal.aborted || closed || !registrations.size) break;
          status("ERR");
          await sleep(delay, undefined, { signal: operation.signal });
          delay = Math.min(delay * 2, 30000);
        }
      }
    } catch { /* Shutdown aborts backoff sleeps. */ }
    finally {
      running = false;
      if (!closed && registrations.size) void poll();
    }
  }

  server.on("connection", (socket) => {
    allSockets.add(socket);
    // Unregistered/malicious clients may not keep a collector alive indefinitely.
    const deadline = setTimeout(() => socket.destroy(), 5000);
    deadline.unref();
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (buffer.length > 32768) { socket.destroy(); return; }
      while (buffer.includes("\n")) {
        const index = buffer.indexOf("\n");
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        try {
          const event = JSON.parse(line);
          if (event.op === "register" && !registrations.has(socket)) {
            if (typeof event.token !== "string" ||
                createHash("sha256").update(event.token).digest("hex") !== tokenHash ||
                typeof event.chatId !== "string" || !/^-?\d+$/.test(event.chatId) ||
                !Array.isArray(event.allowedUserIds) || event.allowedUserIds.length > 100 ||
                !event.allowedUserIds.every((id) => typeof id === "string" && /^\d+$/.test(id)) ||
                !Array.isArray(event.ids) || event.ids.length > 128 ||
                !event.ids.every((id) => Number.isSafeInteger(id) && id > 0)) {
              socket.destroy(); return;
            }
            clearTimeout(deadline);
            clearTimeout(idle);
            token = event.token;
            registrations.set(socket, { chatId: event.chatId,
              allowedUserIds: event.allowedUserIds, ids: event.ids });
            write(socket, { op: "status", status: state });
            if (!running) void poll();
          } else if (event.op === "remember" && Number.isSafeInteger(event.id) && event.id > 0) {
            const registration = registrations.get(socket);
            if (!registration) { socket.destroy(); return; }
            if (!registration.ids.includes(event.id)) registration.ids.push(event.id);
            if (registration.ids.length > 128) registration.ids.shift();
          } else { socket.destroy(); return; }
        } catch { socket.destroy(); return; }
      }
    });
    socket.on("close", () => {
      clearTimeout(deadline);
      allSockets.delete(socket);
      registrations.delete(socket);
      if (!registrations.size) {
        pause?.abort();
        state = "WAIT";
        armIdle(idleMs);
      }
    });
  });

  async function close() {
    if (closed) return;
    closed = true;
    clearTimeout(idle);
    pause?.abort();
    for (const socket of allSockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    token = undefined;
  }

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.removeListener("error", reject);
      server.on("error", () => { void close(); });
      chmodSync(socketPath, 0o600);
      resolve();
    });
  });
  armIdle(initialIdleMs);
  return { close, server };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // flock is held by the parent launcher for this bot throughout our lifetime.
  const [socketPath, tokenHash] = process.argv.slice(2);
  try {
    if (!socketPath || !/^[a-f0-9]{64}$/.test(tokenHash ?? "")) throw new Error();
    try { unlinkSync(socketPath); } catch (error) { if (error.code !== "ENOENT") throw error; }
    const relay = await createRelay({ socketPath, tokenHash });
    process.on("SIGTERM", () => { void relay.close(); });
    process.on("SIGINT", () => { void relay.close(); });
  } catch { process.exitCode = 1; } // Do not log raw errors, URLs, or credentials.
}
