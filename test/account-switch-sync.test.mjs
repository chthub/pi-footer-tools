import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

let root = dirname(realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim()));
while (!existsSync(join(root, "package.json"))) root = dirname(root);
const { createJiti } = createRequire(join(root, "package.json"))("jiti");
const loader = createJiti(import.meta.url, { alias: { "@earendil-works/pi-coding-agent": join(root, "dist/index.js") } });
const { attachRouting, attachFollowingRouting } = await loader.import(new URL("../account-switch/routing.ts", import.meta.url).pathname);
const { createAccountChannel, readAccountChannel, registerChildLaunch, CHILD_LAUNCH_EVENT, CHANNEL_ENV } = await loader.import(new URL("../account-switch/channel.ts", import.meta.url).pathname);
const { registerChildAccountRouting } = await loader.import(new URL("../account-switch/child-extension.ts", import.meta.url).pathname);
const { registerAccountSwitch } = await loader.import(new URL("../account-switch/index.ts", import.meta.url).pathname);
const { ModelRuntime, ModelRegistry, createEventBus } = await import(pathToFileURL(join(root, "dist/index.js")).href);
const PROVIDER = "openai-codex";
const oauth = name => ({ type: "oauth", access: `access-${name}`, refresh: `refresh-${name}`, expires: Date.now() + 3600000, accountId: `id-${name}` });

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), "pi-account-sync-test-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const accounts = ["personal", "backup"].map(name => ({ name, agentDir: join(home, name) }));
  const selected = name => ({ name, authPath: join(home, name, "auth.json") });
  for (const { name, agentDir } of accounts) {
    mkdirSync(agentDir);
    writeFileSync(selected(name).authPath, JSON.stringify({ [PROVIDER]: oauth(name), unrelated: { type: "api_key", key: `key-${name}` } }), { mode: 0o600 });
  }
  const configPath = join(home, "config.json");
  writeFileSync(configPath, JSON.stringify({ accountSwitch: { enabled: true, accounts } }));
  return { home, accounts, selected, agentDir: accounts[0].agentDir, configPath };
}
async function runtimeFor(f) {
  const runtime = await ModelRuntime.create({ authPath: f.selected("personal").authPath, modelsPath: null, modelsStorePath: join(f.home, "models-store.json"), refreshOnCreate: false });
  return { runtime, registry: new ModelRegistry(runtime) };
}
function channelFor(t, f) {
  const channel = createAccountChannel(f.selected("personal"));
  t.after(() => channel.close());
  return channel;
}
function apiHarness(registry, mode = "rpc") {
  const handlers = new Map(), commands = new Map(), notices = [];
  let shutdown = false;
  const events = createEventBus();
  const pi = { events, on: (name, fn) => handlers.set(name, fn), registerCommand: (name, command) => commands.set(name, command) };
  const ctx = {
    modelRegistry: registry, mode, hasUI: mode === "tui", model: { provider: PROVIDER },
    isIdle: () => true, hasPendingMessages: () => false, shutdown: () => { shutdown = true; },
    ui: { theme: { fg: (_, value) => value }, setStatus() {}, notify: (text, level) => notices.push({ text, level }) },
  };
  return { pi, events, ctx, notices, commands, stopped: () => shutdown, fire: (name, event = {}) => handlers.get(name)?.(event, ctx) };
}
function launch(events) {
  const request = { env: {}, extensions: [] };
  events.emit(CHILD_LAUNCH_EVENT, request);
  return request;
}
const token = async runtime => (await runtime.getAuth(PROVIDER)).auth.apiKey;

