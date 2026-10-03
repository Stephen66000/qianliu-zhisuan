# Coding Plan quota windows

## Purpose

为 Kimi 和智谱 Coding Plan 用户提供可理解的 5 小时及周额度耗尽提示，准确表达预计恢复时间，在厂商确认全部阻断窗口恢复后自动恢复原 Key 的调用能力，同时确保等待期间不误放行、不自动转用额外付费资源。

## ADDED Requirements

### Requirement: Identify the actual exhausted window
系统 SHALL 区分 5 小时、周、两项同时耗尽以及明确套餐耗尽但窗口未知。普通并发／频率限制、主体本地额度、鉴权和管理员策略 SHALL 保持独立含义。

#### Scenario: Five hour limit
- **WHEN** Kimi 或智谱的 Coding Plan 响应明确证明 5 小时窗口耗尽
- **THEN** 错误提示 SHALL 写明厂商和“5 小时额度已用完”，并说明系统自动恢复及届时重试

#### Scenario: Weekly limit
- **WHEN** 响应或有效窗口事实明确证明仅周窗口耗尽
- **THEN** 提示 SHALL 写明“周额度已用完”，不使用 5 小时窗口名称或时间

#### Scenario: Window cannot be determined
- **WHEN** 只知道厂商套餐额度耗尽但不能确认属于哪个窗口
- **THEN** 提示 SHALL 使用“套餐额度已用完”，窗口类型 SHALL 保持未知，不猜测为周额度

#### Scenario: Ordinary throttling and authentication
- **WHEN** 错误只表示并发限制、请求频率或真实凭证失效
- **THEN** 系统 SHALL 不把它表述为厂商窗口耗尽，也不以本能力清除该阻断

### Requirement: Estimate recovery only from attributable evidence
系统 SHALL 使用属于同企业、同资源、同阻断窗口的可信时间。中文 SHALL 使用北京时间；机器时间 SHALL 使用 ISO 格式。预计时间不构成已经恢复的证据。

#### Scenario: Provider supplied recovery
- **WHEN** 已识别的窗口耗尽响应提供合法未来重置时间，或语义属于该窗口的 Retry-After
- **THEN** 提示 SHALL 使用该时间；不能把普通限流的重试间隔解释为周重置时间

#### Scenario: Snapshot fallback
- **WHEN** 响应缺少时间但同窗口成功快照符合计划中冻结的新鲜度规则
- **THEN** 提示 SHALL 使用该窗口时间，不从另一个窗口或另一资源读取

#### Scenario: Both windows exhausted with known times
- **WHEN** 5 小时与周窗口都耗尽且各自预计恢复时间已知
- **THEN** 提示 SHALL 写明两项耗尽，整体预计可用时间 SHALL 为较晚的时间

#### Scenario: Any blocking time is unknown
- **WHEN** 全部时间未知，或两个阻断窗口之一的时间未知
- **THEN** 整体预计可用时间 SHALL 保持未知，提示系统将自动检查；不得使用报错时刻加 5 小时或 7 天推算

#### Scenario: Known reset remains in the future
- **WHEN** 当前耗尽事实已保存厂商指定的未来重置时间，采集已超过10分钟
- **THEN** 系统 SHALL 继续展示该重置事实，不仅因采集变旧而抹掉它，也不以它证明余量已恢复

#### Scenario: Original estimate has passed
- **WHEN** 原预计点已到但余量尚未确认
- **THEN** 系统 SHALL 提示正在自动确认，next_reset_at为null，不把下一查询点冒充厂商恢复点

### Requirement: Preserve the message across request paths
对已授权且明确受厂商窗口阻断的请求，系统 SHALL 在首次失败、等待期间重试和准入拒绝时保留具体窗口提示。未提交响应 SHALL 返回 HTTP 429 兼容错误与请求 ID；已提交流 SHALL 使用协议内错误而不伪装成功。

#### Scenario: Repeated request during isolation
- **WHEN** 用户在已记录窗口耗尽后使用原 Key 再次请求同一模型
- **THEN** 系统 SHALL 返回实际窗口原因及仍可信的预计时间，而不是只有“无可用上游资源”；不会调用上游生成接口

#### Scenario: Protocol variants
- **WHEN** 请求通过 Chat Completions、Messages 或 Responses 进入
- **THEN** 各协议错误 SHALL 表达相同窗口和预计恢复语义，保留各自合法输出结构

#### Scenario: Stream already committed
- **WHEN** 已提交的流发生明确窗口耗尽失败
- **THEN** 系统 SHALL 发送合法流内错误并结束，不改写已发送 HTTP 状态、不附加其他模型输出

#### Scenario: Multiple unrelated candidate failures
- **WHEN** 一个模型存在多个已授权资源且阻断原因不同
- **THEN** 系统 SHALL 只在证据确立的资源范围内说明额度耗尽，不把单个账号的时间冒充所有资源的恢复时间

### Requirement: Preserve every unresolved exhausted window
系统 SHALL 在查询失败、字段缺失、进程重启及后续不支持窗口时保留当前仍未解除的阻断窗口，直到与当前凭证及故障相匹配的成功证据确认该窗口恢复。

#### Scenario: Weekly window disappears
- **WHEN** 周窗口已确认耗尽，之后的查询只返回有余量的 5 小时窗口
- **THEN** 周额度阻断 SHALL 保持，继续查询而不恢复普通调用

