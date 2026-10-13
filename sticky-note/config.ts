import { closeSync, openSync, readSync } from "node:fs";
import { resolveConfigPath } from "../config-path.ts";

export interface StickyNoteConfig {
  enabled: boolean;
  state: "loaded" | "missing" | "invalid";
}

const OFF = (state: StickyNoteConfig["state"]): StickyNoteConfig => ({ enabled: false, state });

/** Read once per extension load. Never fall back past an invalid private file. */
export function loadStickyNoteConfig(path = resolveConfigPath()): StickyNoteConfig {
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
  const value = (data as Record<string, unknown>).stickyNote;
  if (value === undefined) return OFF("missing");
  if (typeof value !== "object" || value === null || Array.isArray(value)) return OFF("invalid");
  const { enabled } = value as Record<string, unknown>;
  if (typeof enabled !== "boolean") return OFF("invalid");
  return { enabled, state: "loaded" };
}
