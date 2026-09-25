# Delta Spec: Provider Finance Activation

## ADDED Requirements

### Requirement PFA-01: Complete activation scope

系统 SHALL 在每次预检中生成企业级不可变激活范围快照，覆盖切换时点至预检事实水位的全部相关 API 资源、Coding Plan 资源、必要币种账户、旧购买记录和用量事实。

#### Scenario: Active API resource without known account currency

- **GIVEN** 一个未删除的 API 资源没有余额快照、资金事件、已定价用量币种或历史充值币种
- **WHEN** 管理员提交初始化草稿
- **THEN** 系统要求管理员显式选择至少一个账户币种并提供说明与证据
- **AND** 系统不得自动假定 CNY 或 USD

#### Scenario: Resource changes after preview

- **GIVEN** 候选预检结果为 `GO_CANDIDATE`
- **WHEN** 激活前资源被新增、删除、改模式、改状态或改变财务相关配置
- **THEN** 激活返回 `409 CANDIDATE_STALE`
- **AND** 不写入任何初始化事实

### Requirement PFA-02: Financially read-only preview

系统 SHALL 将草稿作为虚拟事实执行假设投影；预检不得写入资金事件、订阅周期、运行激活状态或修改 `ledger_line`，但 MAY 保存不具财务权威性的候选元数据和预检审计。

#### Scenario: Preview a complete draft

- **GIVEN** 管理员提交完整期初、历史充值、Coding Plan 购买与周期草稿
- **WHEN** 系统执行预检
- **THEN** 草稿参与余额、周期归属和经营账单投影
- **AND** 返回候选哈希、事实水位、有效期和 `GO_CANDIDATE | NO_GO`
- **AND** 资金事实表、订阅周期表和 `ledger_line` 内容保持不变

#### Scenario: Preview has multiple gaps

- **GIVEN** 草稿同时缺少一个 API 期初、一个购买实付和一个套餐周期
- **WHEN** 系统执行预检
- **THEN** 返回三个可定位到资源或旧记录的结构化缺口
- **AND** 不得只返回第一个错误字符串

### Requirement PFA-03: Candidate integrity and expiry

系统 SHALL 使用稳定规范化、SHA-256 候选哈希、完整事实水位和过期时间绑定预检结果。

#### Scenario: Input order changes only

- **GIVEN** 两份草稿包含完全相同的领域事实但数组顺序和 JSON 属性顺序不同
- **WHEN** 系统规范化并计算候选哈希
- **THEN** 两份草稿得到相同候选哈希

#### Scenario: Candidate expires

- **GIVEN** 一个创建并提交候选元数据已满 30 分钟的 `GO_CANDIDATE`
- **WHEN** 管理员请求激活
- **THEN** 系统返回 `409 CANDIDATE_EXPIRED`
- **AND** 不执行任何资金写入

#### Scenario: Candidate TTL does not slide

- **GIVEN** 一个尚未过期的候选被读取、锁竞争失败或遇到 `40001/40P01`
- **WHEN** 客户端再次读取或重试
- **THEN** 原 `expires_at` 保持不变
- **AND** 系统不得因失败或重放延长 30 分钟有效期

### Requirement PFA-04: Atomic activation

系统 SHALL 在一个 `SERIALIZABLE` 外层事务中完成候选复验、初始化事实写入、允许的历史修复、完整守恒、严格写激活和审计，任一步失败必须零写入回滚。

#### Scenario: Activation succeeds

- **GIVEN** 未过期且事实水位未变化的 `GO_CANDIDATE`
- **AND** 管理员拥有 `resources.operate`
- **WHEN** 管理员提交匹配的企业确认、候选哈希和激活幂等键
- **THEN** 系统在同一事务中写入全部事实并激活严格写
- **AND** 返回不可变激活回执

#### Scenario: Failure after some internal writes

- **GIVEN** 激活事务已经执行部分内部插入
- **WHEN** 最终守恒检查失败或任一数据库约束失败
- **THEN** 整个事务回滚
- **AND** 不得留下期初、充值、周期、用量修复、激活状态或成功审计的部分结果

#### Scenario: Serialization failure before or during commit

- **GIVEN** 激活使用 `SERIALIZABLE` 外层事务
- **WHEN** PostgreSQL 在事务语句或提交边界返回 `40001` 或 `40P01`
- **THEN** 整个事务回滚并返回 `409 ACTIVATION_RETRY_REQUIRED`
- **AND** 响应包含 `retryable=true`
- **AND** 服务端协调器、仓储和 HTTP 层均不得自动重试
- **AND** 管理员再次提交前必须重新读取激活状态

#### Scenario: Retry after serialization failure

- **GIVEN** 前一次激活因 `ACTIVATION_RETRY_REQUIRED` 回滚
- **WHEN** 管理员使用相同幂等键重新提交
- **THEN** 水位未变化时可以继续使用原候选
- **AND** 水位变化时返回 `409 CANDIDATE_STALE` 并要求重新预检