function rpcChild(t, f, request, model, sessionPath) {
  const args = [join(root, "dist/cli.js"), "--mode", "rpc", "--offline", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-tools", "--model", `${PROVIDER}/${model.id}`, "--thinking", "low"];
  for (const path of [...request.extensions, new URL("./fixtures/account-sync-provider.ts", import.meta.url).pathname]) args.push("--extension", path);
  if (sessionPath) args.push("--session", sessionPath);
  else args.push("--session-dir", join(f.home, "child-sessions"));
  const proc = spawn(process.execPath, args, {
    cwd: f.home,
    env: { PATH: process.env.PATH, HOME: f.home, PI_CODING_AGENT_DIR: f.agentDir, PI_OFFLINE: "1", NODE_OPTIONS: `--import=${new URL("./fixtures/account-sync-offline.mjs", import.meta.url).href}`, ...request.env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const events = new EventEmitter(), history = [];
  let buffer = "", stderr = "", sequence = 0;
  proc.stdout.setEncoding("utf8"); proc.stderr.setEncoding("utf8");
  proc.stdout.on("data", chunk => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (!line.trim()) continue;
      try { const event = JSON.parse(line); history.push(event); events.emit("record", event); }
      catch { stderr += line; }
    }
  });
  proc.stderr.on("data", chunk => { stderr += chunk; });
  const wait = (match, operation = () => {}) => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error(`RPC timeout: ${stderr}`)), 15000);
    const listener = event => { if (match(event)) finish(undefined, event); };
    const exit = () => finish(new Error(`RPC child exited: ${stderr}`));
    function finish(error, result) { clearTimeout(timeout); events.off("record", listener); proc.off("exit", exit); error ? reject(error) : resolve(result); }
    events.on("record", listener); proc.once("exit", exit); operation();
  });
  const command = (type, fields = {}) => {
    const id = String(++sequence);
    return wait(event => event.type === "response" && event.id === id, () => proc.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`));
  };
  const close = async () => {
    if (proc.exitCode !== null || proc.signalCode !== null) return;
    const exited = once(proc, "exit"); proc.stdin.end();
    const timer = setTimeout(() => proc.kill("SIGKILL"), 2000);
    await exited; clearTimeout(timer);
  };
  t.after(close);
  return { command, close, history, turn: async message => {
    const settled = wait(event => event.type === "agent_settled");
    const response = await command("prompt", { message });
    assert.equal(response.success, true, JSON.stringify(response));
    await settled;
    return history.filter(event => event.type === "message_end" && event.message.role === "assistant").at(-1).message;
  } };
}

test("channel is private, atomic, token-free, and scoped to one window", t => {
  const f = fixture(t), a = channelFor(t, f), b = channelFor(t, f);
  assert.notEqual(a.path, b.path);
  assert.equal(statSync(dirname(a.path)).mode & 0o777, 0o700);
  assert.equal(statSync(a.path).mode & 0o777, 0o600);
  a.publish(f.selected("backup"));
  assert.deepEqual(readAccountChannel(a.path), f.selected("backup"));
  assert.deepEqual(readAccountChannel(b.path), f.selected("personal"));
  assert.doesNotMatch(readFileSync(a.path, "utf8"), /access-|refresh-|accountId/);
  assert.equal(existsSync(join(dirname(a.path), "selection.next")), false);
  a.close();
  assert.throws(() => readAccountChannel(a.path), /synchronization unavailable/);
});

test("invalid, public, symlink and missing channels fail closed with sanitized errors", t => {
  const f = fixture(t), channel = channelFor(t, f);
  for (const content of ["{", "null", JSON.stringify({ version: 2, ...f.selected("backup") }), JSON.stringify({ version: 1, name: "x", authPath: "relative" })]) {
    writeFileSync(channel.path, content);
    assert.throws(() => readAccountChannel(channel.path), error => error.message.includes("synchronization unavailable") && !error.message.includes(channel.path));
  }
  channel.publish(f.selected("backup"));
  chmodSync(channel.path, 0o644);
  assert.throws(() => readAccountChannel(channel.path));
  rmSync(channel.path);
  symlinkSync(f.selected("backup").authPath, channel.path);
  assert.throws(() => readAccountChannel(channel.path));
  assert.throws(() => readAccountChannel("relative"));
});

test("main command publishes account switches to existing, newly attached and revived child runtimes", async t => {
  const f = fixture(t), main = await runtimeFor(f), h = apiHarness(main.registry, "tui");
  registerAccountSwitch(h.pi, f);
  h.fire("session_start");
  t.after(() => h.fire("session_shutdown"));
  const request = launch(h.events), path = request.env[CHANNEL_ENV];
  assert.ok(path);
  assert.match(request.extensions[0], /child-extension\.ts$/);
  const before = process.env[CHANNEL_ENV];
  const children = [await runtimeFor(f), await runtimeFor(f)];
  for (const child of children) {
    child.h = apiHarness(child.registry);
    registerChildAccountRouting(child.h.pi, path);
    child.h.fire("session_start");
    t.after(() => child.h.fire("session_shutdown"));
    assert.equal(await token(child.runtime), "access-personal");
  }
  await h.commands.get("switch-account").handler("backup", h.ctx);
  assert.equal(await token(main.runtime), "access-backup");
  for (const child of children) {
    assert.equal(await token(child.runtime), "access-backup");
    assert.equal((await child.runtime.credentials.read("unrelated")).key, "key-personal");
    assert.deepEqual(launch(child.h.events), request, "grandchildren inherit the same window channel");
  }
  const revived = await runtimeFor(f), revivedHarness = apiHarness(revived.registry);
  registerChildAccountRouting(revivedHarness.pi, launch(h.events).env[CHANNEL_ENV]);
  revivedHarness.fire("session_start");
  t.after(() => revivedHarness.fire("session_shutdown"));
  assert.equal(await token(revived.runtime), "access-backup");
  assert.equal(process.env[CHANNEL_ENV], before, "no global environment mutation");
});

test("follower routes actual provider requests without changing model, context or thinking options", async t => {
  const f = fixture(t), channel = channelFor(t, f), { runtime, registry } = await runtimeFor(f);
  const { createAssistantMessageEventStream } = await import(pathToFileURL(join(root, "node_modules/@earendil-works/pi-ai/dist/index.js")).href);
  const calls = [], base = runtime.getProvider(PROVIDER);
  runtime.registerNativeProvider({ ...base, streamSimple(model, context, options) {
    calls.push({ model, context, options });
    const stream = createAssistantMessageEventStream();
    const message = { role: "assistant", content: [{ type: "text", text: "synthetic reply" }], api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    stream.push({ type: "done", reason: "stop", message }); stream.end(message); return stream;
  } });
  const follower = attachFollowingRouting(registry, () => readAccountChannel(channel.path));
  t.after(() => follower.detach());
  const model = registry.getAll().find(value => value.provider === PROVIDER);
  const context = { messages: [{ role: "user", content: "same saved conversation", timestamp: 1 }] };
  await registry.streamSimple(model, context, { reasoning: "high", maxTokens: 42 }).result();
  channel.publish(f.selected("backup"));
  await registry.streamSimple(model, context, { reasoning: "high", maxTokens: 42 }).result();
  assert.deepEqual(calls.map(call => call.options.apiKey), ["access-personal", "access-backup"]);
  assert.deepEqual(calls[0].context, calls[1].context);
  assert.equal(calls[0].model.id, calls[1].model.id);
  assert.equal(calls[1].options.reasoning, "high");
  assert.equal(calls[1].options.maxTokens, 42);
});

test("switch during child OAuth refresh writes back only to the account whose lock it holds", async t => {
  const f = fixture(t), channel = channelFor(t, f), { runtime, registry } = await runtimeFor(f);
  const path = f.selected("personal").authPath;
  const originalBackup = readFileSync(f.selected("backup").authPath, "utf8");
  const data = JSON.parse(readFileSync(path, "utf8")); data[PROVIDER].expires = 1; writeFileSync(path, JSON.stringify(data));
  let unblock, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const blocked = new Promise(resolve => { unblock = resolve; });
  const base = runtime.getProvider(PROVIDER);
  runtime.registerNativeProvider({ ...base, auth: { oauth: { ...base.auth.oauth,
    async refresh(credential) { entered(); await blocked; return { ...credential, access: "rotated-personal", refresh: "rotated-refresh", expires: Date.now() + 3600000 }; },
    async toAuth(credential) { return { apiKey: credential.access }; },
  } } });
  const follower = attachFollowingRouting(registry, () => readAccountChannel(channel.path)); t.after(() => follower.detach());
  const pending = token(runtime);
  await started;
  channel.publish(f.selected("backup"));
  unblock();
  assert.equal(await pending, "rotated-personal");
  assert.equal(JSON.parse(readFileSync(path, "utf8"))[PROVIDER].refresh, "rotated-refresh");
  assert.equal(readFileSync(f.selected("backup").authPath, "utf8"), originalBackup);
  assert.equal(await token(runtime), "access-backup");
});

test("failed publication rolls back main selection and leaves child selection unchanged", async t => {
  const f = fixture(t), channel = channelFor(t, f), main = await runtimeFor(f), child = await runtimeFor(f);
  const route = attachRouting(main.registry, f.agentDir, f.accounts);
  const follower = attachFollowingRouting(child.registry, () => readAccountChannel(channel.path));
  t.after(() => { route.detach(); follower.detach(); });
  await assert.rejects(route.switchTo("backup", () => true, () => { throw new Error("synthetic publication failure"); }));
  assert.equal(route.name, "personal");
  assert.equal(await token(main.runtime), "access-personal");
  assert.equal(await token(child.runtime), "access-personal");
});

test("channel failures block Codex instead of falling back, and launch errors are explicit", async t => {
  const f = fixture(t), channel = channelFor(t, f), child = await runtimeFor(f);
  const follower = attachFollowingRouting(child.registry, () => readAccountChannel(channel.path)); t.after(() => follower.detach());
  channel.close();
  await assert.rejects(token(child.runtime));
  assert.equal((await child.runtime.credentials.read("unrelated")).key, "key-personal");
  const events = createEventBus();
  const unsubscribe = registerChildLaunch({ events }, () => channel.path);
  assert.match(launch(events).error, /synchronization unavailable/);
  unsubscribe();
  assert.deepEqual(launch(events), { env: {}, extensions: [] });
});

test("ordinary RPC/print/JSON runs never attach; incompatible opted-in child requests shutdown", async t => {
  const f = fixture(t), channel = channelFor(t, f);
  for (const mode of ["rpc", "print", "json", "tui"]) {
    const h = apiHarness(new Proxy({}, { get() { throw new Error("must not access runtime"); } }), mode);
    registerChildAccountRouting(h.pi, mode === "rpc" ? "" : channel.path);
    h.fire("session_start");
    assert.deepEqual(launch(h.events), { env: {}, extensions: [] });
    assert.equal(h.stopped(), false);
  }
  const invalid = apiHarness({});
  registerChildAccountRouting(invalid.pi, channel.path);
  assert.throws(() => invalid.fire("session_start"), /synchronization unavailable/);
  assert.equal(invalid.stopped(), true);
});

test("failed child attachment denies launch credentials even while orderly shutdown is pending", async t => {
  const f = fixture(t), channel = channelFor(t, f), { runtime, registry } = await runtimeFor(f);
  channel.close();
  const h = apiHarness(registry);
  registerChildAccountRouting(h.pi, channel.path);
  assert.throws(() => h.fire("session_start"), /synchronization unavailable/);
  assert.equal(h.stopped(), true);
  await assert.rejects(token(runtime));
  assert.equal((await runtime.credentials.read("unrelated")).key, "key-personal");
  assert.equal((await runtime.listCredentials()).some(entry => entry.providerId === PROVIDER), false);
});

test("opted-in child initialization rejects and removes a conflicting runtime key", async t => {
  const f = fixture(t), channel = channelFor(t, f), { runtime, registry } = await runtimeFor(f);
  runtime.credentials.setRuntimeApiKey(PROVIDER, "synthetic-override");
  const h = apiHarness(registry);
  registerChildAccountRouting(h.pi, channel.path);
  assert.throws(() => h.fire("session_start"), /synchronization unavailable/);
  assert.equal(h.stopped(), true);
  await assert.rejects(token(runtime));
});

test("reload during a pending switch publishes only committed selection and stale owner cannot roll back", async t => {
  const f = fixture(t), { runtime, registry } = await runtimeFor(f), first = attachRouting(registry, f.agentDir, f.accounts);
  const oldChannel = channelFor(t, f);
  let entered, unblock, count = 0;
  const started = new Promise(resolve => { entered = resolve; });
  const blocked = new Promise(resolve => { unblock = resolve; });
  const refresh = registry.refresh.bind(registry);
  registry.refresh = async options => {
    if (++count === 1) { entered(); await blocked; return { aborted: false, errors: new Map() }; }
    return refresh(options);
  };
  const switching = first.switchTo("backup", () => true, oldChannel.publish);
  const rejected = assert.rejects(switching, /refresh-failed/);
  await started;
  first.detach(true);
  const next = attachRouting(registry, f.agentDir, f.accounts);
  const nextChannel = createAccountChannel(next.selection);
  t.after(() => { next.detach(); nextChannel.close(); });
  assert.deepEqual(readAccountChannel(nextChannel.path), f.selected("personal"));
  await next.switchTo("backup", () => true, nextChannel.publish);
  unblock(); await rejected;
  assert.equal(await token(runtime), "access-backup");
  assert.deepEqual(readAccountChannel(nextChannel.path), f.selected("backup"));
  assert.deepEqual(readAccountChannel(oldChannel.path), f.selected("personal"));
});

test("shutdown removes channel and launch listener; reload restores account into a fresh channel", async t => {
  const f = fixture(t), { runtime, registry } = await runtimeFor(f);
  const h = apiHarness(registry, "tui"); registerAccountSwitch(h.pi, f); h.fire("session_start");
  await h.commands.get("switch-account").handler("backup", h.ctx);
  const first = launch(h.events).env[CHANNEL_ENV];
  h.fire("session_shutdown", { reason: "reload" });
  assert.equal(existsSync(first), false);
  assert.deepEqual(launch(h.events), { env: {}, extensions: [] });
  const reloaded = apiHarness(registry, "tui"); registerAccountSwitch(reloaded.pi, f); reloaded.fire("session_start");
  t.after(() => reloaded.fire("session_shutdown"));
  const next = launch(reloaded.events).env[CHANNEL_ENV];
  assert.notEqual(first, next);
  assert.deepEqual(readAccountChannel(next), f.selected("backup"));
  assert.equal(await token(runtime), "access-backup");
});

test("real RPC child continues after quota error and revived session follows the same parent channel", { timeout: 45000 }, async t => {
  const f = fixture(t), main = await runtimeFor(f), h = apiHarness(main.registry, "tui");
  registerAccountSwitch(h.pi, f); h.fire("session_start");
  t.after(() => h.fire("session_shutdown"));
  const model = main.registry.getAll().find(value => value.provider === PROVIDER);
  const child = rpcChild(t, f, launch(h.events), model);
  assert.equal((await child.command("get_state")).success, true);
  const failed = await child.turn("quota");
  assert.equal(failed.stopReason, "error");
  assert.match(failed.errorMessage, /Synthetic account quota exceeded/);
  await h.commands.get("switch-account").handler("backup", h.ctx);
  const continued = await child.turn("continue without restarting");
  assert.equal(continued.stopReason, "stop");
  assert.equal(continued.content[0].text, "access-backup;users=2");
  const state = (await child.command("get_state")).data;
  assert.equal(state.model.id, model.id);
  assert.equal(state.thinkingLevel, "low");
  assert.ok(state.sessionFile);
  await child.close();
  await h.commands.get("switch-account").handler("personal", h.ctx);
  const revived = rpcChild(t, f, launch(h.events), model, state.sessionFile);
  const resumed = await revived.turn("normal saved conversation continuation");
  // The fixture keeps the first quota-triggering message in the transcript,
  // so switching back proves restoration by the expected synthetic error.
  assert.equal(resumed.stopReason, "error");
  assert.equal(resumed.content[0].text, "access-personal;users=3");
  await h.commands.get("switch-account").handler("backup", h.ctx);
  const recovered = await revived.turn("continue revived child");
  assert.equal(recovered.content[0].text, "access-backup;users=4");
  await revived.close();
});
