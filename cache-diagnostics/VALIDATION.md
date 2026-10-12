# 离线验收记录

## 配置文件增补（最新验收）

2026-10-03 UTC 22:13:35 开始检查新增默认配置功能：`jq -e '.cacheDiagnostics.enabledByDefault == false' config.json`、`npm run typecheck`、`node --check test/cache-diagnostics.test.mjs`、`npm test` 均通过；**55/55 测试通过**，无跳过，完整命令约 8 秒。

新增的 6 项测试覆盖：配置路径不受工作目录影响；合法布尔值与错误／超大／缺失配置；配置默认开启在新实例中生效；临时命令不改写配置；文件修改只在重新加载时生效；显式 CLI 优先级与错误提示不泄露正文。为避免误将“未指定 CLI”当成显式关闭，注册 CLI flag 时不再提供 false 默认值，而在首次 session_start 中区分 undefined 与 boolean。

新增 `config.json` 的实际值仍为 `false`，没有对当前 Pi 会话启用诊断，没有发送模型请求或修改 Pi 的 settings.json。修改前的相关文件备份位于 `.backups/2026-10-03-default-config/`。下次加载按文件／显式 CLI 默认值启动，运行中的 on/off 命令不写回文件。

## 初版验收（历史记录）

- 时间：2026-10-03，最终检查开始于 UTC 21:50:19。
- 环境：Pi 1.0.1、Node v22.23.2；HPC 计算节点上的已有交互会话，没有申请或提交新资源。
- 最终命令：`npm run typecheck`；`node --check test/cache-diagnostics.test.mjs`；`node --check test/speed.test.mjs`；`npm test`。
- 结果：类型／语法检查通过，**49/49 测试通过**，无跳过；完整命令约 7.5 秒，Node 测试执行约 2.1 秒。

## 覆盖

原测速回归与新增诊断测试覆盖：明确零／缺失／null／非法数值、正常冷启动、读取正值后归零、部分大幅下降、持续零、归一化差异、失败／中断／未取得终止事件、重复终止事件、并发和未关联请求、不同模型不能取得其他请求指纹、压缩前后基线、预热决策只观察不修改、隐私白名单、每次启用独立 HMAC、16 MiB 指纹截断、待关联状态上限、默认关闭不创建目录或订阅原始流、开启后的测速／其他 footer 状态保持、命令与 CLI 开关、日志权限／轮换／队列丢弃／写失败、幂等关闭排空、真实 Pi 加载器及动态监听器移除。

约 2,000,002 字节的合成 input 在最后一轮中一次指纹计算为 11.5 ms；这不是实际模型延迟或性能保证。NaN／Infinity／负数等仅在故意构造的离线非法用量夹具中使用，预期被标记为 invalid，不写入数值或造成速度误报。

## 修正过的检查失败

- 初次类型检查发现闭包中的 assistant 消息窄化丢失，以及事件名联合类型不能匹配 `pi.on` 重载；已改为稳定局部变量和逐个有类型的事件注册。
- 一次新增的真实加载器冒烟用错了 `EventBus` 构造器，导致 46/47 通过；已使用实际 API 的 `createEventBus()`，再增补启用状态测速及压缩测试后，最终 49/49 通过。

## 没有做的操作

没有启动 agent 或发送模型请求，没有新增保活／重试，没有修改请求参数、SDK、系统提示词、工具声明、认证文件、全局设置或安装链接；也没有向厂商提交数据。真实加载器开关冒烟只在独立 Node 测试进程中使用合成上下文和临时日志目录，启用／关闭后删除临时数据，不是对当前工作的 Pi 会话启用诊断。

当时已有的扩展安装链接保持不变并指向本项目；后续更名后的安装入口见[主 README](../README.md#安装)。初版在没有显式 CLI 开启参数时默认关闭；配置增补后按 config.json／显式 CLI 默认值启动，当前文件仍为 false。真实 provider 的返回兼容性尚未通过调用验证，下一步应单会话观察正常工作。

## 源文件备份

目录不是 Git 仓库；修改前的 `index.ts`、`README.md`、`tsconfig.json` 和 `test/speed.test.mjs` 保存在 `.backups/2026-10-03-cache-diagnostics/`，未改动该备份。新增实现位于 `cache-diagnostics/`，新增测试为 `test/cache-diagnostics.test.mjs`。
