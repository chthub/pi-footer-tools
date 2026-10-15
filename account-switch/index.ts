import { homedir } from "node:os";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadAccountSwitchConfig } from "./config.ts";
import { resolveConfigPath } from "../config-path.ts";
import { PROVIDER, attachRouting } from "./routing.ts";
import { createAccountChannel, registerChildLaunch } from "./channel.ts";

const STATUS_KEY = "account-switch";
export interface AccountSwitchOptions {
  configPath?: string;
  home?: string;
  agentDir?: string;
  onSwitch?: (ctx: ExtensionContext) => void;
}

/** Only authentication changes; sessions, model, settings and environment stay put. */
export function registerAccountSwitch(pi: ExtensionAPI, options: AccountSwitchOptions = {}) {
  const config = loadAccountSwitchConfig(options.configPath ?? resolveConfigPath(), options.home ?? homedir());
  const accountNames = config.accounts.map(profile => profile.name);
  const isAccountName = (name: string) => accountNames.includes(name);
  if (config.state === "invalid") {
    pi.on("session_start", (_event, ctx) => {
      if (ctx.mode === "tui") ctx.ui.notify("Account switch: accountSwitch 配置无效，功能已关闭。", "warning");
    });
  }
  if (!config.enabled) return;

  let routing: ReturnType<typeof attachRouting> | undefined;
  let channel: ReturnType<typeof createAccountChannel> | undefined;
  let unsubscribe: (() => void) | undefined;
  let busy = false;
  let shown: string | undefined;
  function show(ctx: ExtensionContext, provider = ctx.model?.provider) {
    if (ctx.mode !== "tui") return;
    const text = routing ? `${routing.name}${provider === PROVIDER ? "" : " (Codex only)"}` : undefined;
    const styled = text === undefined ? undefined : ctx.ui.theme.fg("dim", text);
    if (styled === shown) return;
    shown = styled;
    ctx.ui.setStatus(STATUS_KEY, styled);
  }
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    try {
      routing = attachRouting(ctx.modelRegistry, options.agentDir ?? getAgentDir(), config.accounts);
      channel = createAccountChannel(routing.selection);
      unsubscribe = registerChildLaunch(pi, () => channel?.path);
      show(ctx);
    } catch {
      routing?.detach();
      routing = undefined;
      channel?.close();
      channel = undefined;
      show(ctx);
      ctx.ui.notify("Account switch: 当前 Pi 认证存储不兼容或存在 Codex 运行时密钥，未启用切换。", "warning");
    }
  });
  pi.on("model_select", (event, ctx) => {
    if (routing) show(ctx, event.model.provider);
  });
  pi.on("agent_end", (_event, ctx) => show(ctx));
  pi.on("session_shutdown", (event, ctx) => {
    unsubscribe?.();
    unsubscribe = undefined;
    channel?.close();
    channel = undefined;
    routing?.detach(event.reason === "reload");
    routing = undefined;
    busy = false;
    shown = undefined;
    if (ctx.mode === "tui") ctx.ui.setStatus(STATUS_KEY, undefined);
  });

  pi.registerCommand("switch-account", {
    description: "切换已配置的 ChatGPT/Codex 账户，保留当前对话",
    getArgumentCompletions: prefix => [...accountNames, "status"].filter(name => name.startsWith(prefix)).map(name => ({ value: name, label: name })),
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") {
        if (ctx.hasUI) ctx.ui.notify("/switch-account 仅支持交互式终端。", "warning");
        return;
      }
      if (!routing) {
        ctx.ui.notify("账户切换不可用；请确认 Pi 版本兼容且没有 Codex 运行时密钥。", "warning");
        return;
      }
      const controller = routing;
      let name = args.trim();
      if (name === "status") {
        show(ctx);
        ctx.ui.notify(`ChatGPT/Codex 账户：${controller.name}。只切换认证，不切换配置或会话目录。`, "info");
        return;
      }
      if (name && !isAccountName(name)) {
        ctx.ui.notify("用法：/switch-account [账户名|status]；不带参数查看已配置账户。", "warning");
        return;
      }
      if (busy || !ctx.isIdle() || ctx.hasPendingMessages()) {
        ctx.ui.notify("请先按 Esc 停止当前请求／重试，并处理排队消息，再切换账户。", "warning");
        return;
      }
      busy = true;
      try {
        if (!name) {
          const entries = accountNames.map(value => value === controller.name ? `${value} (current)` : value);
          const chosen = await ctx.ui.select("切换 ChatGPT/Codex 账户", entries);
          if (!chosen) return;
          name = accountNames[entries.indexOf(chosen)] ?? "";
        }
        if (!isAccountName(name)) return;
        if (controller !== routing || !ctx.isIdle() || ctx.hasPendingMessages()) {
          ctx.ui.notify("会话状态已变化，未切换账户。", "warning");
          return;
        }
        await controller.switchTo(name, () => controller === routing && ctx.isIdle() && !ctx.hasPendingMessages(),
          selection => {
            if (!channel) throw new Error("missing-account-channel");
            channel.publish(selection);
          });
        show(ctx);
        // An optional observer must not turn a successful auth switch into a failure.
        try { options.onSwitch?.(ctx); } catch { /* Auth routing is already committed. */ }
        ctx.ui.notify(`已切换到 ${name}，当前对话和模型保留；主代理及已联动子代理的下一次请求使用此账户。正在进行的请求不重发。`, "info");
      } catch {
        // Auth/storage/provider error messages can contain sensitive data.
        ctx.ui.notify("切换失败，原账户保留。请确认目标账户已登录 ChatGPT/Codex、auth.json 可读，且当前请求已停止。", "error");
      } finally { busy = false; }
    },
  });
}
