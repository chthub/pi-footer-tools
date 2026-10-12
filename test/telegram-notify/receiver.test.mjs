import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createRelay, authorized } from "../../telegram-notify/relay.mjs";
import { Receiver } from "./installed.mjs";

async function wait(predicate, label, timeout = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (predicate()) return;
    await sleep(10);
  }
  assert.fail(label);
}
const token = "test-only:relay-token";
const tokenHash = createHash("sha256").update(token).digest("hex");
const update = (id, reply, text, extra = {}) => ({ update_id: id, message: {
  text, chat: { id: 123, type: "private" }, from: { id: 123, is_bot: false },
  reply_to_message: { message_id: reply }, ...extra,
}});

async function fixture(initial = []) {
  const dir = mkdtempSync(join(tmpdir(), "pi-tg-test-"));
  const socketPath = join(dir, "relay.sock");
  const pending = [...initial];
  const bodies = [];
  let concurrent = 0, maximum = 0, fail = false;
  const fetchImpl = async (_url, options) => {
    const body = JSON.parse(options.body);
    bodies.push(body);
    concurrent++;
    maximum = Math.max(maximum, concurrent);
    try {
      await sleep(20, undefined, { signal: options.signal });
      if (fail) throw new Error("secret error must not be displayed");
      return new Response(JSON.stringify({ ok: true, result: pending.splice(0) }));
    } finally { concurrent--; }
  };
  let relay = await createRelay({ socketPath, tokenHash, fetchImpl, initialIdleMs: 30000 });
  const clients = [];
  function client(chatId = "123", allowedUserIds = []) {
    const messages = [], states = [];
    const receiver = new Receiver({ token, chatId, allowedUserIds, socketPath, launch: () => {},
      onText: (text) => messages.push(text), onStatus: (s) => states.push(s) });
    clients.push(receiver);
    return { receiver, messages, states };
  }
  return { client, pending, bodies, dir, socketPath,
    maxConcurrent: () => maximum,
    isListening: () => relay.server.listening,
    setFailure: (value) => { fail = value; },
    restart: async () => {
      await relay.close();
      relay = await createRelay({ socketPath, tokenHash, fetchImpl, initialIdleMs: 30000 });
    },
    close: async () => {
      for (const client of clients) client.stop();
      await relay.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("single collector routes replies to two windows; unauthorized/unaddressed updates never broadcast", async () => {
  const f = await fixture();
  try {
    const a = f.client(), b = f.client();
    a.receiver.remember(11); b.receiver.remember(22); // Also tests pre-connect registration.
    await wait(() => a.states.includes("READY") && b.states.includes("READY"), "collector ready");
    f.pending.push(update(1, 11, "window A"), update(2, 22, "window B"),
      update(3, 11, "wrong chat", { chat: { id: 999, type: "private" } }),
      update(4, 11, "wrong sender", { from: { id: 999, is_bot: false } }),
      update(5, 11, "bot", { from: { id: 123, is_bot: true } }),
      update(6, 333, "unknown target"), update(7, 11, "no reply", { reply_to_message: undefined }),
      update(8, 11, "group blocked", { chat: { id: 123, type: "group" } }),
      update(9, 11, "accepted"));
    await wait(() => a.messages.length === 2 && b.messages.length === 1, "per-window routing");
    assert.deepEqual(a.messages, ["window A", "accepted"]);
    assert.deepEqual(b.messages, ["window B"]);
    assert.equal(f.maxConcurrent(), 1);
    assert.equal(statSync(f.socketPath).mode & 0o777, 0o600);
    assert.equal(f.bodies[0].offset, -1);
    assert.deepEqual(f.bodies[0].allowed_updates, ["message"]);
    assert.ok(f.bodies.some((body) => body.timeout === 25));
    f.pending.push(update(9, 11, "duplicate"), update(10, 22, "B next"));
    await wait(() => b.messages.length === 2, "next update delivered");
    assert.deepEqual(a.messages, ["window A", "accepted"]);
    assert.ok(f.bodies.some((body) => body.offset >= 10));
  } finally { await f.close(); }
});

test("pre-activation backlog is dropped; stopping one window does not stop another", async () => {
  const f = await fixture([update(50, 11, "old stale instruction")]);
  try {
    const a = f.client(), b = f.client();
    a.receiver.remember(11); b.receiver.remember(22);
    await wait(() => a.states.includes("READY"), "bootstrap finished");
    assert.deepEqual(a.messages, []);
    a.receiver.stop();
    await sleep(50);
    f.pending.push(update(51, 11, "closed A"), update(52, 22, "live B"));
    await wait(() => b.messages.length === 1, "B still receives");
    assert.deepEqual(a.messages, []);
    assert.deepEqual(b.messages, ["live B"]);
  } finally { await f.close(); }
});

test("collector reconnect re-registers live routes; shutdown retains no model prompts", async () => {
  const f = await fixture();
  try {
    const a = f.client();
    a.receiver.remember(11);
    await wait(() => a.states.includes("READY"), "first ready");
    a.states.length = 0;
    await f.restart();
    await wait(() => a.states.includes("WAIT") && a.states.includes("READY"), "reconnected");
    f.pending.push(update(1, 11, "after restart"));
    await wait(() => a.messages.length === 1, "route survived collector restart");
    assert.deepEqual(a.messages, ["after restart"]);
    a.receiver.stop();
    f.pending.push(update(2, 11, "after stop"));
    await sleep(300);
    assert.equal(a.messages.length, 1);
  } finally { await f.close(); }
});

test("polling failure backs off with generic status and later recovers", async () => {
  const f = await fixture();
  try {
    f.setFailure(true);
    const a = f.client();
    await wait(() => a.states.includes("ERR"), "sanitized failure status");
    const calls = f.bodies.length;
    await sleep(300);
    assert.equal(f.bodies.length, calls); // No tight retry loop.
    f.setFailure(false);
    await wait(() => a.states.includes("READY"), "recovery");
    assert.ok(a.states.every((s) => ["WAIT", "ERR", "READY"].includes(s)));
  } finally { await f.close(); }
});

test("wrong bot handshake and oversized frames are rejected without compromising live routes", async () => {
  const f = await fixture();
  try {
    const attacker = createConnection(f.socketPath);
    attacker.on("error", () => {});
    attacker.on("connect", () => attacker.write(JSON.stringify({ op: "register", token: "wrong",
      chatId: "123", allowedUserIds: [], ids: [11] }) + "\n"));
    await wait(() => attacker.destroyed, "wrong bot disconnected");
    assert.equal(f.bodies.length, 0);
    const oversized = createConnection(f.socketPath);
    oversized.on("error", () => {});
    oversized.on("connect", () => oversized.write("x".repeat(40000)));
    await wait(() => oversized.destroyed, "oversized frame disconnected");
    const a = f.client();
    a.receiver.remember(11);
    await wait(() => a.states.includes("READY"), "legitimate window ready");
    f.pending.push(update(1, 11, "valid"));
    await wait(() => a.messages.length === 1, "legitimate route unaffected");
  } finally { await f.close(); }
});

test("ambiguous reply routes fail closed instead of broadcasting a model prompt", async () => {
  const f = await fixture();
  try {
    const a = f.client(), b = f.client();
    a.receiver.remember(11); b.receiver.remember(11);
    await wait(() => a.states.includes("READY") && b.states.includes("READY"), "registered");
    b.receiver.remember(22);
    await sleep(30);
    f.pending.push(update(1, 11, "ambiguous"), update(2, 22, "only B"));
    await wait(() => b.messages.length === 1, "unique route");
    assert.deepEqual(a.messages, []);
    assert.deepEqual(b.messages, ["only B"]);
  } finally { await f.close(); }
});

test("collector stops polling and exits when the last active receiver disconnects", async () => {
  const f = await fixture();
  try {
    const a = f.client();
    await wait(() => a.states.includes("READY"), "ready");
    a.receiver.stop();
    await wait(() => !f.isListening(), "collector idle shutdown");
    const calls = f.bodies.length;
    await sleep(250);
    assert.equal(f.bodies.length, calls);
  } finally { await f.close(); }
});

test("group chats require explicit sender allowlist; channel/business/bot inputs are denied", () => {
  const registration = { chatId: "-100123", allowedUserIds: ["456"] };
  const message = { text: "hello", chat: { id: -100123, type: "supergroup" },
    from: { id: 456, is_bot: false } };
  assert.equal(authorized(message, registration), true);
  assert.equal(authorized(message, { ...registration, allowedUserIds: [] }), false);
  assert.equal(authorized({ ...message, from: { id: 999 } }, registration), false);
  assert.equal(authorized({ ...message, sender_chat: {} }, registration), false);
  assert.equal(authorized({ ...message, business_connection_id: "x" }, registration), false);
  assert.equal(authorized({ ...message, chat: { id: -100123, type: "channel" } }, registration), false);
});
