import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { DEFAULT_CONFIG_PATH, factory, loadTelegramNotifyConfig, registerTelegramNotify, resolveConfigPath } from "./installed.mjs";

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "pi-tg-config-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, path: join(dir, "config.json") };
}
function env(t, key, value) {
  const before = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  t.after(() => {
    if (before === undefined) delete process.env[key];
    else process.env[key] = before;
  });
}

test("capability config is strict, independent and fails closed", t => {
  const f = fixture(t);
  const cases = [
    ["{}", false, "missing"],
    ['{"enabled":true}', false, "missing"],
    ['{"telegramNotify":{"enabled":false}}', false, "loaded"],
    ['{"telegramNotify":{"enabled":true}}', true, "loaded"],
    [JSON.stringify({ telegramNotify: { enabled: true }, accountSwitch: null, contextCost: { enabled: false }, cacheDiagnostics: {} }), true, "loaded"],
    ...[undefined, null, "true", "false", 0, 1, [], {}].map(enabled =>
      [JSON.stringify({ telegramNotify: { enabled } }), false, "invalid"]),
    ...[null, [], true, "yes", 12].map(telegramNotify =>
      [JSON.stringify({ telegramNotify }), false, "invalid"]),
    ...["null", "[]", '"secret"', "true", "123", "{", ""].map(content => [content, false, "invalid"]),
  ];
  for (const [content, enabled, state] of cases) {
    writeFileSync(f.path, content);
    assert.deepEqual(loadTelegramNotifyConfig(f.path), { enabled, state }, content);
  }
  assert.deepEqual(loadTelegramNotifyConfig(join(f.dir, "absent")), { enabled: false, state: "missing" });
  assert.deepEqual(loadTelegramNotifyConfig(f.dir), { enabled: false, state: "invalid" });
});

test("8 KiB bound counts bytes, accepts exact limit and rejects oversized valid JSON", t => {
  const f = fixture(t);
  const json = '{"telegramNotify":{"enabled":true}}';
  writeFileSync(f.path, json.padEnd(8192));
  assert.deepEqual(loadTelegramNotifyConfig(f.path), { enabled: true, state: "loaded" });
  writeFileSync(f.path, json.padEnd(8193));
  assert.deepEqual(loadTelegramNotifyConfig(f.path), { enabled: false, state: "invalid" });
  const unicode = JSON.stringify({ telegramNotify: { enabled: true }, padding: "界".repeat(3000) });
  assert.ok(unicode.length < 8192 && Buffer.byteLength(unicode) > 8192);
  writeFileSync(f.path, unicode);
  assert.deepEqual(loadTelegramNotifyConfig(f.path), { enabled: false, state: "invalid" });
  writeFileSync(f.path, " ".repeat(8193));
  assert.equal(loadTelegramNotifyConfig(f.path).state, "invalid");
});

test("default factory is the gated register function; missing/off register nothing", t => {
  const f = fixture(t);
  assert.equal(factory, registerTelegramNotify);
  const api = new Proxy({}, { get(_target, name) { throw new Error(`unexpected registration: ${String(name)}`); } });
  registerTelegramNotify(api, { configPath: f.path });
  for (const content of ["{}", '{"telegramNotify":{"enabled":false}}']) {
    writeFileSync(f.path, content);
    factory(api, { configPath: f.path });
  }
});

test("default loader respects explicit override and invalid personal config without project fallback", t => {
  const f = fixture(t);
  const personal = join(f.dir, ".pi", "token-speed.json");
  assert.equal(resolveConfigPath(f.dir, ""), DEFAULT_CONFIG_PATH);
  mkdirSync(dirname(personal));
  writeFileSync(personal, "{");
  assert.equal(resolveConfigPath(f.dir, ""), personal);
  assert.equal(loadTelegramNotifyConfig(resolveConfigPath(f.dir, "")).state, "invalid");
  assert.equal(resolveConfigPath(f.dir, "~/custom.json"), join(f.dir, "custom.json"));
  assert.equal(resolveConfigPath(f.dir, f.path), f.path);
  writeFileSync(f.path, '{"telegramNotify":{"enabled":true}}');
  env(t, "PI_TOKEN_SPEED_CONFIG", f.path);
  assert.deepEqual(loadTelegramNotifyConfig(), { enabled: true, state: "loaded" });
  env(t, "PI_TOKEN_SPEED_CONFIG", join(f.dir, "absent"));
  assert.deepEqual(loadTelegramNotifyConfig(), { enabled: false, state: "missing" });
  // Project files are never consulted when the explicit file is missing.
  writeFileSync(join(f.dir, "telegram-notify.json"), '{"enabled":true}');
  const cwd = process.cwd();
  try {
    process.chdir(f.dir);
    assert.deepEqual(loadTelegramNotifyConfig(), { enabled: false, state: "missing" });
  } finally { process.chdir(cwd); }
  const bundled = JSON.parse(readFileSync(DEFAULT_CONFIG_PATH, "utf8"));
  assert.equal(bundled.telegramNotify.enabled, false);
});
