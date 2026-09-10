# C3 交接（V14-C2 Findings 修复候选）

日期：2026-09-10。实施：ZCode；状态：**待 Codex 复核 C3 增量**。历次证据（C1/C2/R01/R02/V14-C2）原样保留。

## 1. 候选标识与冻结

- 候选：`HOME-STANDARD-C3-20260910`（基于 V14-C2 审核报告 Findings 修复）
- 基线：分支 `codex/quota-pricing-review-20260905`，HEAD `4898df546fbcbc9ca292ee892cd7ae412766185a`（未提交、未推送、未合并、未部署）
- tracked patch：`candidate-tracked.patch`，SHA256 `97bc6b57bb435bf5229a01fe376d075b696d4c273441cd69ecce52d17ccd5dff`（15 文件，+682/−978）
- 新增文件 14 项逐文件 SHA256：`candidate-new-files.sha256`
- 自本文件写入起冻结；后续变更产生 C4。

## 2. 相对 C2 的差异

| 文件 | 变化 |
| --- | --- |
| `packages/database/src/repositories/provider-finance-repository.ts` | F-A：恢复 `event.` 限定符（资金查询回到纯抽取态，diff 纯洁性修复） |
| `apps/web/src/components/dashboard/standard-home-model.ts` | F-C：`periodChangePercent` 定点 BigInt（大数不失精度）；F-D：上期全零文案细分；F-E：不变量注释 |
| `apps/web/src/components/dashboard/standard-home-model.test.ts` | **新增**：8 项单测（大数/半入/负值/非法输入/质量口径） |
| `packages/database/src/repositories/dashboard-home-providers.ts` | F-E：2 处不变量注释；F-F：语义决策注释（行为不变） |
| `packages/database/src/__tests-integration__/standard-home.integration.test.ts` | F-B：financeRead=true 组合分支集成用例（7/7） |
| `apps/web/src/pages/Dashboard.test.tsx` | F-D：上期多币种全零文案用例（21 项） |

## 3. 完成项与验证

V14-C2 报告 P2×1 + P3×5 全部处置：F-A/F-B/F-C/F-D 代码修复+回归；F-E 注释固化；F-F 按审计建议"维持现状+决策注释"（产品裁决仍开放，非代码缺陷）。门禁全绿：typecheck/lint/size、web 278、database 13、control-api 金融回归 11；组合层覆盖率 stmts 99.15%、branch 76.9%（financeWindow 分支已覆盖）。对照表与逐文件覆盖率见 validation.md。

## 4. 未解决项 / 供 Codex 复核

1. **F-F 产品裁决**：未配置同步的资源是否计入"需关注"pill——已按审计建议维持现状并注释决策出处，等待产品/用户裁决；若裁决过滤，需明确 NOT_SUPPORTED 判定来源（provider_resource_operating_sync_attempt 缺失 vs balance_status='NOT_SUPPORTED'）。
2. **残余文案/fallback 分支覆盖**（costs 92-94、providers 111-115、dashboard-home.ts:102、metrics 152,183）：展示/兜底分支，本轮未再扩测试；如 Codex 认为需覆盖请指出优先级。
3. **EG-2/EG-3/EG-4 沿袭**（V14-C2 report.md §6）：web 变异基建、生产量级性能、WCAG 定量抽查——未变，仍为登记在案的残余风险。
4. C2 validation.md 中"264 用例"为笔误（实际 269，C2/web-tests.log 可证）；V14-C2 已核发现并说明，非候选差异。

## 5. 本地复现

同 C2 handoff §5（postgres + seed-e2e + 双服务 + admin/admin123）；本轮修复无视觉/交互变化（F-D 仅罕见分支文案），未重复浏览器验证，以组件/单测/集成为准。
