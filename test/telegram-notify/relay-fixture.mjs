// TEST ONLY: collector with fake Telegram updates. No outbound network requests.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createRelay } from "../../telegram-notify/relay.mjs";

const tokenHash = createHash("sha256").update("test-only:json-token").digest("hex");
const dir = join(tmpdir(), `pi-telegram-${process.getuid()}`);
mkdirSync(dir, { mode: 0o700, recursive: true });
const socketPath = join(dir, tokenHash.slice(0, 20) + ".sock");
const updatesFile = join(process.argv[2], "updates.jsonl");
const relay = await createRelay({ socketPath, tokenHash, initialIdleMs: 30000,
  fetchImpl: async (_url, options) => {
    await sleep(50, undefined, { signal: options.signal });
    const { offset } = JSON.parse(options.body);
    const updates = readFileSync(updatesFile, "utf8").split("\n").filter(Boolean).map((s) => JSON.parse(s));
    const result = offset < 0 ? updates.slice(-1) : updates.filter((u) => u.update_id >= offset);
    return new Response(JSON.stringify({ ok: true, result }));
  },
});
console.log("READY");
process.on("SIGTERM", () => { void relay.close(); });
process.on("SIGINT", () => { void relay.close(); });
