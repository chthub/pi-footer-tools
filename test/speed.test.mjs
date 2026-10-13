import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, mock, test } from "node:test";
import { pathToFileURL } from "node:url";

// Use the same TS loader as the installed Pi; no dependencies or API requests.
// Keep regression tests independent of personal configuration.
process.env.PI_FOOTER_TOOLS_CONFIG = new URL("../config.json", import.meta.url).pathname;

let root = dirname(realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim()));
while (!existsSync(join(root, "package.json"))) {
  const parent = dirname(root);
  if (parent === root) throw new Error("Cannot locate installed Pi");
  root = parent;
}
const hostRequire = createRequire(join(root, "package.json"));
const { createJiti } = hostRequire("jiti");
const factory = (await createJiti(import.meta.url, { alias: { "@earendil-works/pi-coding-agent": join(root, "dist/index.js") } }).import(new URL("../index.ts", import.meta.url).pathname)).default;

test("installed Pi loader accepts extension with no model tools and an opt-in diagnostic command", async () => {
  const { loadExtensions } = await import(pathToFileURL(join(root, "dist/core/extensions/loader.js")).href);
  const result = await loadExtensions([new URL("../index.ts", import.meta.url).pathname], process.cwd());
  assert.deepEqual(result.errors, []);
  assert.equal(result.extensions.length, 1);
  assert.ok(result.extensions[0].handlers.has("message_end"));
  assert.equal(result.extensions[0].handlers.has("provider_stream_event"), false);
  assert.equal(result.extensions[0].tools.size, 0);
  assert.equal(result.extensions[0].commands.size, 2);
  assert.ok(result.extensions[0].commands.has("token-speed"));
  assert.equal(result.extensions[0].commands.has("switch-account"), false);
  assert.ok(result.extensions[0].commands.has("cache-diagnostics"));
});

let now;
beforeEach(() => {
  now = 0;
  mock.method(performance, "now", () => now);
});
afterEach(() => mock.restoreAll());

