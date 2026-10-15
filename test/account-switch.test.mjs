import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

let root = dirname(realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim()));
while (!existsSync(join(root, "package.json"))) root = dirname(root);
const hostRequire = createRequire(join(root, "package.json"));
const { createJiti } = hostRequire("jiti");
const loader = createJiti(import.meta.url, { alias: { "@earendil-works/pi-coding-agent": join(root, "dist/index.js") } });
const { loadAccountSwitchConfig } = await loader.import(new URL("../account-switch/config.ts", import.meta.url).pathname);
const { resolveConfigPath, DEFAULT_CONFIG_PATH } = await loader.import(new URL("../config-path.ts", import.meta.url).pathname);
const { attachRouting, accountPath, accountName } = await loader.import(new URL("../account-switch/routing.ts", import.meta.url).pathname);
const { registerAccountSwitch } = await loader.import(new URL("../account-switch/index.ts", import.meta.url).pathname);
const { ModelRuntime, ModelRegistry, createEventBus } = await import(pathToFileURL(join(root, "dist/index.js")).href);
const PROVIDER = "openai-codex";
const ACCOUNT_NAMES = ["default", "work", "backup", "personal"];
const profiles = home => ACCOUNT_NAMES.map(name => ({ name, agentDir: join(home, "profiles", name) }));
const authPath = (name, home) => accountPath(profiles(home).find(profile => profile.name === name));

const oauth = name => ({ type: "oauth", access: `access-${name}`, refresh: `refresh-${name}`, expires: Date.now() + 3600000, accountId: `id-${name}` });
const json = path => JSON.parse(readFileSync(path, "utf8"));
function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), "pi-account-test-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const configPath = join(home, "config.json");
  writeFileSync(configPath, JSON.stringify({ accountSwitch: { enabled: true, accounts: profiles(home) } }));
  for (const name of ACCOUNT_NAMES) {
    const path = authPath(name, home);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ [PROVIDER]: oauth(name), unrelated: { type: "api_key", key: `key-${name}` } }), { mode: 0o600 });
  }
  return { home, configPath, agentDir: dirname(authPath("personal", home)) };
}
async function runtimeFor(f, name = "personal") {
  const runtime = await ModelRuntime.create({ authPath: authPath(name, f.home), modelsPath: null, modelsStorePath: join(f.home, "models-store.json"), refreshOnCreate: false });
  return { runtime, registry: new ModelRegistry(runtime) };
}
function harness(f, registry, mode = "tui") {
  const handlers = new Map(), commands = new Map(), statuses = new Map([["other", "unchanged"]]), notices = [];
  let idle = true, pending = false, choice;
  const ctx = {
    mode, hasUI: mode === "tui", modelRegistry: registry, model: { provider: PROVIDER },
    isIdle: () => idle, hasPendingMessages: () => pending,
    ui: {
      theme: { fg: (_, value) => value }, setStatus: (key, value) => statuses.set(key, value),
      notify: (text, level) => notices.push({ text, level }),
      select: async (title, entries) => typeof choice === "function" ? choice(title, entries) : choice,
    },
  };
  registerAccountSwitch({ events: createEventBus(), on(name, fn) { handlers.set(name, fn); }, registerCommand(name, command) { commands.set(name, command); } }, f);
  return {
    ctx, statuses, notices, handlers, commands,
    fire: (name, event = {}) => handlers.get(name)?.(event, ctx),
    run: args => commands.get("switch-account").handler(args, ctx),
    setIdle(value) { idle = value; }, setPending(value) { pending = value; }, setChoice(value) { choice = value; },
  };
}

test("independent configuration is strict, bounded and fail-closed", t => {
  const f = fixture(t);
  const cases = [
    ["{}", false, "missing"], ['{"accountSwitch":{"enabled":false}}', false, "loaded"],
    [JSON.stringify({ accountSwitch: { enabled: true, accounts: profiles(f.home) } }), true, "loaded"],
    ['{"accountSwitch":{"enabled":true}}', false, "invalid"],
    ['{"accountSwitch":{"enabled":"true"}}', false, "invalid"],
    ['{"accountSwitch":null}', false, "invalid"], ["[]", false, "invalid"], ["{", false, "invalid"],
    [" ".repeat(8193), false, "invalid"],
  ];
  for (const [content, enabled, state] of cases) {
    writeFileSync(f.configPath, content);
    assert.deepEqual(loadAccountSwitchConfig(f.configPath), { enabled, accounts: enabled ? profiles(f.home) : [], state });
  }
  assert.deepEqual(loadAccountSwitchConfig(join(f.home, "missing.json")), { enabled: false, accounts: [], state: "missing" });
});

