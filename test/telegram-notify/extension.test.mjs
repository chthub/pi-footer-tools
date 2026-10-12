import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { registerTelegramNotify, notificationText } from "./installed.mjs";

const originalFetch = globalThis.fetch;
const originalToken = process.env.TELEGRAM_BOT_TOKEN;
const originalChat = process.env.TELEGRAM_CHAT_ID;
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
let agentDir;
let configPath;
let windows = [];
let sent = [];

function harness(mode = "tui") {
  const handlers = new Map();
  const shortcuts = new Map();
  const commands = new Map();
  const statuses = new Map([["other-extension", "untouched"]]);
  const warnings = [];
  // Any conversation/session/agent side effect is an error, not a silent mock.
  const ctx = { mode, ui: {
    setStatus: (key, text) => statuses.set(key, text),
    notify: (text, type) => warnings.push({ text, type }),
  }};
  registerTelegramNotify({
    on: (name, handler) => { handlers.set(name, handler); return () => handlers.delete(name); },
    registerShortcut: (key, options) => shortcuts.set(key, options),
    registerCommand: (name, options) => commands.set(name, options),
  }, { configPath });
  const fire = (name, event = {}) => handlers.get(name)?.(event, ctx);
  const toggle = () => shortcuts.get("alt+n").handler(ctx);
  const status = () => statuses.get("telegram-notify");
  const h = { handlers, shortcuts, commands, statuses, warnings, ctx, fire, toggle, status };
  windows.push(h);
  fire("session_start", { reason: "startup" });
  return h;
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
beforeEach(() => {
  const runtime = new URL("./.test-runtime/", import.meta.url);
  mkdirSync(runtime, { recursive: true });
  agentDir = mkdtempSync(join(runtime.pathname, "config-"));
  configPath = join(agentDir, "token-speed.json");
  writeFileSync(configPath, JSON.stringify({ telegramNotify: { enabled: true } }));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.TELEGRAM_BOT_TOKEN = "test-only:never-a-real-token";
  process.env.TELEGRAM_CHAT_ID = "123";
  sent = [];
  windows = [];
  globalThis.fetch = async (url, options) => {
    sent.push({ url, options, body: JSON.parse(options.body) });
    return new Response('{"ok":true}', { status: 200 });
  };
});
afterEach(async () => {
  for (const h of windows) h.fire("session_shutdown", { reason: "quit" });
  await flush();
  globalThis.fetch = originalFetch;
  if (originalToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
  else process.env.TELEGRAM_BOT_TOKEN = originalToken;
  if (originalChat === undefined) delete process.env.TELEGRAM_CHAT_ID;
  else process.env.TELEGRAM_CHAT_ID = originalChat;
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  rmSync(agentDir, { recursive: true, force: true });
});

// The real installed-loader/shortcut check lives in integration.test.mjs and
// loads the integrated package entry, not the frozen standalone extension.

test("startup OFF; other footer entries untouched; startup never sends", async () => {
  const h = harness();
  assert.equal(h.status(), "TG: OFF [Alt+N]");
  h.fire("agent_settled");
  await flush();
  assert.equal(sent.length, 0);
  assert.equal(h.statuses.get("other-extension"), "untouched");
});

test("toggle is immediate, UI-only, works without idle/agent context", () => {
  const h = harness();
  assert.equal(h.toggle(), undefined);
  assert.equal(h.status(), "TG: ON [Alt+N]");
  assert.equal(sent.length, 0);
  h.toggle();
  assert.equal(h.status(), "TG: OFF [Alt+N]");
});

test("only final settlement sends the last assistant text, never intermediate/thinking/tool content", async () => {
  const h = harness();
  h.toggle();
  assert.ok(!h.handlers.has("agent_end"));
  for (const name of ["agent_end", "session_compact", "auto_retry_start", "agent_end"]) h.fire(name);
  assert.equal(sent.length, 0);
  h.fire("message_end", { message: { role: "assistant", content: [
    { type: "text", text: "intermediate" },
  ] } });
  h.fire("message_end", { message: { role: "toolResult", content: [
    { type: "text", text: "secret tool output" },
  ] } });
  h.fire("message_end", { message: { role: "assistant", content: [
    { type: "thinking", thinking: "private reasoning" },
    { type: "text", text: "Task complete." },
    { type: "toolCall", id: "x", name: "bash", arguments: {} },
    { type: "text", text: "Final result." },
  ] } });
  assert.equal(h.fire("agent_settled"), undefined); // No network wait in handler.
  await flush();
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].body, { chat_id: "123", text: "Task complete.\nFinal result." });
  assert.equal(sent[0].options.redirect, "error");
});

