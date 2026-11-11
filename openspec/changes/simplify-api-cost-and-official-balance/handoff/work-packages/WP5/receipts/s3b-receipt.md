# WP5 S3b 回执：AT-X06 金额核对表生成＋50 条验收矩阵草案装配

日期：2026-11-04；基线：worktree `/Users/mac/Projects/仟流智算-api-decouple`，分支 `codex/simplify-api-cost-and-official-balance`，HEAD `d6550c9`（开工与收工同 HEAD；未提交改动含 S2A/S2B/S3a-1/S3a-2，本批零触碰、未提交 git）。

范围：零业务代码/测试/迁移改动；新增 3 个文件（X06 一次性只读脚本＋X06 核对表 markdown＋矩阵草案）＋本回执。全批只读（SELECT/GET/登录），零写库、零 POST 写端点、零消息发送。

## 1. 实际改动清单（全部新文件，未触碰任何既有文件）

| 文件 | 性质 |
|---|---|
| `V4/Evidence/API-COST-OFFICIAL-BALANCE/WP5-20261104/x06-amount-reconciliation.ts` | 一次性只读脚本（tsx）：DB 仅 `loadApiCostEstimation`＋3 条 SELECT 构成核对查询；HTTP 仅 GET 读端点＋POST /auth/login 取会话；seed 同款安全门（仅 127.0.0.1＋`_e2e` 后缀，否则拒绝连接）；金额运算 8 位定点 BigInt 禁 float |
| `V4/Evidence/API-COST-OFFICIAL-BALANCE/WP5-20261104/x06-amount-reconciliation.md` | 脚本实际运行产出（非手写）：核对表 26 行＋待裁定差异清单（0 条）＋基准 JSON 全文＋15 端点原始响应摘要 |
| `V4/Evidence/API-COST-OFFICIAL-BALANCE/WP5-20261104/matrix-draft.md` | 50 行验收矩阵草案（ACE-01~14/OAB-01~14/AFR-01~14/X01~08），逐行配齐证据指针（测试文件:用例/行号＋回执§号＋E2E test 编号＋X06 行号＋截图＋日志路径）与执行命令图例 |

git status 复核：本批新增仅 `V4/Evidence/API-COST-OFFICIAL-BALANCE/WP5-20261104/` 目录（logs/screenshots 为开工前已存在）；`apps/web/e2e-artifacts/`、`WP5/notes|plan|receipts`、`wp5-upgrade-immutability.integration.test.ts` 等其余未跟踪项均为 S3a-1/S3a-2 前批遗留，本批零触碰。

## 2. 实际执行的命令与结果

1. **自起服务**（后台，指向 `qianliu_e2e`，复用 playwright webServer 起法）：
   ```
   DATABASE_URL=postgres://postgres:qianliu@127.0.0.1:55432/qianliu_e2e \
   GATEWAY_KEY_PEPPER=m5-e2e-only-pepper CREDENTIAL_KEK=ZGV2LW9ubHkta2VrLXJlcGxhY2UtaW4tcGlsb3QAAAA= \
   COOKIE_SECRET=m5-e2e-cookie-secret-at-least-32-bytes CONTROL_API_PORT=8899 \
   WEB_ORIGIN=http://127.0.0.1:5173,http://127.0.0.1:8899 \
   FEATURE_DIRECTORY_IMPORT/USAGE_OVERVIEW_V2/DEPARTMENT_COST/RESOURCE_UTILIZATION_V2/PROCUREMENT_REVIEW=true \
   corepack pnpm@11.11.0 --filter @qianliu/control-api start
   ```
   health 就绪后跑脚本；**收尾已杀进程**（lsof 确认 8899 无监听，后台任务 exit 0）。端口自选 8899（避开 e2e 默认 8788）。
