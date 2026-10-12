import { lstatSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_CONFIG_PATH = fileURLToPath(new URL("./config.json", import.meta.url));

/** Whole-file replacement, not a merge. Never fall back past an invalid private file. */
export function resolveConfigPath(home = homedir(), override = process.env.PI_TOKEN_SPEED_CONFIG): string {
  if (override) return resolve(override.startsWith("~/") ? join(home, override.slice(2)) : override);
  const personal = join(home, ".pi", "token-speed.json");
  try { lstatSync(personal); return personal; }
  catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return DEFAULT_CONFIG_PATH;
    return personal; // unreadable: the feature loaders fail closed
  }
}
