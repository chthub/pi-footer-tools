import { chmodSync, lstatSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AccountSelection } from "./routing.ts";

export const CHILD_LAUNCH_EVENT = "pi-subagents:child-launch:v1";
export const CHANNEL_ENV = "PI_FOOTER_CODEX_ACCOUNT_CHANNEL";
const CHILD_EXTENSION = fileURLToPath(new URL("./child-extension.ts", import.meta.url));

function selection(value: unknown): AccountSelection {
  if (typeof value !== "object" || value === null) throw new Error("invalid-account-channel");
  const data = value as Record<string, unknown>;
  if (typeof data.name !== "string" || !data.name || data.name.length > 256
    || typeof data.authPath !== "string" || !isAbsolute(data.authPath) || data.authPath.length > 4096
    || /[\x00-\x1f\x7f]/.test(data.name + data.authPath)) throw new Error("invalid-account-channel");
  return { name: data.name, authPath: data.authPath };
}

/** A per-window capability file: labels and paths only, never credentials. */
export function createAccountChannel(initial: AccountSelection) {
  const directory = mkdtempSync(join(tmpdir(), "pi-codex-route-"));
  const path = join(directory, "selection.json");
  const publish = (value: AccountSelection) => {
    const data = selection(value);
    const temporary = join(directory, "selection.next");
    try {
      writeFileSync(temporary, JSON.stringify({ version: 1, ...data }), { mode: 0o600 });
      renameSync(temporary, path);
    } catch (error) {
      // Nothing may throw after rename: publication is the transaction commit.
      try { rmSync(temporary, { force: true }); } catch { /* Best-effort cleanup of a token-free file. */ }
      throw error;
    }
  };
  try {
    chmodSync(directory, 0o700);
    publish(initial);
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  return { path, publish, close: () => rmSync(directory, { recursive: true, force: true }) };
}

/** Missing/corrupt channels fail closed instead of silently using the launch account. */
export function readAccountChannel(path: string): AccountSelection {
  try {
    if (!isAbsolute(path)) throw new Error();
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > 16384 || (stat.mode & 0o077)
      || (process.getuid && stat.uid !== process.getuid())) throw new Error();
    const data: unknown = JSON.parse(readFileSync(path, "utf8"));
    if ((data as { version?: unknown } | null)?.version !== 1) throw new Error();
    return selection(data);
  } catch {
    // Do not include file contents or paths in errors surfaced by RPC.
    throw new Error("Codex account synchronization unavailable; reload the parent window.");
  }
}

/** Register only for this runtime; no process-global environment is mutated. */
export function registerChildLaunch(pi: ExtensionAPI, channelPath: () => string | undefined) {
  return pi.events.on(CHILD_LAUNCH_EVENT, value => {
    const path = channelPath();
    if (!path || typeof value !== "object" || value === null) return;
    const request = value as { env: Record<string, string>; extensions: string[]; error?: string };
    try {
      readAccountChannel(path);
      request.env[CHANNEL_ENV] = path;
      if (!request.extensions.includes(CHILD_EXTENSION)) request.extensions.push(CHILD_EXTENSION);
    } catch {
      request.error = "Codex account synchronization unavailable; reload the parent window.";
    }
  });
}
