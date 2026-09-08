# 运行保障与管理员：独立 I1 有限集成审核

**结论：PASS（限本次集成源码与测试修复审核）。未发现需要打回的代码 Finding。全量测试仍在运行，本结论不是全量门禁或发布通过。**

## 范围与对象

- Reviewer：`/root/i1_runtime_admin_review`，此前独立 I1 Reviewer，未参与本次集成或三个测试修复。
- 工作树：`/Users/mac/.codex/worktrees/runtime-admin-integration-20260908/仟流智算`。
- 分支：`codex/runtime-admin-integration-20260908`。
- 集成基线：`99d4f998b0ce08179c72c16ea1f7895e89e7eb44`。
- 功能来源：`e31da82d8a06262d82814d9fb71caa69fb22a7a4`，本工作树集成为 `7e3b313`；适配提交为 `19618d8c63204f8d7407f64f581b15bed094b0e0`。
- 受审未提交变更：provider-finance.test.ts、peak-calendar-settlement.test.ts、pool043-operating-bill-concurrency.integration.test.ts。
- 审核时间：2026-09-08 09:32–09:42（Asia/Shanghai）。

本轮根据已授权的有限集成范围执行：核对原功能迁入同一性、0065/0066/0067 迁移链、index.ts 两侧导出、迁移历史断言，以及三个测试修复的实际业务依据。没有重新执行或宣称完成 V1.4 全套流程，没有并行启动重型全量、覆盖率或 Mutation，也没有重开无关功能审计。

开始与结束 HEAD 均为 `19618d8c63204f8d7407f64f581b15bed094b0e0`；基线至当前 `apps/`、`packages/` 的 44 个变更路径按路径排序后记录内容 SHA-256，整个条目集合摘要首尾一致：

```text
c2d545210f64e03ee4af0b28e7638808bbcd10da2cf697eeb9af1b50169afef3
```

三个未提交测试的精确 SHA-256：

| 文件 | SHA-256 |
| --- | --- |
| apps/control-api/src/__tests-integration__/provider-finance.test.ts | aad69f6232e83b815551732b1bf4ddaedb741419f8a2062852824de078e149a3 |
| apps/gateway/src/__tests-integration__/peak-calendar-settlement.test.ts | c2d7ce213e2d2a935b3db6aae6d2d7dc6eb1a492c027fc2b284070f747bf6c79 |
| packages/database/src/__tests-integration__/pool043-operating-bill-concurrency.integration.test.ts | f5bd77b0af2a38bf57b5a2b773b4eb0eadb17499b2ff0fb17ef7ab23f41c1117 |

本报告绑定上述工作树对象；现有 `candidate-lock.draft.json` 不作为这三个后续测试修复的正式最终锁凭据。

## 核查结果

### 1. 功能迁入及迁移链：PASS

把 e31da82 的 28 个功能路径与当前对象逐项对照，并将迁移路径按新编号映射，只有以下三处内容差异：两个直接测试的迁移名称/数据库 fixture 名称适配，以及 index.ts 的基线新增导出保留。其余功能文件与已审功能提交逐字一致。

| 集成迁移 | 核查 |
| --- | --- |
| 0065_principal_accounting_assignment.js | 与 99d4f99 的既有文件逐字一致；未被功能侧旧 0065 覆盖。归属历史不可变与非空历史禁止 down 的保护保留。 |
| 0066_admin_cleanup.js | 与 e31da82 的 0065_admin_cleanup.js 内容逐字一致，仅重编号；归档列、索引及存在归档管理员时拒绝 down 的保护保留。 |
| 0067_alert_resource_context.js | 与 e31da82 的 0066_alert_resource_context.js 内容逐字一致，仅重编号；同企业请求/Attempt 补全及不清空已补历史的 down 行为保留。 |

当前 migrations 目录共有 68 个 JS 文件，编号前缀无重复，末尾顺序为 0063、0064、0065 主体归属、0066 管理员归档、0067 异常资源。0065 的 created_by 仍引用保留的 admin_user 身份行，与 0066 的归档语义相容。

已审 19618d8 的迁移测试适配：在原回退链前增加 0067→0066→0065，并在完整迁移结果列表追加三个版本；原目标迁移的拒绝回退、事实约束、schema fingerprint、读模型重建断言仍保留。runtime-admin 直接测试的目标迁移同步为 0066/0067，原资源保持和禁止复活归档管理员的断言没有弱化。

### 2. index.ts 两侧导出：PASS

通过 TypeScript AST 提取并比较公开命名导出：

- 集成基线：271 个。
- 功能提交：265 个。
- 当前集成对象：273 个。
- 基线侧缺失：0；功能侧缺失：0。

同时阅读了 index.ts 的实际 diff；新增 AdminMustBeDisabledError、SelfCleanupError 与基线的经营分析/归属等导出并存，没有因冲突处理删除一侧导出。上述数字是静态导出核查，不冒称逐个公共 API 的运行验证。

### 3. 峰谷日历测试修复：PASS

