# V1.4 运行保障与管理员集成复审

- 日期：2026-09-08
- 集成基线：`99d4f998b0ce08179c72c16ea1f7895e89e7eb44`
- 原功能提交：`e31da82d8a06262d82814d9fb71caa69fb22a7a4`
- 集成分支：`codex/runtime-admin-integration-20260908`
- 当前状态：未提交的集成适配；未推送、未部署

## 集成变更

集成分支原有 `0065_principal_accounting_assignment`，因此将运行保障与管理员迁移顺延为：

1. `0065_principal_accounting_assignment`
2. `0066_admin_cleanup`
3. `0067_alert_resource_context`

同步更新所有把 `0064` 视为最新迁移的升级、回退及重建断言。原功能提交与集成分支仅共同修改 `packages/database/src/index.ts`，自动合入后两侧导出均保留。

## 验证结果

- 全仓 TypeScript 类型检查：PASS
- 全仓 ESLint：PASS
- 全仓构建：PASS
- 架构门禁：PASS，465 个生产源码文件，无运行时循环
- 源码体积门禁：PASS，465 个文件均在限制内
- 重复代码门禁：PASS，0.52%，低于 5% 阈值
- Web 全量：55 个文件、269 个用例 PASS
- 本次功能直接回归：数据库 2/2、Control API 14/14、Web 20/20 PASS
- 最终迁移适配回归：数据库 13 个文件、17/17 PASS；Control API 2 个文件、9/9 PASS
- `git diff --check`：PASS

## 全量首轮失败与基线对照

全量 bounded test 首轮保留真实失败，没有按绿处理：

- 数据库：13 个迁移头/迁移列表断言失败，已由本次适配修复；另有 1 个经营账单行锁用例失败。
- Control API：1 个迁移头断言已修复；另有经营账单 2 个断言失败。
- Gateway：峰谷日历 12 个断言失败。

后三组非迁移失败均在未合入本次功能的原始集成基线 `99d4f99` 上逐项复现，因此不是本次集成引入，也未在本次任务中越界修改：

- `pool043-operating-bill-concurrency.integration.test.ts`：1 个失败
- `provider-finance.test.ts`：2 个失败
- `peak-calendar-settlement.test.ts`：12 个失败

## 主代理集成自检结论

更正：本轮未调用独立审查者，以下为主代理自检，不能替代独立 I1 复审。原功能提交的 I1-R3 报告仅适用于其原候选。

- 本次集成增量：PASS
- P0：0
- P1：0
- P2：0
- P3：0
- 整体集成分支全量门禁：仍为 RED（仅因以上基线失败）
- 发布状态：未形成最终候选；后续仍需单独处理基线失败、提交、发布脚本和部署授权
