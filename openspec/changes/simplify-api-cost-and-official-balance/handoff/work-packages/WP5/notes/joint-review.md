# WP1-WP5 跨包联合审核（代码级，只读）

日期：2026-11-04；主持：GLM-5.3 总指挥（hub 会话，用户要求）。背景：S0 联审阶段（任务书 `f6e3c33`）落在 WP5 结包之后，WP5 未执行；本笔记补做**代码级**整分支联审。行为级联合验收已由 WP5 50 条矩阵覆盖（48 PASS＋X07/X08 半段），本审不重跑测试。

对象：`ae506fe..HEAD`（至 `f6e3c33`），293 文件＋22863/−2397。

## 结论：通过，零返工项

| # | 审项 | 结果 | 证据 |
|---|---|---|---|
| 1 | 触及面 | 全部在预期区域（web 65/openspec 64/database 63/证据 43/control-api 36/domain 10/gateway 5/worker 4/config 2）；无 deploy/无越界目录 | `git diff --name-only \| cut -d/ -f1-2 \| uniq -c` |
| 2 | 迁移链 | 仅新增 0093-0096，连续编号，0000-0092 零改动；四条 down 均存在（0095 带多行守卫） | migrations 目录 diff＋逐文件 grep |
| 3 | 红线 | `listServableResources` 内 `enterprise_id`/`quota_block_state`/`evaluateAdmission` 逐字保留、PENDING 过滤已除（预期）；0092 员工额度源码零触碰（仅证据 PNG 同名）；`recordBalanceSyncRecovery` 未改；`FINANCE_MODE_INACTIVE` 仅存 subscription-renewal（套餐停写语义，预期）＋sync runner 注释 | 函数体 awk 提取；diff 对比 ae506fe |
| 4 | 契约一致 | 410 码 `api_funding_management_retired` 字面量仅 3 处（provider-finance 共享守卫×2＋purchases R1）；缺口码按 WP2 设计（OPENING_BALANCE_MISSING 常量保留恒 0 保形状；"待补期初/余额待补"仅存于反向测试断言）；official_balance 状态单源产出（database `official-balance-states.ts`）→ control-api 透传（providers/routes.ts:330）→ web 消费；`loadApiCostEstimation` 14 个消费方单源 | 各 grep 定位 |
| 5 | 残留 | web 对 7 个退役端点零调用；无死调用/旧文案残留 | grep 退役路径于 apps/web |

## 联审澄清的两个"异常"（均非问题）

1. purchases 410 实际落点＝`department-costs/routes.ts:229-236`（该端点挂载于 department-costs 而非 providers）；实现优先于幂等/closed/mode 一切分支、模式无关、零写入，PACKAGE_PURCHASE 保留——与用户 2026-11-04 裁定一致。
2. `never_synced` 状态不在 control-api 产出属设计：database 层单源（`official-balance-states.ts`），control-api 只透传。

## 移交 WP6 的联合项（非本审缺陷）

- X07/X08 的回退/切换半段（WP5 BLOCKED 记录）；W20-10 P95 复验；生产版本/迁移水位补核；0095 down 多行守卫纳入回退方案。
- 业务签收走查（用户亲自，§7 路线）尚未回传结论＋OAB-13 文案裁定——不阻塞 WP6 准备，阻塞最终业务签收状态。
