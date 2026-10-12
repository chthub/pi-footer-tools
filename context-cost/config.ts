import { closeSync, openSync, readSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DEFAULT_STARTUP_TOKENS, type StartupMode } from "./core.ts";

export const DEFAULT_CONFIG_PATH = fileURLToPath(new URL("../config.json", import.meta.url));
export interface ContextCostConfig {
  enabled: boolean;
  startupMode: StartupMode;
  /** Fixed background a fresh window loads; positive integer token count. */
  startupTokens: number;
  state: "loaded" | "missing" | "invalid";
}

const OFF = (state: ContextCostConfig["state"]): ContextCostConfig => ({
  enabled: false, startupMode: "cache-write", startupTokens: DEFAULT_STARTUP_TOKENS, state,
});

function section(data: object): Record<string, unknown> | undefined {
  const value = (data as Record<string, unknown>).contextCost;
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/**
 * Read once per extension load (/reload re-reads). Absent section means off;
 * malformed values fail closed instead of silently switching the pricing basis.
 */
export function loadContextCostConfig(path = DEFAULT_CONFIG_PATH): ContextCostConfig {
  let text: string;
  try {
    const fd = openSync(path, "r");
    try {
      const buffer = Buffer.alloc(8193);
      let bytes = 0;
      while (bytes < buffer.length) {
        const read = readSync(fd, buffer, bytes, buffer.length - bytes, null);
        if (read === 0) break;
        bytes += read;
      }
      if (bytes > 8192) return OFF("invalid");
      text = buffer.toString("utf8", 0, bytes);
    } finally { closeSync(fd); }
  } catch (error) {
    const missing = typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
    return OFF(missing ? "missing" : "invalid");
  }
  let data: unknown;
  try { data = JSON.parse(text); } catch { return OFF("invalid"); }
  if (typeof data !== "object" || data === null || Array.isArray(data)) return OFF("invalid");
  const config = section(data);
  if (config === undefined) return OFF("contextCost" in data ? "invalid" : "missing");
  const { enabled, startupMode = "cache-write", startupTokens = DEFAULT_STARTUP_TOKENS } = config;
  if (typeof enabled !== "boolean" || (startupMode !== "cache-write" && startupMode !== "uncached-input")) return OFF("invalid");
  if (!Number.isSafeInteger(startupTokens) || (startupTokens as number) <= 0) return OFF("invalid");
  return { enabled, startupMode, startupTokens: startupTokens as number, state: "loaded" };
}
