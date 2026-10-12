# 可选缓存诊断

这是 `pi-token-speed` 的可配置功能，出厂默认关闭，不是第二个扩展。已在 Pi 1.0.1 的实际加载器上做离线验证；尚未为验证功能发送真实模型请求。

## 开关与试用

默认值在扩展根目录（与 `index.ts` 同级）的 `config.json` 设置：

```json
{
  "cacheDiagnostics": {
    "enabledByDefault": false
  }
}
```

设为 `true` 默认开启，设为 `false` 默认关闭；修改后执行 `/reload` 或重启。必须使用真正的布尔值，不接受字符串或数字。该文件属于扩展，不是 Pi 的 `settings.json`。配置只在当前扩展实例首次 `session_start` 时读取，不监听文件变化、不在模型请求期间读配置。

文件缺失时使用关闭默认值；格式错误、缺少必需字段、读取失败或超过 8 KiB 时，配置默认关闭并提示一次，不展示配置正文或异常原文。显式 CLI 布尔值优先于配置（启动参数 `pi --cache-diagnostics` 可强制开启）；无显式 CLI 值时使用文件默认。关闭开关不保证零文件读取：启动时会读取这个小配置文件，但不会创建诊断日志或计算请求指纹。

已加载旧版扩展的 Pi 先执行 `/reload`，当前实例可使用：

```text
/cache-diagnostics on
/cache-diagnostics status
/cache-diagnostics off
```

无参数等于 `status`。关闭诊断不会关闭测速。关闭会移除诊断自己的 provider 监听器并排空待写日志，不触碰其他扩展的监听器。默认关闭时不创建日志目录、不做请求指纹计算，也不增加每个原始流事件的分发工作。

命令开关只保存在当前扩展实例中，不改写配置文件；重新加载／重启或会话运行实例替换后，按配置／CLI 默认值启动。例如文件设为 `true`，临时 `off` 后，下次 `/reload` 仍会开启。切换会话后可用 `status` 确认；诊断仍启用的会话启动事件会建立新的记录目录。`status` 显示当前状态、已加载的配置默认值、启动默认来源（config／cli）和配置路径；文件编辑后的新值在下次加载时读取。`off` 不会删除命令行参数，也不会修改其他全局配置。

正常工作的请求就是样本，不需要发送测试请求。首次启用可能在某个流已经开始之后，此时仍可记录后续原始用量，但会明确标记没有可靠的请求指纹关联。

## 记录范围

当前识别 `openai-responses`、`openai-codex-responses`、`azure-openai-responses` 的 Responses 结构。其他 API 不按此格式解码，不把其他 provider 的字段差异误判为缓存读取缺失。自定义／虚拟模型的上下文标签和实际 provider 标签不一致时，可能只能记录未关联的流用量。

每次被钩子观察到的逻辑请求用本地 `call-N` 关联。日志是追加式 JSONL，**一行不等于一次请求**：

| `kind` | 内容 |
|---|---|
| `capture_start` / `capture_end` | 记录窗口、版本线索、结束原因和计数 |
| `request_start` | 请求前观察时间、模型标签、指纹摘要 |
| `request_end` | 原始终止事件的用量、响应 ID、完成状态及异常标签 |
| `normalized_usage` | 同一响应的 Pi 最终用量；通过响应 ID 或明确的单一候选关联 |
| `raw_terminal_update` | 同一响应再次出现终止事件，不当作新请求；保留后一次字段状态 |
| `request_incomplete` | 没有观察到原始终止事件、关闭、状态上限或运行结束等，不虚构缓存读取零 |
| `unmatched_normalized_usage` | 无法安全关联的最终消息用量 |
| `http_response` | 观察到的 HTTP 状态和受限格式的 `x-request-id`；没有响应对象关联 ID 的钩子只提供候选关联 |
| `comparison_reset` | 已观察到的模型、分支或压缩边界，重置比较基线 |
| `cache_warming_decision` | Pi 已有预热决策在本监听器位置的值；不代表后续扩展处理后的最终决策 |

后台预热、摘要和用户 assistant 消息并非一一对应。原始终止事件即使没有 `message_end` 也保存；并发请求、模型标签不匹配等无法确定关联的情况标记 `ambiguous` 或 `unmatched`，不强行对照前一条正常请求的前缀。`single_pending` 是基于已观察到的单一候选，不是网络层请求 ID 的证明。内部网络重试／重连未必逐次触发这些钩子，不能把这些行数当作所有实际网络尝试数。

版本线索中的 `piSdkVersion` 来自扩展使用的 Pi SDK `VERSION` 导出，`nodeVersion` 来自本进程。provider 的实际 pi-ai 实现版本没有公开入口，明确保存 `piAiVersion: "not_exposed"`，不拿硬盘上安装包的版本推断实际加载版本。

## 原始用量字段

`rawUsage` 只保留以下映射及其状态：

| 日志字段 | Responses 字段 |
|---|---|
| `input` | `usage.input_tokens`，包含缓存读取等输入组成 |
| `output` | `usage.output_tokens` |
| `total` | `usage.total_tokens` |
| `cacheRead` | `usage.input_tokens_details.cached_tokens` |
| `cacheWrite` | `usage.input_tokens_details.cache_write_tokens` |
| `reasoning` | `usage.output_tokens_details.reasoning_tokens` |