function harness(mode = "tui", speedMode = "stream") {
  const handlers = new Map();
  const commands = new Map();
  const notices = [];
  const statuses = new Map([["another-extension", "unchanged"]]);
  const writes = [];
  const ctx = { mode, ui: { notify(text, type) { notices.push({ text, type }); }, setStatus(key, value) {
    statuses.set(key, value);
    writes.push([key, value]);
  } } };
  // Real Pi composes event handlers; diagnostics remain disabled in speed regressions.
  factory({
    on(name, handler) {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
    registerCommand(name, command) { commands.set(name, command); }, registerFlag() {}, getFlag() { return false; },
  });
  const fire = (name, event = {}) => {
    for (const handler of handlers.get(name) ?? []) handler(event, ctx);
  };
  const h = { fire, statuses, writes, notices, commands,
    command: args => commands.get("token-speed").handler(args, ctx),
    status: () => statuses.get("footer-tools.token-speed") };
  fire("session_start");
  if (speedMode === "stream") h.command("stream");
  return h;
}
function start(h, time = 0) {
  now = time;
  h.fire("turn_start");
  h.fire("before_provider_request");
  h.fire("message_start", { message: { role: "assistant" } });
}
function delta(h, type, text = "x") {
  h.fire("message_update", {
    message: { role: "assistant" },
    assistantMessageEvent: { type, delta: text },
  });
}
function end(h, output = 500, stopReason = "stop", reasoning) {
  h.fire("message_end", {
    message: { role: "assistant", usage: { output, reasoning }, stopReason },
  });
}

test("API token count and thinking determine average; only English speed is displayed", () => {
  const h = harness();
  start(h);
  now = 1000;
  delta(h, "thinking_delta");
  assert.equal(h.status(), undefined);
  now = 3000;
  delta(h, "text_delta");
  assert.equal(h.status(), undefined);
  now = 13000;
  end(h, 500, "stop", 100);
  assert.equal(h.status(), "Avg stream 41.7 tok/s");
  assert.equal(h.statuses.get("another-extension"), "unchanged");
});

test("pre-request context preparation is excluded", () => {
  const h = harness();
  h.fire("turn_start");
  now = 5000;
  h.fire("before_provider_request");
  h.fire("message_start", { message: { role: "assistant" } });
  now = 6000;
  delta(h, "text_delta");
  now = 15000;
  end(h);
  assert.equal(h.status(), "Avg stream 55.6 tok/s");
});

test("tool execution, tool results, and unrelated background calls do not change completed measurement", () => {
  const h = harness();
  start(h);
  now = 1000;
  delta(h, "toolcall_start");
  delta(h, "toolcall_delta");
  assert.equal(h.status(), undefined);
  now = 2000;
  end(h, 100, "toolUse");
  const previous = h.status();
  assert.equal(previous, "Avg stream 100.0 tok/s");
  now = 100000;
  h.fire("before_provider_request");
  h.fire("message_start", { message: { role: "toolResult" } });
  h.fire("message_end", { message: { role: "toolResult" } });
  h.fire("agent_end");
  assert.equal(h.status(), previous);
  start(h, 100000);
  delta(h, "text_delta");
  now = 102000;
  end(h, 200);
  assert.equal(h.status(), "Avg stream 100.0 tok/s");
});

test("speed works without a request hook", () => {
  const h = harness();
  h.fire("turn_start");
  h.fire("message_start", { message: { role: "assistant" } });
  now = 1000;
  delta(h, "text_delta");
  now = 5000;
  end(h);
  assert.equal(h.status(), "Avg stream 125.0 tok/s");
});

test("empty deltas and block starts do not start output timing; repeated deltas do not repaint", () => {
  const h = harness();
  start(h);
  for (const type of ["text_start", "thinking_start", "toolcall_start"]) delta(h, type);
  for (const type of ["text_delta", "thinking_delta", "toolcall_delta"]) delta(h, type, "");
  assert.equal(h.status(), undefined);
  now = 2000;
  delta(h, "text_delta");
  const writes = h.writes.length;
  for (let i = 0; i < 1000; i++) delta(h, "text_delta");
  assert.equal(h.writes.length, writes);
  now = 10000;
  end(h, 700);
  assert.equal(h.status(), "Avg stream 87.5 tok/s");
});

test("previous result stays visible through waiting, thinking, text, and tool generation until one replacement", () => {
  const h = harness();
  start(h);
  delta(h, "text_delta");
  now = 10000;
  end(h, 265);
  const previous = h.status();
  const writes = h.writes.length;
  assert.equal(previous, "Avg stream 26.5 tok/s");

  now = 20000;
  h.fire("turn_start");
  assert.equal(h.status(), previous);
  now = 22000;
  h.fire("before_provider_request");
  h.fire("message_start", { message: { role: "assistant" } });
  delta(h, "thinking_delta");
  now = 24000;
  delta(h, "text_delta");
  delta(h, "toolcall_start");
  delta(h, "toolcall_delta");
  for (let i = 0; i < 1000; i++) delta(h, "text_delta");
  assert.equal(h.status(), previous);
  assert.equal(h.writes.length, writes);

  now = 32000;
  end(h, 500, "toolUse", 100);
  assert.equal(h.writes.length, writes + 1);
  assert.equal(h.status(), "Avg stream 50.0 tok/s");
  h.fire("agent_end");
  assert.equal(h.writes.length, writes + 1);
});

test("no placeholder or status writes before the first request completes", () => {
  const h = harness();
  const writes = h.writes.length;
  start(h);
  delta(h, "thinking_delta");
  now = 1000;
  delta(h, "text_delta");
  delta(h, "toolcall_start");
  assert.equal(h.status(), undefined);
  assert.equal(h.writes.length, writes);
  now = 10000;
  end(h);
  assert.equal(h.status(), "Avg stream 50.0 tok/s");
  assert.equal(h.writes.length, writes + 1);
});

test("incomplete request with no final message preserves previous result", () => {
  const h = harness();
  start(h);
  now = 10000;
  end(h);
  const previous = h.status();
  const writes = h.writes.length;
  start(h, 20000);
  delta(h, "thinking_delta");
  delta(h, "text_delta");
  h.fire("agent_end");
  assert.equal(h.status(), previous);
  assert.equal(h.writes.length, writes);
  now = 30000;
  end(h); // A stray end must not revive the discarded measurement.
  assert.equal(h.status(), previous);
  assert.equal(h.writes.length, writes);
});

test("no invented speed without output deltas", () => {
  const h = harness();
  start(h);
  now = 10000;
  end(h);
  assert.equal(h.status(), "Avg stream -- tok/s");
});

test("thinking-only output has a speed", () => {
  const h = harness();
  start(h);
  now = 2000;
  delta(h, "thinking_delta");
  now = 7000;
  end(h, 500, "stop", 500);
  assert.equal(h.status(), "Avg stream 100.0 tok/s");
});

test("waiting before first output does not affect speed", () => {
  for (const wait of [1000, 20000]) {
    const h = harness();
    start(h);
    now = wait;
    delta(h, "text_delta");
    now += 2000;
    end(h, 100);
    assert.equal(h.status(), "Avg stream 50.0 tok/s");
  }
});

test("first output at completion has no measurable duration even after a long wait", () => {
  const h = harness();
  start(h);
  now = 10000;
  delta(h, "text_delta");
  end(h);
  assert.equal(h.status(), "Avg stream -- tok/s");
});

test("zero, absent, negative, nonfinite or fractional token usage is unavailable", () => {
  for (const output of [0, undefined, -1, NaN, Infinity, 1.5]) {
    const h = harness();
    start(h);
    delta(h, "text_delta");
    now = 5000;
    h.fire("message_end", {
      message: { role: "assistant", usage: { output }, stopReason: "stop" },
    });
    assert.equal(h.status(), "Avg stream -- tok/s");
    assert.doesNotMatch(h.status(), /NaN|Infinity/);
  }
});

test("zero-duration response has no infinite rate", () => {
  const h = harness();
  start(h);
  delta(h, "text_delta");
  end(h);
  assert.equal(h.status(), "Avg stream -- tok/s");
});

test("errors, aborts and deferred replies show only unavailable speed", () => {
  for (const reason of ["error", "aborted", "deferred"]) {
    const h = harness();
    start(h);
    delta(h, "text_delta");
    now = 1000;
    end(h, 500, reason);
    assert.equal(h.status(), "Avg stream -- tok/s");
  }
});

test("token-limit completion shows only speed", () => {
  const h = harness();
  start(h);
  delta(h, "text_delta");
  now = 10000;
  end(h, 500, "length");
  assert.equal(h.status(), "Avg stream 50.0 tok/s");
});

test("request hooks before and after output do not change output timing", () => {
  const h = harness();
  h.fire("turn_start");
  h.fire("before_provider_request");
  now = 5000;
  h.fire("before_provider_request");
  h.fire("message_start", { message: { role: "assistant" } });
  now = 6000;
  h.fire("before_provider_request");
  delta(h, "text_delta");
  now = 7000;
  h.fire("before_provider_request");
  now = 10000;
  end(h);
  assert.equal(h.status(), "Avg stream 125.0 tok/s");
});

test("session/model transitions clear result and do not synthesize old measurements", () => {
  for (const event of ["session_start", "session_tree", "model_select"]) {
    const h = harness();
    start(h);
    now = 5000;
    end(h);
    h.fire(event);
    assert.equal(h.status(), undefined);
    end(h); // e.g. stray event while viewing old history
    assert.equal(h.status(), undefined);
  }
});

test("agent termination handles incomplete requests, shutdown removes only own status", () => {
  const h = harness();
  start(h);
  h.fire("agent_end");
  assert.equal(h.status(), undefined);
  h.fire("session_shutdown");
  assert.equal(h.status(), undefined);
  assert.equal(h.statuses.get("another-extension"), "unchanged");
});

test("RPC and print modes perform no UI writes", () => {
  for (const mode of ["rpc", "print"]) {
    const h = harness(mode);
    start(h);
    delta(h, "text_delta");
    now = 10000;
    end(h);
    h.fire("agent_end");
    h.fire("session_shutdown");
    assert.equal(h.writes.length, 0);
  }
});

test("overall is default and includes waiting but excludes pre-request preparation", () => {
  const h = harness("tui", "overall");
  h.fire("turn_start");
  now = 5000;
  h.fire("before_provider_request");
  now = 15000;
  delta(h, "thinking_delta");
  now = 17000;
  end(h, 600);
  assert.equal(h.status(), "Avg overall 50.0 tok/s");
  h.command("stream");
  assert.equal(h.status(), "Avg stream 300.0 tok/s");
  h.command("");
  assert.equal(h.status(), "Avg overall 50.0 tok/s");
});

test("batch delivery shows overall speed without inheriting the stream spike", () => {
  const h = harness("tui", "overall");
  start(h);
  now = 10000;
  delta(h, "text_delta");
  now = 10500;
  end(h, 1300);
  assert.equal(h.status(), "Avg overall 123.8 tok/s");
  h.command("stream");
  assert.equal(h.status(), "Avg stream 2600.0 tok/s");
});

test("overall needs a request hook rather than silently inventing a start time", () => {
  const h = harness("tui", "overall");
  h.fire("turn_start");
  now = 1000;
  delta(h, "text_delta");
  now = 5000;
  end(h);
  assert.equal(h.status(), "Avg overall -- tok/s");
  h.command("stream");
  assert.equal(h.status(), "Avg stream 125.0 tok/s");
});

test("overall can measure a final-only reply or first content at completion", () => {
  for (const hasDelta of [false, true]) {
    const h = harness("tui", "overall");
    start(h);
    now = 10000;
    if (hasDelta) delta(h, "text_delta");
    end(h, 500);
    assert.equal(h.status(), "Avg overall 50.0 tok/s");
    h.command("stream");
    assert.equal(h.status(), "Avg stream -- tok/s");
  }
});

test("repeated request hooks keep the first timestamp, including waits within a message", () => {
  const h = harness("tui", "overall");
  h.fire("before_provider_request"); // No active main turn: ignore background requests.
  start(h, 1000);
  now = 5000;
  h.fire("before_provider_request");
  now = 7000;
  delta(h, "text_delta");
  now = 9000;
  h.fire("before_provider_request");
  now = 11000;
  end(h, 500);
  assert.equal(h.status(), "Avg overall 50.0 tok/s");
  now = 100000;
  h.fire("before_provider_request");
  h.fire("message_end", { message: { role: "toolResult" } });
  h.fire("agent_end");
  assert.equal(h.status(), "Avg overall 50.0 tok/s");
  start(h, 100000);
  now = 102000;
  end(h, 200, "toolUse");
  assert.equal(h.status(), "Avg overall 100.0 tok/s");
});

test("switching during a request re-renders the previous result without resetting timing", () => {
  const h = harness("tui", "overall");
  start(h);
  now = 2000;
  delta(h, "text_delta");
  now = 10000;
  end(h, 500);
  start(h, 20000);
  h.command("stream");
  assert.equal(h.status(), "Avg stream 62.5 tok/s");
  now = 24000;
  delta(h, "toolcall_delta");
  h.command("overall");
  assert.equal(h.status(), "Avg overall 50.0 tok/s");
  now = 30000;
  end(h, 1000, "toolUse");
  assert.equal(h.status(), "Avg overall 100.0 tok/s");
  h.command("stream");
  assert.equal(h.status(), "Avg stream 166.7 tok/s");
});

test("command status, invalid input, completions, and switching before any result", () => {
  const h = harness("tui", "overall");
  h.command("status");
  assert.deepEqual(h.notices.at(-1), { text: "Token speed: overall", type: "info" });
  const writes = h.writes.length;
  h.command("invalid");
  assert.equal(h.writes.length, writes);
  assert.equal(h.notices.at(-1).type, "warning");
  h.command("");
  assert.equal(h.status(), undefined);
  h.command("status");
  assert.equal(h.notices.at(-1).text, "Token speed: stream");
  const complete = h.commands.get("token-speed").getArgumentCompletions;
  assert.deepEqual(complete("o"), [{ value: "overall", label: "overall" }]);
  assert.equal(complete("missing"), null);
});

test("resets clear both measurements and a new runtime defaults to overall", () => {
  for (const event of ["session_start", "session_tree", "model_select", "session_shutdown"]) {
    const h = harness("tui", "overall");
    start(h);
    delta(h, "text_delta");
    now = 10000;
    end(h);
    h.fire(event);
    h.command("stream");
    assert.equal(h.status(), undefined);
    h.command("overall");
    assert.equal(h.status(), undefined);
  }
  const fresh = harness("tui", "overall");
  fresh.command("status");
  assert.equal(fresh.notices.at(-1).text, "Token speed: overall");
});

test("overall rejects invalid tokens, unsuccessful completions and nonpositive durations", () => {
  for (const output of [0, undefined, -1, NaN, Infinity, 1.5]) {
    const h = harness("tui", "overall");
    start(h);
    now = 10000;
    h.fire("message_end", {
      message: { role: "assistant", usage: { output }, stopReason: "stop" },
    });
    assert.equal(h.status(), "Avg overall -- tok/s");
  }
  for (const reason of ["error", "aborted", "deferred"]) {
    const h = harness("tui", "overall");
    start(h);
    now = 10000;
    end(h, 500, reason);
    assert.equal(h.status(), "Avg overall -- tok/s");
  }
  for (const time of [0, -100]) {
    const h = harness("tui", "overall");
    start(h);
    now = time;
    end(h);
    assert.equal(h.status(), "Avg overall -- tok/s");
  }
});

test("speed commands do not touch non-TUI UI", () => {
  for (const mode of ["rpc", "print"]) {
    const h = harness(mode, "overall");
    for (const args of ["", "status", "stream", "overall", "invalid"]) h.command(args);
    start(h);
    now = 10000;
    end(h);
    assert.equal(h.writes.length, 0);
    assert.equal(h.notices.length, 0);
  }
});

test("reasoning breakdown is never displayed", () => {
  for (const reasoning of [undefined, 0, 100, 500, -1, NaN, Infinity, 600, 1.5]) {
    const h = harness();
    start(h);
    delta(h, "text_delta");
    now = 10000;
    end(h, 500, "stop", reasoning);
    assert.equal(h.status(), "Avg stream 50.0 tok/s");
  }
});