#### Scenario: Recovery and next quota cycle
- **WHEN** 当前耗尽窗口已获有效恢复证据，后来进入新的耗尽周期
- **THEN** 系统 SHALL 不让前一周期的耗尽记录永久阻断新周期，也不让前一周期的恢复证据解除新故障

### Requirement: Confirm quota before reopening generation
系统 SHALL 在预计时间到达后自动检查厂商窗口，只在所有相关阻断窗口确认有余量时恢复原 Key 调用。管理员 SHALL 不需要点击同步、保存、验证或恢复。

#### Scenario: Timer expires before quota query succeeds
- **WHEN** 重置时间已到，查询尚未完成、查询失败或仍返回零
- **THEN** 普通请求和消耗生成额度的半开探针 SHALL 保持阻断，仅自动安排后续额度检查

#### Scenario: All blocking windows recover
- **WHEN** 当前凭证及故障对应的成功查询确认所有阻断窗口有余量
- **THEN** 原有效 Key SHALL 自动可调用；额度类阻断不会要求第二次人工解除

#### Scenario: One window is still exhausted
- **WHEN** 5 小时窗口恢复但周窗口仍耗尽
- **THEN** 调用 SHALL 保持阻断，提示周额度耗尽并使用周恢复时间

#### Scenario: Key is no longer authorized
- **WHEN** 等待期间管理员撤销该 Key 或模型授权
- **THEN** 自动额度恢复 SHALL 不重新授予已撤销权限，也不把未授权请求改成额度提示

#### Scenario: Admin changes only the visible resource status
- **WHEN** 当前额度阻断仍未获得恢复证据而管理操作改变资源status
- **THEN** 普通生成请求 SHALL 继续受额度事实门禁限制，不能绕过到期确认规则

### Requirement: Recovery evidence cannot cross state generations
系统 SHALL 仅在查询对应的资源、凭证版本和故障仍有效时提交恢复；资源、窗口及适用额度类阻断 SHALL 不因部分提交呈现已经可用。真实鉴权或管理员策略不得被额度恢复解除。

#### Scenario: Credential rotates during quota query
- **WHEN** 查询进行期间资源凭证更换
- **THEN** 旧凭证查询结果 SHALL 不覆盖新凭证的当前窗口与恢复状态

#### Scenario: Active quota block and credential replacement
- **WHEN** 受控更换仍有活跃额度阻断的资源凭证
- **THEN** 新凭证 SHALL 等待自身额度确认，旧查询和旧窗口不能证明新凭证有余量

#### Scenario: New exhaustion occurs before recovery commits
- **WHEN** 同步返回有余量后、提交恢复前发生新的耗尽故障
- **THEN** 旧查询结果 SHALL 不解除新故障，下一轮以新故障重新检查

#### Scenario: Partial recovery commit fails
- **WHEN** 窗口、资源、原Key模型或关联额度事件的恢复提交中发生错误
- **THEN** 本次恢复 SHALL 全部回滚，不出现部分可调用状态；只清除同一当前额度故障关联事件

### Requirement: Quota exhaustion cannot trigger extra spending
系统 SHALL 在 Coding Plan 窗口耗尽时结束请求，不自动切换模型或使用额外付费 API、已购余额，不在后台重放失败请求。只有明确单独的付费授权才能允许超出套餐的费用，模型技术授权不等于付费授权。

#### Scenario: Mixed coding plan and API routes
- **WHEN** 同一模型同时配置 Coding Plan 和付费 API，套餐窗口已耗尽且没有单独付费授权
- **THEN** 首次失败及后续重试 SHALL 不向付费 API 发起 Attempt，不因套餐候选被过滤而自动使用余额

#### Scenario: Intent before filtering and dispatch switch
- **WHEN** 原始有效授权集合中有启用未归档CP路由，状态过滤使其暂时不可用或策略试图SWITCH到API
- **THEN** 本能力 SHALL 保持PLAN_ONLY意图，初选和SWITCH都不得付费回退；配置、余额和未验证请求头不构成支付许可

#### Scenario: API only model
- **WHEN** 当前Key目标模型只有有效API路由，没有本能力保护的CP路由
- **THEN** 系统 SHALL 保持原API及授权行为，不因本变更全局关闭API

#### Scenario: No background replay
- **WHEN** 额度在后台恢复
- **THEN** 系统 SHALL 只恢复接收新请求，不自动重跑先前失败的请求

### Requirement: Verify actual client visibility separately
系统 SHALL 分别记录服务端协议合同验证、部署验证和实际客户端验收，不以 OpenSpec 格式校验或健康检查代替业务验收。

#### Scenario: Client wraps the error
- **WHEN** Gateway 返回正确窗口错误但实际客户端只显示通用错误
- **THEN** 验收 SHALL 记录该客户端提示不可见，不能声明该入口业务验收完成

### Requirement: Automatic checks survive unrelated task errors
在Worker持续运行且必要数据库可用时，系统 SHALL 在独立前置任务失败后仍尝试额度检查。单资源失败不能阻止其他资源及后续检查，真实错误不能冒充成功。

#### Scenario: A preceding task fails
- **WHEN** 基础设施、运行事件或预测任务在同一循环发生异常
- **THEN** 额度任务 SHALL 仍被尝试，原错误独立记录，后续循环继续检查

#### Scenario: One resource query fails
- **WHEN** 一项资源的额度接口查询失败
- **THEN** 系统 SHALL 保留其阻断并安排下次检查，同时继续处理其他到期资源
