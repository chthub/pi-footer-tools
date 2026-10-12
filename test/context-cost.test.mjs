import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

// Keep regression tests independent of personal configuration.
process.env.PI_TOKEN_SPEED_CONFIG = new URL("../config.json", import.meta.url).pathname;

let root = dirname(realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim()));
while (!existsSync(join(root, "package.json"))) root = dirname(root);
const { createJiti } = createRequire(join(root, "package.json"))("jiti");
const jiti = createJiti(import.meta.url, { alias: { "@earendil-works/pi-coding-agent": join(root, "dist/index.js") } });
const base = new URL("../context-cost/", import.meta.url).pathname;
const { estimate, formatStatus, PRICED_PROVIDERS } = await jiti.import(join(base, "core.ts"));
const { loadContextCostConfig, DEFAULT_CONFIG_PATH } = await jiti.import(join(base, "config.ts"));
const { registerContextCost } = await jiti.import(join(base, "index.ts"));

const ASTRA = "gpt-6-astra";
const SOL = "gpt-6.1-sol";
// Handoff price table (official OpenAI pricing, checked 2026-10-03), in Pi's model.cost shape.
const COST = {
  [ASTRA]: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5, tiers: [{ inputTokensAbove: 272_000, input: 20, output: 75, cacheRead: 2, cacheWrite: 25 }] },
  [SOL]: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5, tiers: [{ inputTokensAbove: 272_000, input: 4, output: 15, cacheRead: 0.2, cacheWrite: 5 }] },
};
const model = (id, provider = "openai", cost = COST[id]) => ({ id, provider, cost });
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);
const at = (id, h, t = h, extra = {}) => estimate({ model: model(id), historyTokens: h, nextTotalInputTokens: t, ...extra });

test("installed Pi model data matches the handoff price table for both OpenAI providers", () => {
  const data = join(root, "node_modules/@earendil-works/pi-ai/dist/providers/data");
  for (const provider of PRICED_PROVIDERS) {
    const entries = [];
    (function walk(value) {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === "object") {
        if (value.cost && (value.id === ASTRA || value.id === SOL)) entries.push(value);
        Object.values(value).forEach(walk);
      }
    })(JSON.parse(readFileSync(join(data, `${provider}.json`), "utf8")));
    for (const id of [ASTRA, SOL]) {
      const found = entries.filter(entry => entry.id === id);
      assert.equal(found.length, 1, `${provider}/${id}`);
      assert.deepEqual(found[0].cost, COST[id], `${provider}/${id}`);
    }
  }
});

test("acceptance table: H = T, full cache read history, 50k cache-write startup", () => {
  for (const [id, tokens, history, startup] of [
    [ASTRA, 272_000, 0.272, 0.625], [ASTRA, 272_001, 0.544002, 0.625], [ASTRA, 300_000, 0.6, 0.625],
    [ASTRA, 312_500, 0.625, 0.625], [ASTRA, 400_000, 0.8, 0.625],
    [SOL, 272_000, 0.0272, 0.125], [SOL, 272_001, 0.0544002, 0.125], [SOL, 400_000, 0.08, 0.125],
    [SOL, 500_000, 0.1, 0.125], [SOL, 625_000, 0.125, 0.125], [SOL, 800_000, 0.16, 0.125],
  ]) {
    const result = at(id, tokens);
    close(result.historyUsd, history);
    close(result.startupUsd, startup);
    assert.equal(result.tiered, true);
  }
});

test("tier follows next total input T, not history H", () => {
  close(at(ASTRA, 270_000, 280_000).historyUsd, 0.54);
  close(at(SOL, 270_000, 280_000).historyUsd, 0.054);
  close(at(ASTRA, 280_000, 270_000).historyUsd, 0.28);
});

test("highest matching tier wins regardless of tier order, like Pi's calculateCost", () => {
  const cost = { input: 1, cacheRead: 0.1, cacheWrite: 1.25, tiers: [
    { inputTokensAbove: 500_000, input: 3, cacheRead: 0.3, cacheWrite: 3.75 },
    { inputTokensAbove: 200_000, input: 2, cacheRead: 0.2, cacheWrite: 2.5 },
  ] };
  const run = tokens => estimate({ model: model("gpt-x", "openai", cost), historyTokens: tokens, nextTotalInputTokens: tokens });
  close(run(200_000).historyUsd, 0.02);
  close(run(300_000).historyUsd, 0.06);
  close(run(600_000).historyUsd, 0.18);
});