test("OFF run never sends; each separate ON run sends once", async () => {
  const h = harness();
  h.toggle(); h.fire("agent_settled");
  await flush();
  h.toggle(); h.fire("agent_settled");
  await flush();
  assert.equal(sent.length, 1);
  h.toggle(); h.fire("agent_settled");
  await flush();
  assert.equal(sent.length, 2);
});

test("two independent runtimes and a fresh runtime always start OFF", () => {
  const a = harness(), b = harness();
  a.toggle();
  assert.equal(a.status(), "TG: ON [Alt+N]");
  assert.equal(b.status(), "TG: OFF [Alt+N]");
  a.fire("session_shutdown", { reason: "quit" });
  const fresh = harness();
  assert.equal(fresh.status(), "TG: OFF [Alt+N]");
});

test("missing/blank credentials never crash; ON is refused with only variable names", () => {
  delete process.env.TELEGRAM_BOT_TOKEN;
  process.env.TELEGRAM_CHAT_ID = "   ";
  const h = harness();
  assert.equal(h.status(), "TG: OFF [Alt+N] · UNCONFIGURED");
  h.toggle();
  assert.match(h.warnings[0].text, /TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID/);
  assert.match(h.status(), /OFF/);
  h.fire("agent_settled");
  assert.equal(sent.length, 0);
});

test("credentials removed while enabled: next settlement disables safely", () => {
  const h = harness();
  h.toggle();
  delete process.env.TELEGRAM_CHAT_ID;
  h.fire("agent_settled");
  assert.match(h.status(), /OFF.*UNCONFIGURED/);
  assert.equal(sent.length, 0);
});

test("network exception is caught; neither token nor raw error is shown", async () => {
  globalThis.fetch = async () => { throw new Error(process.env.TELEGRAM_BOT_TOKEN); };
  const h = harness();
  h.toggle(); h.fire("agent_settled");
  await flush();
  assert.equal(h.warnings.length, 1);
  assert.ok(!h.warnings[0].text.includes(process.env.TELEGRAM_BOT_TOKEN));
  assert.match(h.status(), /ON/);
});

test("HTTP rejection, Telegram ok:false and invalid JSON are handled without retries", async () => {
  for (const response of [
    new Response('{"ok":false,"description":"secret"}', { status: 401 }),
    new Response('{"ok":false}', { status: 200 }),
    new Response("not json", { status: 502 }),
  ]) {
    const h = harness();
    let calls = 0;
    globalThis.fetch = async () => { calls++; return response; };
    h.toggle(); h.fire("agent_settled");
    await flush();
    assert.equal(calls, 1);
    assert.equal(h.warnings.length, 1);
    assert.ok(!h.warnings[0].text.includes("secret"));
  }
});

