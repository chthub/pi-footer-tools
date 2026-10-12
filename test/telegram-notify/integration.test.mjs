import assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { performance } from "node:perf_hooks";
import { after, afterEach, mock, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { createRelay } from "../../telegram-notify/relay.mjs";
// jiti snapshots named builtin imports. Install wrappers BEFORE module import,
// and keep them installed in this isolated worker through the suite. A positive
// control below verifies interception really works; after() restores the exports.
const originalRead = fs.readFileSync;
const originalSpawn = childProcess.default.spawn;
let observedReads;
let collectorLaunches = 0;
fs.readFileSync = function(path, ...args) {
  if (observedReads && String(path).endsWith("/telegram-notify.json")) {
    observedReads.fileReads++;
    throw new Error("credential file must not be opened");
  }
  return originalRead.call(this, path, ...args);
};
childProcess.default.spawn = function(...args) {
  if (args[0] === "flock") {
    collectorLaunches++;
    throw new Error("real collector forbidden in tests");
  }
  return Reflect.apply(originalSpawn, this, args);
};
syncBuiltinESMExports();
const { hostImport, integratedFactory, integratedPath, piPackage, registerTelegramNotify } = await import("./installed.mjs");
after(() => {
  fs.readFileSync = originalRead;
  childProcess.default.spawn = originalSpawn;
  syncBuiltinESMExports();
});

const flush = () => new Promise(resolve => setImmediate(resolve));
afterEach(() => { mock.restoreAll(); syncBuiltinESMExports(); });
function fixture(t, config = {}) {
  const dir = fs.mkdtempSync(join(tmpdir(), "pi-tg-integrated-"));
  const configPath = join(dir, "footer-tools.json");
  fs.writeFileSync(configPath, JSON.stringify({ cacheDiagnostics: { enabledByDefault: false }, ...config }));
  const names = ["PI_FOOTER_TOOLS_CONFIG", "PI_CODING_AGENT_DIR", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"];
  const before = Object.fromEntries(names.map(name => [name, process.env[name]]));
  process.env.PI_FOOTER_TOOLS_CONFIG = configPath;
  process.env.PI_CODING_AGENT_DIR = dir;
  process.env.TELEGRAM_BOT_TOKEN = "test-only:integrated-token";
  process.env.TELEGRAM_CHAT_ID = "123";
  const originalFetch = globalThis.fetch;
  const sent = [], windows = [];
  globalThis.fetch = async (url, options) => {
    sent.push({ url, options, body: JSON.parse(options.body) });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 11 } }));
  };
  t.after(async () => {
    for (const h of windows) await h.fire("session_shutdown", { reason: "quit" });
    await flush();
    globalThis.fetch = originalFetch;
    for (const [name, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, configPath, sent, windows };
}
function harness(f, mode = "tui", standalone = false) {
  const handlers = new Map(), shortcuts = new Map(), commands = new Map();
  const statuses = new Map([["other-extension", "untouched"]]);
  const writes = [], notices = [], prompts = [];
  const ctx = { mode, hasUI: mode === "tui", ui: {
    setStatus(key, value) { statuses.set(key, value); writes.push([key, value]); },
    notify(text, type) { notices.push({ text, type }); },
  } };
  const api = {
    on(name, fn) {
      const list = handlers.get(name) ?? [];
      list.push(fn); handlers.set(name, list);
      return () => { const index = list.indexOf(fn); if (index >= 0) list.splice(index, 1); };
    },
    registerShortcut: (key, value) => shortcuts.set(key, value),
    registerCommand: (key, value) => commands.set(key, value),
    registerFlag() {}, getFlag() { return false; },
    sendUserMessage(text, options) { prompts.push({ text, options }); },
  };
  if (standalone) registerTelegramNotify(api, { configPath: f.configPath });
  else integratedFactory(api);
  const h = { ctx, handlers, shortcuts, commands, statuses, notices, writes, prompts,
    async fire(name, event = {}) { for (const fn of [...handlers.get(name) ?? []]) await fn(event, ctx); },
    toggle: () => shortcuts.get("alt+n").handler(ctx),
    command: args => commands.get("notify").handler(args, ctx),
  };
  f.windows.push(h);
  return h;
}
function guardCredentials() {
  const counts = { fileReads: 0, envReads: 0 };
  observedReads = counts;
  const originalEnv = process.env;
  process.env = new Proxy(originalEnv, { get(target, key) {
    if (key === "TELEGRAM_BOT_TOKEN" || key === "TELEGRAM_CHAT_ID") counts.envReads++;
    return target[key];
  } });
  return { counts: () => ({ ...counts }), restore: () => {
    process.env = originalEnv;
    observedReads = undefined;
  } };
}
const assistant = (text, output = 500) => ({ message: { role: "assistant", content: [{ type: "text", text }], usage: { output }, stopReason: "stop" } });

async function speedRun(h) {
  await h.fire("turn_start");
  await h.fire("message_update", { message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", delta: "reply" } });
  await h.fire("message_end", assistant("final answer"));
}

test("main entry default off adds no Telegram commands, shortcuts, status, handlers or credential access", async t => {
  const f = fixture(t);
  const off = harness(f);
  assert.equal(off.commands.has("notify"), false);
  assert.equal(off.shortcuts.size, 0);
  assert.equal(off.handlers.has("agent_settled"), false);
  assert.equal(off.handlers.has("before_agent_start"), false);
  for (const name of ["message_end", "session_start", "session_shutdown"]) {
    // Speed (and the pre-existing diagnostics lifecycle) remain registered.
    assert.ok(off.handlers.has(name));
  }
  const signature = [...off.handlers].map(([name, list]) => [name, list.length]);
  fs.writeFileSync(f.configPath, '{"telegramNotify":{"enabled":false}}');
  const explicitOff = harness(f);
  assert.deepEqual([...explicitOff.handlers].map(([name, list]) => [name, list.length]), signature);
  const guard = guardCredentials();
  try {
    await off.fire("session_start");
    await speedRun(off);
    assert.match(off.statuses.get("footer-tools.token-speed"), /^Avg /);
    await off.fire("agent_settled");
    await off.fire("session_shutdown", { reason: "reload" });
    assert.deepEqual(guard.counts(), { fileReads: 0, envReads: 0 });
  } finally { guard.restore(); }
  assert.equal(off.statuses.has("footer-tools.tui.telegram-notify"), false);
  assert.equal(off.statuses.get("footer-tools.token-speed"), undefined);
  assert.equal(off.statuses.get("other-extension"), "untouched");
  assert.equal(f.sent.length, 0);
});

test("installed Pi loads integrated enabled entry; Alt+N has no default key conflict", async t => {
  fixture(t, { telegramNotify: { enabled: true } });
  t.diagnostic(`Installed Pi ${piPackage.version} (migration verified against 1.1.0)`);
  assert.equal(piPackage.name, "@earendil-works/pi-coding-agent");
  const { loadExtensions } = await hostImport("dist/core/extensions/loader.js");
  const result = await loadExtensions([integratedPath], process.cwd());
  assert.deepEqual(result.errors, []);
  assert.equal(result.extensions.length, 1);
  const ext = result.extensions[0];
  assert.equal(ext.tools.size, 0);
  assert.ok(ext.commands.has("notify"));
  assert.ok(ext.commands.has("cache-diagnostics"));
  assert.ok(ext.handlers.has("turn_start"));
  assert.ok(ext.handlers.has("agent_settled"));
  const { ExtensionRunner } = await hostImport("dist/core/extensions/runner.js");
  const { KEYBINDINGS } = await hostImport("dist/core/keybindings.js");
  const builtin = Object.values(KEYBINDINGS).flatMap(v => typeof v.defaultKeys === "string" ? [v.defaultKeys] : v.defaultKeys ?? []);
  assert.ok(builtin.includes("ctrl+n"));
  assert.ok(!builtin.includes("alt+n"));
  const runner = { extensions: result.extensions, hasUI: () => true };
  const shortcuts = ExtensionRunner.prototype.getShortcuts.call(runner,
    Object.fromEntries(Object.entries(KEYBINDINGS).map(([id, value]) => [id, value.defaultKeys])));
  assert.ok(shortcuts.has("alt+n"));
  assert.deepEqual(runner.shortcutDiagnostics, []);
});

test("real loader default off creates no Telegram resources even with legacy credential enabled field", async t => {
  const f = fixture(t);
  fs.writeFileSync(join(f.dir, "telegram-notify.json"), '{"enabled":true,"token":"secret","chatId":"123"}');
  const { loadExtensions } = await hostImport("dist/core/extensions/loader.js");
  const result = await loadExtensions([integratedPath], process.cwd());
  assert.deepEqual(result.errors, []);
  const ext = result.extensions[0];
  assert.equal(ext.commands.has("notify"), false);
  assert.equal(ext.shortcuts.size, 0);
  assert.equal(ext.handlers.has("agent_settled"), false);
});

test("footer status order keeps Telegram after speed and before LSP", async t => {
  const f = fixture(t, { telegramNotify: { enabled: true } });
  const h = harness(f);
  await h.fire("session_start");
  await speedRun(h);
  h.statuses.set("lsp", "LSP: 0/7 servers");
  h.statuses.set("context-cost", "Cache read $0.0006 | Cold start $0.1250");
  h.statuses.set("account-switch", "pi");
  // Match Pi's footer renderer: localeCompare on keys, not registration order.
  const ordered = [...h.statuses.entries()]
    .filter(([key]) => key !== "other-extension")
    .sort(([a], [b]) => a.localeCompare(b));
  assert.deepEqual(ordered.map(([, text]) => text), [
    "pi",
    "Cache read $0.0006 | Cold start $0.1250",
    h.statuses.get("footer-tools.token-speed"),
    "TG: OFF [Alt+N]",
    "LSP: 0/7 servers",
  ]);
  assert.equal(f.sent.length, 0);
});

test("enabled main entry composes both message_end handlers and speed/TG statuses without transcript effects", async t => {
  const f = fixture(t, { telegramNotify: { enabled: true } });
  let now = 1000;
  mock.method(performance, "now", () => now);
  const h = harness(f);
  await h.fire("session_start");
  assert.equal(h.statuses.get("footer-tools.tui.telegram-notify"), "TG: OFF [Alt+N]");
  assert.equal(h.handlers.get("message_end").length, 2);
  h.toggle();
  await h.fire("before_agent_start");
  await h.fire("turn_start");
  await h.fire("message_update", { message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", delta: "reply" } });
  now = 11000;
  await h.fire("message_end", assistant("final answer"));
  assert.equal(h.statuses.get("footer-tools.token-speed"), "Avg 50.0 tok/s");
  assert.equal(h.statuses.get("footer-tools.tui.telegram-notify"), "TG: ON [Alt+N]");
  await h.fire("agent_end");
  assert.equal(f.sent.length, 0);
  await h.fire("agent_settled");
  await flush();
  assert.deepEqual(f.sent[0].body, { chat_id: "123", text: "final answer" });
  assert.deepEqual(h.prompts, []);
  assert.equal(h.statuses.get("other-extension"), "untouched");
  await h.command("off");
  assert.equal(h.statuses.get("footer-tools.token-speed"), "Avg 50.0 tok/s");
});

test("invalid capability warns exactly once in TUI and never quotes private content or reads credentials", async t => {
  const f = fixture(t);
  fs.writeFileSync(f.configPath, '{"telegramNotify":{"enabled":"secret-do-not-echo"}}');
  const h = harness(f, "tui", true);
  assert.equal(h.commands.size, 0);
  assert.equal(h.shortcuts.size, 0);
  assert.deepEqual([...h.handlers.keys()], ["session_start"]);
  const guard = guardCredentials();
  try {
    h.ctx.mode = "rpc";
    await h.fire("session_start");
    assert.equal(h.notices.length, 0);
    h.ctx.mode = "tui";
    await h.fire("session_start");
    await h.fire("session_start", { reason: "reload" });
    assert.deepEqual(guard.counts(), { fileReads: 0, envReads: 0 });
  } finally { guard.restore(); }
  assert.equal(h.notices.length, 1);
  assert.equal(h.notices[0].type, "warning");
  assert.match(h.notices[0].text, /telegramNotify/);
  assert.ok(!h.notices[0].text.includes("secret-do-not-echo"));
  assert.equal(h.writes.length, 0);
});

test("credential-access guard observes enabled TUI reads; registration itself is credential-free", async t => {
  const f = fixture(t, { telegramNotify: { enabled: true } });
  const guard = guardCredentials();
  try {
    const h = harness(f);
    assert.deepEqual(guard.counts(), { fileReads: 0, envReads: 0 });
    await h.fire("session_start");
    assert.equal(guard.counts().fileReads, 1);
    assert.ok(guard.counts().envReads >= 2);
    assert.equal(h.statuses.get("footer-tools.tui.telegram-notify"), "TG: OFF [Alt+N]");
  } finally { guard.restore(); }
});

test("enabled nonTUI lifecycle and commands perform no credential reads, UI writes or Telegram calls", async t => {
  const f = fixture(t, { telegramNotify: { enabled: true } });
  const guard = guardCredentials();
  try {
    for (const mode of ["rpc", "print", "json"]) {
      const h = harness(f, mode);
      await h.fire("session_start");
      h.toggle();
      await h.command("on");
      await h.command("status");
      await h.fire("before_agent_start");
      await speedRun(h);
      await h.fire("message_end", { message: { role: "assistant", get content() {
        throw new Error("nonTUI Telegram must not retain assistant text");
      } } });
      await h.fire("agent_settled");
      await h.fire("session_shutdown");
      assert.deepEqual(h.writes, []);
      assert.deepEqual(h.notices, []);
      assert.deepEqual(h.prompts, []);
    }
    assert.deepEqual(guard.counts(), { fileReads: 0, envReads: 0 });
  } finally { guard.restore(); }
  assert.equal(f.sent.length, 0);
});

test("reload aborts old delivery, clears only own statuses and applies capability change", async t => {
  const f = fixture(t, { telegramNotify: { enabled: true } });
  const h = harness(f);
  await h.fire("session_start");
  h.toggle();
  let signal, reject;
  globalThis.fetch = (_url, options) => {
    signal = options.signal;
    return new Promise((_resolve, r) => { reject = r; });
  };
  await h.fire("agent_settled");
  fs.writeFileSync(f.configPath, '{"telegramNotify":{"enabled":false}}');
  await h.fire("session_shutdown", { reason: "reload" });
  assert.ok(signal.aborted);
  reject(new Error("secret-late-error"));
  await flush();
  assert.equal(h.notices.length, 0);
  assert.equal(h.statuses.get("footer-tools.tui.telegram-notify"), undefined);
  assert.equal(h.statuses.get("footer-tools.token-speed"), undefined);
  assert.equal(h.statuses.get("other-extension"), "untouched");
  await h.fire("message_end", { message: { role: "assistant", get content() {
    throw new Error("disposed Telegram must not retain assistant text");
  } } });
  const fresh = harness(f);
  await fresh.fire("session_start");
  assert.equal(fresh.commands.has("notify"), false);
  assert.equal(fresh.shortcuts.size, 0);
  assert.equal(fresh.statuses.has("footer-tools.tui.telegram-notify"), false);
  await h.fire("agent_settled");
  assert.equal(f.sent.length, 0);
});

async function wait(predicate, label) {
  const end = Date.now() + 4000;
  while (Date.now() < end) {
    if (predicate()) return;
    await sleep(10);
  }
  assert.fail(label);
}

test("integrated reception remembers sent IDs; Telegram slash replies remain follow-up model text, OFF tears route down", async t => {
  const f = fixture(t, { telegramNotify: { enabled: true } });
  const token = `test-only:${f.dir}`;
  process.env.TELEGRAM_BOT_TOKEN = token;
  fs.writeFileSync(join(f.dir, "telegram-notify.json"), JSON.stringify({ receiveMessages: true }));
  // The import-time spawn wrapper above forbids real collector launch, including
  // on an unexpected fixture disconnect; do not remove the shared IPC directory.
  collectorLaunches = 0;
  const digest = createHash("sha256").update(token).digest("hex");
  const ipc = join(tmpdir(), `pi-telegram-${process.getuid()}`);
  fs.mkdirSync(ipc, { mode: 0o700, recursive: true });
  const socketPath = join(ipc, digest.slice(0, 20) + ".sock");
  const pending = [];
  const relay = await createRelay({ socketPath, tokenHash: digest, initialIdleMs: 30000,
    fetchImpl: async (_url, options) => {
      await sleep(20, undefined, { signal: options.signal });
      return new Response(JSON.stringify({ ok: true, result: pending.splice(0) }));
    },
  });
  const h = harness(f);
  try {
    await h.fire("session_start");
    h.toggle();
    await wait(() => h.statuses.get("footer-tools.tui.telegram-notify").includes("RX:READY"), "receiver ready");
    await h.fire("message_end", assistant("notification reply target"));
    await h.fire("agent_settled");
    await flush();
    const update = (id, reply, text, sender = 123) => ({ update_id: id, message: {
      text, chat: { id: 123, type: "private" }, from: { id: sender, is_bot: false },
      reply_to_message: { message_id: reply },
    } });
    pending.push(update(1, 999, "unknown route"), update(2, 11, "wrong sender", 999), update(3, 11, "/new"));
    await wait(() => h.prompts.length === 1, "slash reply delivered");
    assert.deepEqual(h.prompts, [{ text: "/new", options: { deliverAs: "followUp", expandPromptTemplates: false } }]);
    h.toggle();
    pending.push(update(4, 11, "after OFF"));
    await sleep(80);
    assert.equal(h.prompts.length, 1);
    assert.equal(h.statuses.get("footer-tools.tui.telegram-notify"), "TG: OFF [Alt+N]");
    assert.equal(collectorLaunches, 0);
  } finally {
    await h.fire("session_shutdown", { reason: "reload" });
    await relay.close();
    fs.rmSync(socketPath, { force: true });
  }
});
