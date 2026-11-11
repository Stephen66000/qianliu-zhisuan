# WP5 S3a-1 回执：database 层验收缺口补测（G3/G5/G23/G26）＋ AT-X05 新文件（task 6.2）

日期：2026-11-04；基线：worktree `/Users/mac/Projects/仟流智算-api-decouple`，分支 `codex/simplify-api-cost-and-official-balance`，HEAD `d6550c9`（开工与收工同 HEAD，未提交改动含 S2A/S2B，本批零触碰、未提交 git）。

范围：只写测试（含 X05 只读摘要对比 helper），不改任何业务代码/迁移语义；金额断言一律 8 位小数字符串字面值；无旧断言删除（`git diff` 删行仅注释行/导入行重排，逐行核对见 §1）。

## 1. 实际改动清单（5 文件，均为测试文件）

| 文件 | 改动 | 新增用例 |
|---|---|---|
| `packages/database/src/__tests-integration__/api-cost-estimation.integration.test.ts` | +104/-4：文件头注释增 h) 行；`SeedLineInput` 增可选 `inputTokens`/`outputTokens`（缺省保持 1000/100，既有用例零行为变化）；新增 `seedRuleVersioned` 助手（既有 `seedRule` 原样） | 1（G3） |
| `packages/database/src/__tests-integration__/api-cost-estimation-attempts.integration.test.ts` | +101/-1：文件头注释扩充 §1.2b 说明 | 1（G26） |
| `packages/database/src/__tests-integration__/wp2-finance-mode-parity.integration.test.ts` | +49/-2：import 增 `loadApiCostEstimation`；文件头注释增 G5 条目 | 1（G5） |
| `packages/database/src/__tests-integration__/api-cost-draft-model-alignment.integration.test.ts` | +106/-2：文件头注释增 d) 行 | 1（G23） |
| `packages/database/src/__tests-integration__/wp5-upgrade-immutability.integration.test.ts` | 新文件 416 行（AT-X05，含文件内 ~40 行只读摘要 helper） | 3（6.2a/6.2b/6.2c） |

删行核对（`git diff | grep "^-"`）：4 个扩展文件的全部删除行仅为文件头注释行与 import 行的重排前文本，零断言/零逻辑删除。

## 2. 逐 G 落点与断言清单

### G3（AT-ACE-03 价格调整）→ 落点 `api-cost-estimation.integration.test.ts`（主 describe 新 it "h)"）

落点说明：C1 统一入口套件已具备 fixture/seedLine/priceBasis 断言先例（同文件 f) 用例），G3 是估算入口语义用例，放同文件最小 diff；未建新文件。
- 夹具（F11 雏形）：同企业规则版本 A（`f11-price-a`，effective_from 2026-08-01，每百万 miss 1 元/输出 2 元）与 B（`f11-price-b`，effective_from 2026-09-15 为明确生效点，每百万 miss 0.5 元/输出 1 元）；同一用量（miss 600000＋输出 200000）在生效点前后各一条 ledger 消费，金额字面值 A=`1.00000000`、B=`0.50000000`（各按当时版本单价×用量）。
- 断言：① 全窗 amounts=`[{CNY,"1.50000000"}]`＋KNOWN_COMPLETE＋无缺口＋priceBasis 含 A/B 两版本；② 生效点分窗各读 `[start,boundary)`=`1.00000000`、`[boundary,end)`=`0.50000000`（按各自生效时点版本计价）；③ 不改动任何数据重读（模拟刷新页面）整个估算对象 `toEqual` 逐字相等＋amounts JSON 字符串相等；④ 旧行 `ledger_line.api_cost` 仍 `1.00000000`、`billing_rule_id`/`rule_version` 仍版本 A；生效点前重读 priceBasis 仅含版本 A（旧调用不重算）。

### G5（AT-ACE-06 官方余额下降不影响估算）→ 落点 `wp2-finance-mode-parity.integration.test.ts`（新增 it）

