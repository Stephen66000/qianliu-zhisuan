# Design

## Context

参见 `proposal.md` 的 Why。当前正式 Gateway 通过资源感知策略解析首字节和流式空闲门限；空闲默认 45 秒，智谱 Coding Plan 默认为 120 秒，厂商／模式变量可以继续覆盖。上游解析器用 `AbortSignal` 实现首字节、空闲和总时长三层计时，但底层 Undici 7.29.0 还有默认 300 秒 `bodyTimeout`。

Chat 和 Messages 的上游数据可逐块北向转发；Messages 已每 5 秒发送 ping。Responses 目前聚合完整上游输出后才生成北向 SSE。Coding Plan 并发租约默认 TTL 为 60 秒，正式调用尚未把 TTL 与总调用时限同源装配。

## Goals / Non-Goals

**Goals:**

- 让业务层 300 秒连续空闲计时成为正式流式调用唯一有效的空闲判定。
- 确保 HTTP 客户端、代理和租约不会在业务合同之前抢先终止或回收。
- 三种协议使用一致的失败含义，同时保持各自合法的传输格式。
- 将配置迁移、测试、发布和回滚绑定到同一候选版本。

**Non-Goals:**

- 不实现跨模型自动接替、自动重放、断点续写或 Agent 任务恢复。
- 不改变首字节门限、600 秒总调用时限、模型路由评分、额度规则或计价规则。
- 不改造 Responses 为真正的逐块北向透传；该演进如有需要另立变更。
- 不增加数据库迁移、管理后台页面或新的监控系统。

## Decisions

### 1. 正式调用只保留一个空闲门限来源

正式 Gateway 的 `createStreamIdleTimeoutPolicy` 只读取 `GATEWAY_UPSTREAM_STREAM_IDLE_TIMEOUT_MS`，空值默认 300000。厂商和模式级空闲变量不再参与解析；启动时扫描已知旧变量并各提示一次弃用，日志只输出变量名和迁移指引。

通用 `createOpenAiCompatibleCaller` 的回退默认值同步为 300000，避免新接入或旁路正式调用回落到 45 秒。模型发现和验证显式传入的 15／30／60 秒时限不变。

备选方案是保留厂商覆盖并在部署层逐一写 300000。该方案会让未来新增资源和遗留变量继续产生漂移，因此不采用。

### 2. 业务空闲计时只由非空原始上游块刷新

`readSseData` 在读到 `Uint8Array.byteLength > 0` 时调用 `markChunk`；合法 SSE 注释和心跳虽然不会产生业务 `data`，仍属于非空上游活动。零长度块跳过计时刷新。异常 EOF、损坏 JSON 和显式上游错误保持即时失败。

这保留“连接仍有活动”和“产生可展示正文”之间的区别，同时关闭用零长度读取无限续期的漏洞。

### 3. 给业务计时器留出底层 HTTP 余量

为生产上游 Caller 使用显式 Undici dispatcher。其 `bodyTimeout` 由流式空闲门限加固定安全余量派生，初始取 `300000 + 30000 = 330000` 毫秒。`headersTimeout` 由统一安全余量 `30_000` 毫秒与有效首字节门限、总调用时限同源派生：

- `headersTimeout = max(有效首字节门限, 总调用时限) + 30_000`（毫秒）。

这保证业务层 `FIRST_BYTE_TIMEOUT` 与 600 秒 `REQUEST_TIMEOUT` 的 AbortSignal 都先于 Undici headers timeout 触发；`bodyTimeout` 仅由流式空闲门限派生时亦满足"业务先触发"，因为空闲窗口结束早于总时限或与总时限独立并存，而 body 数据流动期间 headers 阶段早已结束。门限派生统一经过 `readPositiveMs` 式正整数（安全整数）校验，非法配置启动即失败；dispatcher 派生值与其单测断言使用同一公式常量，公式、校验和测试保持一致。总调用仍由 600 秒 `AbortSignal` 控制。

dispatcher 的时限只用于兜底，业务 AbortSignal 必须先触发并留下 `STREAM_IDLE_TIMEOUT`。真实 HTTP 慢流测试用 300 秒边界验证这一顺序，而不是只用 mock fetch。

备选方案是把 Undici body timeout 设为 0。该方案会移除基础设施兜底，扩大计时器失效时的悬挂风险，因此不采用。

### 4. 并发租约与总调用时限同源派生

