import { open } from "node:fs/promises";
import { DEFAULT_CONFIG_PATH, resolveConfigPath } from "../config-path.ts";
import { object } from "./core.ts";

export { DEFAULT_CONFIG_PATH };
export interface Defaults {
  enabledByDefault: boolean;
  state: "loaded" | "missing" | "invalid";
}

/** Read only our small, explicit configuration file; malformed defaults fail closed. */
export async function loadDefaults(path = resolveConfigPath()): Promise<Defaults> {
  try {
    const handle = await open(path, "r");
    let text: string;
    try {
      // A single read can be short, so accumulate until EOF or one byte beyond the limit.
      const buffer = Buffer.alloc(8193);
      let bytes = 0;
      while (bytes < buffer.length) {
        const { bytesRead } = await handle.read(buffer, bytes, buffer.length - bytes, null);
        if (bytesRead === 0) break;
        bytes += bytesRead;
      }
      if (bytes > 8192) return { enabledByDefault: false, state: "invalid" };
      text = buffer.toString("utf8", 0, bytes);
    } finally { await handle.close(); }
    const data: unknown = JSON.parse(text);
    const enabled = object(object(data)?.cacheDiagnostics)?.enabledByDefault;
    return typeof enabled === "boolean"
      ? { enabledByDefault: enabled, state: "loaded" }
      : { enabledByDefault: false, state: "invalid" };
  } catch (error) {
    // Never expose configuration contents or exception messages to a model or log.
    const missing = typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
    return { enabledByDefault: false, state: missing ? "missing" : "invalid" };
  }
}
