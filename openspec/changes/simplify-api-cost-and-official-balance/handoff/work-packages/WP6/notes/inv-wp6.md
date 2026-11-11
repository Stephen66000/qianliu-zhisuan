# WP6 S1 只读调查笔记（inv-wp6）

- 调查人：glm-flash（WP6 task 6.3 S1）；日期：2026-11-04。
- 基线核实：worktree `/Users/mac/Projects/仟流智算-api-decouple`，分支 `codex/simplify-api-cost-and-official-balance`，HEAD `59f7367`（`git rev-parse` 实测一致）。
- 性质：只读调查，未修改任何业务代码/迁移/测试/配置；未运行任何测试；git 仅用只读命令。
- 工作区状态：`git status --porcelain` 仅 1 条——`?? .../WP6/plan.md`（总指挥既有文档，非本调查产物）。

---

## A. 发布候选素材

### A1. 服务/包清单

**apps/（4 个服务，均为 @qianliu/* 0.3.0，private）**

| 服务 | name/version | 启动（dev/start） | 监听 | 入口 |
|---|---|---|---|---|
| control-api | `@qianliu/control-api` 0.3.0 | `tsx --env-file=../../.env watch src/main.ts` / `node --import tsx src/main.ts` | `CONTROL_API_PORT ?? 8788`，host `CONTROL_API_HOST ?? 127.0.0.1`（apps/control-api/src/main.ts:22-23） | apps/control-api/src/main.ts |
| gateway | `@qianliu/gateway` 0.3.0 | `tsx watch src/main.ts` / 同上 | `GATEWAY_PORT ?? 8787`，host `GATEWAY_HOST ?? 127.0.0.1`（apps/gateway/src/main.ts:20-21） | apps/gateway/src/main.ts |
| worker | `@qianliu/worker` 0.3.0 | `tsx --env-file=../../.env watch src/main.ts` | 健康口 `WORKER_HEALTH_PORT ?? 9191`（apps/worker/src/main.ts:250）；REDIS_URL（:272） | apps/worker/src/main.ts |
| web | `@qianliu/web` 0.3.0 | `vite`（dev 5173）/ `vite build` → nginx 静态 | dev `127.0.0.1:5173`（apps/web/vite.config.ts）；生产 nginx `:80`（apps/web/Dockerfile runtime 段） | vite + nginx |

**packages/（7 个，均为 0.3.0）**：config、contracts、database、domain、observability、provider-adapters、testing。根包 `qianliu-zhisuan` 0.3.0；`VERSION` 文件＝`2.5.8`。

**Dockerfile / 部署配置**
- 每服务 Dockerfile：apps/{control-api,gateway,worker,web}/Dockerfile（web 为 node build → nginx:1.27-alpine 两阶段，`SOURCE_REVISION` label 注入 git SHA）。
- compose：deploy/compose.yaml（服务：postgres:18、redis、**migrate**（一次跑 `node --import tsx packages/database/src/cli/migrate.ts up`，compose.yaml:49-62）、control-api:8788、gateway:8787、worker（9191）、web:8080→80、caddy:80/443；卷 postgres-data/caddy-*）、deploy/compose.target.yaml（仅 Caddy 暴露公网，`!reset []` 收业务端口）、deploy/compose.glm-first-byte-60s.yaml（gateway 首字节 60s 调优层）。
- caddy：deploy/caddy/Caddyfile、Caddyfile.target（统一管理 API 入口＋/v1/* 转 Gateway，compose.yaml:149 注释）。

**web ↔ control-api/gateway 连接**
- dev：vite 代理 `/api` → `CONTROL_API_ORIGIN`（默认 `http://127.0.0.1:8788`，可被 `E2E_CONTROL_API_PORT` 覆盖；apps/web/vite.config.ts:12-18，rewrite 去 /api 前缀带 cookie 同源头）。
- 生产：web 容器 nginx `location /api/ → proxy_pass http://control-api:8788`（apps/web/Dockerfile:39-46）；gateway 前端基址 build-arg `VITE_GATEWAY_BASE_URL`（Dockerfile:29-30 默认 `https://gw.qianliuai.com/v1`）。
- 环境变量名（权威定义 packages/config/src/index.ts:114-186 AppConfigSchema/loadConfig）：`DATABASE_URL`、`REDIS_URL`、`GATEWAY_KEY_PEPPER`、`SESSION_AFFINITY_HMAC_KEY`、`CREDENTIAL_KEK`、`COOKIE_SECRET`（control-api main.ts:4 敏感三件套＋cookie）、`NODE_ENV`、`LOG_LEVEL`、`CONTENT_RETENTION_MODE`、`RUNTIME_ASSURANCE_MODE`、`RUNTIME_ASSURANCE_WECOM_NOTIFY`、`FEATURE_*`（index.ts:22-29 七个开关）、`PROVIDER_FINANCE_MODE`（OFF/DARK/ACTIVE，compose 注入默认 ACTIVE）、provider 凭证 env（DEEPSEEK_API_KEY/ZHIPU_CODING_TOKEN/KIMI_CODING_TOKEN 等，index.ts:107 PROVIDER_SECRET_ENV）、`WECOM_REPORT_DELIVERY_ENABLED_AT/PAUSED`（worker main.ts:402）。

### A2. 迁移 0093–0096 逐条

| 迁移 | 文件 | up | down | down 数据损失 |
|---|---|---|---|---|
| 0093 | packages/database/migrations/0093_billing_rule_source_status.js | billing_rule 加列 `source_status varchar(16) NOT NULL DEFAULT 'UNVERIFIED'`＋CHECK ∈('VERIFIED','UNVERIFIED')（:19-24） | drop CHECK＋drop column IF EXISTS（:29-33） | 无（纯加列回滚；存量规则 UNVERIFIED 标记丢失但业务数据不动） |
| 0094 | packages/database/migrations/0094_retire_api_finance_pending_admission.js | drop 种入触发器 `provider_resource_finance_state_seed_trigger`＋函数 `provider_resource_finance_state_seed()`（0081:185-205 引入；:24-25）；不动 provider_resource_finance_state 表与任何行（D4 留档） | 逐字恢复 0081:185-205 函数＋触发器（:31-52），不写任何数据行 | 无（不删不改任何行） |
| 0095 | packages/database/migrations/0095_official_balance_sync_decouple.js | drop 唯一索引 `provider_resource_operating_sync_attempt_daily_uq`（:17） | 先查同键多行，**多行则抛错拒绝**，单行才重建唯一索引（:21-40） | 无数据删除；但多行场景 down 不可行（守卫拒绝） |
| 0096 | packages/database/migrations/0096_official_balance_refresh_request.js | 建表 `provider_resource_balance_refresh`（11 列）＋status CHECK（RUNNING/SUCCEEDED/FAILED）＋idempotency 唯一索引＋RUNNING 部分唯一索引＋latest_idx（:17-53） | `dropTable`（:57-59） | **删整表**——文件头明示"可能丢弃仅存的在途标记，不影响任何余额事实"（瞬时协调状态非证据） |

**0095 down 多行拒绝式守卫（file:line＋摘录）**：packages/database/migrations/0095_official_balance_sync_decouple.js:22-34
```js
const duplicates = await sql`
  SELECT enterprise_id, provider_resource_id, sync_day
    FROM provider_resource_operating_sync_attempt
   GROUP BY enterprise_id, provider_resource_id, sync_day
  HAVING count(*) > 1
   LIMIT 1
`.execute(db);
if (duplicates.rows.length > 0) {
  throw new Error(
    "0095 down: provider_resource_operating_sync_attempt 已存在同日多行"
    + "（P1 周期门禁产物），重建 daily_uq 唯一索引会失败；回滚被拒绝",
  );
}
```
守卫已有双向测试：packages/database/src/__tests-integration__/wp3-operating-sync-decouple.integration.test.ts:82-113（多行→rollbackTo 0095 抛 /0095 down/，索引保持不存在）；:115-140 附近单行路径 down 成功、重 up 再放开。

### A3. 备份方案素材

- **迁移执行器**：Kysely `Migrator`＋`FileMigrationProvider`（packages/database/src/migrator.ts:36-45）；CLI 入口 packages/database/src/cli/migrate.ts（`up|down` 二值参数，:10-15）；scripts：packages/database/package.json:15-16 `db:migrate`/`db:rollback`（**db:rollback 只回滚最近一个迁移**——migrator.ts:71-83 migrateDown 单步；多步回滚仅测试层 helper `rollbackTo`，packages/database/src/__tests-integration__/migration-rollback.ts:17-30，500 次安全上限循环 migrateDown）；根 package.json:19 `db:migrate` 转发。compose 侧由 `migrate` 一次性服务执行 up（compose.yaml:60）。
- **迁移水位表**：`kysely_migration`（Kysely 默认表名，未自定义——kysely.ts:85 声明＋migrator.ts 无 migrationTableName 覆盖）。生产水位查询先例：`docker exec ic-postgres ... SELECT name FROM kysely_migration ORDER BY timestamp DESC LIMIT 1`（deploy/scripts/release-wecom-report-delivery-20261019.sh:14、release-recorded-cost-disposition-20261002-bt.sh:19）。
- **备份/恢复脚本**：
  - 发布前 `pg_dump -Fc`：deploy/scripts/release-wecom-report-delivery-20261019.sh:36 `pg_dump ... > database-before-*.dump`＋:46 非空校验（"Verified backup required"）。
  - 回退脚本 deploy/scripts/rollback.sh：从 `deploy/backups/*.sql.gz` 恢复（:9-10 用法）；**DESTRUCTIVE 定级、运维 Owner 独立授权**（:5-7）；先重建目标库再灌全量快照（:100 注释"完整备份已把 schema、迁移表和数据一起恢复…禁止再叠加 down"，:113）。
  - 库内迁移级备份表先例：0045 `_migration_0045_pool046_backup`（0045_zhipu_weekday_window_alias.js:25,113）。
  - 另有 deployment_log 表 `backup_ref` 字段（0035_deployment_log.js:23；deployment-log-repository.ts:24,61）＋`deployment:import` CLI（apps/control-api/src/cli/import-deployment-manifest.ts，校验敏感信息后入库）。
  - **未发现** 通用"数据库备份"文档或定时备份配置（仅上述发布脚本内嵌 pg_dump；未核实生产是否有库外备份制度）。

---

## B. X07/X08 演练方式回溯

### B1. WP5 已 PASS 半段与 BLOCKED 半段原始记录

- **矩阵终稿 X07 行**（V4/Evidence/API-COST-OFFICIAL-BALANCE/WP5-20261104/matrix.md:100）：可执行半段＝DB estimation a) :160（可读）＋GW pending (a) :135（可结算全链路）＋GW gates :320（受额度约束）＋AFR-11 系（冻结/逐字节）＋DB migration-rollback 系（provider-finance-activation-migration :359、wp3-operating-sync-decouple :82/:113、wp5-upgrade-immutability 6.2b）＋WK runner/CA refresh.http :307（官方刷新恢复）＋X06 行 1-26；终判 `PASS（可执行半段）＋BLOCKED-WP6 半段`，备注"候选版本回退演练（停新版本→回旧版本→数据保留断言/旧服务读新数据）归 WP6（INV §3-X07）"。
- **矩阵终稿 X08 行**（同文件:101）：机制证据＝CA pf :896（停旧写七端点 410＋四表零增量）＋CA activ :458（未排空拒绝且不落候选）＋GW provider-finance-quiescence-gate :126/:171（租约内 503 零事实/到期自动恢复）＋WK runner gate＋renewal tick＋provider-operating-sync runner＋CA refresh.http :307＋X01 组合套件；备注"实际候选版本切换时序演练（多进程隔离环境：control-api+gateway+worker+模拟上游）归 WP6（INV §3-X08、acceptance §1 分工）"。
- **BLOCKED 原始记录**：WP5 notes/inv-wp5.md:92-93（X07/X08 行，G29/G30 缺口）、:135-136（"回退半段不可在本包执行：回退到旧服务版本需 WP6 的候选镜像/回退方案；旧服务读新数据无旧服务测试环境，标 BLOCKED→WP6"）、:178（移交清单）；joint-review.md:24（"X07/X08 的回退/切换半段（WP5 BLOCKED 记录）"列为 WP6 任务）。
- **执行证据目录**（V4/Evidence/API-COST-OFFICIAL-BALANCE/WP5-20261104/）：logs/ 16 个日志（control-api-integration-final.log 565KB、gateway-integration.log 176KB、database-test.log、worker-test.log、e2e-full-suite*.log 三轮、database-w20-capacity-isolated-rerun.log 等）；screenshots/ 11 张 wp5-*.png；matrix-draft.md/matrix.md；x06-amount-reconciliation.md＋.ts。总指挥 e2e 复跑档 logs/e2e-wp4-spec-commander-rerun.log（matrix.md:11 记 16 passed / 36.3s）。
- **执行命令**：matrix.md:20-29 CMD-DB/GW/CA/WK/AD/WEB/E2E/FULL（corepack pnpm@11.11.0；E2E 需 4 环境变量＋DATABASE_URL=qianliu_e2e；CMD-FULL 注明 w20 与 usage-aggregate-migration-capacity 为已知本机容量 flake，隔离复绿）。

### B2. X07/X08 断言落点（本轮逐一打开核对，行号实测）

| 断言 | 实测位置 | 内容 |
|---|---|---|
| 官方刷新失败→恢复 | apps/control-api/src/__tests-integration__/official-balance-refresh.http.test.ts:304 | "AT-X02 上游失败：失败 attempt 留痕、旧快照保留、失败态返回；冷却到期后可再次刷新成功" |
| 停旧写 410 | apps/control-api/src/__tests-integration__/provider-finance.test.ts:893-896（it.each 起） | 7 个退役端点×合法认证→410＋`api_funding_management_retired`＋资金事实/候选/对账/幂等表零增量 |
| 未排空拒绝 | apps/control-api/src/__tests-integration__/provider-finance-activation.http.test.ts:458 | "activation-preview：未排空（在途请求）时拒绝并且不落候选"（GatewayLedgerRepository.createRequest 造在途） |
| 静默门禁 | apps/gateway/src/__tests-integration__/provider-finance-quiescence-gate.test.ts:126（503 enterprise_maintenance 零事实）/:171（到期自动恢复） | 租约内三端点 503、retry-after 60、零上游零账本；/v1/models 不受限 |
| 0094 准入解除全链路 | apps/gateway/src/__tests-integration__/wp2-pending-admission.test.ts:134（describe）/:135 起 (a)（新建无资金账户→立即可服务＋用量估算）/:163 (b)（存量 PENDING 留档可服务） | AFR-04/05 |
| 0094 down 演练 | packages/database/src/__tests-integration__/provider-finance-activation-migration.integration.test.ts:356 起 | "0094 down 恢复种入触发器（正反控制），存量 finance_state 行原样保留（D4/AFR-02）" |
| 0095 down 守卫 | packages/database/src/__tests-integration__/wp3-operating-sync-decouple.integration.test.ts:82（多行拒绝）/:113 后单行成功 | 见 A2 |
| 水位回滚基建 | packages/database/src/__tests-integration__/migration-pre-monthly-fixture.ts:5-11（`PRE_MONTHLY_FIXTURE_HEAD="0072_admin_roles_security"`＋migrateToPreMonthlyFixtureHead）；rollbackTo＝migration-rollback.ts:17-30 | 0072 起步的历史回退演练基建（legacy rollback rehearsals） |
| Worker runner 门禁 | apps/worker/src/provider-operating-sync/runner.test.ts、subscription-renewal/runner.test.ts（CMD-WK 指定这两文件，matrix.md:25） | OFF/DARK 同步/续订门禁、P1 周期 |
| 冻结月数据保留（AFR-11） | matrix.md:85：CA pool025 :551/:201＋DB parity :139＋draft-model-alignment :294＋E2E test6 :196-212＋X06 行 14 | CLOSED 冻结不可变、逐字节 |
| X06 26 行金额核对 | V4/Evidence/API-COST-OFFICIAL-BALANCE/WP5-20261104/x06-amount-reconciliation.ts（脚本头 :1-24，只读：loadApiCostEstimation＋GET 端点＋login；15 端点） | 无期初消费金额可读可核对（X07 行 1-26 引用） |

### B3. BLOCKED 半段最小可执行方案要素盘点（仅素材，不设计方案）

1. **候选版本服务形态**：compose 全栈已可起（deploy/compose.yaml：postgres+redis+migrate+control-api+gateway+worker+web+caddy）；每服务 Dockerfile 可按 `SOURCE_REVISION=$(git rev-parse HEAD)` 构建带 SHA label 的镜像；web build-arg VITE_GATEWAY_BASE_URL。
2. **旧基线 ae506fe 可用性**：`git cat-file -t ae506fe`＝commit；`git merge-base --is-ancestor ae506fe origin/main`＝是（PR #7 合并提交，origin/main HEAD 即 `ae506fe`，远端已核实存在）；本机现有 8 个 worktree（`git worktree list`）均非该提交检出，可新建 worktree 检出。旧基线迁移头＝0092（WP0 baseline.md §3："源码迁移水位 0000-0092…本 change 新迁移自 0093 起"）。旧服务在新库上读新数据的兼容性（billing_rule 新列、0095 索引缺失、0096 新表、kysely_migration 超前水位）**未核实**——旧代码是否容忍需演练时实证（WP5 inv-wp5:135 明说"旧服务读新数据无旧服务测试环境"）。
3. **迁移 up/down 隔离库执行方式**：测试层既有范式＝`startPostgresContainer`（packages/testing/src/postgres-container.ts:13，Testcontainers）＋`createKysely(pg.connectionString)`＋`createMigrator(db).migrateTo("0094_...")/migrateToLatest()/migrateDown()`（wp3-operating-sync-decouple.integration.test.ts:82-140 实例）；CLI 层只有单步 down（A3）。**注意**：CLI `db:rollback` 一次只退一个迁移，多步退到 0092 需循环调用或库外处理；rollback.sh 官方回退路径是"整库备份恢复、禁止叠加 down"（rollback.sh:100-113）——两条回退路线并存，演练设计需裁定采用哪条（总指挥）。
4. **在途消费收尾既有夹具**：见 B2 表——静默租约门禁（GW :126/:171）、未排空拒绝（CA activ :458）、在途刷新租约收敛（0096 表 expires_at 租约＋CA refresh.http :304 失败后恢复）、worker runner 三件套。
5. **演练数据种子**：seed-e2e.ts（安全门 127.0.0.1/_e2e＋TRUNCATE）＋seed-e2e-wp4.ts（WP4/WP5 全部页面夹具，F01 估算半开窗 :288-300；三态官方余额 :12-24）；walkthrough 回执记录的演练库＝`qianliu_e2e`（WP5/receipts/walkthrough-signoff-20261104.md:3）。
6. **残留风险**：walkthrough 回执 :30"走查环境后台服务待停（5173/8788）"——WP6 演练起服务前需确认端口占用。

---

## C. W20-10 定位

- 文件：packages/database/src/__tests-integration__/w20-standard-capacity.integration.test.ts。
- describe/case：`W20-10 标准容量合同 > 1,000,000 ledger 的常用管理、单主体聚合、资源与部门月账 P95 达标`（:209 it）。
- 阈值断言：**:281 `expect(resourceUtilizationP95).toBeLessThanOrEqual(1_000);`**（同组 :279 commonAdmin≤500、:280 subjectUsage≤800、:282 departmentBill≤1000；整用例超时 300_000ms）。
- 测量方式：`measuredP95`（:36-50，2 次预热＋20 采样取 P95，performance.now）；被测操作＝`app.inject GET /provider-resources/utilization?month=2026-08`＋行组成断言（:246-262）——**集成测试内嵌的本机性能测量**（Testcontainers 起 Postgres＋真实 control-api buildControlApi app.inject；本机 colima Docker VM 承载，非 CI 标定环境）。
- 四数据点出处（WP5 report.md:56 §5-①"986/1018/1094/1187"）：
  - 1018.68ms＝WP5 receipts/s2b-receipt.md:83（S2B 全量下实测 `resourceUtilizationP95=1018.68ms > 1000 ✗`，同轮 departmentBill 944.63）；:96 §6-1 分析（路径零触碰、无法做 HEAD 基线对照、请裁定）。
  - 986.1ms＝receipts/s3a1-receipt.md:69（S3A1 隔离样本 2 全绿：subjectUsage 365.8、resourceUtilization 986.1、departmentBill 829.9）；同处样本 1 超阈值 1292.9/1123.1。
  - 1094.1044580ms＝logs/database-w20-capacity-isolated-rerun.log:52（AssertionError）；1187.1449170ms＝同文件:128（第二次失败）。
  - 即四点＝S2B 1 点＋S3A1 样本 2 的 1 过点＋隔离复跑 2 点；报告定性"本机环境 FAIL，路径本包零触碰，WP6 必须复验、不放宽阈值"（report.md:56、:86）。

---

## D. D-1~D-4 变更面与受影响场景

### D1. 三笔提交逐笔

**715e5d0（D-1，请求明细精确金额＋单价回退）**——8 文件 +228/-20：
- apps/control-api/src/gateway-requests/routes.ts（+66）：请求明细 attempts 路由新增 `billingPrices` 字段——快照（billing_rule_snapshot）缺单价时回退 billing_rule 当前单价并标 `source: "BILLING_RULE"`；快照含单价时字段为 null；两边都无则 null（新增 BillingRulePrices 接口＋billingPricesOf）。只加字段不改语义。
- apps/web/src/lib/usage-cost.ts（+13/-1）：新增 `costMoneyExactText`（8 位原值直出不两位舍入）。
- apps/web/src/pages/RequestDrilldown.tsx：结算汇总改用精确金额＋"单价（缓存/输入/输出）"三列渲染（快照优先，billingPrices 回退）。
- 新增/修改测试：apps/web/src/lib/usage-cost.test.ts（describe "costMoneyExactText 请求详情精确金额展示（D-1）" 7 参数用例）；apps/web/src/pages/RequestDrilldown.test.tsx（:171-187 "计价决策单价三列显示快照单价…" 等 +52 行）；apps/control-api/src/__tests-integration__/usage-cost-disposition.http.test.ts（+50 行新断言）；apps/web/e2e/wp4-cost-official-balance.spec.ts（test8 内断言 "0.00"→精确 "0.00104"＋新增单价行断言）。

**da36ac4（D-2，资源表官方余额组成）**——3 文件 +69/-1：
- apps/web/src/components/resources/resource-page-display.tsx（+23）：余额单元格渲染"赠送 X · 充值 Y"并排组成行（不相加；null 侧省略；null 组成不渲染；0 值原样显示）。
- 新增测试：apps/web/src/components/resources/resource-page-display.test.tsx（+42 行组成断言）。
- e2e spec test1（:62-114）新增断言 `赠送 ¥10.00 · 充值 ¥100.00`（浏览器层，保留"不出现 220"）。

**68d2227（D-3/D-4，文案级）**——2 文件 +6/-5：
- D-3：apps/web/src/components/resources/ProviderFinancePanel.tsx:223 标签 `"经营成本合计（旧资金口径）"`→`"经营成本合计（含 API 费用估算）"`（注释同步改为 ledger 消费计价＋套餐现金）。
- D-4：apps/web/src/components/resources/ResourceUsageOverviewPanel.tsx（预测表下沿新增一行 `<p>预测仅按已观察消费速率估算，不承诺账户实际可用时长</p>`，:38 附近，table 包入 Fragment）。

### D2. 三笔改动影响的矩阵 case 映射（对照 matrix.md 终稿）

| 改动 | 直接影响 case | 理由与证据指针 |
|---|---|---|
| D-1 | ACE-02（matrix:38） | 金额 0.00104 从"两位舍入 0.00"改为详情页精确展示——E2E test8 :245-283 与 DB :160-171 字面值联动 |
| D-1 | ACE-04（matrix:39 指针行） | 单价来源标注（SNAPSHOT/BILLING_RULE）与"价格依据待核实"角标同屏——WEB RequestDrilldown.test.tsx :104,112＋新增 :171-187 |
| D-1 | ACE-09（matrix:46） | 同一 e2e test8 内 Attempt 数＝1 断言未动但同屏复验 |
| D-1 | ACE-10（matrix:47） | usage-cost-disposition.http.test.ts 被本笔 +50 行修改（三投影一致性套件本体变更） |
| D-1 | ACE-01（matrix:35，间接） | 详情页结算汇总命名区域重排（"API费用估算"精确金额行） |
| D-1 | X06（matrix:96 引用行 1/3/6/9/12） | 请求明细端点响应新增 billingPrices 字段——X06 脚本核对 15 端点（含明细），金额不受影响但响应面变化宜复跑核对 |
| D-2 | OAB-01（matrix:56） | 组成断言升浏览器层——E2E test1 :62-114＋:99-113 C2 composition |
| D-2 | OAB-02/OAB-04/OAB-08/OAB-09（matrix:57-63 行段，同一资源表三态渲染） | 组成行渲染覆盖 OK/保鲜/过期/从未成功/同账户各行同一组件路径（resource-page-display.tsx 单点改动） |
| D-3 | AFR-01（matrix:75） | 套餐与订阅面板（ProviderFinancePanel 即该面板成本卡）文案变化；E2E test3 :137-159＋WEB resource-page-display G24 组合断言层 |
| D-4 | OAB-13/OAB-14（matrix:68-69） | 供给预测表新增局限说明行——E2E test16 :459-476 文案断言区新增一句需纳入 |

**风险标注**：D-3/D-4 新文案（"经营成本合计（含 API 费用估算）"、"预测仅按已观察消费速率估算，不承诺账户实际可用时长"）经全库 grep **未发现任何测试断言**（apps/web/src、apps/web/e2e 均无）——walkthrough-signoff-20261104.md:29 称"D-3/D-4 为文案级、组件测试覆盖"，该说法与代码现状不符（**未核实到对应测试**；疑指组件挂载冒烟测试，非文案断言）。WP6 候选复跑若要覆盖 D-3/D-4 文案，现只有浏览器走查路径。

### D3. 最小复跑集（D-1~D-4 新断言所在 spec 与用例名）

e2e（apps/web/e2e/wp4-cost-official-balance.spec.ts，16 个 test）最小集：
1. test1 `ACE-01/OAB-01/OAB-04/OAB-02：资源列表官方余额三态`（:62）——D-2。
2. test3 `AFR-01 场景1：套餐与订阅面板无 API 资金表单，历史资金记录只读含来源`（:137）——D-3 同面板。
3. test8 `ACE-01/02/05 请求详情：结算汇总 API费用估算 0.00104、1200 Token、attempt 按请求口径`（:248）——D-1。
4. test16 `OAB-13/14 供给预测：可信度/覆盖说明与'不可计算'局限文案`（:459）——D-4。

HTTP/单元层（D-1 直接改测）：
- apps/control-api/src/__tests-integration__/usage-cost-disposition.http.test.ts（+50 行）。
- apps/web/src/lib/usage-cost.test.ts、apps/web/src/pages/RequestDrilldown.test.tsx（:171-187）。
- apps/web/src/components/resources/resource-page-display.test.tsx（D-2 +42 行）。

---

## E. 生产补核素材

- **WP0 记录**：baseline.md §3（:31-34）"本会话无生产服务器/数据库只读权限。用户声明：PR #7 未部署、0092 未在生产执行"；所需核实三项＝各服务镜像 tag/容器版本、`knex_migrations` 水位（注：实际水位表名为 `kysely_migration`，baseline 此处写 knex_migrations 为历史笔误，未核实）、PROVIDER_FINANCE_MODE 与 strict_writes_enabled 实际取值；report.md:10 同口径；plan.md:21、:58"不自动执行任何生产动作"。
- **生产环境线索（仓库内）**：
  - 生产容器名约定 `ic-*`：ic-postgres / ic-control-api / ic-worker / ic-web（release-wecom-report-delivery-20261019.sh:14,36；release-home-opening-20261002-bt.sh:35,44,60）。
  - 生产主机路径 `/root/docker/qianliu-zhisuan`＋发布目录 `/root/docker/qianliu-<name>-<sha12>`、锁文件 `/root/docker/.qianliu-unify-release.lock`（release-weekly-retina-20261002-bt.sh:8-12）；脚本以 root 在主机执行（git archive→compose build），发布模式 --prepare/--build/--deploy 三段＋基线镜像 pin 校验（docker inspect 比对 baseline.json pins）。
  - 两类主机脚本族：`*-mac-mini.sh` 与 `*-bt.sh`（宝塔面板主机），deploy/scripts/ 共 39 个 release 脚本＋rollback.sh＋test-main-unify-readiness.py＋quota-pricing-preflight.sql。
  - 目标环境模板 deploy/target.env.example（QIANLIU_PUBLIC_HOST、NODE_ENV=production、全部 PLACEHOLDER 密钥、FEATURE_* 全 true）；deploy/compose.target.yaml（仅 Caddy 暴露 80/443）。
  - **未发现**任何只读连接串、跳板机、SSH 别名或运维文档形式的只读访问凭据；生产访问方式＝发布脚本内嵌 `docker exec ic-postgres psql`（只读 SELECT）先例——WP6 补核可照此模式请用户在主机执行（回执式），仓库内无现成只读通道（**未核实**生产主机实际可达性）。
  - 迁移水位补核 SQL 先例：`SELECT name FROM kysely_migration ORDER BY timestamp DESC LIMIT 1`（release-wecom-report-delivery-20261019.sh:14）。

---

## 剩余问题/风险清单

1. 0095 down 守卫意味着"同日多行已发生"的库**无法**用 down 回到 0094——回退方案只能走整库备份恢复（rollback.sh）或放弃该步回退；两条路线并存需总指挥裁定演练采用哪条。
2. CLI `db:rollback` 仅单步；从 0096/0095 退到 0092（旧基线水位）在 CLI 层无现成命令（测试层 rollbackTo 不在 CLI），演练基建需自行循环或临时手段（属 WP6 实施期设计，本轮只盘点）。
3. 旧服务（ae506fe，迁移头 0092）读新库（含 0093 新列/0096 新表/超前 kysely_migration 水位）的兼容性未核实；"旧服务读新数据"断言是否可行需在隔离库实证。
4. X07 回退半段的"数据保留断言"在 WP5 已有 DB 层材料（AFR-11 冻结系、X06、0094 down D4 行保留），但"旧服务进程级"演练需要旧镜像构建（ae506fe 的 Dockerfile/pnpm-lock 与当前 lockfile 差异未核实）。
5. D-3/D-4 新文案无自动化断言（grep 证实），walkthrough 回执"组件测试覆盖"表述与代码现状对不上；候选复跑清单需把这两条列为人工/浏览器核对项或补断言（补断言属实施期，本轮未做）。
6. W20-10 四数据点中 986 来自 S3A1 样本 2（receipt 文本），非独立 log 文件可指认（receipts/s3a1-receipt.md:69）；S2B 的 1018.7 证据在 /tmp/wp5-s2b-capacity-isolated.log（receipt :107 注明，该 /tmp 文件是否仍在**未核实**）；1094/1187 有入库 log。复验时按 CMD-FULL 注记须隔离复绿。
7. walkthrough 演练环境后台服务（5173/8788）按回执尚未停——WP6 起服前需检查端口占用。
8. 生产补核无仓库内只读通道；只能沿用"用户在主机执行 docker exec/psql 回执"模式（WP0 同款 BLOCKED 若不补核将持续未核实）。
9. WP0 baseline.md 把水位表写作 `knex_migrations`，实际为 `kysely_migration`（本包代码为准）——补核回执措辞需修正。