落点说明：该套件即 AT-X01/ACE-06 机制层主场，`seedEnterprise` 夹具（12.34 CNY 已计价＋1 条 UNKNOWN）直接复用。
- 操作：同窗先读估算基线 → 仅直插一条更晚的 `provider_resource_operating_snapshot`（source=`PROVIDER_SYNC`＋balance_source=`PROVIDER_API`，collected_at 2031-11-20，余额 `3.00`，小于消费金额，模拟平台外消费下降）→ 重读估算。
- 断言：① 基线 amounts=`[{CNY,"12.34000000"}]`＋KNOWN_PARTIAL＋gaps=`[{PRICE_MISSING,1}]`；② 夹具自证快照确为官方来源且余额更小（8 位小数字面值 `3.00000000`）；③ ledger_line 计数保持 3（零新增消费）；④ 重读 `after toEqual before`＋amounts/completeness/gaps 三者 JSON 字符串逐字一致（币种金额与字符串精度完全一致）。

### G23（AT-AFR-12 仅余额桥接月份）→ 落点 `api-cost-draft-model-alignment.integration.test.ts`（draft describe 新增 it）

落点说明：G23 断言对象即经营账单 draft 桥接字段/快照 JSON，该文件已有 getBill 夹具先例；未建新文件。
- 夹具（F08「仅有余额桥接、无请求计价」）：期初快照 100（2026-08-30）＋期末快照 120（2026-09-20）＋充值记录 50（2026-09-10），**无任何 ledger_line**；夹具自证 ledger_line 计数=0 且估算 amounts=[]＋KNOWN_COMPLETE。
- 断言：① 桥接字段照常产出且原值保留（provider 行 opening `100.00000000`/recharge `50.00000000`/ending `120.00000000`；summary 同值）；② 桥接可算性按既有字段 `apiSpendStatus` 实际语义断言＝`CALCULABLE`、`apiSpendReason=null`（期初/期末事实齐全时的既有枚举值；期初缺席分支为 `BRIDGE_UNAVAILABLE`，见 monthly-operating-cost.ts 注释——按任务合同"按实际字段名/既有语义断言"，不发明新语义，用例注释已列明两种分支同属既有桥接可算性枚举）；③ 原历史金额 `100+50−120=30` 连同其桥接标签一起保留在 `sourceFacts.balanceBridgeFacts[0].apiSpend="30.00000000"`＋`apiSpendStatus="CALCULABLE"`；④ 估算主值为无计价行的精确 0 语义：provider/summary `apiCost="0.00000000"`、provider `totalCost="0.00000000"`、`apiSpends=[]`、gaps=[]，**不是**把桥接 30 填成已确认估算；⑤ 读取层不出现「API费用估算=30」：对整棵 draft JSON 做全树扫描（估算域字段=标量 apiCost/totalCost/monthlyCost＋apiSpends/totalSpends 分列的 amount 叶子），断言无任何路径承载 `30.00000000`，同时正面断言桥接域仍含 30（原历史金额及其标签保留）。

### G26（AT-X03 事务回滚后重放）→ 落点 `api-cost-estimation-attempts.integration.test.ts`（§1.2 后新增 it "§1.2b"）

- 基线：两 Attempt 正常结算（0.01 失败已计价＋0.02 成功）→ 估算 `[{CNY,"0.03000000"}]`。
- 故障注入（按合同指定的最简做法）：`db.transaction()` 内写第三笔（attempt_no=3＋usage_event＋ledger_line 计价 9.99）后 throw abort → 整体回滚。
- 断言：① 回滚零残留——attempt/usage_event/ledger_line 计数保持 `["2","2","2"]`，估算 `toEqual` 基线（9.99 幽灵行不存在）；② 对同一 Attempt（attempt2）以完全相同终态证据重放结算 → `created=false`、计数仍 `["2","2","2"]`（重复终态幂等在回滚后仍成立＝结算事务约束不可移除）；③ 金额仍 `0.03000000`（不因回滚＋重放变多）＋ dedup 证据唯一（`<requestId>:attempt1`/`attempt2` 各恰 1 条 usage_event）。