test("OFF and shutdown abort pending fetch, silently; shutdown clears only own status", async () => {
  let signal;
  globalThis.fetch = (_url, options) => {
    signal = options.signal;
    return new Promise((_resolve, reject) =>
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
  };
  const h = harness();
  h.toggle(); h.fire("agent_settled");
  h.toggle();
  assert.ok(signal.aborted);
  await flush();
  assert.equal(h.warnings.length, 0);
  h.toggle(); h.fire("agent_settled");
  h.fire("session_shutdown", { reason: "reload" });
  assert.ok(signal.aborted);
  await flush();
  assert.equal(h.status(), undefined);
  assert.equal(h.statuses.get("other-extension"), "untouched");
  assert.equal(h.warnings.length, 0);
});

test("native fetch timeout includes response body; handler returns immediately", { timeout: 8000 }, async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.write('{"ok":'); // Headers arrive, body never completes.
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    globalThis.fetch = (_url, options) =>
      originalFetch(`http://127.0.0.1:${server.address().port}`, options);
    const h = harness();
    h.toggle();
    const start = Date.now();
    h.fire("agent_settled");
    assert.ok(Date.now() - start < 100);
    await new Promise((resolve) => setTimeout(resolve, 5300));
    assert.equal(h.warnings.length, 1);
    assert.match(h.status(), /ON/);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test("print/RPC cannot accidentally enable outbound notifications", async () => {
  for (const mode of ["print", "rpc"]) {
    const h = harness(mode);
    h.toggle(); h.fire("agent_settled");
    assert.equal(h.status(), undefined);
  }
  await flush();
  assert.equal(sent.length, 0);
});

test("/notify is local and does not require a conversation message", async () => {
  const h = harness();
  await h.commands.get("notify").handler("on", h.ctx);
  assert.match(h.status(), /ON/);
  await h.commands.get("notify").handler("status", h.ctx);
  assert.equal(sent.length, 0);
  await h.commands.get("notify").handler("off", h.ctx);
  assert.match(h.status(), /OFF/);
});

test("late failure after teardown never warns a disposed UI", async () => {
  let reject;
  globalThis.fetch = () => new Promise((_resolve, r) => { reject = r; });
  const h = harness();
  h.toggle(); h.fire("agent_settled");
  h.fire("session_shutdown", { reason: "new" });
  reject(new Error("secret"));
  await flush();
  assert.equal(h.warnings.length, 0);
});

test("new run resets final text; empty final assistant cannot leak an earlier reply", async () => {
  const h = harness();
  h.toggle();
  h.fire("before_agent_start");
  h.fire("message_end", { message: { role: "assistant", content: [{ type: "text", text: "previous reply" }] } });
  h.fire("agent_settled");
  await flush();
  h.fire("before_agent_start");
  h.fire("agent_settled");
  await flush();
  assert.equal(sent[0].body.text, "previous reply");
  assert.match(sent[1].body.text, /没有可发送的文本/);
  h.fire("message_end", { message: { role: "assistant", content: [] } });
  h.fire("agent_settled");
  await flush();
  assert.match(sent[2].body.text, /没有可发送的文本/);
});

test("Telegram character limit, surrogate-safe truncation and bot-token redaction", () => {
  assert.equal(notificationText("short answer", "secret"), "short answer");
  assert.equal(notificationText("token=secret", "secret"), "token=[REDACTED TELEGRAM TOKEN]");
  assert.equal(notificationText("url=a%3Ab", "a:b"), "url=[REDACTED TELEGRAM TOKEN]");
  const long = notificationText("😀".repeat(5000), "secret");
  assert.ok(long.length <= 4096);
  assert.match(long, /已截断/);
  assert.ok(!/[\uD800-\uDBFF]$/.test(long.split("\n\n")[0]));
});

function useFileConfig(config) {
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_CHAT_ID;
  writeFileSync(join(agentDir, "telegram-notify.json"), JSON.stringify(config), { mode: 0o600 });
}

test("JSON-only credentials work; persisted enabled is ignored; toggle never writes config", async () => {
  useFileConfig({ token: " file-token ", chatId: " -100123 ", enabled: true });
  const before = readFileSync(join(agentDir, "telegram-notify.json"), "utf8");
  const h = harness();
  assert.equal(h.status(), "TG: OFF [Alt+N]");
  assert.equal(sent.length, 0);
  h.toggle(); h.fire("agent_settled");
  await flush();
  assert.equal(sent.length, 1);
  assert.match(sent[0].url, /botfile-token\/sendMessage$/);
  assert.equal(sent[0].body.chat_id, "-100123");
  h.toggle();
  assert.equal(readFileSync(join(agentDir, "telegram-notify.json"), "utf8"), before);
});

test("environment takes precedence per field; empty environment falls back to JSON", async () => {
  useFileConfig({ token: "file-token", chatId: "file-chat" });
  process.env.TELEGRAM_BOT_TOKEN = " env-token ";
  process.env.TELEGRAM_CHAT_ID = "   ";
  const h = harness();
  h.toggle(); h.fire("agent_settled");
  await flush();
  assert.match(sent[0].url, /botenv-token\/sendMessage$/);
  assert.equal(sent[0].body.chat_id, "file-chat");
  process.env.TELEGRAM_CHAT_ID = "env-chat";
  h.fire("agent_settled");
  await flush();
  assert.equal(sent[1].body.chat_id, "env-chat");
});

test("malformed JSON is quiet; parser cannot leak token fragments", () => {
  useFileConfig({});
  writeFileSync(join(agentDir, "telegram-notify.json"), '{"token":"secret-file-token",invalid}');
  const h = harness();
  assert.match(h.status(), /OFF.*UNCONFIGURED/);
  h.toggle();
  assert.equal(h.warnings.length, 1);
  assert.match(h.warnings[0].text, /telegram-notify.json.*格式错误/);
  assert.ok(!h.warnings[0].text.includes("secret-file-token"));
  assert.equal(sent.length, 0);
});

test("invalid JSON shapes and credential types cannot crash startup or toggle", () => {
  for (const config of [null, [], "secret", { token: 12, chatId: "123" },
    { token: "secret-token", chatId: 123 }, { token: {}, chatId: true },
    { token: "secret-token", chatId: "123", receiveMessages: "yes" },
    { token: "secret-token", chatId: "123", allowedUserIds: [123] }]) {
    useFileConfig(config);
    const h = harness();
    h.toggle();
    assert.match(h.status(), /OFF.*UNCONFIGURED/);
    assert.equal(h.warnings.length, 1);
    assert.ok(!h.warnings[0].text.includes("secret-token"));
  }
});

test("unreadable JSON path does not crash; valid environment can bypass broken config", async () => {
  useFileConfig({});
  rmSync(join(agentDir, "telegram-notify.json"));
  mkdirSync(join(agentDir, "telegram-notify.json")); // EISDIR rather than readable JSON.
  const h = harness();
  h.toggle();
  assert.match(h.status(), /OFF.*UNCONFIGURED/);
  assert.equal(h.warnings.length, 1);
  process.env.TELEGRAM_BOT_TOKEN = "env-token";
  process.env.TELEGRAM_CHAT_ID = "env-chat";
  h.toggle(); h.fire("agent_settled");
  await flush();
  assert.match(h.status(), /ON/);
  assert.equal(sent.length, 1);
});

test("config is loaded at session start; reload reads new credentials but not switch state", async () => {
  useFileConfig({ token: "old-token", chatId: "old-chat" });
  const h = harness();
  useFileConfig({ token: "new-token", chatId: "new-chat", enabled: true });
  h.toggle(); h.fire("agent_settled");
  await flush();
  assert.equal(sent[0].body.chat_id, "old-chat");
  h.fire("session_shutdown", { reason: "reload" });
  const reloaded = harness();
  assert.equal(reloaded.status(), "TG: OFF [Alt+N]");
  reloaded.toggle(); reloaded.fire("agent_settled");
  await flush();
  assert.equal(sent[1].body.chat_id, "new-chat");
});

test("profile-specific user JSON is isolated; project JSON is never used", async () => {
  useFileConfig({ token: "profile-token", chatId: "profile-chat" });
  const a = harness();
  const project = join(agentDir, "project");
  mkdirSync(project);
  writeFileSync(join(project, "telegram-notify.json"),
    JSON.stringify({ token: "project-token", chatId: "project-chat" }));
  const previousCwd = process.cwd();
  try {
    process.chdir(project);
    const b = harness();
    a.toggle(); a.fire("agent_settled");
    b.toggle(); b.fire("agent_settled");
    await flush();
    assert.deepEqual(sent.map((s) => s.body.chat_id), ["profile-chat", "profile-chat"]);
    process.env.PI_CODING_AGENT_DIR = project;
    const c = harness();
    assert.equal(c.status(), "TG: OFF [Alt+N]");
    c.toggle(); c.fire("agent_settled");
    await flush();
    assert.equal(sent[2].body.chat_id, "project-chat");
  } finally {
    process.chdir(previousCwd);
  }
});
