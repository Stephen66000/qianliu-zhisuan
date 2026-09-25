# Delta Spec: Provider Finance Initialization Facts

## ADDED Requirements

### Requirement PFH-01: Opening balance per required account

系统 SHALL 为激活范围内每个 API 资源的每个必要币种账户建立且仅建立一条原始期初余额，发生时间固定为资金切换时点。

#### Scenario: Explicit zero opening

- **GIVEN** API 账户在切换时点尚未启用
- **WHEN** 管理员明确录入金额 `0`、说明和证据
- **THEN** 系统接受零值期初并参与守恒
- **AND** 空值不得等同于零值

#### Scenario: Duplicate opening with different amount

- **GIVEN** 某企业、资源和币种已经存在原始期初余额
- **WHEN** 候选尝试写入不同金额的另一条原始期初
- **THEN** 系统返回冲突
- **AND** 不覆盖已有事实

### Requirement PFH-02: Complete closure of legacy purchase records

系统 SHALL 为切换时点后的每条旧购买记录保存唯一关闭结果：`MIGRATED`、`ALREADY_REPRESENTED` 或 `REJECTED_WITH_EVIDENCE`。

#### Scenario: Migrate historical API recharge

- **GIVEN** 旧购买记录代表切换时点后的真实 API 充值且尚无资金事件
- **WHEN** 激活成功
- **THEN** 系统写入对应 `API_RECHARGE` 事件
- **AND** 保存原币金额、人民币实付、时间、订单引用、证据和旧记录引用

#### Scenario: Reject legacy record without evidence

- **GIVEN** 管理员选择 `REJECTED_WITH_EVIDENCE` 但没有填写原因或证据
- **WHEN** 执行预检
- **THEN** 返回 `NO_GO`
- **AND** 不允许通过忽略该记录继续激活

#### Scenario: Rejection cannot close unknown usage cost

- **GIVEN** 存在 `UNKNOWN_COST` API 用量行
- **WHEN** 管理员把一条旧购买记录标记为 `REJECTED_WITH_EVIDENCE`
- **THEN** 该决定只关闭对应旧购买记录
- **AND** `UNKNOWN_COST` 仍然是独立 `NO_GO` 缺口

#### Scenario: Already represented record

- **GIVEN** 旧购买记录已由现有资金事件完整表达
- **WHEN** 管理员选择 `ALREADY_REPRESENTED`
- **THEN** 必须引用同企业、同资源且语义匹配的资金事件
- **AND** 金额、币种和发生时间不匹配时返回 `NO_GO`

### Requirement PFH-03: Coding Plan purchase and period semantics

系统 SHALL 将页面的上海自然日包含结束日转换为数据库 `[period_start, period_end_exclusive)`，并保证历史套餐用量唯一归属。

#### Scenario: Default monthly period

- **GIVEN** 服务开始日为某上海自然日且结束日为空
- **WHEN** 系统生成默认周期
- **THEN** 页面结束日为下个月同日前一日
- **AND** 数据库结束边界为该结束日次日上海零点

#### Scenario: Overlapping periods cause ambiguous attribution

- **GIVEN** 两个未冲销周期同时覆盖同一条 Coding Plan 用量
- **WHEN** 执行预检
- **THEN** 返回 `NO_GO` 和冲突周期引用
- **AND** 不得通过任意排序选择其中一个周期

### Requirement PFH-04: Bounded usage repair

系统 SHALL 只允许初始化修复 `ledger_line.settled_at`、`api_cost_currency`、`api_cost_status` 和 `subscription_period_id`，并证明其他字段未变化。

#### Scenario: Apply eligible repairs

- **GIVEN** 历史用量满足确定性修复条件
- **WHEN** 激活事务执行修复
- **THEN** 只按候选中稳定排序的 `ledger_line` 主键列表锁定和更新四个允许字段
- **AND** 对固定行集逐行计算的非目标字段哈希变化数为零

#### Scenario: New ledger line after preview

- **GIVEN** 预检已经固定修复资格行主键与逐行基准哈希
- **WHEN** 预检后出现新的 `ledger_line`
- **THEN** 新行不得加入原候选的非目标字段哈希比较
- **AND** 完整事实水位或静默门禁必须使旧候选失效

#### Scenario: Repair would modify another field

- **GIVEN** 修复实现导致 Token、成本金额、资源、主体或计价快照发生变化
- **WHEN** 系统比较非目标字段哈希
- **THEN** 激活失败并整体回滚

### Requirement PFH-05: Full-window conservation

系统 SHALL 对切换时点至候选事实水位的完整窗口以及所有涉及月份执行资金、Token、周期归属和经营账单守恒。

#### Scenario: One month passes but another fails

- **GIVEN** 九月资金守恒通过但十月存在未知 API 成本
- **WHEN** 执行预检
- **THEN** 总体结论为 `NO_GO`
- **AND** 缺口明确指向十月和相关资源

#### Scenario: Balance projection reuses the ledger implementation

- **GIVEN** 候选包含期初、充值、更正、对账、历史成本、冲销和用量扣费
- **WHEN** 系统执行虚拟余额投影
- **THEN** 投影复用与 `provider-finance-balances.ts` 相同的共享聚合函数
- **AND** 不得另行定义冲销正负号或第二套余额公式

### Requirement PFH-06: Evidence is mandatory for opening and migrated money facts

系统 SHALL 强制期初、历史充值、购买、续费和拒绝旧记录具备说明与证据引用，不得由兼容接口绕过。

#### Scenario: Future resource calls legacy opening endpoint without evidence

- **GIVEN** 企业已激活且新增一个 API 资源
- **WHEN** 管理员通过兼容期初接口提交无说明或无证据的期初
- **THEN** 请求失败
- **AND** 资源保持资金未就绪且不可承载生产流量

### Requirement PFH-07: Future API resource finance readiness

系统 SHALL 在企业激活后阻止资金未就绪的新 API 资源承载生产流量，直到必要币种期初和资源级守恒完成。

#### Scenario: New resource before opening registration

- **GIVEN** 企业已激活严格资金写并新建 API 资源
- **WHEN** 该资源尚未完成期初登记
- **THEN** 系统将其标记为资金未就绪
- **AND** 调度和生产请求不得使用该资源

#### Scenario: New resource becomes ready

- **GIVEN** 新 API 资源已登记全部必要币种期初、说明和证据
- **WHEN** 资源级守恒通过
- **THEN** 资源可以进入可调度状态