每个数值字段有四种状态：`value`、`missing`、`null`、`invalid`。只有非负安全整数保存原始数值；无效数值不保存原文。`value: 0` 才是明确返回零，缺失字段绝不补零。写入字段缺失不等于没有写入。

Pi 最终用量单独保存在 `normalized_usage.usage`，不覆盖原始字段。已知原始值和最终值不同、最终对应字段缺失，或明确可核对的未缓存输入组成不符时，记录转换差异。原始读取缺失而 Pi 保存零只说明信息不足，不称为已证实的转换错误或物理 miss。

费用只保存 Pi 最终消息已有的有限非负 `loggedEstimate`，不做新计价。这不是实际账单、订阅扣减或缓存归零的额外损失。

## 指纹与异常

指纹观察点是 `before_provider_request`。分别对 instructions、完整有序工具声明、相关设置、缓存 key 以及 input 计算 HMAC-SHA256。每个记录目录使用独立随机密钥，密钥只在内存中；不写入磁盘，因此跨目录的指纹不可比较。

input 的 JSON 序列化结果按 16 KiB 分段计算指纹，最多观察 16 MiB。超出时保存 `complete: false`。异常文件保存这些段的哈希，而非正文；正常摘要省略段列表。设置中只额外保留模型标识和已知的 reasoning effort、verbosity、service tier、缓存 mode／TTL、并行工具布尔值及工具数量。

触发详细记录的情况包括：

- 前一次可关联的完成响应读取为正，本次明确为零；
- 缓存读取比例下降至少 30 个百分点；比例需要有效、相互一致的原始输入／读取数值；
- 完成响应缺失／无效的读取字段，或输入组成不一致；
- 同一响应的多次终止事件用量发生变化；
- 原始用量与 Pi 最终用量不一致；
- 在已观察到缓存活动的上下文中持续为零，单独标记，不冒充新的“前次正值→零”配对。

首次调用不自动触发零值异常。压缩／分支处理开始前、完成后、压缩失败及模型切换会重置比较基线；取消某次转换也可能使下一次比较保守地缺少基线。异常触发后保存当前指纹、可取得的前一次指纹，再保存同作用域内下一次终止响应的指纹。关闭、切换上下文或没有后续调用时，不伪造“后一次”。

`equalLeadingBytesLowerBound` 只是客户端序列化 input 中连续相同分段的字节下界，**不是相同 token 数、模型内部前缀或服务端缓存命中保证**。短 input 的追加可能改变第一个分段，报告零下界也不等于整个历史都变了。HMAC 变化可以定位客户端变化线索，但不能单独证明这些变化导致失效。

## 隐私、上限及故障

默认根目录：`getAgentDir()/cache-diagnostics`，通常是 `~/.pi/agent/cache-diagnostics`。`PI_CACHE_DIAGNOSTICS_DIR` 可指定其他位置。每次开启／会话替换建立私有 `capture-*` 子目录；目录权限 0700，日志文件 0600。不保存工作目录、原始 session ID、完整 headers、对话、输出、工具参数正文或认证信息。session 只保存同一记录目录内可比较的 HMAC 指纹；响应 ID 属于白名单元数据。

每个子目录有两类日志：

- `summary-*.jsonl`：普通摘要及关联记录；
- `anomalies-*.jsonl`：异常和前后指纹。

每类保留最多 3 个、每个最多 4 MiB 文件，稳定保留总量不超过 24 MiB；轮换时可能短暂多一个新空文件。只删除本次私有子目录中由自身创建的旧文件，不遍历或删除其他记录目录。**不同启用／会话的旧目录保留供审计，总根目录没有跨会话自动清理上限，需要人工归档或清理。**

队列最多 2 MiB，单行最多 256 KiB。超限丢弃且累积 `dropped`；状态还显示 `rotatedFiles`，表示已经删除的旧日志文件数量。若任一值非零，保存下来的日志不是该启用窗口的完整样本，不能直接当成全窗口分母。进程突然结束、磁盘故障或未排空队列也可能丢失末尾记录；日志不是事务或网络审计账本。

内存中最多保留 16 个待关联请求、32 个响应关联，以及各 8 个比较／后续上下文作用域。长期状态只有哈希和白名单元数据，不保留原始请求对象；序列化时仍有与输入大小相关的短时内存和 CPU 开销。离线合成测试中约 2 MB input 的一次指纹计算约十几毫秒，仅作本机测试结果，不是实际模型延迟或性能保证。

常规 provider 事件只入有界内存队列，不等待文件写入。写入故障／观察器异常会停用诊断、移除自己的监听器并提示一次，不改变请求、工具、重试、保活或模型输出。开启、关闭及退出时等待初始化／排空日志；不会通过失败重发模型请求。日志异常不会在 footer 中刷屏，状态由命令查询。

## 官方 diagnostics 与证据边界

若调用方原本已经取得 `prompt_cache_diagnostics`，只记录已知 type／reason 和相关合法 token 数；未知字段不整段保存。插件**不会**增加 `comparison_response_id` 或其他官方诊断参数。Codex 订阅入口对此参数的支持仍未验证。

这些证据可以区分明确零、字段缺失和归一化差异，并检查所观察到的系统／工具／input 指纹是否变化。它们不等于最终 HTTP／WebSocket 字节，不证明物理连接是否新建、所有隐藏路由／重试是否一致、官方 TTL、服务端 miss 根因或真实订阅额度扣减。其他监听器、SDK 或传输层在本观察点之后仍可能处理数据；转换差异也不自动归因于某一个 SDK 缺陷。