2. **X06 脚本**（worktree 根）：
   ```
   DATABASE_URL=... qianliu_e2e ... X06_BASE_URL=http://127.0.0.1:8899 \
   corepack pnpm@11.11.0 exec tsx V4/Evidence/API-COST-OFFICIAL-BALANCE/WP5-20261104/x06-amount-reconciliation.ts
   ```
   → **exit 0**：26 行核对表 / 15 端点 / **待裁定差异 0**；基准 `loadApiCostEstimation`＝`[{CNY,"3.00104000"},{USD,"0.50000000"}]`、KNOWN_PARTIAL、gaps＝PRICE_MISSING:1、CURRENCY_MISSING:5、PRICE_BASIS_UNVERIFIED:4、priceBasis 两条 UNVERIFIED（与 e2e seed 常量逐字吻合）。
   开发期中间失败如实记录：① 脚本放证据目录导致 `@qianliu/database`/`kysely` 不在解析链（改相对路径直引包内源文件＋query-builder 替代运行时 kysely import，共 3 次迭代后复现全绿）；② 初版三处形状解析错误（analysis months 为对象数组、资源分解键为 `providerSummaries`、/usage 请求级缺省币种标签语义）——均以 DB 只读构成核对（缺口行按"有/无 ledger_transaction"分桶）修正后归零。

## 3. X06 端点清单（15 GET＋1 登录）

GET `/dashboard`、`/dashboard/home`、`/usage/overview?subject_type=EMPLOYEE&period=MONTH`、`/usage?limit=500`、`/usage/export`（CSV 抓全文解析）、`/operating-bills`、`/operating-bills/2026-11`（DRAFT 当月）、`/operating-bills/2026-10`（CLOSED 冻结历史）、`/operating-bills/2026-11/analysis`（年度）、`/operating-bills/2026-11/department-accounts`、`/operating-bills/2026-11/departments`、`/operating-bills/2026-11/project-allocation-status`、`/operating-bills/2026-11/project-unallocated`、`/operating-bills/2026-11/projects/00000000-0000-4000-8000-000000000140/allocation-lines`、`/provider-resources/usage-overview`；POST `/auth/login`（admin/admin123，cookie 会话，与 e2e fixtures 同法）。

## 4. X06 对照结果（结论）

- **一致 10 行**：/dashboard monthlyApiCosts、/dashboard/home apiSpends、/operating-bills/2026-11 apiSpends（三者与基准 8 位逐字相等＝同源 loadApiCostEstimation）；/usage 与 CSV 的 USD 列（0.50000000 逐字）；角标/口径说明行（priceBasisUnverified、账单 apiSpendReason 与基准 gaps 的双权威换算）；CLOSED 冻结月 apiSpends=CNY 96.00000000 零改动（白名单(c)）。
- **差异但可归因白名单 16 行**：
  - (b) 双权威：/usage/overview apiCost=null（含 UNKNOWN 事务行拒绝出数）；年度页 (DeepSeek,CNY/USD) 行 apiSpend 保守置 null＋false（WP1 §6 多币种月份已知边界）；部门域/待归属行 apiCost=null＋缺口码。
  - (a) 范围/期间：CSV 与 /usage 默认全量期间（含窗口外 pool043 8 月行 3.2＋4.8）；资源分解组域收敛（各 API 组 reason=CURRENCY_MISSING:n／币种不一致）；年度 apiAccounts 覆盖仅 DeepSeek WP4 资源。
  - (a)+(b) 组合（金额逐行可对平）：/usage CNY 标签合计 137.00104000 与 CSV CNY 列合计 137.00104000＝基准 3.00104000＋有事务缺口行 126（请求 030 合并 45+80=125＋请求 050=1）＋窗口外 8；无事务缺口行（pool042 8.00）经空金额行呈现；缺省币种标签为展示语义（`usage-repository.ts:339`／export `costCurrency ?? "CNY"`）。
  - 部门账户 knownApiCost=137.50104000＝基准＋窗口内全部缺口行（134）逐字对平（跨币种直加为投影层既有口径，S2B §3 残留观察）。
- **待裁定差异：0 条**（X06 §2 空清单）。

## 5. 矩阵草案统计

`matrix-draft.md` 50 行：**PASS 候选 47**（ACE 14＋OAB 14＋AFR 14＋X02~X06 5）、**待 S5 全量日志确认 1**（X01 组合矩阵＝分域参数化证据合成，无单一矩阵用例——G25 建议已被总指挥接受）、**BLOCKED-WP6 半段 2**（X07 候选版本回退演练、X08 实际切换时序演练；各行可执行半段另标 PASS 候选）。金额类 case（ACE-02/07/09/13/14、X03、X06）逐条链到 X06 表行号或 0.00104000/0.03000000 字面值用例；X06 表已入矩阵行并回链。

