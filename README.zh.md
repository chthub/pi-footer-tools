# pi-footer-tools

[English](README.md) | [中文](README.zh.md)

`pi-footer-tools` 是 Pi 现有底栏的小工具集合：追加状态，不替换 footer，不影响其他扩展。

- **输出测速**：始终启用，显示每次模型请求的输出均速。
- **账户切换**：可选，在当前窗口切换 Codex 认证并显示账户名。
- **上下文费用对照**：可选，显示缓存读取与冷启动的 API 等价费用估计。
- **缓存诊断**：可选，通过命令查看状态并记录受限元数据。
- **[Telegram 通知／回复](telegram-notify/README.md)**：可选，显示窗口开关状态，支持完成通知与授权回复。
- **任务与备忘**：可选，在输入框上方固定显示最近一条派活 prompt（折叠，点击展开）和自己写的备忘。

可选功能均由独立配置控制，仓库默认全部关闭。Telegram 从 `pi-telegram-notify` 合并到本仓库，后续只维护 `telegram-notify/`。

## 输出测速

默认使用 `overall` 口径，也可切换为原有的 `stream` 口径：

```text
Avg overall 43.7 tok/s
Avg stream 61.2 tok/s
```

- **overall（默认）**：本次主会话单条 assistant 消息的 API `usage.output` ÷ 从第一次 `before_provider_request` 钩子到该消息 `message_end` 的耗时。该钩子是请求 payload 提交前的近似时间，**不是精确的 socket 发包时刻**。排除钩子前的上下文准备，包含钩子后首次输出等待、停顿／重试及结束延迟；同一消息多次触发钩子时保留第一次时间。没有钩子时显示 `Avg overall -- tok/s`，不回退到 `turn_start`；即使没有增量，只要最终消息有有效用量且时长为正，仍可计算。
- **stream（原有口径）**：同一条消息的 `usage.output` ÷ 从首次非空正文、思考或工具参数增量到 `message_end` 的耗时。不依赖请求前钩子，不计首次输出前的等待（包括重试等待），但首次输出后的停顿、内部重试及结束事件的传输延迟仍计入。没有非空增量时显示 `Avg stream -- tok/s`；没有请求前钩子也可计算。
- **共同边界**：两者只使用本次主会话单条 assistant 输出用量，包含思考与生成的工具参数，不包含子代理 token 或工具执行时间；不数流式块、不根据字符数猜。都是客户端观测的均速，**不是纯正文或纯服务端 GPU 解码速度**。
- **只显示英文均速与口径**：不显示“测速”、首字延迟、输出 token 总数、思考细分或结束原因。
- 等待、思考、输出和工具执行期间持续显示上一次结果；每次最终模型消息结束时同时保存两种测量结果，直接替换为新结果，不显示中间状态。首次运行尚无结果时不显示测速项。未收到最终模型消息就结束的请求不生成新测量，也不替换上次结果。
- 最终消息失败、中断、没有有效输出用量或对应耗时非正时，该口径显示 `--`（例如 `Avg overall -- tok/s`）；缺少钩子只影响 overall，缺少增量只影响 stream。
- **stream 的测量局限**：使用全部输出 token，但无法知道首个流式块包含多少 token，也无法观测服务商未流式公开的思考过程；尤其是短回复、批量到达或隐藏思考时，stream 均速可能偏高，不能据此推断纯解码性能。overall 包含请求前钩子后的等待，也不能据此分离纯解码性能。
- 不恢复历史测速结果；切换会话、历史树或模型时清空两个结果，避免把旧结果当成本次测量。口径仅保存在扩展运行时，不写磁盘或会话；`/reload` 或重启重建扩展运行时后恢复 `overall`。

在 TUI 中使用（参数支持补全）：

```text
/token-speed overall    # 使用 overall 口径
/token-speed stream     # 使用 stream 口径
/token-speed status     # 查看当前口径
/token-speed            # 切换 overall / stream
```

切换口径会立即重绘上次已保存的对应结果，不发起请求；也可以在请求期间切换，不改变正在进行的计时。RPC／print 模式下命令不操作 UI。