## 3. AT-X05 新文件结构与白名单明细（`wp5-upgrade-immutability.integration.test.ts`）

用例命名均含 "AT-X05/task 6.2" 标识；每个断言组注释引用 acceptance-plan §6 X05 通过标准（"原始用量/规则/资金事件与 V1 快照内容不变；迁移仅在预先列明的合同/新增数据范围变更"）。结构：

1. **6.2a 升级不变性**：`startPostgresContainer("wp5_upgrade")` → `createMigrator(db).migrateTo("0091_recorded_cost_accounting_policy")`（水位先例 wp3-operating-sync-decouple）→ 在 0091 水位插入 F08/F09 旧数据 → 受保护行集摘要（基线）→ `migrateToLatest()`（断言执行列表含 0092…0096 全部五条）→ 同组查询重读摘要逐名相等；并正向断言 0093 白名单变更确已发生（billing_rule 存量行 source_status=`UNVERIFIED`）。
   - 0091 水位 F08/F09 夹具：`operating_bill_period`(CLOSED, 2026-09)＋`operating_bill_version` v1 冻结快照（期初 100＋充值 50−期末 120＝旧费用 30 的旧口径：summary.apiCost=`"30.00000000"`＝桥接值、balanceBridgeFacts 保留）；`provider_finance_event` 三条（API_OPENING_BALANCE source=MIGRATION 切换时点 100 CNY／API_RECHARGE source=MIGRATION 50 CNY＋cash 50／F09 CODING_PLAN_PURCHASE 100 CNY）；`provider_subscription_period` 一条（PURCHASE，上海零点对齐周期）；billing_rule 规则（`legacy-v1`）＋原始 ledger 消费行两条（计价 `10.15000000` 含 `billing_rule_snapshot` 冻结快照＋UNKNOWN 未计价）及配套 ai_request/upstream_attempt/usage_event；`provider_finance_usage_cost_disposition` 历史处置投影行（0086，`original_ledger_fact=to_jsonb(line)`）。
   - 关键实现约束：0059 的 `provider_subscription_period_closure` 为 DEFERRABLE INITIALLY DEFERRED 约束触发器 → CP 事件与周期必须同一事务提交（夹具内已用 `db.transaction()`，并注释说明）。
2. **摘要 helper（文件内自写 ~40 行）**：`SELECT row_to_json(t) ... ORDER BY <pk>` 有序行 → `canonicalJson`（递归键排序、Date→ISO、bigint→字符串，摘要只依赖行内容）→ sha256。受保护行集 10 个：F08_bill_period／F08_bill_version／F08_F09_finance_events／F09_subscription_period／raw_requests／raw_attempts／raw_usage_events／raw_ledger_lines／F08_cost_disposition／F08_billing_rule（白名单列）。
3. **允许差异白名单**（文件头逐条列明迁移依据）：
   - **0092_employee_monthly_quota**：新增员工额度域对象（enterprise/principal_grant 加列＋两新表＋两唯一索引）——不 UPDATE 任何既有行；受保护行集不含 enterprise/principal_grant → 无白名单列。
   - **0093_billing_rule_source_status**：billing_rule `ADD COLUMN source_status varchar(16) NOT NULL DEFAULT 'UNVERIFIED'`——唯一会填充既有行新列的迁移，属 WP1 合同 §2/ACE-02 场景 3 预先列明的合同变更 → `F08_billing_rule` 按显式列白名单 `BILLING_RULE_DIGEST_COLUMNS`（0091 水位即存在的全部 27 列）对比、排除 source_status；用例内另正向断言该列填充为 `UNVERIFIED`（合同变更本身发生但不触碰白名单内列）。
   - **0094/0095/0096**：仅 DROP 触发器/DROP 索引/新表 → 无行变更、无白名单项。
   - 其余 9 个受保护表全部 `SELECT *` 全列对比——若未来迁移向这些表加列，列集变化会使本用例失败，从而强制 conscious 白名单审核（设计意图，注释已写明）。
