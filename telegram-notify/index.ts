import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Receiver, type ReceiverStatus } from "./receiver.ts";
import { loadTelegramNotifyConfig } from "./config.ts";

const STATUS_KEY = "telegram-notify";
const SHORTCUT = "alt+n";
const TIMEOUT_MS = 5_000;
const CONFIG_FILE = "telegram-notify.json";

export function notificationText(text: string, token: string): string {
  const safe = (text.trim() || "Pi 已结束（本次没有可发送的文本回复）。")
    .split(token).join("[REDACTED TELEGRAM TOKEN]")
    .split(encodeURIComponent(token)).join("[REDACTED TELEGRAM TOKEN]");
  if (safe.length <= 4096) return safe;
  const suffix = "\n\n[回复过长，已截断；完整内容请查看 Pi 窗口。]";
  let head = safe.slice(0, 4096 - suffix.length);
  if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1);
  return head + suffix;
}

export interface TelegramNotifyOptions { configPath?: string }

/** Capability is opt-in; the separate window switch always starts OFF. */
export function registerTelegramNotify(pi: ExtensionAPI, options: TelegramNotifyOptions = {}): void {
  const config = loadTelegramNotifyConfig(options.configPath);
  if (config.state === "invalid") {
    let warned = false;
    pi.on("session_start", (_event, ctx) => {
      if (warned || ctx.mode !== "tui") return;
      warned = true;
      // Never include parser exceptions: config files may contain private data.
      ctx.ui.notify("TG: telegramNotify 配置无法读取或格式错误；功能已关闭。", "warning");
    });
  }
  if (!config.enabled) return;
  let enabled = false;
  let active = false;
  let fileCredentials: { token?: string; chatId?: string } = {};
  let configError = false;
  let lastAssistantText = "";
  let receiveMessages = false;
  let allowedUserIds: string[] = [];
  let receiver: Receiver | undefined;
  let receiverStatus: ReceiverStatus | undefined;
  let receiverWarned = false;
  const requests = new Set<AbortController>();

  function loadConfig(): void {
    fileCredentials = {};
    configError = false;
    receiveMessages = false;
    allowedUserIds = [];
    try {
      const parsed: unknown = JSON.parse(readFileSync(join(getAgentDir(), CONFIG_FILE), "utf8"));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
      const config = parsed as Record<string, unknown>;
      for (const key of ["token", "chatId"]) {
        if (config[key] !== undefined && typeof config[key] !== "string") throw new Error();
      }
      if (config.receiveMessages !== undefined && typeof config.receiveMessages !== "boolean") throw new Error();
      if (config.allowedUserIds !== undefined && (!Array.isArray(config.allowedUserIds) ||
          config.allowedUserIds.length > 100 ||
          !config.allowedUserIds.every((id) => typeof id === "string" && /^\d+$/.test(id)))) throw new Error();
      receiveMessages = config.receiveMessages === true;
      allowedUserIds = (config.allowedUserIds as string[] | undefined) ?? [];
      // Ignore any persisted "enabled" value.
      fileCredentials = {
        token: (config.token as string | undefined)?.trim(),
        chatId: (config.chatId as string | undefined)?.trim(),
      };
    } catch (error) {
      // JSON parser errors may quote secrets. Never display the exception.
      configError = (error as NodeJS.ErrnoException)?.code !== "ENOENT";
    }
  }

  function credentials() {
    return {
      token: process.env.TELEGRAM_BOT_TOKEN?.trim() || fileCredentials.token,
      chatId: process.env.TELEGRAM_CHAT_ID?.trim() || fileCredentials.chatId,
    };
  }

  function updateStatus(ctx: ExtensionContext): void {
    if (ctx.mode !== "tui") return;
    const { token, chatId } = credentials();
    const config = token && chatId ? "" : " · UNCONFIGURED";
    const rx = enabled && receiveMessages ? ` · RX:${receiverStatus ?? "WAIT"}` : "";
    ctx.ui.setStatus(STATUS_KEY, `TG: ${enabled ? "ON" : "OFF"} [Alt+N]${config}${rx}`);
  }

  function warn(ctx: ExtensionContext, text: string): void {
    // Do not allow a torn-down UI (or a delivery error) to reject detached work.
    try {
      if (active && ctx.mode === "tui") ctx.ui.notify(text, "warning");
    } catch {
      // Best effort, including local feedback.
    }
  }

  function cancelRequests(): void {
    for (const controller of requests) controller.abort();
    requests.clear();
  }

  function stopReceiver(): void {
    receiver?.stop();
    receiver = undefined;
    receiverStatus = undefined;
    receiverWarned = false;
  }

  function startReceiver(ctx: ExtensionContext, token: string, chatId: string): void {
    if (receiver || !receiveMessages) return;
    try {
      if (!/^-?\d+$/.test(chatId)) throw new Error();
      receiver = new Receiver({
        token, chatId, allowedUserIds,
        onStatus: (status) => {
          if (!active || !enabled) return;
          if (status === "ERR" && !receiverWarned) {
            receiverWarned = true;
            warn(ctx, "TG: 收件暂不可用；请检查网络、flock，以及 bot 是否被其他收件程序占用。");
          }
          if (status === "READY") receiverWarned = false;
          receiverStatus = status;
          updateStatus(ctx);
        },
        onText: (text) => {
          if (!active || !enabled) return;
          // Pi queues follow-ups while streaming; idle delivery starts a run.
          // Do not treat Telegram slash text as local commands/template expansion.
          pi.sendUserMessage(text, { deliverAs: "followUp", expandPromptTemplates: false });
          ctx.ui.notify("TG: 已接收 Telegram 回复并交给模型。", "info");
        },
      });
    } catch {
      receiverStatus = "ERR";
      warn(ctx, "TG: 无法启动安全的本机收件入口；发送通知仍可使用。");
    }
  }

  function setEnabled(value: boolean, ctx: ExtensionContext): void {
    if (ctx.mode !== "tui" || !active) return;
    const { token, chatId } = credentials();
    if (value && (!token || !chatId)) {
      const missing = [
        !token && "TELEGRAM_BOT_TOKEN",
        !chatId && "TELEGRAM_CHAT_ID",
      ].filter(Boolean).join(", ");
      enabled = false;
      warn(ctx, configError
        ? "TG: telegram-notify.json 无法读取或格式错误；通知仍为 OFF。"
        : `TG: 未配置 ${missing}；可在用户级 telegram-notify.json 配置 token、chatId；通知仍为 OFF。`);
    } else {
      enabled = value;
    }
    if (!enabled) {
      cancelRequests();
      stopReceiver();
    } else if (token && chatId) {
      startReceiver(ctx, token, chatId);
    }
    updateStatus(ctx);
  }

  async function deliver(ctx: ExtensionContext, token: string, chatId: string, text: string): Promise<void> {
    const targetReceiver = receiver;
    const controller = new AbortController();
    requests.add(controller);
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
    timeout.unref();
    try {
      const response = await fetch(
        `https://api.telegram.org/bot${encodeURIComponent(token)}/sendMessage`,
        {
          method: "POST",
          redirect: "error",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text: notificationText(text, token),
          }),
          signal: controller.signal,
        },
      );
      // Telegram can report a failure in JSON. Never display its body or the URL.
      const result: unknown = await response.json();
      if (!response.ok || typeof result !== "object" || result === null ||
          !("ok" in result) || result.ok !== true) {
        warn(ctx, "TG: 发送失败；Pi 可继续使用（不重试）。");
      } else if ("result" in result && typeof result.result === "object" && result.result !== null &&
          "message_id" in result.result && typeof result.result.message_id === "number" &&
          active && enabled && targetReceiver === receiver) {
        targetReceiver?.remember(result.result.message_id);
      }
    } catch {
      // Abort on OFF/shutdown is intentional. Timeout/network errors are generic.
      if (requests.has(controller)) {
        warn(ctx, "TG: 发送失败或超时；Pi 可继续使用（不重试）。");
      }
    } finally {
      clearTimeout(timeout);
      requests.delete(controller);
    }
  }

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    active = true;
    loadConfig();
    updateStatus(ctx);
  });

  pi.registerShortcut(SHORTCUT, {
    description: "Toggle per-window Telegram completion notifications",
    handler: (ctx) => setEnabled(!enabled, ctx),
  });

  pi.registerCommand("notify", {
    description: "Telegram notification switch: /notify [on|off|status]",
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase();
      if (action === "on") setEnabled(true, ctx);
      else if (action === "off") setEnabled(false, ctx);
      else if (action === "") setEnabled(!enabled, ctx);
      else if (action !== "status") {
        warn(ctx, "用法：/notify [on|off|status]");
        return;
      }
      updateStatus(ctx);
      if (ctx.mode === "tui") {
        ctx.ui.notify(`TG: ${enabled ? "ON" : "OFF"} [Alt+N]`, "info");
      }
    },
  });

  pi.on("before_agent_start", () => { lastAssistantText = ""; });
  pi.on("message_end", (event) => {
    if (!active || event.message.role !== "assistant") return;
    lastAssistantText = event.message.content.filter((part) => part.type === "text")
      .map((part) => part.text).join("\n").trim();
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (!active || !enabled || ctx.mode !== "tui") return;
    const { token, chatId } = credentials();
    if (!token || !chatId) {
      setEnabled(false, ctx);
      warn(ctx, "TG: Telegram 凭据缺失；通知已关闭。");
      return;
    }
    // Pi awaits lifecycle handlers. Deliberately detach bounded, fully caught I/O
    // so waiting for Telegram never delays Pi becoming idle.
    void deliver(ctx, token, chatId, lastAssistantText);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    active = false;
    enabled = false;
    cancelRequests();
    stopReceiver();
    lastAssistantText = "";
    if (ctx.mode === "tui") ctx.ui.setStatus(STATUS_KEY, undefined);
  });
}

export default registerTelegramNotify;