#### Scenario: Process exits during activation transaction

- **GIVEN** 候选状态为 `PREVIEWED`
- **WHEN** 激活进程在提交前退出
- **THEN** 数据库回滚且候选仍为 `PREVIEWED`
- **AND** 系统中不存在持久化的 `ACTIVATING` 状态

### Requirement PFA-05: Fail-fast activation concurrency

系统 SHALL 使用企业级 `pg_try_advisory_xact_lock` 串行化激活；未取得锁时立即失败，不排队等待。

#### Scenario: Two administrators activate concurrently

- **GIVEN** 两名管理员同时提交同一企业的激活请求
- **WHEN** 第一请求已经持有企业激活锁
- **THEN** 第二请求返回 `409 ACTIVATION_IN_PROGRESS`
- **AND** 最终最多产生一组初始化事实和一个激活结果

#### Scenario: Activation lock uses a dedicated 64-bit namespace

- **GIVEN** 系统请求企业级激活锁
- **WHEN** 计算咨询锁键
- **THEN** 使用 `hashtextextended('qianliu:provider-finance-activation:v1:' || enterprise_id, 0)`
- **AND** 不得使用无业务命名空间的裸企业 ID 或 32 位 `hashtext` 键

### Requirement PFA-06: Enterprise-level activation idempotency

系统 SHALL 按企业、激活幂等键和候选哈希保存并重放激活结果。

#### Scenario: Same key and same candidate replay

- **GIVEN** 某候选已经成功激活
- **WHEN** 再次提交相同企业、幂等键和候选哈希
- **THEN** 返回第一次激活结果并标记 `replayed=true`

#### Scenario: Same key with different candidate

- **GIVEN** 一个激活幂等键已经绑定候选 A
- **WHEN** 客户端使用相同幂等键提交候选 B
- **THEN** 返回 `409 IDEMPOTENCY_CONFLICT`

#### Scenario: Enterprise already activated by another request

- **GIVEN** 企业已由候选 A 激活
- **WHEN** 提交不同幂等键或不同候选
- **THEN** 返回 `409 ALREADY_ACTIVATED`
- **AND** 不得把它伪装成成功重放

### Requirement PFA-07: Session-derived authority

系统 SHALL 仅从认证会话取得企业、管理员、角色和权限；请求体身份只能用于二次确认，不得覆盖会话身份。

#### Scenario: Forged enterprise or administrator identity

- **GIVEN** 已登录管理员在请求体伪造其他企业或管理员 ID
- **WHEN** 请求预检或激活
- **THEN** 服务端忽略或拒绝伪造身份
- **AND** 不得访问或修改其他企业数据

### Requirement PFA-08: Irreversible activation with operational stop-write

系统 SHALL 保持数据库严格写激活不可逆；异常停写必须通过 Control API 与 Worker 双端运行模式完成。

#### Scenario: Emergency stop after activation

- **GIVEN** 企业已经激活严格资金写
- **WHEN** 运维将 Control API 与 Worker 同时切换为 `DARK`
- **THEN** 新充值、续费、自动续订和严格账本写入停止
- **AND** `strict_writes_enabled` 仍保持 `true`
- **AND** 已有资金事实保持不变

### Requirement PFA-09: Pre-activation quiescence

系统 SHALL 在生产预检和激活前建立目标企业的审计静默租约，暂停新 Gateway 请求和自动续订，并排空全部在途请求与结算事实。

#### Scenario: Start a quiescence lease

- **GIVEN** 企业尚未激活严格资金写并已获得生产激活授权
- **WHEN** 管理员启动静默租约
- **THEN** Gateway 拒绝该企业新的 admission
- **AND** Worker 跳过该企业自动续订和会改变候选事实的任务
- **AND** 已提交上游的请求继续完成，不被强制中断

#### Scenario: Preview before drain completes

- **GIVEN** 静默租约有效但仍存在 `IN_PROGRESS` 请求、未完成 Attempt、未配对 Usage/Ledger 或待结算事务
- **WHEN** 管理员请求预检
- **THEN** 返回 `409 ACTIVATION_NOT_QUIESCENT`
- **AND** 不生成 `GO_CANDIDATE`

#### Scenario: Lease expires

- **GIVEN** 静默租约已达到最长 60 分钟
- **WHEN** Gateway 或 Worker 检查租约
- **THEN** 租约自动失效并恢复该企业流量和自动续订
- **AND** 在该租约下生成的旧候选不得继续激活

#### Scenario: Lease has insufficient remaining time

- **GIVEN** 静默租约剩余时间不足 5 分钟
- **WHEN** 管理员请求激活
- **THEN** 返回 `409 ACTIVATION_NOT_QUIESCENT`
- **AND** 要求重新建立静默期和候选