4. **6.2b 退役写入口升级后仍拒绝（DB 层 410/409 等价物）**：升级后库上 ① ADMIN API 期初直插（企业未激活）→ 0083 触发器拒绝 `resource-level opening balance requires an activated enterprise`；② ADMIN API 充值无同币种期初 → 拒绝 `API recharge requires an opening balance in the same currency`；③ MIGRATION 期初非切换时点 → 拒绝 `migration opening balance facts must use the cutover instant`（0083 时点合同未被迁移弱化）；零写入证据：资金事件仍恰 3 条。
5. **6.2c 新库对照**：另起全新库 `wp5_fresh` → `migrateToLatest()` 成功且迁移头=0096 → 同组受保护行集查询全部可执行、均为空集摘要（新库路径可用，不断言旧数据）。

## 4. 实际执行的验证命令与结果（预期/实际）

环境：colima（`DOCKER_HOST=unix:///Users/mac/.colima/default/docker.sock`＋`TESTCONTAINERS_RYUK_DISABLED=true`，S2B 已趟通的组合；仅命令行环境变量，非文件改动）。

1. **五个目标文件精确运行**（`corepack pnpm@11.11.0 exec vitest run --config ../../vitest.config.ts <5 文件>`，cwd `packages/database`）：**5 文件 29/29 全绿**（exit 0）——api-cost-estimation 11（10 旧＋1 新 G3）、attempts 6（5 旧＋1 新 G26）、parity 3（2 旧＋1 新 G5）、draft-model-alignment 6（5 旧＋1 新 G23）、wp5-upgrade-immutability 3（全新）。预期 ≥5 新用例通过且旧用例零回归；实际 29/29。
2. **合同并集命令**（`corepack pnpm@11.11.0 --filter @qianliu/database run test:integration -- <合同 3 文件＋parity＋draft-model-alignment 共 5 文件>`；脚本自带目录参数 → 实际并集 **82 个集成文件**，非仅 5 个）：**Test Files 2 failed｜80 passed（82）；Tests 2 failed｜598 passed（600）；6 unhandled errors；exit 1**。5 个目标文件在并集中全部 ✓（11/6/3/6/3）。2 个失败均为已知容量类文件（与 inv-wp5 §0、S2B 回执 §4.1-1 同一组）：
   - `w20-standard-capacity.integration.test.ts`：W20-10 P95（并集 4 worker 争抢下 subjectUsageP95 1280.9ms>800）；
   - `usage-aggregate-migration-capacity.integration.test.ts`：600s 超时（百万行种子＋迁移争抢下超时）。
   **两文件隔离复跑定性**：migration-capacity 单文件 **1/1 过**（363.5s）；w20 单文件两样本——样本 1 两项 P95 超阈值（resourceUtilizationP95=1292.9ms>1000、departmentBillP95=1123.1ms>1000，subjectUsageP95=343.8ms 达标）、样本 2 **2/2 全绿**（subjectUsageP95=365.8ms、resourceUtilizationP95=986.1ms、departmentBillP95=829.9ms，均达标但 resourceUtilization 贴近上限）。→ 隔离复绿成立，失败为本机 colima VM 性能边际＋争抢波动，非本批回归（该测量路径本批零触碰，S2B §6-1 已同记录 resourceUtilizationP95 边际问题）。
3. **6 unhandled errors（57P01 类）**：并集高并发下 6 例 `terminating connection due to administrator command`（容器 stop 与 pool socket 关闭竞态），涉及 4 个文件——project-allocation-close（2，本批未触碰）、operating-bill-resource-scope（2，本批未触碰）、api-cost-draft-model-alignment（1）、wp5-upgrade-immutability（1）。未触碰文件出现同类证明该类属并集环境现象；本批对其新文件已加 200ms teardown settle 加固（仅测试文件内，见 §1），加固后 X05 文件三次单文件运行均零 uncaught error。未逐一复现于其他 3 文件（超出本批合同范围，见 §6-3）。
4. **typecheck**：`corepack pnpm@11.11.0 --filter @qianliu/database run typecheck` → **exit 0**（仅 pnpm node v22.17.1 vs wanted ≥22.23.4 引擎 WARN，与本批无关）。
5. **lint**：`corepack pnpm@11.11.0 --filter @qianliu/database run lint` → 最终 **exit 0（零告警）**。过程中两处中间失败已修复（`pricedLine`/`planEventId` 未使用变量），最终态全绿。
6. **最终态一致性说明**：并集运行于中间态代码（其后仅两处行为中性编辑：6.2c teardown 加固 200ms＋删除未使用变量 `planEventId`）；最终态已复跑 5 文件精确运行（29/29）＋X05 单文件（3/3）＋typecheck/lint（0/0）。

