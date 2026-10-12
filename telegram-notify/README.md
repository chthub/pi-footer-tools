# 可选 Telegram 通知与回复

本目录是 Telegram 功能的唯一后续维护入口，随 `pi-footer-tools` 加载，无需另装扩展。旧 `pi-telegram-notify` 仓库保留为**独立的归档回滚版本**，不依赖本目录，也不继续双份维护。

本次合并已在 **Pi 1.1.0**（包名 `@earendil-works/pi-coding-agent`）通过 Node 套件、类型检查及真实 Pi PTY 集成验证；模型为合成 provider，Telegram 请求被拦截，不代表真实 bot 端到端验证。运行时使用 Node 原生网络能力；可选收件还需要 Linux 的 `flock`。

## 两层开关

### 1. 配置总开关：默认完全关闭

沿用 [工具集配置](../README.md#配置与隐私) 的优先级，**按完整文件替换，不合并**：

1. `PI_FOOTER_TOOLS_CONFIG` 指定的 JSON 文件；
2. `~/.pi/footer-tools.json`；
3. 仓库自带的 `config.json`。

在选中的配置文件里加入此段；已有配置时必须保留其他字段，不要用示例覆盖整个文件：

```json
{
  "telegramNotify": {
    "enabled": true
  }
}
```

`enabled` 只接受 JSON 布尔值，不接受 `"true"`、`1` 等。默认 `false`；缺少配置段或配置非法时按关闭处理。指定文件缺失、无法读取或格式错误不会绕过它回退到另一份配置。修改后 `/reload` 生效。

**没有 `enabledByDefault` 选项。** 显式 `false` 或缺少配置时，不注册 `/notify` 或 Alt+N，不显示 TG 状态，不读取 Telegram 凭据，不订阅 Telegram 功能事件，不发网络请求、不启动收件进程。非法／无法读取的配置同样保持关闭，但会注册一个 `session_start` handler，仅用于在 TUI 警告一次；没有发送／收件 handler，也不读凭据或访问网络。测速及其他可选功能不受该开关影响。

### 2. 当前窗口开关：加载能力后仍为 OFF

`telegramNotify.enabled: true` 只允许加载功能，不自动开始发送或收件。TG 状态位于测速之后、LSP 状态之前；不替换底栏或改变其他扩展的文字。TUI 页脚显示：

```text
TG: OFF [Alt+N]
TG: ON [Alt+N]
TG: ON [Alt+N] · RX:READY
```

- **Alt+N** 立即切换；快捷键不提交草稿、不暂停／取消 agent、不写会话、不打开弹窗。agent 运行时主编辑器仍可响应，模态选择器或其他组件占用焦点时不保证响应。
- `/notify` 切换，`/notify on` 开启，`/notify off` 关闭，`/notify status` 查询。
- 没有足够凭据时显示 `TG: OFF [Alt+N] · UNCONFIGURED`，尝试开启只给本地提示并保持 OFF。
- 窗口状态仅在运行时内存中，两个 Pi 进程独立；退出重启、`/reload`、`/new`、恢复／分叉会话重建运行时后回到 OFF，不持久化窗口开关。
- 仅交互式 TUI 发送／收件，print、JSON、RPC 模式不发送。

允许收件时，同一窗口开关同时控制通知和收件；窗口 OFF 不会启动收件或访问 Telegram。能力加载后可以读取凭据并显示本地状态，这与总开关关闭时不加载发送／收件能力不同。

## 凭据与收件许可：位置不变

**不搬动原凭据。** 仍支持 `TELEGRAM_BOT_TOKEN`、`TELEGRAM_CHAT_ID` 和用户级 `<agent-dir>/telegram-notify.json`，按字段优先使用非空环境变量，缺少时回退到 JSON。不要把 token 放进工具集的 `config.json`。

### 用户级 JSON

`<agent-dir>` 由 Pi 的 `getAgentDir()` 确定；默认是 `~/.pi/agent`，可由 `PI_CODING_AGENT_DIR` 指定。不读取项目目录里的同名文件。

```json
{
  "token": "<你的 bot token>",
  "chatId": "<目标 chat ID>",
  "receiveMessages": false,
  "allowedUserIds": []
}
```

- `token`、`chatId` 使用字符串；群组负数 ID 也写成字符串。
- `receiveMessages` 是收件能力许可，默认 `false`，不是窗口开关。
- `allowedUserIds` 是群聊发送者白名单，使用数字 Telegram user ID 的字符串数组，最多 100 项；不接受群用户名代替 ID。
- 凭据文件里的 `enabled` 被忽略，不能代替工具集配置总开关，也不能持久化窗口 ON。
- 文件在 `session_start` 读取；修改后 `/reload` 或重启，窗口仍从 OFF 开始。
- 文件不存在、读取失败或格式／字段类型错误不会泄露解析内容；没有足够有效凭据时保持 UNCONFIGURED，开启失败只给固定本地提示。
- 扩展不会自动创建、覆盖或迁移实际凭据文件，切换窗口状态也不会写回。

建议限制权限：

```bash
chmod 600 "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/telegram-notify.json"
```

### 环境变量（逐字段优先）

在启动 Pi 的父 shell 中设置，例如：

```bash
export TELEGRAM_BOT_TOKEN='<你的 bot token>'
export TELEGRAM_CHAT_ID='<目标 chat ID>'
pi
```

不要把真实 token 粘贴到聊天或提交到仓库。本功能不读取 `.env`，不打印 token。已运行的 Pi 不会继承后来在其他 shell 中 export 的变量；环境变量修改后应从该 shell 重启 Pi。

应先让目标用户向 bot 发消息，或把 bot 加入目标群并允许发言。

## 完成通知正文与隐私

只在 **`agent_settled`** 时尝试发送本次 run **最后一条 assistant 回复中的文本**，不在 `agent_end` 提前通知。自动重试、压缩恢复或排队工作可能继续运行，settled 才是“没有自动续跑”的通知边界，不等于任务一定成功；取消或最终错误也可能触发它。

不另外附加历史对话、工具结果、thinking 或项目路径。本次没有文本回复时发简短兜底提示。单条最多 4096 字符，超长截断并注明，仍只发送一次；使用纯文本，不启用 Telegram Markdown／HTML 解析。已配置的 bot token 及其 URL 编码形式会被遮盖。

**开启窗口通知后，最终 assistant 回复正文会离开本机进入 Telegram。正文若包含代码、路径或秘密，也可能随之发送；除已配置的 bot token 外，扩展不能自动识别所有敏感信息。只有接受这个边界时才开启 TG。** 测速自身没有网络或模型请求的保证不覆盖此可选功能。

## Telegram 回复唤醒窗口（另行 opt-in）

在原用户级凭据 JSON 中将 `receiveMessages` 改为 `true`，保留原 token、chatId 和其他字段。默认不允许收件，避免意外开启远程操作能力。

1. 配置总开关开启后，在目标 Pi 窗口 `/reload`，再按 Alt+N 或执行 `/notify on`。
2. 等页脚显示 **`RX:READY`**，正常完成任务，让 bot 发来最终回复。
3. 在 Telegram 对**这条 bot 消息使用“回复 / Reply”**，输入下一项任务。
4. 通知的 `message_id` 只映射到原窗口：空闲时唤醒模型，忙时作为 follow-up 排队，不打断当前运行；下一次真正 settled 后再发最终回复。
5. 无 Reply 的普通消息、未知／已关闭窗口的路由、非文本消息均忽略，不猜窗口、不广播。没有当前路由映射的旧通知不可用于收件。

### 授权与路由边界

- 私聊只接受配置的数字 chat ID 对应的真实用户。
- 群聊／超级群还必须显式配置 `"allowedUserIds": ["你的数字 Telegram user ID"]`；默认不接受群内任何人。
- 机器人、匿名群身份、频道、business／guest 消息不作为模型输入。
- 窗口 OFF、关闭、重载或切换会话后不再接受原路由；重新开启后应回复新的完成通知。
- 每个在线窗口最多保留最近 128 条通知路由，只在内存中保存，不写入会话、JSON 或持久状态文件。
- 已被模型接受的任务不能通过事后关闭 TG 撤回。

远程文本通过 `pi.sendUserMessage(text, { deliverAs: "followUp", expandPromptTemplates: false })` 注入，作为正常用户消息进入会话，**允许当前模型使用当前工具**。这是远程操作能力，不是仅显示一条消息：保护 Telegram 账号和 bot token，不要将不可信群成员列入白名单。Telegram 中的 `/new` 等文本是模型输入，不会直接作为 Pi 命令执行，也不展开提示词模板。

### 单一收件进程：Linux，且仅限本机

- 收件依赖 Linux 的 `flock`；同用户、同主机、同 bot 的窗口共享一个自动启动的收件进程，避免各自争抢 `getUpdates`。发送通知本身不要求开启收件。
- 凭据只经用户私有 Unix socket 传入，不放进进程 argv、子进程环境、日志或收件状态文件。
- IPC 目录为 `$TMPDIR/pi-telegram-<uid>`（默认 `/tmp`），目录权限 700、socket 权限 600；空的 flock 锁文件只用于互斥，不含凭据、路由或窗口开关。
- 只有存在 TG ON 且允许收件的窗口才保持长轮询。最后一个窗口断开后约 2 秒退出；启动后无客户端约 5 秒退出。窗口 OFF 默认不启动收件进程。
- 初次收件／收件进程重启丢弃旧更新积压，避免突然执行过时任务；在线窗口重连会登记尚有效的路由。不设磁盘收件日志，不承诺 exactly-once 可靠队列。
- `RX:WAIT` 表示连接／启动中，`RX:READY` 表示轮询成功，`RX:ERR` 表示暂不可用。网络失败退避重试，本地警告不会每次重试刷屏，不阻塞 Pi。
- **`flock`、Unix socket 和临时目录的协调范围是主机本地，不支持同一个 bot 跨不同主机／计算节点同时收件。** 跨主机需要另做统一网络收件服务，或每台主机使用不同 bot。
- 同 bot 不应同时由其他应用运行 `getUpdates`；已有 webhook 也不能长轮询。本功能不会擅自删除 webhook，应先停止其他收件程序或自行处理 webhook。

## 网络行为与失败边界

- Node 原生 `fetch` 通过 HTTPS POST 访问 Telegram Bot API。
- 每次最终 settled 最多一次发送尝试，发送失败不重试，不等于保证服务端 exactly-once 或必定送达。
- 网络工作与生命周期 handler 分离，Pi 不等待 Telegram；发送请求及响应体共用 **5 秒超时**。
- 请求、解析、HTTP 或 Telegram API 错误只给固定本地警告，不显示 URL、token、响应体或原始错误。
- 收件轮询有 30 秒网络上限（Telegram long-poll 25 秒），失败后 1–30 秒退避；这与“不重试发送”不同。
- 关闭窗口开关或 `session_shutdown` 会取消尚未完成的发送并停止收件；已到达 Telegram 的消息不能撤回。
- 禁止 HTTP 重定向，避免将含 token 的 URL 转发到其他位置。
- 用户键位或其他扩展可能占用 Alt+N；用 Pi 冲突诊断及 `/hotkeys` 核查，某些终端需将 Option／Alt 配置为 Meta。

## 从独立扩展迁移与回滚

**绝不要同时加载旧独立实现和新集成功能**，否则可能重复通知、快捷键冲突或收件争抢。

迁移是用户手动操作；仓库更新不修改个人文件、凭据、settings 或已安装符号链接：

1. 按 [主 README](../README.md#安装) 安装／保留 `pi-footer-tools` 的单一入口，不要另将本子目录作为扩展入口加载。
2. 确定当前实际选中的工具集配置文件。在已有外部配置中加入或修改 `telegramNotify.enabled: true`，保留账户切换、缓存诊断、费用等全部其他字段。完整文件替换规则不会帮你合并遗漏的字段。
3. 保留原 `TELEGRAM_BOT_TOKEN`、`TELEGRAM_CHAT_ID`、`<agent-dir>/telegram-notify.json`；不搬凭据，不自动改 `receiveMessages` 或白名单。
4. **在重载前**移除旧 discovery 链接 `<agent-dir>/extensions/pi-telegram-notify`（只移除链接，不删归档仓库），或在 Pi settings 中禁用旧包扩展。也检查项目入口、其他 profile、显式 `-e` 等，确保旧实现不会被再次发现。
5. 执行 `/reload`，新功能应从 `TG: OFF` 开始；需要时手动开启。旧通知路由不迁移，应回复新发送的通知。

禁用新功能：在实际使用的工具集配置中设 `telegramNotify.enabled: false` 并 `/reload`，无需改凭据。

回滚：先禁用新功能并 `/reload`，再手动恢复旧独立仓库的加载入口并重载，始终只加载一套 Telegram 实现。归档仓库保留原独立源码，不是引用相邻 `pi-footer-tools` 的共享包装器；其旧版验证记录不等于当前 Pi 版本的兼容性保证。

## 验证

从 `pi-footer-tools` 仓库根目录运行，不能遗漏新的子目录套件：

```bash
npm test
npm run typecheck
# 等价的完整 Node 测试 glob：
node --test test/*.test.mjs test/telegram-notify/*.test.mjs
```

`npm test` 脚本包含 `test/telegram-notify/*.test.mjs`；仅 `test/*.test.mjs` 不覆盖这些测试。Pi 加载器测试需要 PATH 上的 Pi，类型检查需要开发依赖，安装说明见主 README。

**Pi 1.1.0** 下已完成的验证：

- Telegram 专项 Node 测试 **44/44 通过**；既有回归测试另行 **96/96 通过**。这不是对完整合并套件一次运行结果的声明。
- 生产 `npm run typecheck` 和 TUI fixture 类型检查通过。
- 两套集成的真实 Pi PTY 测试通过：发送／settlement／重载与多窗口收件路由，使用合成模型和拦截的 Telegram 请求。
- Python Ruff 与 basedpyright 检查通过。

可选的 PTY 与 fixture 检查（从仓库根目录运行，不包含在 `npm test` 中）：

```bash
node test/telegram-notify/typecheck.mjs
python3 test/telegram-notify/tui-smoke.py
python3 test/telegram-notify/tui-inbound.py
ruff check test/telegram-notify/tui-smoke.py test/telegram-notify/tui-inbound.py
basedpyright --level error test/telegram-notify/tui-smoke.py test/telegram-notify/tui-inbound.py
```

PTY 需要 Linux、`pi`、`node` 和 `flock`，加载集成主入口而非旧独立扩展。具体测试职责与隔离方式见 [测试说明](../test/telegram-notify/README.md)。验收范围包括：总开关显式关闭／缺失时零 Telegram 注册，非法配置仅注册一次 TUI 警告 handler，所有关闭情形均零凭据读取、零网络；配置文件优先级和完整替换；启用后初始 OFF、窗口隔离和重载；文本提取／遮盖／截断、settled 发送、失败与取消；逐字段凭据优先级；私聊授权、群聊白名单和精确 Reply 路由；收件进程协调、重连、丢弃旧积压和退出；以及测速、账户切换、费用、诊断的回归。

本次自动化验证使用临时合成凭据、合成模型与拦截的 Telegram 请求，不调用付费模型或向真实 chat 发消息；超时回归仅使用本机 loopback HTTP 服务，集成收件及 PTY fixture 阻止真实 collector 启动。**验证范围不包含新集成的真实 bot 端到端测试。自动化测试不修改个人凭据、符号链接或配置；手动迁移操作不属于测试范围。** 真实 bot 验证需单独明确授权并记录其范围，不能用旧仓库历史测试结果替代。
