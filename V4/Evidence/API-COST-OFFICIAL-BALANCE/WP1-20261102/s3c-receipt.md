# S3c 收据：年度/经营分析聚合的 API 费用对齐同源估算（task 2.3 追加，追加合同 S3c）

日期：2026-11-03；执行：glm-flash 子 Agent（WP1 追加合同 S3c）；分支 `codex/simplify-api-cost-and-official-balance`。

## 1. 基线核对

- `git rev-parse HEAD`＝`9bf156005052f85425b1a2d84c9ff3dec3de2e20`（S1-S3b 已提交基线，符合合同 §0）。
- `git status --porcelain` 开工时仅 `?? V4/Evidence/API-COST-OFFICIAL-BALANCE/` 与 `?? openspec/.../WP1/` 未跟踪项（见 `s3c-worktree-status.txt`）。
- 全程未执行 checkout/reset/rebase/stash/push；未改任何已提交内容。唯一非常规操作：验证阶段在 `/tmp` 用 `git clone --shared` 建只读基线克隆（只读源仓库，工作区零改动，用后已删除，见 §5.1）。

## 2. 实际改动文件（每文件一句话；全部在允许清单内）

| 文件 | 说明 |
|---|---|
| `packages/database/src/repositories/operating-analysis-repository.ts` | 月度 apiSpend/apiSpendComplete 数据源从资金账户 monthlyApiCost（loadResourceFinanceViews）改为 `loadApiCostEstimation`（12 个月×逐厂商，按企业＋该月 operatingBillMonthRange 的 settled_at 半开窗；资源范围收敛到该厂商当月 views 内 API 资源，与 key 集合互斥可加）；资金域轨迹字段（opening/recharge/paidCny/ending）与 keys 派生原样保留（views 调用保留）；apiReviews totals 代码零改动、随新源自然更新 |
| `packages/database/src/__tests-integration__/operating-analysis.integration.test.ts` | 断言迁移 1 处（注明依据）＋新增 S3c 用例 4 条（a-d） |

单元格派生语义（实现注释同步）：多币种 → null＋false（ACE-07 不混加）；单币种 → 该币种估算金额字面值按本文件既有 toFixed(2) 展示精度；期间无 API 行（含仅明确零/合法处置排除）→ 精确 0；KNOWN_PARTIAL → 已知金额照出＋complete=false、无已知金额 → null（ACE-04 不把缺失冒充零）；估算未加载（未来/超出所选月）→ null＋false（与既有 valid=false 语义一致）。

## 3. 命令与用例数（全部实跑，逐条报数）

| 命令（除注明外均在 `packages/database` 下） | 结果 | 证据 |
|---|---|---|
| `corepack pnpm@11.11.0 exec tsc -p tsconfig.json --noEmit` | 退出码 0 | `s3c-db-typecheck-lint.log` |
| `corepack pnpm@11.11.0 exec eslint src --max-warnings=0` | 退出码 0 | `s3c-db-typecheck-lint.log` |
| vitest run operating-analysis.integration.test.ts（首次，暴露实现 bug） | 8 通过 1 失败 | `s3c-db-first-run-gapbug.log` |
| vitest run operating-analysis.integration.test.ts（修正后） | **9 通过（5 既有＋4 新增）** | `s3c-db-operating-analysis-output.log` |
| vitest run operating-feedback + subscription-auto-renewal + api-cost-estimation + api-cost-readers-alignment | 32 通过（4 文件） | `s3c-db-consumers-output.log` |
| vitest run 全量 `src/__tests-integration__`（75 文件） | 558 通过 1 失败（唯一失败＝w20-standard-capacity P95 计时，见 §5.1） | `s3c-db-full-integration-output.log` |

## 4. 断言迁移与新增用例

1. **断言迁移 1 处**（原 :181-187 区块）：`apiAccounts[0].months[8].apiSpend` "12.00"→"62.00" 并补 `apiSpendComplete: true`。依据：apiSpend 改由 loadApiCostEstimation 同源估算（追加合同 §1/ACE-06），按 settled_at 半开窗聚合整个 operatingBillMonthRange、无 asOf 截断（S1 估算合同；与经营账单 draft/首页读者同期间语义），故测试中 09-20 结算的已计价行（50.00）计入 9 月估算 2+10+50=62.00；不再沿用资金视图 `settled_at<=asOf` 的旧值。轨迹字段（opening 100.00/recharge 170.00/paidCny 150.00/ending 258.00）数值不变，仍走资金视图 asOf 口径。非放宽：行为变更本体即换源。
2. **新增 4 条**（合同 §4 a-d）：a) 无资金事件仅有已结算已计价行 → apiSpend＝估算字面值 "7.50"、complete=true、totals 同步（ACE-03）；b) CNY+USD 双币 → 两行均 apiSpend=null＋complete=false（ACE-07）；c) 已知 2.50＋UNKNOWN_COST 缺口行 → 金额照出＋complete=false（ACE-04）；d) 期初 80/充值 20/实付 20/期末 96 与估算 apiSpend 4.00 并存产出（轨迹保留）。