测速只在 TUI 显示；测速自身没有网络或额外模型请求、定时器、tokenizer、磁盘或会话写入。诊断关闭时不写日志、不订阅额外的原始流事件。每次测速流式更新只做常数时间判断，请求期间不因流式事件刷新测速显示；请求结束、口径切换、会话／模型／树重置和退出时更新底部。可选 Telegram 功能有独立开关：开启窗口通知后会访问 Telegram；另行允许收件后，远程回复可启动模型及其工具，不属于测速的零请求保证。

## 安装

把仓库克隆到任意位置，再在 Pi 的扩展目录建立符号链接：

```text
~/.pi/agent/extensions/pi-footer-tools -> <仓库路径>/pi-footer-tools
```

在 Pi 中执行 `/reload` 加载新代码。正常工作收到下一次模型回复时显示测速，无需专门发测试请求。卸载时移除该符号链接并 `/reload`。

## 从旧名称迁移

本项目由 `pi-token-speed` 更名为 `pi-footer-tools`，配置名称也一起更新，**不读取旧配置文件名或旧环境变量**：

- 将现有 `~/.pi/token-speed.json` 移到 `~/.pi/footer-tools.json`，保留全部内容及 `0600` 权限；不要用仓库默认配置覆盖个人配置。如果新旧文件都存在，先人工确认使用哪份，不要直接覆盖。
- 若使用 `PI_TOKEN_SPEED_CONFIG`，改为 `PI_FOOTER_TOOLS_CONFIG`，继续指向原来的自定义文件，或同步调整其路径；从父 shell 中移除旧变量。自定义文件不要求固定文件名。
- 本地仓库目录及 discovery 符号链接改为 `pi-footer-tools`，同步更新 settings、启动脚本和显式 `-e` 中的旧路径；只保留一个加载入口。
- GitHub 地址为 `https://github.com/chthub/pi-footer-tools`；已有 clone 的 remote 同步改用该地址。
- 完成后建议**重启 Pi 并恢复原会话**，以清除旧运行时身份。此次更名不继承内存中的账户选择、测速结果或 Telegram ON 状态；账户可重新选择，Telegram 需要重新开启。

配置字段（`accountSwitch`、`contextCost`、`cacheDiagnostics`、`telegramNotify`）不变；OAuth 与 Telegram 凭据、诊断日志目录及功能专用环境变量不搬动。

## 配置与隐私

仓库中的 `config.json` 只有通用默认值：测速始终启用，其他功能默认关闭；不包含实际账户列表、认证路径或个人计费策略。

配置优先级（按完整文件替换，不合并）：

1. 环境变量 `PI_FOOTER_TOOLS_CONFIG` 指定的 JSON 文件；
2. `~/.pi/footer-tools.json`，适合多个 Pi 启动配置共用；
3. 仓库自带的 `config.json`。

个人账户名、目录和偏好请放在**仓库外**的上述个人配置文件中。文件不需要包含令牌；各账户的 OAuth 凭据仍保存在自己的 `auth.json`。建议个人配置权限为 `0600`。非法／无法读取的配置按关闭处理，不会跳过私人文件回退到另一个配置；修改后执行 `/reload`。指定的配置文件缺失时同样不会回退。

## 可选 Telegram 通知／回复（默认完全关闭）

无需安装第二个扩展。只在上述配置优先级选中的**完整配置文件**中加入或修改此段；已有个人配置时保留账户、诊断、费用等其他字段，不要用示例覆盖整个文件：

```json
{
  "telegramNotify": {
    "enabled": true
  }
}
```

- `enabled` 必须是 JSON 布尔值；默认 `false`，缺少配置段或非法配置也按关闭处理。**没有 `enabledByDefault` 选项。** 显式 `false` 或缺少配置时，不注册 `/notify`、Alt+N、Telegram 功能事件或 TG 状态，不读取 Telegram 凭据，不发请求、不启动收件进程。非法／无法读取的配置同样保持关闭，但会注册一个仅用于在 TUI 警告一次的 `session_start` handler。
- `true` 只加载能力，**每个窗口仍从 OFF 开始**。执行 `/reload` 后用 **Alt+N** 或 `/notify on` 开启，`/notify off` 关闭，`/notify status` 查询；不带参数的 `/notify` 切换。运行时开关不写回配置，重载／新建／恢复／分叉会话后重新 OFF。
- 凭据保持原位置：`TELEGRAM_BOT_TOKEN`、`TELEGRAM_CHAT_ID` 或 `<agent-dir>/telegram-notify.json`，环境变量逐字段优先；不搬入工具集配置。默认只发送，`receiveMessages: true` 才允许收件，群聊还需 `allowedUserIds` 白名单。
- **隐私与权限**：开启后，最终 assistant 回复文本会离开本机进入 Telegram；收件是可触发当前模型及工具的远程操作能力，不只是通知。Linux `flock` 收件协调仅限同用户、同主机，不能让同一个 bot 跨主机／节点安全共享。
- **迁移必须手动完成**：先在现有外部工具集配置中启用并保留其他字段，再移除旧 `pi-telegram-notify` discovery 符号链接，或在 Pi settings 中禁用旧包的扩展，然后 `/reload`。**绝不要同时加载新旧实现**（也检查显式 `-e` 等入口）。仓库更新不会自动修改个人配置、凭据或已安装链接。旧仓库保留为独立归档回滚版本，不是依赖相邻仓库的包装器。