`w16-dispatch-fixture.ts` 为测试企业创建授权时未指定 valid_from；授权查询实际以 `principal_grant.valid_from <= now` 筛选。日历测试把请求和最终授权时钟固定为 2026-09-06/07 等日期，晚于这些日期执行测试时，数据库默认创建时间会导致请求尚未获得授权。

修复仅把本测试企业的 fixture 授权起点设为 2026-09-01；生产授权检查、HTTP 请求、策略匹配、金额/额度结算和 PG 账本全部保留。费用、倍率、扣减、上游调用次数和日历边界断言没有放宽；403 场景新增 `dispatch_rejected` 精确错误码断言，反而避免把其他授权失败误判成调度拒绝。返回 response body 只增加失败诊断信息。

### 4. 并发关账与历史项目归属测试修复：PASS

当前冻结合同 `V4/Evidence/OPERATING-BILL-20260906/V14/contract.md` 明确员工与项目为独立主体。现有 live/frozen account 查询均按 `source_principal_type = dimension` 筛选，既有用例也明确“项目账只统计项目主体，员工请求的历史项目标签不重复入账”。

本 fixture 的真实请求主体为 EMPLOYEE，projectId 是并发提交的历史归属信息。因此用 PROJECT 维度合计判断是否保留归属，已不符合当前合同。修复保留原真实行锁竞争、等待、提交和关账路径，直接断言 `closed.sourceFacts.accountFacts` 同时包含 requestId、员工身份、projectId、30/3 Token；再断言员工账 33 Token/1 请求、项目账为零。关键的“关账快照不得丢失并发已提交归属”由更直接的冻结事实断言保护，并未因项目账改为零而移除。

### 5. 费用尾差与 DARK 夹具：PASS

实际 `operating-bill-finance-projection.ts:190–205` 对可精确到分的付款以 100 为分配精度，先取 floor，再按最大余数分配尾差；这段实现从 99d4f99 到当前 HEAD 没有变化。

对 199 元及 Token 300:100:50，独立整数复算为：基础分配 13266/4422/2211 分，总计 19899 分；剩余 1 分给最大余数的 300 Token 主体，结果为 **132.67 / 44.22 / 22.11**。测试的新八位格式字符串与该算法一致，合计恰好 199 的断言仍保留；不是换成近似比较或取消守恒检查。

DARK 测试仍保留隐藏资金写入口、关账冻结、UNKNOWN 和 API_COST_UNKNOWN 断言。未知成本 fixture 在同一文件较早的费用用例后半段建立，原费用期望提前失败确实会阻止其建立；本修复恢复该既有顺序路径，没有把 UNKNOWN 改成成功事实。这里没有宣称 DARK 用例已具备独立单跑能力。

三个测试以及上述授权/账单/分摊生产实现，在 `99d4f99..19618d8` 提交范围内均没有对应变更；它们的不一致来自集成基线已有测试口径。本 Reviewer 没有另启原基线的重型失败复现，复现计数仍以主会话原记录为来源。

## 实际验证证据与边界

本 Reviewer 本轮实际执行：git 对象与 diff 核查、功能文件逐字比较、迁移内容/编号检查、公开导出 AST 集合比较、整数分摊复算、首尾 44 文件 SHA-256 一致性检查，以及 `git diff --check`（exit 0）。未修改任何候选源码或测试。

已阅读主会话保存的原始定向测试日志，而非仅采用摘要：

| 现有日志 | 实际记录 |
| --- | --- |
| baseline-fixes/concurrency.log | 单文件 57/57 通过，09:30:27 开始。 |
| baseline-fixes/finance.log | 单文件 9/9 通过，09:30:28 开始；DARK 相关用例未失败。 |
| baseline-fixes/calendar.log | 单文件 13/13 通过，09:30:29 开始。最后新增错误码断言的最终对象覆盖，应以正在进行的全量结果核定。 |

截至 2026-09-08 09:42:36，已从 `baseline-fixes/full-test.log` 原始输出确认 database 62 文件 / 366 项 PASS、Control API 42 文件 / 285 项 PASS；日志已进入 Gateway。并发文件 57 项、65,535 容量用例及 0066/0067 迁移用例在当前全量中已经通过。整个根命令尚无最终退出结果，不据此推断 Gateway、其余包或全量已经完成。日志可能在本报告之后继续增长。

`integration-review.md` 的既有全仓 type/lint/build、迁移回归等数字属于主会话先前自检，本报告没有把它们改称 Reviewer 独立重跑。旧功能 I1-R3 通过、此次有限集成审核、当前全量测试与生产验收分别记录。

## Findings 与下一步

- 本次有限源码审核：P0/P1/P2/P3 新增 Finding 均为 0。
- Decision：**PASS（有限集成审核）**。
- 待完成验证：主会话等待当前全量根命令真实退出，确认最新峰谷错误码断言包含在通过结果中，再绑定最终对象与测试证据；当前报告不授权提交、推送、部署或发布。
- 若后续候选源码或这三个测试再次变化，应只复核对应增量并重绑对象，不将本报告扩大解释为重新完整执行 V1.4。