test("personal config path priority is portable, explicit, and does not fall back on malformed files", t => {
  const f = fixture(t);
  const home = join(f.home, "isolated-home");
  mkdirSync(home);
  assert.equal(resolveConfigPath(home, ""), DEFAULT_CONFIG_PATH);
  const privatePath = join(home, ".pi", "footer-tools.json");
  mkdirSync(dirname(privatePath));
  writeFileSync(privatePath, "{", { mode: 0o600 });
  assert.equal(resolveConfigPath(home, ""), privatePath);
  assert.equal(loadAccountSwitchConfig(resolveConfigPath(home, "")).state, "invalid");
  assert.equal(resolveConfigPath(home, "~/custom.json"), join(home, "custom.json"));
  const explicit = join(home, "missing.json");
  assert.equal(resolveConfigPath(home, explicit), explicit);
  assert.equal(loadAccountSwitchConfig(resolveConfigPath(home, explicit)).state, "missing");
});

test("account profiles are configurable, validate labels/paths, and expand home only locally", t => {
  const f = fixture(t);
  const good = { enabled: true, accounts: [{ name: "example", agentDir: "~/.pi/example-agent" }] };
  writeFileSync(f.configPath, JSON.stringify({ accountSwitch: good }));
  assert.deepEqual(loadAccountSwitchConfig(f.configPath, f.home).accounts,
    [{ name: "example", agentDir: join(f.home, ".pi", "example-agent") }]);
  for (const accounts of [[], null, [{ name: "status", agentDir: f.home }],
    [{ name: "../escape", agentDir: f.home }], [{ name: "example", agentDir: "relative" }],
    [{ name: "example", agentDir: "~/.pi/x\u001b" }],
    [{ name: "same", agentDir: f.home }, { name: "same", agentDir: f.home }]]) {
    writeFileSync(f.configPath, JSON.stringify({ accountSwitch: { enabled: true, accounts } }));
    assert.equal(loadAccountSwitchConfig(f.configPath, f.home).state, "invalid");
  }
});

test("off registers no commands or events and never touches auth storage", t => {
  const f = fixture(t);
  writeFileSync(f.configPath, '{"accountSwitch":{"enabled":false}}');
  const h = harness(f, new Proxy({}, { get() { throw new Error("must not touch runtime"); } }));
  assert.equal(h.handlers.size, 0);
  assert.equal(h.commands.size, 0);
});

test("all launch profiles and custom directory labels are recognized", t => {
  const f = fixture(t);
  for (const name of ACCOUNT_NAMES) assert.equal(accountName(dirname(authPath(name, f.home)), profiles(f.home)), name);
  assert.equal(accountName(join(f.home, "custom-agent"), profiles(f.home)), "custom-agent");
});

test("real installed Pi resolves each switched account without copying auth files or touching other providers", async t => {
  const f = fixture(t), { runtime, registry } = await runtimeFor(f);
  const before = ACCOUNT_NAMES.map(name => readFileSync(authPath(name, f.home), "utf8"));
  const originalModel = registry.getAll().find(model => model.provider === PROVIDER);
  assert.ok(originalModel);
  const route = attachRouting(registry, f.agentDir, profiles(f.home));
  t.after(() => route.detach());
  assert.equal(route.name, "personal");
  for (const name of ACCOUNT_NAMES) {
    await route.switchTo(name);
    const auth = await registry.getApiKeyAndHeaders(originalModel);
    assert.equal(auth.ok, true);
    assert.equal(auth.apiKey, `access-${name}`);
    assert.equal((await runtime.listCredentials()).find(entry => entry.providerId === PROVIDER).type, "oauth");
    assert.equal(registry.find(PROVIDER, originalModel.id).id, originalModel.id);
    // The same shared runtime still resolves unrelated providers from the launch profile.
    assert.equal((await runtime.credentials.read("unrelated")).key, "key-personal");
  }
  assert.deepEqual(ACCOUNT_NAMES.map(name => readFileSync(authPath(name, f.home), "utf8")), before);
  route.detach();
  assert.equal((await runtime.getAuth(PROVIDER)).auth.apiKey, "access-personal");
});

