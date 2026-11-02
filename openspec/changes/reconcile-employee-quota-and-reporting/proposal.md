# Proposal

## Why

2026 年 10 月团队月报把全部员工授权的 22 亿，与仅套餐路径形成的 3.88884913 亿扣减相减，展示“月末剩余 18.1 亿”，但同期实际用量为 27.09467730 亿 Token。问题同时涉及额度事实缺失、累计与月度周期混用、员工与项目范围不一致；现有“允许超额”配置不能被误诊为禁止超额失效。

## What Changes

- 明确三种事实：实际 Token、Coding Plan 折算扣减、API 金额；API 内部额度按实际 input + output 计量，不伪造套餐扣减或 API 现金费用。
- 用户已明确选择“每月额度，每月 1 日重置”：按企业时区自然月建立独立额度账，保存旧月事实，按员工 × 厂商池分别展示额度口径、分配、期间使用、期末余额和超额；保留现有 `allow_overage`。
- 补齐 API 员工额度计量、预占与结算，复用现有授权、行锁、终态事务和幂等机制；允许超额仍可使用且记真实超额，禁止超额才执行额度阻断。
- 为新消费冻结授权归属、额度单位和月份，为后续授权变更保留前后事实；跨月完成的 Attempt 结算回其预占月份。存量历史先核账，只在能证明归属、起点和历史配置时生成可执行修复清单。
- 报表按完整企业时区期间和同一员工范围计算；修复周报混入项目额度、个人周/月报余额算法不同、UTC 月界偏移、日报模型混入项目，以及 Top3 占比归一化问题。
- **BREAKING（展示合同）**：不同计量基础或不同累计起点的额度不再相加为一个可用 Token 总额；无法重建的历史余额显示“待核账/历史未留存”，不继续显示 18.1 亿或直接改成 `22−27.1`。
- 分两段交付：A 段先修正报表事实和误导展示；B 段补齐每月额度、API 额度及历史核账。发送窗口、接收人、持久化投递、防重与 UNKNOWN 处理沿用已上线可靠性合同。

## Capabilities

### New Capabilities

- `employee-quota-accounting`: 员工厂商池额度的计量、每月重置、超额策略与 API/Coding Plan 结算。
- `employee-report-consistency`: 日、周、月报统一的时间、主体、模型、占比、额度状态及图文事实合同。
- `quota-history-reconciliation`: 历史额度可追溯性、只读核账、分阶段切换及业务验收。

### Modified Capabilities

无。`openspec list --specs --json` 当前返回空列表；其他在途 change 不是已归档主规格。本方案通过新 capability 补足合同，不重写其他变更。

## Impact

- Gateway：Attempt 额度预占、结算、撤权/失败清理；Key 原始 Token 限额和厂商真实余额/套餐窗口保持独立。
- Database：复用 `principal_grant` 和终态结算，新增每月额度账、消费归属及必要授权历史；旧 `quota_counter` 留作切换前历史，不物理清零。迁移编号在实施时核实，不能复用旧 0090。
- Worker：共享报表事实投影、自然月/周边界、额度表格、图文快照；A 段原则上仅 Worker，B 段需要 Gateway、Control API、Worker 协同，不能承袭旧“仅发布 Worker”授权。
- Control API/Web：授权写路径保留历史；配置页/API 显示同源额度单位、累计起点、已用/超额状态，既有管理操作和开关语义不变。
- 增加月初额度初始化，并以请求/查询时按月初始化保证 Worker 暂停后仍遵守月界；不引入外部依赖、通用预算平台、自动换厂商、自动回放或自动历史重发。
- 基线：本地 SHA `2a2fdbe3c52b6853d12be476a6162221fc8163fe`；生产本次观测 Worker 为 `ic-worker:model-labels-45e1c3a6ca61`，running/healthy；不能把本地 HEAD 当作当前全套生产版本。
- 证据：`V4/Evidence/WECOM-REPORT-DELIVERY-20261019/MONTHLY-QUOTA-DIAGNOSIS-20261101/`。完整方案与用例索引见 [具体方案](../../../V4/员工额度与企业微信报表口径统一开发方案-v1.0-20261101.md)。
- 状态：`LOCAL_IMPLEMENTATION_COMPLETE / TARGETED_CHECKS_PASS / PRODUCTION_UNCHANGED`。2026-11-01 用户追加授权具体开发及多个 GPT-6.1 Sol 子 agent；本地实现与定向验证已完成。提交推送、生产迁移、历史计数修正、部署和补发仍未执行；仓库既有 6 项 source-size 门禁失败单独保留，不能称全仓质量全绿。详见本次实施交付报告与 tasks。