完整安全边界、凭据配置、收件及迁移步骤见 [Telegram 说明](telegram-notify/README.md)。本次合并已在 **Pi 1.1.0** 验证：Telegram Node 套件及真实 Pi PTY 集成测试使用合成模型和拦截的 Telegram 请求，不代表真实 bot 端到端验证。

## 可选账户切换（独立开关）

在**当前窗口、当前对话**中切换 ChatGPT/Codex 认证，不需要退出或 resume。账户由个人配置显式提供，代码不预设账号名，也不扫描 shell 别名或本地认证目录。示例仅使用虚构配置：

```json
{
  "accountSwitch": {
    "enabled": true,
    "accounts": [
      { "name": "default", "agentDir": "~/.pi/agent" },
      { "name": "work", "agentDir": "~/.pi/example-work" }
    ]
  }
}
```

`accounts` 每项包含自选的 `name` 和该账户的 Pi `agentDir`；认证文件为 `<agentDir>/auth.json`。目录支持绝对路径或 `~/`，不支持相对路径。名称可用字母、数字、下划线、点和连字符，最多 64 字符；名称必须唯一，`status` 是保留字。最多配置 64 个账户。开启时列表不能为空。

执行 `/reload` 后可用：

```text
/switch-account          # 弹出账户选择列表，Esc 取消
/switch-account work     # 按个人配置的名称切换，支持补全
/switch-account status   # 查看当前 ChatGPT/Codex 账户
```

底栏只追加灰色名称（如 `work`），不带 Account 前缀，不替换 footer，也不影响测速或费用显示。

