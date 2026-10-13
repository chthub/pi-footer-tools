// Resolve host APIs through installed Pi, just as its loader does (verified on 1.1.0).
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const executable = execFileSync("bash", ["-c", "command -v pi"], { encoding: "utf8" }).trim();
let dir = dirname(realpathSync(executable));
while (!existsSync(join(dir, "package.json"))) {
  const parent = dirname(dir);
  if (parent === dir) throw new Error("Installed Pi package not found");
  dir = parent;
}
export const piRoot = dir;
export const piPackage = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
if (piPackage.name !== "@earendil-works/pi-coding-agent") {
  throw new Error("These verification tests require an installed @earendil-works/pi-coding-agent");
}
export const hostRequire = createRequire(join(dir, "package.json"));
const { createJiti } = hostRequire("jiti");
export const alias = {
  "@earendil-works/pi-coding-agent": join(dir, "dist/index.js"),
  "@earendil-works/pi-tui": join(dir, "node_modules/@earendil-works/pi-tui/dist/index.js"),
};
export const jiti = createJiti(import.meta.url, { alias });
export const integratedPath = new URL("../../index.ts", import.meta.url).pathname;
export const telegramPath = new URL("../../telegram-notify/index.ts", import.meta.url).pathname;
const extensionModule = await jiti.import(telegramPath);
export const registerTelegramNotify = extensionModule.registerTelegramNotify;
export const factory = extensionModule.default;
export const notificationText = extensionModule.notificationText;
export const Receiver = (await jiti.import(new URL("../../telegram-notify/receiver.ts", import.meta.url).pathname)).Receiver;
export const { loadTelegramNotifyConfig } = await jiti.import(new URL("../../telegram-notify/config.ts", import.meta.url).pathname);
export const { resolveConfigPath, DEFAULT_CONFIG_PATH } = await jiti.import(new URL("../../config-path.ts", import.meta.url).pathname);
export const integratedFactory = (await jiti.import(integratedPath)).default;
export const hostImport = (path) => import(pathToFileURL(join(piRoot, path)).href);