test("real request dispatch keeps conversation/model/options while using the switched token", async t => {
  const f = fixture(t), { runtime, registry } = await runtimeFor(f);
  const { createAssistantMessageEventStream } = await import(pathToFileURL(join(root, "node_modules/@earendil-works/pi-ai/dist/index.js")).href);
  const base = runtime.getProvider(PROVIDER), calls = [];
  runtime.registerNativeProvider({ ...base, streamSimple(model, context, options) {
    calls.push({ model, context, options });
    const stream = createAssistantMessageEventStream();
    const message = {
      role: "assistant", content: [{ type: "text", text: "synthetic reply" }],
      api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: "stop",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    stream.push({ type: "done", reason: "stop", message });
    stream.end(message);
    return stream;
  } });
  const route = attachRouting(registry, f.agentDir, profiles(f.home));
  t.after(() => route.detach());
  const model = registry.getAll().find(value => value.provider === PROVIDER);
  const context = { messages: [{ role: "user", content: "existing conversation", timestamp: 1 }] };
  await registry.streamSimple(model, context, { maxTokens: 42, reasoning: "high" }).result();
  await route.switchTo("backup");
  await registry.streamSimple(model, context, { maxTokens: 42, reasoning: "high" }).result();
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.apiKey, "access-personal");
  assert.equal(calls[1].options.apiKey, "access-backup");
  assert.equal(calls[1].options.maxTokens, 42);
  assert.equal(calls[1].options.reasoning, "high");
  assert.equal(calls[1].model.id, calls[0].model.id);
  assert.deepEqual(calls[1].context, calls[0].context);
});

test("OAuth refresh, concurrent resolutions, login writes and logout stay in the selected auth.json", async t => {
  const f = fixture(t), { runtime, registry } = await runtimeFor(f);
  const path = authPath("backup", f.home);
  const data = json(path);
  data[PROVIDER].expires = 1;
  writeFileSync(path, JSON.stringify(data));
  const beforeLaunch = readFileSync(authPath("personal", f.home), "utf8");
  let refreshes = 0;
  const base = runtime.getProvider(PROVIDER);
  runtime.registerNativeProvider({ ...base, auth: { oauth: {
    ...base.auth.oauth,
    async refresh(credential) {
      refreshes++;
      assert.equal(credential.refresh, "refresh-backup");
      return { ...credential, access: "rotated-backup", refresh: "rotated-refresh", expires: Date.now() + 3600000 };
    },
    async toAuth(credential) { return { apiKey: credential.access }; },
    async login() { return oauth("new-backup-login"); },
  } } });
  const route = attachRouting(registry, f.agentDir, profiles(f.home));
  t.after(() => route.detach());
  await route.switchTo("backup");
  const resolved = await Promise.all([runtime.getAuth(PROVIDER), runtime.getAuth(PROVIDER)]);
  assert.equal(refreshes, 1);
  assert.ok(resolved.every(value => value.auth.apiKey === "rotated-backup"));
  assert.equal(json(path)[PROVIDER].refresh, "rotated-refresh");
  assert.deepEqual(json(path).unrelated, data.unrelated);
  assert.equal(readFileSync(authPath("personal", f.home), "utf8"), beforeLaunch);
  await runtime.login(PROVIDER, "oauth", { prompt: async () => "", notify() {} });
  assert.equal(json(path)[PROVIDER].access, "access-new-backup-login");
  await runtime.logout(PROVIDER);
  assert.equal(json(path)[PROVIDER], undefined);
  assert.equal(readFileSync(authPath("personal", f.home), "utf8"), beforeLaunch);
});

test("missing, malformed, wrong credential type and changed state preserve the original selection", async t => {
  const f = fixture(t), { runtime, registry } = await runtimeFor(f);
  const route = attachRouting(registry, f.agentDir, profiles(f.home));
  t.after(() => route.detach());
  await assert.rejects(route.switchTo("unconfigured-account"), /unknown-account/);
  const path = authPath("work", f.home);
  rmSync(dirname(path), { recursive: true });
  await assert.rejects(route.switchTo("work"));
  assert.equal(existsSync(dirname(path)), false, "no new account files created");
  mkdirSync(dirname(path));
  for (const content of ["{", JSON.stringify({ [PROVIDER]: { type: "api_key", key: "not-chatgpt" } }), JSON.stringify({ [PROVIDER]: { type: "oauth", access: "x" } })]) {
    writeFileSync(path, content);
    await assert.rejects(route.switchTo("work"));
    assert.equal(route.name, "personal");
    assert.equal((await runtime.getAuth(PROVIDER)).auth.apiKey, "access-personal");
  }
  await assert.rejects(route.switchTo("backup", () => false));
  assert.equal(route.name, "personal");
});

test("snapshot refresh failure rolls back the credential route and label", async t => {
  const f = fixture(t), { runtime, registry } = await runtimeFor(f);
  const route = attachRouting(registry, f.agentDir, profiles(f.home));
  t.after(() => route.detach());
  const original = registry.refresh.bind(registry);
  let calls = 0;
  registry.refresh = async options => ++calls === 1 ? { aborted: false, errors: new Map([[PROVIDER, new Error("secret")]]) } : original(options);
  await assert.rejects(route.switchTo("backup"), /refresh-failed/);
  assert.equal(calls, 2);
  assert.equal(route.name, "personal");
  assert.equal((await runtime.getAuth(PROVIDER)).auth.apiKey, "access-personal");
});