- 改为 `"enabled": false` 并 `/reload`：关闭命令及账户显示，恢复启动账户的认证，不影响其他功能。缺少该配置段时默认关闭；非法配置警告并关闭。
- **只切换 `openai-codex` 的认证**：对话、模型、思考级别、会话文件位置、agent 目录、AGENTS、插件、其他 provider 和环境变量保持不变。会话仍保存在启动配置的会话目录。使用非 Codex 模型时标注 `(Codex only)`，该模型的账户不受影响。
- 名称是配置标签，不显示邮箱、访问令牌、refresh token 或真实账户 ID；未匹配配置的当前 agent 目录显示目录名。
- 若主代理正在生成、执行工具、重试或存在排队消息，拒绝切换。账号到限时先按 Esc 停止当前运行；切换不会自动重发失败消息，下一条消息才使用新账户。
- **子代理联动**：配合支持 `pi-subagents:child-launch:v1` 的新版 `pi-subagents`，当前窗口的既有、新建及恢复的子代理（包括后代）会在下一次 Codex 请求时使用新账户，不需要退出主会话或手动 resume。正在进行的请求不被中断或重发；失败的子代理可用 `agent_send` 继续原对话。两边更新后先执行一次 `/reload`，让旧子进程关闭并在恢复时接入联动；更新前已启动的进程无法被追溯接入。其他窗口不受影响。
- 目标必须已有完整的 ChatGPT/Codex OAuth 登录信息；缺失、损坏或 API-key 类型的认证不允许切换，也不会为未登录账户创建文件。需要时先使用目标启动配置执行 `/login`。取消或切换失败时原选择不变。
- 成功切换时重置已开启的缓存诊断比较基线，避免跨账户冷缓存误报；不记录账户 ID 或令牌。
- **不复制或覆盖不同账户的认证**。OAuth 自动刷新仍由 Pi 自带的跨进程文件锁处理，刷新后的凭据写回选中账户自己的文件；切换后 `/login`、`/logout` 对 Codex 的操作也作用于该账户（其他 provider 仍是启动目录）。命令不请求模型或验证远端额度；过期令牌在下一次请求时由 Pi 正常刷新，失效的 refresh token 仍需重新登录。
- 选择在普通 `/reload` 后保留，但不写入会话或持久配置。为联动子代理，每个窗口使用独立的临时目录（`0700`）和原子更新的选择文件（`0600`），仅含账户标签及认证文件路径，不含令牌；正常关闭／reload 时删除。子进程通过专用环境变量接收该文件路径及显式加载的认证桥接扩展，不改变主进程环境或 `PI_CODING_AGENT_DIR`。通道丢失／损坏时拒绝 Codex 认证，不静默回退旧账号。退出重启、`/new`、`/resume` 或 `/fork` 重建会话运行时后重新使用启动账户；关闭或移除扩展并 `/reload` 同样恢复启动账户。没有定时器或每-token 认证操作。
- **兼容性边界**：认证／请求流程已在 Pi **1.1.0** 测试。Pi 当前没有公开的“在线更换凭据存储”接口，因此仅在 `account-switch/routing.ts` 中使用受结构检查保护的内部适配器；其余认证、流式请求和 OAuth 刷新仍走 Pi 自带逻辑。内部结构不兼容或存在 Codex 运行时 API-key 覆盖时拒绝启用／切换。升级 Pi 后应重跑 `npm test`。切换命令只在交互式 TUI 启用；普通 print／JSON／RPC 不改认证，只有父窗口显式注入联动通道和桥接扩展的子代理 RPC 进程例外。

## 可选缓存诊断（默认开关可配置）

诊断已集成在同一个扩展中，开关不影响测速；无需安装第二个扩展。仓库自带的 `config.json` **默认关闭**；配置文件缺失时按关闭处理。

在仓库外的个人配置文件中启用：

```json
{
  "cacheDiagnostics": {
    "enabledByDefault": true
  }
}
```