test("uncached-input startup is opt-in; default stays cache-write", () => {
  close(at(ASTRA, 0, 0, { startupMode: "uncached-input" }).startupUsd, 0.5);
  close(at(SOL, 0, 0, { startupMode: "uncached-input" }).startupUsd, 0.1);
  close(at(ASTRA, 0).startupUsd, 0.625);
  assert.match(formatStatus(at(SOL, 0, 0, { startupMode: "uncached-input" })), /Cold start \$0\.1000$/);
  assert.match(formatStatus(at(SOL, 0)), /Cold start \$0\.1250$/);
});

test("local untiered policy is opt-in and matches exact provider/model IDs", () => {
  assert.equal(estimate({ model: model(SOL, "openai-codex"), historyTokens: 400_000, nextTotalInputTokens: 400_000 }).tiered, true);
  const codex = (id, h, t = h, extra = {}) => estimate({ model: model(id, "openai-codex"), untieredModels: [`openai-codex/${SOL}`], historyTokens: h, nextTotalInputTokens: t, ...extra });
  for (const [tokens, history] of [[272_000, 0.0272], [272_001, 0.0272001], [800_000, 0.08]]) {
    const result = codex(SOL, tokens);
    close(result.historyUsd, history);
    close(result.startupUsd, 0.125);
    assert.equal(result.tiered, false);
  }
  close(codex(SOL, 0, 0, { startupTokens: 300_000 }).startupUsd, 0.75);
  close(codex(ASTRA, 272_001).historyUsd, 0.544002);
  assert.equal(codex(ASTRA, 1).tiered, true);
  close(at(SOL, 272_001).historyUsd, 0.0544002);
  assert.equal(formatStatus(codex(SOL, 400_000)), "Cache read $0.0400 | Cold start $0.1250");
});

test("unknown tokens are never shown as $0; zero is a valid zero", () => {
  for (const bad of [null, undefined, NaN, Infinity, -Infinity, -1, "1000"]) {
    for (const [h, t] of [[bad, 1000], [1000, bad], [bad, bad]]) {
      // Call estimate directly: a helper default parameter would turn T = undefined into T = H.
      const result = estimate({ model: model(ASTRA), historyTokens: h, nextTotalInputTokens: t });
      assert.equal(result.historyUsd, null);
      close(result.startupUsd, 0.625);
      assert.equal(formatStatus(result), "Cache read — | Cold start $0.6250");
    }
  }
  assert.equal(at(ASTRA, 0).historyUsd, 0);
  assert.equal(formatStatus(at(ASTRA, 0)), "Cache read $0.0000 | Cold start $0.6250");
});

test("any OpenAI model with usable model.cost is priced; zero cache write bills first input as input", () => {
  // e.g. Pi's gpt-5.5: no separate cache-write charge.
  const gpt55 = { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0, tiers: [{ inputTokensAbove: 272_000, input: 10, output: 45, cacheRead: 1, cacheWrite: 0 }] };
  for (const provider of ["openai", "openai-codex"]) {
    const result = estimate({ model: model("gpt-5.5", provider, gpt55), historyTokens: 100_000, nextTotalInputTokens: 100_000 });
    close(result.historyUsd, 0.05);
    close(result.startupUsd, 0.25);
    close(estimate({ model: model("gpt-5.5", provider, gpt55), historyTokens: 0, nextTotalInputTokens: 0, startupTokens: 300_000 }).startupUsd, 3);
  }
});