## 5. 用例数（预期/实际）

- 本批新增用例：**5（G3/G5/G23/G26 各 1＋X05 3 个 it 合计新增 3）**；实际全部通过。
- 目标文件用例总数：**29**（新增 5＋既有保留 24）；实际 29/29 通过（精确运行与并集两口径一致）。
- database 包并集：预期（S2B 基线）593 用例→实际 600 用例（含本批 5 新增；其余差额为 HEAD 既有演进），598 过/2 失败（两容量文件，隔离复绿）。
- typecheck 0 错误；lint 0 告警。

## 6. 未解决问题

1. **w20-standard-capacity 的 resourceUtilizationP95／departmentBillP95 阈值边际**：隔离两样本一次超（1292.9/1123.1ms）、一次过（986.1/829.9ms）；该测量路径本批零触碰，无法做 HEAD 基线对照（本机存在不可回退的未提交改动）。延续 S2B §6-1 的请裁定项：在标定环境复测，或复核该阈值标定。
2. **并集 57P01 unhandled error 类**（§4-3）：本批仅能对其新文件加固；project-allocation-close/operating-bill-resource-scope/draft-model-alignment 三文件的同类现象未修复（修复涉及标准 teardown 模式改动，超出"只写测试且不改既有语义"的最小范围）。建议后续统一排查 testcontainer 停机与 pg pool 关闭的竞态。
3. **并集命令过滤不收敛**：`test:integration` 脚本自带目录参数，合同命令实际跑 82 文件全量（S2B 已记录同机制）；精确单文件运行已补作为指定范围证据。
4. **X05 覆盖边界**：按合同"只做 DB 层可断言部分"——HTTP 层 410/409 退役合同（W1-W12）不在本文件；另 `migrateDown` 水位回退演练归 migration-rollback 系既有测试（wp3/activ-migration），本文件未重复。F08 摘要的"迁移前快照保存"（acceptance-plan §2-5）以用例内现场生成基线摘要实现（inv-wp5 §5-6 已注明仓内无现成产物）。

## 7. 禁止事项遵守确认

- 未删任何旧断言、未放宽任何阈值、未补零期初；未动业务代码/迁移（git status：本批仅 5 个测试文件，4 modified＋1 untracked；S2A/S2B 的 20 个既有未提交文件零触碰）。
- 金额断言全部 8 位小数字符串字面值；未进入主仓 `/Users/mac/Projects/仟流智算`；未提交 git。

## 8. 证据文件（本机临时日志，未入库）

- 5 文件精确运行（最终态）：`/tmp/wp5-s3a1-final-five.log`（29/29）
- X05 单文件最终态：`/tmp/wp5-s3a1-x05-final.log`（3/3，零 uncaught）
- 并集合同命令：`/tmp/wp5-s3a1-union.log`（82 文件，598/600，5 目标文件全 ✓）
- 迁移容量隔离复跑：`/tmp/wp5-s3a1-migration-capacity-isolated.log`（1/1，363.5s）
- w20 容量隔离两样本：`/tmp/wp5-s3a1-capacity-isolated.log`（1 failed，P95 证据行）／`/tmp/wp5-s3a1-capacity-isolated2.log`（2/2 过，P95 证据行）
- typecheck/lint 最终：`/tmp/wp5-s3a1-typecheck-final2.log`／`/tmp/wp5-s3a1-lint-final2.log`（均 exit 0）
