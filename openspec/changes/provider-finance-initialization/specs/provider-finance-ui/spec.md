# Delta Spec: Provider Finance Initialization UI

## ADDED Requirements

### Requirement PFU-01: Initialization mode and daily mode are mutually exclusive

系统 SHALL 在企业严格写未激活时展示初始化向导，在激活后展示日常充值与订阅面板；运行模式为 `OFF` 时不得展示资金功能。

#### Scenario: Enterprise is not activated

- **GIVEN** 资金模式不是 `OFF` 且企业 `strict_writes_enabled=false`
- **WHEN** 管理员打开“厂商资源 → 充值与订阅”
- **THEN** 页面展示资金初始化向导
- **AND** 日常充值、续费和自动续订操作保持不可用

#### Scenario: Enterprise is activated

- **GIVEN** 企业 `strict_writes_enabled=true`
- **WHEN** 管理员刷新页面
- **THEN** 页面隐藏企业级初始化向导
- **AND** 展示日常资金面板和激活回执摘要

### Requirement PFU-02: Complete draft editing

系统 SHALL 让管理员在一个初始化流程中完成 API 期初、历史 API 充值、Coding Plan 购买/续费、跨切换周期和旧记录关闭决定。

#### Scenario: Existing recharge record requires completion

- **GIVEN** 旧购买记录被识别为真实 API 充值但缺少人民币实付
- **WHEN** 管理员编辑初始化草稿
- **THEN** 页面显示原记录引用并要求补充实付、订单和证据
- **AND** 该记录未完成前预检按钮可执行但结果必须为 `NO_GO`

### Requirement PFU-03: Structured preflight feedback

系统 SHALL 按资源、账户、旧记录、月份和用量缺口类型展示预检结果。

#### Scenario: Candidate is not ready

- **GIVEN** 预检返回多个结构化缺口
- **WHEN** 页面展示结果
- **THEN** 管理员可以定位到每个缺口对应的表单行或事实类别
- **AND** 激活按钮保持禁用

#### Scenario: Candidate becomes stale

- **GIVEN** 页面已有 `GO_CANDIDATE`
- **WHEN** 服务端检测到事实水位变化
- **THEN** 页面清除可激活状态并提示重新预检
- **AND** 不得继续提交旧候选

#### Scenario: Serializable activation requires manual retry

- **GIVEN** 激活返回 `409 ACTIVATION_RETRY_REQUIRED` 和 `retryable=true`
- **WHEN** 页面处理响应
- **THEN** 页面不得静默自动重试资金激活
- **AND** 重新读取 activation-state，向管理员展示“事务已回滚，可人工重试”
- **AND** 水位变化时要求重新预检

### Requirement PFU-04: Explicit irreversible activation confirmation

系统 SHALL 在激活前展示不可逆影响、候选哈希、事实水位、候选过期时间和企业确认输入。

#### Scenario: Confirmation enterprise does not match

- **GIVEN** 管理员输入的确认企业与会话企业不一致
- **WHEN** 管理员尝试激活
- **THEN** 前端不提交或服务端拒绝请求
- **AND** 候选保持未激活

#### Scenario: Activation succeeds

- **GIVEN** 管理员确认匹配且候选仍有效
- **WHEN** 激活返回成功
- **THEN** 页面展示激活回执和审计摘要
- **AND** 刷新厂商资源、资金摘要、余额、订阅周期、经营账单和首页缓存

#### Scenario: Enterprise is not quiescent

- **GIVEN** 静默租约无效、即将过期或仍有在途结算
- **WHEN** 管理员尝试预检或激活
- **THEN** 页面展示 `ACTIVATION_NOT_QUIESCENT` 的具体排空缺口
- **AND** 激活按钮保持禁用

### Requirement PFU-05: Zero and evidence are explicit

系统 SHALL 区分金额空值与零值，并对期初及历史资金事实强制要求说明和证据引用。

#### Scenario: Empty opening amount

- **GIVEN** 管理员没有填写期初余额
- **WHEN** 提交预检
- **THEN** 页面将其标记为未填写
- **AND** 不得自动转换为 `0`

#### Scenario: Explicit zero opening amount

- **GIVEN** 管理员输入 `0` 并填写说明和证据
- **WHEN** 提交预检
- **THEN** 页面把它作为有效零值发送
- **AND** 预检可以基于该事实继续计算

### Requirement PFU-06: Permission-aware UI

系统 SHALL 根据管理员权限区分只读状态查看、草稿预检和激活操作，但服务端权限始终为最终门禁。

#### Scenario: View-only administrator

- **GIVEN** 管理员仅拥有 `resources.view`
- **WHEN** 打开初始化页面
- **THEN** 可以查看状态、缺口和回执
- **AND** 不能保存草稿、创建预检候选或执行激活