- `false`：默认关闭；`true`：默认开启。必须使用 JSON 布尔值，不能写成带引号的字符串。
- 修改后执行 `/reload` 或重启 Pi 生效，不需要修改 Pi 的 `settings.json`。
- 使用[配置与隐私](#配置与隐私)中的配置优先级。多个实例可以共用个人配置，当前运行不会自动热更新。

当前实例仍可临时切换或查看状态：

```text
/cache-diagnostics on
/cache-diagnostics status
/cache-diagnostics off
```

不带参数时查询状态，不自动切换。命令只临时切换当前实例，不改写 `config.json`；重新加载后按配置默认值启动。也可通过 `pi --cache-diagnostics` 显式开启，命令行开关优先于配置。文件缺失默认关闭；格式错误或无法读取时警告并将配置默认按关闭处理。`status` 同时显示当前状态、已加载的配置默认值及配置路径。

第一版只解析 OpenAI Responses 格式，包括 `openai-codex-responses`。每次观察到的请求保存简短元数据；出现读取归零、大幅下降、字段缺失或转换差异时，再保存前后请求的指纹对照。首次调用及已观察到的压缩／分支／模型转换边界重置比较基线，避免把正常冷启动当成归零事件。

- **只记录**：不注入提示词、不注册模型工具、不改请求参数，不新增保活、重试或模型调用；也不自动设置官方诊断参数。
- **保护内容**：不保存对话、输出、工具参数正文、密钥或认证头。保存用量合法数值、字段存在性、响应 ID、参数白名单及每次启用独立的 HMAC 指纹。
- **有界且隔离**：后台写日志并轮换；写入失败停用诊断，不中断模型请求。不在每个 token 到达时落盘或刷新底部。
- **不是网络抓包**：指纹来自请求前钩子，原始用量来自 SDK 转换前的结构化事件；无法据此证明最终传输字节、物理连接复用、服务端缓存根因或订阅额度扣减。

默认日志根目录为 `~/.pi/agent/cache-diagnostics/`，自定义 Pi agent 目录会随 `getAgentDir()` 调整。每次启用／切换会话建独立 `capture-*` 目录，`status` 显示具体位置。可用 `PI_CACHE_DIAGNOSTICS_DIR` 指定其他目录。

**个人配置开启诊断后，会持续在上述目录写入元数据日志（不含对话内容），旧目录不会自动清理；不需要时把 `enabledByDefault` 改为 `false` 并 `/reload`。** 详细字段、保存上限与证据边界见 [缓存诊断说明](cache-diagnostics/README.md)。

## 可选上下文费用对照（个人配置开关）

在底部再追加一个状态项 `context-cost`，用与 Pi 自带底栏相同的 dim 灰色，按**当前选中模型**对照两项背景输入费用（USD，Standard API 等价估计，不是实际账单）：

```text
Cache read $0.8000 | Cold start $0.6250
```

- **Cache read**：继续当前窗口时，把当前上下文估计全部按缓存读取计价。首版取 Pi 的 `getContextUsage().tokens` 作当前上下文 C，并近似 H≈T≈C：费率档位由下一次总输入 T 决定（超过某档阈值时整请求用该档），计费量是历史 H。C 可能含上次输出，不含编辑器里未发送的文本和新增工具开销，分档边界附近不精确。
- **Cold start**：新开窗口加载固定背景（默认 50,000 token，可用 `startupTokens` 配置），全部按首次写缓存计价（不再叠加普通输入费）。背景本身超过分档阈值时同样按对应档计价。
- 只比较背景输入：不含新输入、输出／推理、工具费、生成交接摘要和返工。不代表实际账单或订阅额度扣减，也不代表 Fast／Batch／Flex 等价格档。不给"建议重开"之类的结论。
- **未知不显示为 $0**：上下文未知（例如压缩后、下一次有效回复前）显示 `—`，新窗口价格照常显示；0 是有效值。
- **价格来源**：直接读取 Pi 的模型数据 `model.cost`（普通输入、缓存读取、缓存写入及 `tiers` 分档），分档规则与 Pi 的 `calculateCost` 一致：总输入超过的最高阈值对整请求生效。价格随 Pi 升级更新，本扩展不另存价格表。
- **支持范围**：只计算 provider 为 `openai` 或 `openai-codex` 的模型；其他 provider 的价格数据常缺缓存单价，显示 `API price not configured`。
- **OpenAI 数据中的 0**：缓存写入价为 0（GPT-6 之前的模型，写缓存不另收费）时，Cold start 按普通输入价计；缓存读取价或普通输入价为 0（如 pro 系列没有缓存折扣）、价格缺失或格式异常时不硬算，显示 `API price not configured`。

默认严格跟随 Pi 的模型价格及分档。若自己的计费策略明确不使用长上下文分档，可在个人配置的 `contextCost.untieredModels` 中列出精确的 `provider/modelId`；代码不预设任何订阅特例，也不据此推断远端实际账单。

配置（仓库自带配置默认关闭；在个人配置中启用）：

```json
{
  "contextCost": {
    "enabled": true,
    "startupMode": "cache-write",
    "startupTokens": 50000
  }
}
```

- `enabled`：JSON 布尔值。`false` 或缺少 `contextCost` 段时完全不注册事件。
- `startupMode`：可省略，默认 `"cache-write"`；`"uncached-input"` 改为按普通冷输入计价（Astra $0.5000，6.1 Sol $0.1000）。底栏标签不变，仍显示 `Cold start`。
- `startupTokens`：可省略，默认 `50000`；必须是正整数。底栏不显示这个数。
- `untieredModels`：可省略，默认 `[]`；字符串列表，每项为精确的 `provider/modelId`，只对这些模型忽略分档。不支持通配符或自动检测订阅策略。
- 格式错误时按关闭处理，并在 TUI 中警告一次。修改后 `/reload` 生效。

只在 TUI 模式显示；Pi 没有主题切换事件，切换主题后灰色在下一次刷新时更新。会话开始／恢复／fork／reload、切换模型、每轮结束、压缩和树导航后本地重算，没有定时器、网络或模型请求。切换到未支持模型时立即替换旧金额；退出时只清除自己的状态项。

## 可选任务与备忘（个人配置开关）

工具调用刷屏后，最初交代任务的 prompt 很快被顶出屏幕。开启后在**输入框上方**固定两类内容，不显示状态总结或状态符号：

```text
 任务 ▸ 把 telegram-notify 的回复路由改成按 session id 匹配，旧的按 chat id 的逻辑保留做 fa…  14:20
 备忘   等它改完 → 手机上发条回复验证
        别合并，先给 A 看
```

- **任务**：当前分支上最近一条**不是确认语**的用户 prompt，不按字数判断。确认语只认固定词库：继续、同意、可以、确认、批准、同意继续、继续下一步、继续执行、继续推进、继续做、自行继续推进、接着、好、好的、行、嗯、对、是的、没问题、ok、okay、yes、y、go、go ahead、continue、proceed、lgtm。比较前忽略大小写、空格和标点，并去掉开头的“那你／行啊／好的／那／你／行／好／嗯”和结尾的“一下／吧／啊／呀／了”，所以“行，那你继续吧”“可以了”也算确认语；“你好”除外。其余 prompt（包括“提交”“commit and push”“继续t12”）都会成为任务行；分支上全是确认语时不显示任务行。`/skill:` 调用只显示命令和后面的话，代码块折成 `[代码 N 行，已省略]`。默认折叠为一行，右侧是发送时间；**鼠标点击**任务行展开全文，再点收起，出现新任务时自动收起。点击依赖 fullscreen 模式（Pi 默认）；regular 模式下鼠标归终端，用 `/note task` 展开／收起。
- **备忘**：自己写的多行文字，全部显示，不折叠、不设行数上限；**鼠标点击**备忘任意一行即打开编辑框。

| 操作 | 方式 |
|---|---|
| 编辑备忘 | 点击备忘、`Alt+M` 或 `/note`：打开多行编辑框，预填当前备忘（没有备忘时为空）；Enter 保存，Shift+Enter／Ctrl+J 换行，Esc 取消 |
| 快速设置 | `/note 一句话` |
| 删除备忘 | `/note clear`，或在编辑框里清空后保存 |
| 撤销 | `/note undo`（可连续撤销） |
| 换任务行 | `/note pin`：从最近 12 条 prompt 里选一条固定；选第一项“自动”取消固定，恢复按词库判断 |
| 展开／收起任务 | 点击任务行，或 `/note task` |

`clear`、`undo`、`pin`、`task` 是保留子命令，备忘正好是这几个词时用编辑框输入。

备忘和固定都以自定义会话条目（`footer-tools.sticky-note`）追加保存，**不进入模型上下文**、不改写旧条目；`/resume`、reload、fork 后按当前分支重放恢复，`/tree` 切回某个节点时也回到那时的备忘。不发网络或模型请求，没有定时器；只在 TUI 显示。

配置（仓库自带配置默认关闭；在个人配置中启用）：

```json
{
  "stickyNote": {
    "enabled": true
  }
}
```

`enabled` 必须是 JSON 布尔值；`false` 或缺少 `stickyNote` 段时不注册任何事件、命令或快捷键。格式错误时按关闭处理并在 TUI 中警告一次。修改后 `/reload` 生效。

## 测试

任务与备忘（Pi **1.2.0**）：`npm run typecheck` 通过，完整 `npm test` **161/161 通过**，新增 8 个测试（确认语词库、prompt 清理、锚点与固定、条目重放、渲染宽度、配置、生命周期与命令）。另用现有 synthetic fixture 在真实 Pi PTY 中冒烟：任务行折叠、`Alt+M` 多行编辑、鼠标点击展开任务、点击备忘进入编辑、`/note task`、`/note clear` 均通过；该冒烟脚本未纳入仓库。

双口径测速更新（当前安装 Pi **1.2.0**）：`npm run typecheck` 通过，完整 `npm test` **153/153 通过**，**0 失败、0 跳过**。本次新增 **10 个测速测试**。真实 Pi **1.2.0** 的测速命令定向 PTY 冒烟也已通过，验证默认 overall、显式切换、不带参数切换、status、reload 恢复 overall，以及切换不产生额外模型请求；该冒烟复用现有 synthetic fixture，输出用量故意为 0，因此显示 `--` 属预期，不验证真实 API 生成速度或数值计时。此次**未重跑既有两套完整 PTY 套件**。

测速边界覆盖包括 overall／stream 计时、重复／缺失请求前钩子、无增量但有效最终用量、失败／中断／无效用量／非正时长、口径命令与补全、切换重绘、请求期间切换、生命周期重置和非 TUI 行为。下方 Pi 1.1.0 的结果为**既往验证记录**，与本次更新分别记录。

更名回归（Pi **1.1.0**）：完整 `npm test` **142/142 通过**，无失败或跳过；生产类型检查、Telegram fixture 类型检查、两套真实 Pi PTY 测试及本次修改的 Python 文件 Ruff／basedpyright 检查均通过。新增测试覆盖新包名、个人配置文件名与环境变量优先级；PTY 使用合成模型和拦截的 Telegram 请求，不代表真实 bot 端到端验证。

底栏排序调整后，新增「测速 → TG → LSP」顺序回归测试，重新运行完整 `npm test` **143/143 通过**，生产类型检查通过；该次检查未重跑 PTY 套件。

`npm test` 需要 PATH 上已安装 Pi（`npm install -g @earendil-works/pi-coding-agent`），使用已安装 Pi 的加载器及 jiti 加载实际扩展，再用确定性事件及单调时钟验证统计；上下文费用对照另有纯计算（验收表、分档、可配置不分档策略、未知值）、配置解析和生命周期测试。测试不调用远端模型、不访问 API。账户切换测试使用临时合成凭据和已安装 Pi 的真实 ModelRuntime，覆盖认证路由、保持请求上下文／模型、并发 OAuth 刷新及正确写回、登录／登出、失败回滚、reload／关闭、非 TUI 和命令交互，不读取或改动真实账号。联动测试另外覆盖窗口通道隔离、后代继承、初始化失败时拒绝启动凭据、切换过程中 reload，以及真实 Pi RPC 子进程在模拟额度报错后切换账号继续同一对话（包含会话恢复）。RPC 使用合成 provider，并在启动前阻断 fetch；这些测试不验证真实额度或远端 provider 行为。诊断测试只在临时目录写合成日志并清理，包含原始字段缺失／显式零、转换差异、异常前后对照、并发关联保护、默认关闭、动态订阅、权限／轮换、写失败及开启诊断时的测速回归。

合并后的 `npm test` 脚本还包含 `test/telegram-notify/*.test.mjs`，不能只运行原来的顶层 glob 而漏掉 Telegram 套件。也可直接运行完整套件：

```bash
node --test test/*.test.mjs test/telegram-notify/*.test.mjs
```

Pi **1.1.0** 下，Telegram 专项 Node 测试 **44/44 通过**，既有回归测试 **96/96 通过**；生产类型检查、TUI fixture 类型检查、两套真实 Pi PTY 集成测试以及 Python Ruff／basedpyright 检查均通过。这里分别记录已完成的验证，不将其声明为完整合并套件的一次运行结果。Telegram 测试覆盖关闭／缺少配置时零注册、非法配置仅有一次 TUI 警告 handler、关闭时不读凭据／不访问网络，以及窗口初始 OFF、发送与取消、授权、路由和集成回归。

可选的真实 Pi PTY 与 fixture 检查（不包含在 `npm test` 中）：

```bash
node test/telegram-notify/typecheck.mjs
python3 test/telegram-notify/tui-smoke.py
python3 test/telegram-notify/tui-inbound.py
ruff check test/telegram-notify/tui-smoke.py test/telegram-notify/tui-inbound.py
basedpyright --level error test/telegram-notify/tui-smoke.py test/telegram-notify/tui-inbound.py
```

PTY 测试需要 Linux、`pi`、`node` 和 `flock`，加载集成主入口，使用隔离临时配置、合成模型和拦截的 Telegram 请求；不调用付费模型、不发真实 Telegram 消息。验证范围不包含新集成的真实 bot 端到端测试；这些自动化测试不会修改个人凭据、符号链接或配置，手动迁移操作不属于测试范围。详细范围见 [Telegram 验证](telegram-notify/README.md#验证) 和 [测试说明](test/telegram-notify/README.md)。

`npm run typecheck` 验证本扩展类型，从 `node_modules` 解析 Pi 与 Node 类型。先执行 `npm install` 安装开发依赖；也可以不下载，直接链接全局安装的 Pi：

```bash
mkdir -p node_modules/@earendil-works
ln -s "$(npm root -g)/@earendil-works/pi-coding-agent" node_modules/@earendil-works/pi-coding-agent
```