## 5. 偏离与设计选择（需总指挥复核）

1. **w20-standard-capacity P95 失败＝预存环境计时问题，与本次改动无关（已实测证明）**：全量与两次空闲隔离复跑均超 resourceUtilizationP95 预算（1890.89 → 1066.48 → 1054.93ms，预算 1000ms）。为排除因果，在 /tmp 建基线克隆（`git clone --shared`，HEAD=9bf1560 干净树，无本合同改动；node_modules 以符号链接复用主工作区、仅 @qianliu/database 指向克隆内基线代码）复跑同一测试：**基线同样失败，P95=1046.68ms**，与改动后数值统计等值。调用图亦零交集：该测试测 `/provider-resources/utilization`（resource-insights/token-utilization）等路径，不 import operating-analysis-repository（control-api 唯一消费方是 operating-bills/analysis-route）。按合同未改该测试；也未按 S1/S2 先例取得"隔离复跑通过"——本机当前对该测试稳定超预算约 5%，属环境性能漂移，移交总指挥裁定（不影响本合同验收项）。
2. **首次实现缺陷自查记录**：apiSpendComplete 初版把"该币种有金额"误作 complete 的析举分支，用例 c) 当场拦截（首次运行日志 `s3c-db-first-run-gapbug.log`），修正为 `completeness !== "KNOWN_PARTIAL"` 后全绿——ACE-04"金额照出但缺口→false"语义由测试钉死。
3. **估算按厂商分组调用**（12 个月×P 个厂商，每月 3 条聚合 SQL）：行模型按 (providerCode, currency) 分列，全企业单次估算无法拆厂商；资源范围取该厂商当月 views 内 API 资源（operatingBillResourceScope 保证当月有结算行的资源必在 views），各行互斥可加。量级与既有每月 loadResourceFinanceViews 相当（合同 §1.3 允许）；api-cost-estimation.ts 零改动（S1 产物）。
4. **估算缺口文案未加入行模型**：apiAccounts 行无 reason 字段，完整性以 apiSpendComplete=false 表达；`apiEstimationGapText` 未复用（合同标注"如需"）。展示缺口文案归 WP4。
5. **临时基线克隆**：§5.1 的对照测量在 /tmp 进行，未触碰合同工作区 git 状态（clone 非 checkout/reset/rebase/stash/push），用后已删除。

## 6. 剩余问题

1. w20-standard-capacity 在本机稳定超预算约 5%（基线同值）——环境性能漂移，非本包回归；总指挥裁定处置（换机/调阈值/放宽并行度均属其权限）。
2. 行键（keys）仍来自资金视图 accounts（期初事件∪当月 PRICED 行）：仅有缺口行（无已计价、无期初）的厂商不出现 apiAccounts 行——预存模型边界，合同未授权改 keys，未动。
3. 已知部分与缺口并存的月份，行内只有 complete=false 布尔，无缺口明细（见 §5.4）；WP4 文案与 WP5 核对以 `loadApiCostEstimation` gaps 为数据源。
4. `apiSpend` 展示精度沿用 toFixed(2)（合同允许），底层来源为估算 8 位小数字符串；若 WP5 需 8 位字面核对需从估算入口直读。

## 7. 收尾提交（合同 §4 授权）

- `git add` 仅上述 2 个合同文件；证据目录与 openspec handoff 不入本次 commit（沿 S3b 先例留给总指挥）。
- 提交信息：`feat(cost-estimation): align annual analysis api spend with same-source estimation (WP1 task 2.3)`
- 提交结果：**commit `75a82fedaa69731c8e5e602529b65a8a2b1c40e1`**（2 files changed, 211 insertions(+), 3 deletions(-)）；
  提交后 `git status --porcelain` 仅余 V4/Evidence 与 openspec handoff 未跟踪项（留给总指挥）。

## 8. 证据路径（worktree `/Users/mac/Projects/仟流智算-api-decouple`）

- `V4/Evidence/API-COST-OFFICIAL-BALANCE/WP1-20261102/s3c-receipt.md`（本文件）
- `s3c-code-diff.txt`、`s3c-worktree-status.txt`
- `s3c-db-typecheck-lint.log`、`s3c-db-first-run-gapbug.log`、`s3c-db-operating-analysis-output.log`
- `s3c-db-consumers-output.log`、`s3c-db-full-integration-output.log`
- `s3c-w20-isolated-rerun.log`、`s3c-w20-isolated-rerun2.log`、`s3c-w20-baseline-clone-check.log`