生产 runtime 同源生成 `requestTimeoutMs`、上游 Caller、半开探针租约和 Coding Plan 并发租约 TTL。并发租约初始采用 `requestTimeoutMs + 60000`，由准备 Attempt 时显式传给仓储，避免依赖 60 秒默认值。

该变更不修改数据库结构。测试覆盖租约超过 300 秒仍有效、请求结束原子释放，以及恢复任务不会提前回收。

### 5. 以分层代理配置保障 Responses，不在本次改造其传输架构

Messages 保持已有 ping。Chat 在已开始输出后的 300 秒空闲期间依赖可控代理的读取时限；Responses 因聚合行为，需要可控代理覆盖 600 秒总调用时限和发送余量。目标环境对 `/v1/*` 的有效等待不低于 660 秒，并保留 `flush_interval -1` 等流式设置。

实际生产可能经过宝塔、CDN 或其他反代，因此仓库 Caddy 模板不是生效证据。WP1 必须得到真实链路的配置和验证结果。若 WorkBuddy 自身提前终止且不可配置，记录业务验收缺口，不通过伪造心跳宣称解决。

备选方案是给 Chat 和 Responses 增加 SSE 注释心跳。该方案可能改变尚未提交的 Responses 行为和第三方解析兼容性；本次只在真实验证证明代理调整不足且客户端兼容后，更新 OpenSpec 再实施。

### 6. 错误文案以 failureLayer 判定

失败呈现不得只判断通用 `outcome.error=upstream_timeout`，还必须检查 `failureLayer`。只有 `STREAM_IDLE_TIMEOUT` 使用约定中文文案；`FIRST_BYTE_TIMEOUT` 和 `REQUEST_TIMEOUT` 保留独立含义。

已提交的 Chat／Messages 通过现有 Writer 发送协议内错误；未提交路径和 Responses 聚合失败返回 HTTP 504 兼容错误。机器字段保留 `upstream_timeout`、`STREAM_IDLE_TIMEOUT` 和真实 AI 请求 ID。

### 7. 空闲超时是终止性 Attempt 结果

`shouldAttemptUpstreamFailover` 对 `failureLayer=STREAM_IDLE_TIMEOUT` 明确返回 false，无论北向响应是否已经提交。这样既避免已输出后拼接，也避免等待五分钟后再开启另一轮最长六分钟的调用。

此前因其他可切换错误产生的 Attempt 保持不变；测试断言的是“空闲超时后 Attempt 数不再增加”，不是整个请求只能有一个 Attempt。

## Risks / Trade-offs

- [真正卡死的请求更晚失败，持续占用连接和资源] → 保留 600 秒总时限，租约覆盖且结束后释放，并在账本观察等待时长和并发占用。
- [底层时限、业务时限和事件循环调度仍可能在边界竞争] → 保留 30 秒余量，使用真实 HTTP 300 秒测试，并记录触发层。
- [统一门限失去厂商级精细调节] → 这是本次明确的产品决定；以后若恢复差异化，应通过新的规格变更和可观测证据完成。
- [Responses 长时间没有下游字节] → 将代理等待覆盖总时限并做 WorkBuddy 实测；真正逐块 Responses 另立变更。
- [旧环境变量失效属于运维兼容变化] → 发布前枚举、脱敏告警和清理，回滚包保留原值。
- [五分钟真实时间测试增加发布耗时] → 单元边界用假时钟，候选发布前只保留一次必要的真实链路验收。

## Migration Plan

1. 在隔离工作区锁定与生产对应的代码基线，采集生产镜像、容器环境和实际反代的只读证据。
2. 完成策略、Caller、解析器、租约、错误呈现和测试修改；不触碰数据库。
3. 生成候选镜像并在隔离环境执行确定性测试、真实 HTTP 慢流和三协议验证。
4. 准备环境变量差异：全局值 300000，清理厂商／模式旧值；准备实际代理时限调整及 WorkBuddy 验收步骤。
5. 获得部署授权后选择无关键长请求的窗口，替换 Gateway 和相关代理配置；核验运行镜像、容器环境、有效门限和公网行为。
6. 回滚时恢复原镜像、旧环境变量和原代理设置，检查健康状态、租约释放与请求账本。

## Open Questions

- WorkBuddy 5.5.6 是否原样显示 Gateway 中文流内错误，还是统一包装为 3003；该问题不改变服务端合同或任务拆分，但决定最终客户端验收结论。
- 生产入口是否还有宝塔之外的 CDN／负载均衡；WP1 只读核验后补充到部署证据，不改变规格。