test("unpriced: other providers, missing or malformed cost, no cache discount, bad tiers", () => {
  const bad = [
    model(ASTRA, "openrouter"), model(SOL, "azure"), model(SOL, "anthropic"), model("example-local-model", "local"),
    model("gpt-x", "openai", undefined), model("gpt-x", "openai", null), model("gpt-x", "openai", 5),
    model("gpt-5-pro", "openai", { input: 15, output: 120, cacheRead: 0, cacheWrite: 0 }),
    model("gpt-6-luna", "openai", { input: 0.1, output: 0, cacheRead: 0, cacheWrite: 0 }),
    model("gpt-x", "openai", { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
    model("gpt-x", "openai", { input: 1, cacheRead: 0.1 }),
    model("gpt-x", "openai", { input: 1, cacheRead: -0.1, cacheWrite: 1 }),
    model("gpt-x", "openai", { input: NaN, cacheRead: 0.1, cacheWrite: 1 }),
    model("gpt-x", "openai", { input: "1", cacheRead: 0.1, cacheWrite: 1 }),
    model("gpt-x", "openai", { ...COST[SOL], tiers: {} }),
    model("gpt-x", "openai", { ...COST[SOL], tiers: [null] }),
    model("gpt-x", "openai", { ...COST[SOL], tiers: [{ ...COST[SOL].tiers[0], inputTokensAbove: undefined }] }),
    model("gpt-x", "openai", { ...COST[SOL], tiers: [{ ...COST[SOL].tiers[0], cacheRead: 0 }] }),
  ];
  for (const m of bad) assert.equal(estimate({ model: m, historyTokens: 1000, nextTotalInputTokens: 1000 }), undefined, JSON.stringify(m));
  assert.equal(formatStatus(undefined), "API price not configured");
});

test("documented example strings", () => {
  assert.equal(formatStatus(at(ASTRA, 400_000)), "Cache read $0.8000 | Cold start $0.6250");
  assert.equal(formatStatus(at(SOL, 400_000)), "Cache read $0.0800 | Cold start $0.1250");
});

// ---- config ----
function withConfig(content, run) {
  const dir = mkdtempSync(join(tmpdir(), "context-cost-"));
  try {
    const path = join(dir, "config.json");
    if (content !== undefined) writeFileSync(path, content);
    return run(path);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("config: missing file/section is off; explicit booleans and modes load; malformed fails closed", () => {
  const load = content => withConfig(content, loadContextCostConfig);
  assert.deepEqual(load(undefined), { enabled: false, startupMode: "cache-write", startupTokens: 50_000, untieredModels: [], state: "missing" });
  assert.deepEqual(load(JSON.stringify({ cacheDiagnostics: { enabledByDefault: true } })).state, "missing");
  assert.deepEqual(load(JSON.stringify({ contextCost: { enabled: true } })), { enabled: true, startupMode: "cache-write", startupTokens: 50_000, untieredModels: [], state: "loaded" });
  assert.deepEqual(load(JSON.stringify({ contextCost: { enabled: false } })), { enabled: false, startupMode: "cache-write", startupTokens: 50_000, untieredModels: [], state: "loaded" });
  assert.deepEqual(load(JSON.stringify({ contextCost: { enabled: true, startupMode: "uncached-input" } })),
    { enabled: true, startupMode: "uncached-input", startupTokens: 50_000, untieredModels: [], state: "loaded" });
  for (const bad of ["{", "[]", JSON.stringify({ contextCost: true }), JSON.stringify({ contextCost: { enabled: "true" } }),
    JSON.stringify({ contextCost: { enabled: true, startupMode: "uncached" } }), JSON.stringify({ contextCost: { enabled: true, pad: "x".repeat(9000) } }),
    ...[0, -1, 1.5, "50000", null, 1e300].map(startupTokens => JSON.stringify({ contextCost: { enabled: true, startupTokens } }))]) {
    assert.deepEqual(load(bad), { enabled: false, startupMode: "cache-write", startupTokens: 50_000, untieredModels: [], state: "invalid" }, bad.slice(0, 60));
  }
  assert.deepEqual(load(JSON.stringify({ contextCost: { enabled: true, startupTokens: 80_000 } })),
    { enabled: true, startupMode: "cache-write", startupTokens: 80_000, untieredModels: [], state: "loaded" });
  assert.ok(DEFAULT_CONFIG_PATH.endsWith("pi-token-speed/config.json"));
  assert.equal(typeof loadContextCostConfig().enabled, "boolean");
});

// ---- extension lifecycle ----
function harness({ config = { contextCost: { enabled: true } }, mode = "tui", model: selected = model(ASTRA), tokens = 400_000 } = {}) {
  const handlers = new Map();
  const statuses = new Map([["another-extension", "unchanged"]]);
  const writes = [];
  const notices = [];
  let usageCalls = 0;
  const ctx = {
    mode, model: selected,
    getContextUsage() { usageCalls++; return h.usage; },
    ui: {
      setStatus(key, value) { statuses.set(key, value); writes.push([key, value]); },
      notify(text, kind) { notices.push([text, kind]); },
      // Marks the theme colour so tests can check styling without real ANSI codes.
      theme: { fg: (color, text) => `<${color}>${text}</${color}>` },
    },
  };
  const pi = { on(name, handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); } };
  withConfig(JSON.stringify(config), configPath => registerContextCost(pi, { configPath }));
  const h = {
    ctx, handlers, statuses, writes, notices, usage: { tokens, contextWindow: 1_000_000, percent: null },
    usageCalls: () => usageCalls,
    fire(name, event = {}) { for (const handler of handlers.get(name) ?? []) handler(event, ctx); },
    raw: () => statuses.get("context-cost"),
    status() {
      const value = statuses.get("context-cost");
      if (value === undefined) return value;
      const match = /^<dim>(.*)<\/dim>$/.exec(value);
      assert.ok(match, `not dimmed: ${value}`);
      return match[1];
    },
  };
  return h;
}

test("session start shows the comparison for the selected model without touching other statuses", () => {
  const h = harness();
  h.fire("session_start", { reason: "startup" });
  assert.equal(h.status(), "Cache read $0.8000 | Cold start $0.6250");
  assert.equal(h.statuses.get("another-extension"), "unchanged");
});

test("model switches reprice from event.model and never leave a stale amount", () => {
  const h = harness();
  h.fire("session_start", { reason: "startup" });
  // ctx.model still holds the previous model while model_select is dispatched.
  h.fire("model_select", { model: { id: "claude-opus-5-5", provider: "anthropic" } });
  assert.equal(h.status(), "API price not configured");
  h.fire("model_select", { model: model(SOL) });
  assert.equal(h.status(), "Cache read $0.0800 | Cold start $0.1250");
  h.fire("model_select", { model: model(SOL, "openai-codex") });
  assert.equal(h.status(), "Cache read $0.0800 | Cold start $0.1250");
  h.ctx.model = undefined;
  h.fire("session_start", { reason: "new" });
  assert.equal(h.status(), undefined);
  assert.equal(h.writes.at(-1)[1], undefined);
});

test("context updates refresh after turns, compaction (unknown) and tree navigation", () => {
  const h = harness();
  h.fire("session_start", { reason: "resume" });
  h.usage = { tokens: 300_000, contextWindow: 1_000_000, percent: 30 };
  h.fire("turn_end");
  assert.equal(h.status(), "Cache read $0.6000 | Cold start $0.6250");
  h.usage = { tokens: null, contextWindow: 1_000_000, percent: null };
  h.fire("session_compact");
  assert.equal(h.status(), "Cache read — | Cold start $0.6250");
  h.fire("agent_end"); // still no post-compaction usage: must not reuse the old amount
  assert.equal(h.status(), "Cache read — | Cold start $0.6250");
  h.usage = { tokens: 20_000, contextWindow: 1_000_000, percent: 2 };
  h.fire("agent_end");
  assert.equal(h.status(), "Cache read $0.0200 | Cold start $0.6250");
  h.usage = { tokens: 312_500, contextWindow: 1_000_000, percent: 31 };
  h.fire("session_tree");
  assert.equal(h.status(), "Cache read $0.6250 | Cold start $0.6250");
  h.usage = undefined;
  h.fire("turn_end");
  assert.equal(h.status(), "Cache read — | Cold start $0.6250");
});

test("unchanged text is not rewritten; session start always repaints", () => {
  const h = harness();
  h.fire("session_start", { reason: "startup" });
  const writes = h.writes.length;
  for (let i = 0; i < 5; i++) { h.fire("turn_end"); h.fire("agent_end"); }
  assert.equal(h.writes.length, writes);
  h.fire("session_start", { reason: "reload" });
  assert.equal(h.writes.length, writes + 1);
});

test("shutdown clears only its own status, idempotently", () => {
  const h = harness();
  h.fire("session_start", { reason: "startup" });
  h.fire("session_shutdown");
  h.fire("session_shutdown");
  assert.equal(h.status(), undefined);
  assert.ok(h.statuses.has("context-cost"));
  assert.equal(h.statuses.get("another-extension"), "unchanged");
  h.fire("session_start", { reason: "fork" });
  assert.equal(h.status(), "Cache read $0.8000 | Cold start $0.6250");
});

test("non-TUI modes make no UI calls and read no context", () => {
  for (const mode of ["rpc", "json", "print"]) {
    const h = harness({ mode });
    for (const name of ["session_start", "model_select", "turn_end", "agent_end", "session_compact", "session_tree", "session_shutdown"]) {
      h.fire(name, { model: model(SOL) });
    }
    assert.equal(h.writes.length, 0);
    assert.equal(h.notices.length, 0);
    assert.equal(h.usageCalls(), 0);
  }
});

test("switch off registers no handlers; invalid config warns once in TUI and stays off", () => {
  for (const config of [{}, { contextCost: { enabled: false } }]) {
    assert.equal(harness({ config }).handlers.size, 0);
  }
  const h = harness({ config: { contextCost: { enabled: "yes" } } });
  assert.deepEqual([...h.handlers.keys()], ["session_start"]);
  h.fire("session_start", { reason: "startup" });
  h.fire("session_start", { reason: "new" });
  assert.equal(h.notices.length, 1);
  assert.equal(h.notices[0][1], "warning");
  assert.equal(h.writes.length, 0);
  const rpc = harness({ config: { contextCost: { enabled: "yes" } }, mode: "rpc" });
  rpc.fire("session_start", { reason: "startup" });
  assert.equal(rpc.notices.length, 0);
});

test("configured uncached-input mode changes the cold-start price", () => {
  const h = harness({ config: { contextCost: { enabled: true, startupMode: "uncached-input" } }, model: model(SOL) });
  h.fire("session_start", { reason: "startup" });
  assert.equal(h.status(), "Cache read $0.0800 | Cold start $0.1000");
});

test("configured startup tokens change the cold-start price and, past 272k, the tier", () => {
  for (const [startupTokens, modelId, provider, text] of [
    [80_000, ASTRA, "openai", "Cache read $0.8000 | Cold start $1.0000"],
    [12_345, SOL, "openai", "Cache read $0.0800 | Cold start $0.0309"],
    [300_000, SOL, "openai", "Cache read $0.0800 | Cold start $1.5000"],
    [300_000, SOL, "openai-codex", "Cache read $0.0800 | Cold start $1.5000"],
  ]) {
    const h = harness({ config: { contextCost: { enabled: true, startupTokens } }, model: model(modelId, provider) });
    h.fire("session_start", { reason: "startup" });
    assert.equal(h.status(), text);
  }
});

test("local untieredModels config affects only listed provider/model IDs", () => {
  const h = harness({ config: { contextCost: { enabled: true, startupTokens: 300_000, untieredModels: [`openai-codex/${SOL}`] } }, model: model(SOL, "openai-codex") });
  h.fire("session_start");
  assert.equal(h.status(), "Cache read $0.0400 | Cold start $0.7500");
  h.fire("model_select", { model: model(SOL, "openai") });
  assert.equal(h.status(), "Cache read $0.0800 | Cold start $1.5000");
  for (const untieredModels of [true, ["missing-provider"], ["openai/"], ["openai/model extra"], [null]]) {
    withConfig(JSON.stringify({ contextCost: { enabled: true, untieredModels } }), path => {
      assert.equal(loadContextCostConfig(path).state, "invalid");
    });
  }
});

test("text uses the theme's dim colour and repaints after a theme switch", () => {
  const h = harness();
  h.fire("session_start", { reason: "startup" });
  assert.equal(h.raw(), "<dim>Cache read $0.8000 | Cold start $0.6250</dim>");
  const writes = h.writes.length;
  h.fire("turn_end");
  assert.equal(h.writes.length, writes);
  h.ctx.ui.theme = { fg: (color, text) => `{${color}}${text}{/${color}}` };
  h.fire("turn_end");
  assert.equal(h.writes.length, writes + 1);
  assert.equal(h.raw(), "{dim}Cache read $0.8000 | Cold start $0.6250{/dim}");
});