test("reload remembers selection; disabling/removing the extension restores launch authentication", async t => {
  const f = fixture(t), { runtime, registry } = await runtimeFor(f);
  const first = attachRouting(registry, f.agentDir, profiles(f.home));
  await first.switchTo("work");
  first.detach(true);
  assert.equal((await runtime.getAuth(PROVIDER)).auth.apiKey, "access-personal");
  const reloaded = attachRouting(registry, f.agentDir, profiles(f.home));
  t.after(() => reloaded.detach());
  assert.equal(reloaded.name, "work");
  assert.equal((await runtime.getAuth(PROVIDER)).auth.apiKey, "access-work");
  first.detach(); // stale handler cannot undo a newer extension's route
  assert.equal((await runtime.getAuth(PROVIDER)).auth.apiKey, "access-work");
  reloaded.detach();
  assert.equal((await runtime.getAuth(PROVIDER)).auth.apiKey, "access-personal");
});

test("unsupported runtimes/storage and Codex runtime overrides fail closed", async t => {
  const f = fixture(t);
  assert.throws(() => attachRouting({}, f.agentDir, profiles(f.home)), /unsupported-runtime/);
  const { runtime, registry } = await runtimeFor(f);
  runtime.credentials.setRuntimeApiKey(PROVIDER, "override");
  assert.throws(() => attachRouting(registry, f.agentDir, profiles(f.home)), /runtime-api-key/);
  runtime.credentials.removeRuntimeApiKey(PROVIDER);
  const route = attachRouting(registry, f.agentDir, profiles(f.home));
  t.after(() => route.detach());
  runtime.credentials.setRuntimeApiKey(PROVIDER, "later-override");
  await assert.rejects(route.switchTo("backup"), /runtime-api-key/);
});

test("command selector, direct switch, cancellation, footer and statuses are isolated", async t => {
  const f = fixture(t), { runtime, registry } = await runtimeFor(f), h = harness(f, registry);
  t.after(() => h.fire("session_shutdown"));
  h.fire("session_start");
  assert.equal(h.statuses.get("account-switch"), "personal");
  h.setChoice(undefined);
  await h.run("");
  assert.equal((await runtime.getAuth(PROVIDER)).auth.apiKey, "access-personal");
  h.setChoice((_title, entries) => { assert.ok(entries.includes("personal (current)")); return "backup"; });
  await h.run("");
  assert.equal(h.statuses.get("account-switch"), "backup");
  assert.equal((await runtime.getAuth(PROVIDER)).auth.apiKey, "access-backup");
  await h.run("work");
  assert.equal(h.statuses.get("account-switch"), "work");
  await h.run("status");
  assert.match(h.notices.at(-1).text, /work/);
  await h.run("../../invalid");
  assert.match(h.notices.at(-1).text, /用法/);
  assert.deepEqual(h.commands.get("switch-account").getArgumentCompletions("ba"), [{ value: "backup", label: "backup" }]);
  h.fire("model_select", { model: { provider: "anthropic" } });
  assert.equal(h.statuses.get("account-switch"), "work (Codex only)");
  assert.equal(h.statuses.get("other"), "unchanged");
  h.fire("session_shutdown");
  assert.equal(h.statuses.get("account-switch"), undefined);
  assert.equal((await runtime.getAuth(PROVIDER)).auth.apiKey, "access-personal");
});

test("running requests, queued messages and state changes while selecting block switching", async t => {
  const f = fixture(t), { runtime, registry } = await runtimeFor(f), h = harness(f, registry);
  h.fire("session_start");
  t.after(() => h.fire("session_shutdown"));
  h.setIdle(false);
  await h.run("backup");
  h.setIdle(true); h.setPending(true);
  await h.run("backup");
  h.setPending(false);
  h.setChoice(() => { h.setIdle(false); return "backup"; });
  await h.run("");
  assert.equal((await runtime.getAuth(PROVIDER)).auth.apiKey, "access-personal");
  assert.ok(h.notices.every(notice => notice.level === "warning"));
});

test("failed commands redact secrets and non-TUI modes never attach authentication routes", async t => {
  const f = fixture(t);
  for (const mode of ["print", "json", "rpc"]) {
    const h = harness(f, new Proxy({}, { get() { throw new Error("secret-token"); } }), mode);
    h.fire("session_start");
    await h.run("backup");
    assert.equal(h.statuses.has("account-switch"), false);
  }
  const { registry } = await runtimeFor(f), h = harness(f, registry);
  h.fire("session_start");
  t.after(() => h.fire("session_shutdown"));
  registry.refresh = async () => { throw new Error("secret-token"); };
  await h.run("backup");
  assert.equal(h.statuses.get("account-switch"), "personal");
  assert.ok(h.notices.every(notice => !notice.text.includes("secret-token")));
});
