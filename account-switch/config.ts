import { closeSync, openSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { DEFAULT_CONFIG_PATH, resolveConfigPath } from "../config-path.ts";

export { DEFAULT_CONFIG_PATH };
export interface AccountProfile { name: string; agentDir: string }
export interface AccountSwitchConfig {
  enabled: boolean;
  accounts: AccountProfile[];
  state: "loaded" | "missing" | "invalid";
}

/** Independent switch with explicit profiles; no shell aliases or directories are scanned. */
export function loadAccountSwitchConfig(path = resolveConfigPath(), home = homedir()): AccountSwitchConfig {
  const off = (state: AccountSwitchConfig["state"]): AccountSwitchConfig => ({ enabled: false, accounts: [], state });
  let text: string;
  try {
    const fd = openSync(path, "r");
    try {
      const buffer = Buffer.alloc(8193);
      let bytes = 0;
      while (bytes < buffer.length) {
        const count = readSync(fd, buffer, bytes, buffer.length - bytes, null);
        if (!count) break;
        bytes += count;
      }
      if (bytes > 8192) return off("invalid");
      text = buffer.toString("utf8", 0, bytes);
    } finally { closeSync(fd); }
  } catch (error) {
    return off(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT" ? "missing" : "invalid");
  }
  let data: unknown;
  try { data = JSON.parse(text); } catch { return off("invalid"); }
  if (typeof data !== "object" || data === null || Array.isArray(data)) return off("invalid");
  if (!("accountSwitch" in data)) return off("missing");
  const section = data.accountSwitch;
  if (typeof section !== "object" || section === null || Array.isArray(section)
    || !("enabled" in section) || typeof section.enabled !== "boolean") return off("invalid");
  const raw = "accounts" in section ? section.accounts : [];
  if (!Array.isArray(raw) || raw.length > 64 || (section.enabled && !raw.length)) return off("invalid");
  const accounts: AccountProfile[] = [];
  const names = new Set<string>();
  for (const value of raw) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return off("invalid");
    const { name, agentDir } = value as Record<string, unknown>;
    // Slash-command-friendly, bounded labels; reject reserved command arguments.
    if (typeof name !== "string" || !/^[\p{L}\p{N}_][\p{L}\p{N}_.-]{0,63}$/u.test(name)
      || name === "status" || names.has(name) || typeof agentDir !== "string" || !agentDir
      || /[\x00-\x1f\x7f-\x9f]/.test(agentDir)) return off("invalid");
    const expanded = agentDir.startsWith("~/") ? join(home, agentDir.slice(2)) : agentDir;
    if (!isAbsolute(expanded)) return off("invalid");
    names.add(name);
    accounts.push({ name, agentDir: resolve(expanded) });
  }
  return { enabled: section.enabled, accounts, state: "loaded" };
}
