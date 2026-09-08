# 集成基线测试修复

日期：2026-09-08。集成适配检查点：`19618d8`。

## 原因与修复依据

1. 峰谷日历测试使用 2026-09-06/07 的固定请求时间，但授权由 PostgreSQL 默认 `now()` 创建。2026-09-08 执行时，授权尚未在被模拟的时刻生效，真实 HTTP 返回 `principal_grant_required`。只在本用例企业内将测试授权起始时间固定为 2026-09-01，保留生产授权检查；拒绝场景进一步精确断言 `dispatch_rejected`，防止其他 403 被误认为调度拒绝。
2. 并发测试中的请求属于员工，项目只是历史归属标签。当前员工/项目独立记账合同见 `OPERATING-BILL-20260906/V14/contract.md`，既有数据库回归亦明确“项目账只统计项目主体，员工请求的历史项目标签不重复入账”。保留真实行锁竞争与关账重试，直接断言冻结 `accountFacts` 中请求、员工、项目及 Token；再断言员工账 33 Token/1 请求、项目账为零。
3. 费用测试中的 199 元按 Token 300:100:50 分配，当前金额可精确到分，因此先分得 132.66/44.22/22.11，余下 0.01 给最大余数主体，结果 132.67/44.22/22.11。同步旧八位期望，保留合计恰好 199 的断言。第一处旧期望失败曾导致同一用例后续未知成本夹具未创建，从而使 DARK 冻结用例连带失败；后者断言无需修改，复跑已通过。

本轮仅修改三个测试文件，未修改生产实现、迁移内容、门禁配置或阈值。

## 验证

- 行锁并发完整文件：57/57 PASS，见 `concurrency.log`。
- 资金接口完整文件：9/9 PASS，见 `finance.log`。
- 峰谷日历完整文件：13/13 PASS，见 `calendar.log`；最终精确拒绝码断言纳入全量重跑。
- Database / Control API / Gateway 类型检查与 ESLint：PASS。
- `git diff --check`：PASS。
- 全量命令：`corepack pnpm@11.11.0 run test`，退出码 0，238 个文件 / 1,743 个用例全部通过，见 `full-test.log`。运行至 2026-09-08 09:45（Asia/Shanghai）。
- 分包用例数：Config 12、Contracts 5、Domain 180、Observability 9、Provider Adapters 273、Database 366、Control API 285、Gateway 315、Worker 29、Web 269。
- 最终峰谷日历 13/13 通过，包含 `dispatch_rejected` 精确错误码断言。
- 独立 I1 有限集成审核 PASS，新增 P0/P1/P2/P3 Finding 均为 0，见上级 `independent-review.md`；该报告中的“全量运行中”状态由本记录的最终退出结果补齐。
- 原首轮失败及基线复现记录：上级 `integration-review.md`；不由后续通过结果覆盖。

原功能独立 I1-R3 与本次集成审核分开记录；完整 V1.4 覆盖率、变异及生产验收不由本记录代替。
