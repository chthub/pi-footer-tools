# Pi 底栏工具集

`pi-footer-tools` 是 Pi 现有底栏的小工具集合：追加状态，不替换 footer，不影响其他扩展。

- **输出测速**：始终启用，显示每次模型请求的输出均速。
- **账户切换**：可选，在当前窗口切换 Codex 认证并显示账户名。
- **上下文费用对照**：可选，显示缓存读取与冷启动的 API 等价费用估计。
- **缓存诊断**：可选，通过命令查看状态并记录受限元数据。
- **[Telegram 通知／回复](telegram-notify/README.md)**：可选，显示窗口开关状态，支持完成通知与授权回复。

可选功能均由独立配置控制，仓库默认全部关闭。Telegram 从 `pi-telegram-notify` 合并到本仓库，后续只维护 `telegram-notify/`。

## 输出测速

```text
Avg 43.7 tok/s
```

- **Avg（均速）**：API 返回的 `usage.output` ÷ 输出阶段耗时。输出阶段从首次非空正文、思考或工具参数增量开始，到本次模型消息结束；不计首次输出之前的等待，不包括工具执行。它是客户端观测的流式输出均速，不是纯正文或服务端 GPU 解码速度。
- **只显示英文均速**：不显示“测速”、首字延迟、输出 token 总数、思考细分或结束原因。计算仍使用 API 返回的输出用量，包含思考与生成的工具调用；不数流式块、不根据字符数猜。
- 等待、思考、输出和工具执行期间持续显示上一次结果；每次模型请求结束后直接替换为新结果，不显示中间状态。首次运行尚无结果时不显示测速项。
- 未收到最终模型消息就结束的请求不替换上次结果。
- 缺失用量、失败、中断、没有非空输出增量或输出阶段零耗时时，显示 `Avg -- tok/s`。
- 均速不依赖请求前钩子，不计首次输出前的重试等待，但首次输出后的停顿、内部重试以及结束事件的传输延迟仍计入输出阶段。
- **测量局限**：使用全部输出 token，但无法知道首个流式块包含多少 token，也无法观测服务商未流式公开的思考过程；尤其是短回复、批量到达或隐藏思考时，均速可能偏高，不能据此推断纯解码性能。
- 不恢复历史测速结果；切换会话、历史树或模型时清空，避免把旧结果当成本次测量。
- 测速只在 TUI 显示；测速自身没有网络或额外模型请求、定时器、tokenizer 或会话写入。诊断关闭时不写日志、不订阅额外的原始流事件。每次测速流式更新只做常数时间判断，请求期间不刷新测速显示；只有请求结束、会话／模型重置和退出时更新底部。可选 Telegram 功能有独立开关：开启窗口通知后会访问 Telegram；另行允许收件后，远程回复可启动模型及其工具，不属于测速的零请求保证。

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
- 若正在生成、执行工具、重试或存在排队消息，拒绝切换。账号到限时先按 Esc 停止当前运行；切换不会自动重发失败消息，下一条消息才使用新账户。
- 目标必须已有完整的 ChatGPT/Codex OAuth 登录信息；缺失、损坏或 API-key 类型的认证不允许切换，也不会为未登录账户创建文件。需要时先使用目标启动配置执行 `/login`。取消或切换失败时原选择不变。
- 成功切换时重置已开启的缓存诊断比较基线，避免跨账户冷缓存误报；不记录账户 ID 或令牌。
- **不复制或覆盖不同账户的认证**。OAuth 自动刷新仍由 Pi 自带的跨进程文件锁处理，刷新后的凭据写回选中账户自己的文件；切换后 `/login`、`/logout` 对 Codex 的操作也作用于该账户（其他 provider 仍是启动目录）。命令不请求模型或验证远端额度；过期令牌在下一次请求时由 Pi 正常刷新，失效的 refresh token 仍需重新登录。
- 选择在普通 `/reload` 后保留，但不写入会话或磁盘。退出重启、`/new`、`/resume` 或 `/fork` 重建会话运行时后重新使用启动账户；关闭或移除扩展并 `/reload` 同样恢复启动账户。没有定时器或每-token 认证操作。
- **兼容性边界**：认证／请求流程已在 Pi **1.1.0** 测试。Pi 当前没有公开的“在线更换凭据存储”接口，因此仅在 `account-switch/routing.ts` 中使用受结构检查保护的内部适配器；其余认证、流式请求和 OAuth 刷新仍走 Pi 自带逻辑。内部结构不兼容或存在 Codex 运行时 API-key 覆盖时拒绝启用／切换。升级 Pi 后应重跑 `npm test`。只在交互式 TUI 启用，print／JSON／RPC 不改认证。

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
- 使用上一节的配置优先级。多个实例可以共用个人配置，当前运行不会自动热更新。

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

## 测试

更名回归（Pi **1.1.0**）：完整 `npm test` **142/142 通过**，无失败或跳过；生产类型检查、Telegram fixture 类型检查、两套真实 Pi PTY 测试及本次修改的 Python 文件 Ruff／basedpyright 检查均通过。新增测试覆盖新包名、个人配置文件名与环境变量优先级；PTY 使用合成模型和拦截的 Telegram 请求，不代表真实 bot 端到端验证。

底栏排序调整后，新增「测速 → TG → LSP」顺序回归测试，重新运行完整 `npm test` **143/143 通过**，生产类型检查通过；该次检查未重跑 PTY 套件。

`npm test` 需要 PATH 上已安装 Pi（`npm install -g @earendil-works/pi-coding-agent`），使用已安装 Pi 的加载器及 jiti 加载实际扩展，再用确定性事件及单调时钟验证统计；上下文费用对照另有纯计算（验收表、分档、可配置不分档策略、未知值）、配置解析和生命周期测试。测试不调用模型、不访问 API。账户切换测试使用临时合成凭据和已安装 Pi 的真实 ModelRuntime，覆盖认证路由、保持请求上下文／模型、并发 OAuth 刷新及正确写回、登录／登出、失败回滚、reload／关闭、非 TUI 和命令交互，不读取或改动真实账号。诊断测试只在临时目录写合成日志并清理，包含原始字段缺失／显式零、转换差异、异常前后对照、并发关联保护、默认关闭、动态订阅、权限／轮换、写失败及开启诊断时的测速回归。

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