## 6. 未决问题（供总指挥裁定）

1. **CSV/用量行缺省币种标签**：无币种已计价行（基准 CURRENCY_MISSING:5）在 /usage 行与 CSV 中缺省显示 CNY（`usage-repository.ts:339`、export `costCurrency ?? "CNY"`）——金额可逐行核对缺口清单、不属异源算法差异，但"币种缺失行以 CNY 标签示人"的展示语义是否需改为"币种缺失"，建议另立任务裁定（本批零改动）。
2. **年度页 apiAccounts 覆盖范围**：本期 apiAccounts 仅含 DeepSeek WP4 E2E；zhipu（45/1/80）与 pool042（3.2/4.8）资源的当月账本行不在任何 apiAccounts 行中——S3c 注释声称"operatingBillResourceScope 保证当月有结算行的资源必在 views 中"，对这些资源未生效（机制未逐行核实，**未核实项**）。属白名单(a) 范围差异，是否需扩大年度覆盖请裁定。
3. **部门账户 knownApiCost 跨币种直加**：137.50104000＝CNY 3.00104＋USD 0.5＋缺口行 134 单标量直加（S2B §3 残留观察的同类投影层既有口径）；本次以"与基准＋缺口行逐字对平"归因 (b)，口径是否收敛（分列/置 null）请另立任务裁定。
4. **CSV 空金额行＝3 与基准 PRICE_MISSING:1 的构成差**：除 1 条 UNKNOWN 外，pool042 两请求仅有账本行、无 ledger_transaction，请求级读取方（/usage、CSV）天然不含其行级金额——属读取域差异（白名单(a)），已在 X06 表备注；如需在请求级也可见，涉及产品层读取模型扩展，非本包范围。
5. **knownApiCost 各厂商分桶**（DeepSeek 3.50104000/zhipu 126/pool042 8）含 USD 0.5 混入 DeepSeek 桶（3.00104+0.5=3.50104）——同一跨币种直加口径的分桶表达，随未决问题 3 一并裁定。
6. 本批只对当月 DRAFT＋上月 CLOSED 做了对照；年度页月份矩阵（2026-01~12 全列）仅抓取未逐列核对（矩阵 12 个月全为 0 值列，当月列已核对），如需逐月展开请另立任务。

## 7. 禁止事项遵守确认

- 未改任何业务代码/测试/e2e spec/迁移；`git status` 本批仅新增证据目录 3 文件＋本回执。
- 脚本只读：DB 仅 SELECT（loadApiCostEstimation＋3 条构成核对查询），HTTP 仅 GET＋登录；无 POST 写端点、无写库、未发送任何消息。
- 未进主仓 `/Users/mac/Projects/仟流智算`；未提交 git；自起服务已杀（8899 无残留监听）。
- 无相对路径 bash 写文件（本批全部写文件经绝对路径 Write 工具或绝对路径 python heredoc；初版脚本两次 import 修正亦为绝对路径 heredoc）。

## 8. 证据文件

- 脚本：`/Users/mac/Projects/仟流智算-api-decouple/V4/Evidence/API-COST-OFFICIAL-BALANCE/WP5-20261104/x06-amount-reconciliation.ts`
- 核对表（实际运行产出）：`/Users/mac/Projects/仟流智算-api-decouple/V4/Evidence/API-COST-OFFICIAL-BALANCE/WP5-20261104/x06-amount-reconciliation.md`
- 矩阵草案：`/Users/mac/Projects/仟流智算-api-decouple/V4/Evidence/API-COST-OFFICIAL-BALANCE/WP5-20261104/matrix-draft.md`
- 既有日志/截图（前批，未改动）：同目录 `logs/e2e-wp4-spec-commander-rerun.log`（16 passed/36.3s）、`screenshots/`（wp5-* 11 张＋wp4-* 复用）
