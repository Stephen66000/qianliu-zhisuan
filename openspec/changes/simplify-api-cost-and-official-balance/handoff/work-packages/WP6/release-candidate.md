# WP6 发布候选清单（task 6.3：发布/回退操作单）

- 包：WP6；撰写：glm-flash 子 Agent（S2 文档成文）；日期：2026-11-05。
- 性质：本文件是**发布候选标识与切换/回退操作单**，全部断言来自隔离环境演练与仓库代码事实；**不构成生产部署授权**（见 §9 状态声明）。
- 证据根目录：`/Users/mac/Projects/仟流智算-api-decouple/V4/Evidence/API-COST-OFFICIAL-BALANCE/WP6-20261104/`（下文简写 `Evidence/WP6-20261104/`）。

---

## 1. 候选标识

| 项 | 值 | 核实方式 |
|---|---|---|
| 分支 | `codex/simplify-api-cost-and-official-balance` | `git branch --show-current` 实测 |
| 候选 HEAD | `59f7367`（全量 `59f736744d6e0752d9ed38a847f3b9a5d1e8c949`） | `git rev-parse HEAD` 实测（2026-11-05） |
| 远端 main | `ae506fed47d21865420afa91137e8b244072933e`（PR #7 合并提交，2026-11-02） | `git rev-parse origin/main` 实测 |
| 包含关系 | `ae506fe` 为候选 HEAD 祖先 | `git merge-base --is-ancestor ae506fe origin/main` 通过；WP6/plan.md:19 开工复核同口径 |
| 版本号 | `VERSION` 文件＝`2.5.8` | `cat VERSION` 实测 |
| 包版本 | 4 个 apps＋7 个 packages 全部 `0.3.0`（private/工作包）；根包 `qianliu-zhisuan` 0.3.0 | 各 `package.json` `"version"` 字段实测（apps/control-api、apps/gateway、apps/worker、apps/web；packages/config、contracts、database、domain、observability、provider-adapters、testing） |

**构建与镜像可追溯机制**：四个服务 Dockerfile 均含 `ARG SOURCE_REVISION=unknown` ＋ `LABEL org.opencontainers.image.revision=$SOURCE_REVISION`（apps/control-api/Dockerfile:27-28、apps/gateway/Dockerfile:30-31、apps/worker/Dockerfile:34-35、apps/web/Dockerfile:33-34）。构建时按 `SOURCE_REVISION=$(git rev-parse HEAD)` 注入，发布前可比对镜像 label 与候选 SHA——先例：deploy/scripts/release-wecom-report-delivery-20261019.sh:20-22 `candidate()`（label 不匹配即拒绝发布）、:26 preflight 输出 label。

---

## 2. 服务与镜像清单

### 2.1 四个服务

| 服务 | 包/版本 | 监听 | 入口/启动 | Dockerfile |
|---|---|---|---|---|
| control-api | @qianliu/control-api 0.3.0 | 8788（`CONTROL_API_PORT ?? 8788`，apps/control-api/src/main.ts:22-23） | apps/control-api/src/main.ts | apps/control-api/Dockerfile |
| gateway | @qianliu/gateway 0.3.0 | 8787（`GATEWAY_PORT ?? 8787`，apps/gateway/src/main.ts:20-21） | apps/gateway/src/main.ts | apps/gateway/Dockerfile |
| worker | @qianliu/worker 0.3.0 | 健康口 9191（`WORKER_HEALTH_PORT ?? 9191`，apps/worker/src/main.ts:250） | apps/worker/src/main.ts | apps/worker/Dockerfile |
| web | @qianliu/web 0.3.0 | nginx `:80`（apps/web/Dockerfile:40 `listen 80`） | vite build → nginx 静态＋`/api/` 反代 control-api:8788（apps/web/Dockerfile:44-45） | apps/web/Dockerfile |

### 2.2 compose 拓扑（deploy/compose.yaml）

- **postgres**：`postgres:17-alpine`，digest 锁定 `sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193`（deploy/compose.yaml:6,14；W01 锁定，工程规则 §2）。卷 postgres-data＋postgres-init 初始化（:28-29）。
  - **勘误说明**：WP6 调查笔记 inv-wp6.md A1 段写作 "postgres:18"，与实际文件不符——以 deploy/compose.yaml:14 为准（PG17）。本清单按实际文件成文。
- **redis**：`redis:8-alpine`，digest 锁定 `sha256:8096655e…`（compose.yaml:7,15）；`--save "" --appendonly no`（派生状态可丢弃重建，:39）。
- **migrate（一次性服务）**：复用 control-api 镜像，跑 `node --import tsx packages/database/src/cli/migrate.ts up` 后退出（compose.yaml:48-62，command 在 :59）；业务服务均 `depends_on: migrate: service_completed_successfully`（如 :84-85, :107-108, :134-135）。**即 compose 栈内迁移 up 是自动前置步骤**。
- **control-api**（:64-85）：8788 仅绑 127.0.0.1（:78）；`stop_grace_period: 20s`（:69）；注入 `PROVIDER_FINANCE_MODE: ${PROVIDER_FINANCE_MODE:-ACTIVE}`（:75）。
- **gateway**（:87-108）：8787 仅绑 127.0.0.1（:101）；stop_grace_period 20s（:92）。
- **worker**（:110-135）：健康检查 `wget http://127.0.0.1:9191/health`（:123-128）；注入 PROVIDER_FINANCE_MODE（:121）。
- **web**（:137-146）：`127.0.0.1:8080:80`（:143），depends_on control-api。
- **caddy**：`caddy:2.9-alpine`，80/443（:150-155），挂 caddy/Caddyfile；注释明确"统一管理 API 入口 + /v1/* 转 Gateway；Web 直连 web:8080 不经 Caddy"（:148-149）。
- 叠加层：deploy/compose.target.yaml（目标环境：postgres/redis/control-api/gateway/web 端口全部 `!reset []` 收回私网，仅 Caddy 暴露 80/443/443udp，改用 Caddyfile.target）；deploy/compose.glm-first-byte-60s.yaml（gateway 首字节 60s 调优层）。

### 2.3 web 构建参数

- `ARG VITE_GATEWAY_BASE_URL=https://gw.qianliuai.com/v1`（apps/web/Dockerfile:25-26）——前端直连 Gateway 的基址为**构建期固化**，发布不同环境需按目标域名传入 build-arg；改基址需重建镜像，不是运行时配置。

### 2.4 关键环境变量（权威定义：packages/config/src/index.ts；本清单只列变量名，不抄任何密钥值）

- 基础连接：`DATABASE_URL`、`REDIS_URL`（AppConfigSchema，index.ts:120-125）。
- 密钥类（全部环境注入，缺失即启动失败，index.ts:127-130 起）：`GATEWAY_KEY_PEPPER`、`SESSION_AFFINITY_HMAC_KEY`、`CREDENTIAL_KEK`、`COOKIE_SECRET`。
- 运行模式：`NODE_ENV`、`LOG_LEVEL`、`CONTENT_RETENTION_MODE`（固定 METADATA_ONLY，index.ts:11,169）、`RUNTIME_ASSURANCE_MODE`（OFF/OBSERVE/ENFORCE，默认 OBSERVE，:14,176）、`RUNTIME_ASSURANCE_WECOM_NOTIFY`（:178）。
- 资金模式：`PROVIDER_FINANCE_MODE` ∈ OFF/DARK/ACTIVE，缺省 ACTIVE（index.ts:32-39 `readProviderFinanceMode`；compose.yaml:75,121 注入）。
- 功能开关：`FEATURE_FLAG_NAMES` 共 **5 个**——FEATURE_DIRECTORY_IMPORT / FEATURE_USAGE_OVERVIEW_V2 / FEATURE_DEPARTMENT_COST / FEATURE_RESOURCE_UTILIZATION_V2 / FEATURE_PROCUREMENT_REVIEW（index.ts:22-28；非 test 环境缺省 false，:85）。目标环境模板 deploy/target.env.example 全部置 true（inv-wp6.md §E 记录）。
- 官方余额三参数（WP3 P1-P3，index.ts:46-70）：`PROVIDER_OPERATING_SYNC_INTERVAL_MS`（默认 900000）、`PROVIDER_OPERATING_BALANCE_EXPIRE_MS`（默认 1800000）、`PROVIDER_OPERATING_BALANCE_REFRESH_COOLDOWN_MS`（默认 30000）。
- Provider 凭证 env 名（冻结表 PROVIDER_SECRET_ENV，index.ts:107-111）：DEEPSEEK_API_KEY / ZHIPU_CODING_TOKEN / KIMI_CODING_TOKEN。
- 投递开关（worker 报告投递）：`WECOM_REPORT_DELIVERY_ENABLED_AT`、`WECOM_REPORT_DELIVERY_PAUSED`（apps/worker/src/main.ts:401-402）。

---

## 3. 迁移 0093–0096 说明

| 迁移 | up 内容 | down 内容 | down 数据影响 |
|---|---|---|---|
| 0093_billing_rule_source_status | billing_rule 加列 `source_status varchar(16) NOT NULL DEFAULT 'UNVERIFIED'`＋CHECK ∈('VERIFIED','UNVERIFIED')（packages/database/migrations/0093_billing_rule_source_status.js:21-23） | drop CHECK＋drop column IF EXISTS（同文件:31-32） | 无业务数据删除；存量规则的 UNVERIFIED 标记随列消失（可接受，down 语义即如此） |
| 0094_retire_api_finance_pending_admission | drop 种入触发器 `provider_resource_finance_state_seed_trigger`＋函数 `provider_resource_finance_state_seed()`（0094_retire_api_finance_pending_admission.js:24-25；二者系 0081_provider_finance_activation.js:185-205 引入） | 逐字恢复 0081:185-205 的函数＋触发器（0094:29-52），不写任何数据行 | 不删不改任何行；副作用见 §6「回退不得恢复 API 期初门槛」 |
| 0095_official_balance_sync_decouple | drop 唯一索引 `provider_resource_operating_sync_attempt_daily_uq`（0095_official_balance_sync_decouple.js:16） | 先查同键（enterprise_id, provider_resource_id, sync_day）多行；多行则**抛错拒绝**；单行才重建唯一索引（同文件:20-45） | 无数据删除；**多行场景 down 不可行（守卫拒绝，见 §6 辅路线）** |
| 0096_official_balance_refresh_request | 建表 `provider_resource_balance_refresh`（11 列）＋status CHECK＋idempotency 唯一索引＋latest_idx（0096_official_balance_refresh_request.js:19-50） | `dropTable`（同文件:58） | **删整表**——文件头明示可能丢弃仅存的在途刷新标记；该表是瞬时协调状态，非余额事实，不影响任何已落库余额/消费数据 |

### X07 实证要点（Evidence/WP6-20261104/logs/wp6-rollback-drill.log，7/7 passed；长期资产＝packages/database/src/__tests-integration__/wp6-rollback-drill.integration.test.ts，537 行）

1. **down 链 0096→0092 数据逐字保留**（断言 3，测试文件:317）：受保护行集＝8 组（ai_request / upstream_attempt / usage_event / ledger_line / ledger_transaction / principal_quota_period / principal_quota_usage / provider_resource_finance_state，测试文件:100-109 PROTECTED_SETS），每组 sha256 全行摘要，down 链后**逐字不变**；期初/充值类 finance 事件全程为 0（不补期初）；结算幂等约束（ledger_transaction_unique_request 等）仍在。
2. **0092 幂等重放**：`0092 down` 是空函数（packages/database/migrations/0092_employee_monthly_quota.js:39 `export async function down(_db) {}`）——rollbackTo 0092 执行该空 down 后**应用水位暂落 0091**，须幂等重放 0092 up（全 IF NOT EXISTS，无数据变更）使水位与数据一致；演练实证：`0092 空操作 down 后水位 0091→幂等重放→0092`（Evidence/WP6-20261104/logs/legacy-ae506fe-read-check.output.md §1(1)）。
3. **0095 down 两态**（断言 4a/4b，测试文件:480/:509）：多行态——同日两条 attempt 后 down 抛「回滚被拒绝」，daily_uq 保持不存在、数据原样；单行态——down 成功、daily_uq 重建且唯一性恢复。守卫代码＝0095_official_balance_sync_decouple.js:22-34（HAVING count(*)>1 即 throw）。守卫双向测试先例：packages/database/src/__tests-integration__/wp3-operating-sync-decouple.integration.test.ts:82-140。
4. **0094 down 边界**（断言 5，测试文件:382-407）：已存在资源不被追溯种入（5a）；down 后**新建** API 资源被恢复的种入触发器标记 PENDING（5b）。回退后重升 migrateToLatest 恢复 0096，金额仍可读、种入随 up 再次退役、数据零丢失（断言 6，测试文件:409）。

---

## 4. 备份方案

### 4.1 发布前备份（先例：deploy/scripts/release-wecom-report-delivery-20261019.sh）

- 备份：`docker exec ic-postgres sh -c 'pg_dump -Fc -U "$POSTGRES_USER" -d "$POSTGRES_DB"' > <state_dir>/database-before-*.dump`（同文件:36，custom 格式 -Fc）。
- 非空校验：`[[ -s ...dump ]] || { echo 'Verified backup required'; exit 2; }`（同文件:46）——**备份文件不存在或为零字节时禁止进入部署段**。同文件:35 另有防覆盖门（备份已存在则拒绝重写，要求人工核查）。
- 镜像可追溯门：`candidate()` label 校验（同文件:20-22）。

### 4.2 回退脚本模式（deploy/scripts/rollback.sh，先例）

- 定级与授权：文件头明示**安全等级 DESTRUCTIVE（会重置数据库到备份点）、授权要求运维 Owner 独立授权**（rollback.sh:5-6）。
- 流程：指定备份文件→gzip 完整性校验 `gzip -t`（:43）→交互确认输入 YES（:60-63）→停业务服务保留 postgres（:70-71）→等待 pg 就绪（:81-93）→**dropdb --force＋createdb 重建目标库再灌全量快照**（:101-106，拒绝恢复到系统库）→恢复后校验迁移头（:113-121）。
- **"禁止叠加 down"规则**：完整备份已把 schema、迁移表和数据一起恢复到备份点，**禁止再叠加 down 迁移**（rollback.sh:113 注释原文；:115-121 恢复后头校验）。
- **复用注意（实施时需定制，未在生产验证）**：a) 该脚本头校验硬编码历史头 `0045_zhipu_weekday_window_alias`（:117）——本轮回退若恢复到 0092 备份点，期望头应改为 `0092_employee_monthly_quota`，直接照跑会 exit 3；b) 该脚本消费 `.sql.gz` 纯 SQL 格式（:10,29,43,109 `gunzip | psql`），而 §4.1 先例产出 `-Fc` 自定义格式（需 `pg_restore`）——**两种制品格式不通用，发布前必须统一选定一种并配套对应恢复手段**，本清单不擅自裁定，列入发布前置检查。

### 4.3 备份登记先例

- deployment_log 表含 `backup_ref varchar(256)` 字段（packages/database/migrations/0035_deployment_log.js:23；packages/database/src/deployment-log-repository.ts:24,61）＋`deployment:import` CLI（apps/control-api/src/cli/import-deployment-manifest.ts）——发布/回退记录可将备份制品路径登记入 deployment_log。

### 4.4 未核实项（如实标注）

- 仓库内**未发现**通用数据库定时备份配置或备份制度文档（inv-wp6.md §A3）；生产是否存在库外备份制度**未核实**。本清单的备份主张仅覆盖"发布前即时 pg_dump＋非空校验"这一有先例的最小闭环。

---

## 5. 切换操作单（X08 五段时序）

演练证据：Evidence/WP6-20261104/logs/wp6-x08-switch-drill.log（五段时序逐行）＋ logs/x08-result.json（23 断言 allPass=true）＋ logs/x08-baseline-t0.json。演练环境：隔离容器 `wp6-x08-pg`（postgres:17-alpine digest pinned，:55434 保留待复核）＋模拟上游 :19191（chat/balance 计数）；旧栈＝ae506fe@0092 水位，候选栈＝59f7367@0096。编排脚本＝Evidence/WP6-20261104/scripts/（run-drill.sh、x08-prepare.ts、x08-checks.ts、x08-mock-upstream.mjs、x08-fetch-guard.mjs 等）。

> **耗时声明**：演练实测全时序 31,789ms（约 31.8s，drill log X08-DRILL-END 行）**仅为隔离环境参考值**（本地空库＋模拟上游＋无真实负载）；生产窗口时长预估不得引用该数值。

### T0 旧栈基线（演练实测 10,679ms）

- 要点：旧栈（ae506fe）三服务起于 0092 水位；模拟上游就绪；seed（resourceA/B/P，全程零期初资金）；control-api 会话登录；登记 CODING_PLAN 订阅（auto_renew=true，未到期）；**基线快照**（开关、周期行、资金四表计数、一笔正常消费金额、worker 首轮同步计数）；挂起一笔在途请求（mock 延迟 8s，admitted 未结算）。证据：drill log T0-SEEDED/T0-C0-COUNTS/T0-CONSUMPTION/T0-READ/T0-MOCK-STATS/T0-INFLIGHT 行；x08-baseline-t0.json。
- 生产映射要点：基线快照内容（资金四表行数、周期行、最近消费金额、worker tick 状态）在切换前留存为 T0 对照值。

### T1 停旧写＋在途收尾＋停旧栈（演练实测 6,023ms）

- 步骤：启动静默租约（LEASE-START，ACTIVE，600s）→租约内新请求被门禁 503 `enterprise_maintenance`（零上游零账本，GATE-503；x08-gate-503.json）→收尾报告 drained=true（IN_PROGRESS=0 openAttempts=0 pendingTx=0；在途请求已在旧 gateway 完成结算，x08-drain-report.json）→释放租约（RELEASED）→**停旧 worker→旧 gateway→旧 control-api**（此后不可能再新增 API 资金写入）→窗口起点计数快照 C1。
- 验证断言（x08-result.json）：B1 在途请求 admitted 于租约生效时；B2 门禁拒绝零事实；B3 收尾归零 drained=true；B4 在途消费金额可读（SUCCEEDED api_cost=0.00040000 tx=SETTLED）；B5 租约终态 RELEASED；A1-A4 窗口起点 C1 计数。
- 生产映射要点：对应 X08 断言 B 组的机制在候选代码中即静默租约/收尾门禁（apps/gateway/src/__tests-integration__/provider-finance-quiescence-gate.test.ts:126,171；apps/control-api/src/__tests-integration__/provider-finance-activation.http.test.ts:458）。

### T2 迁移 up 0093→0096（演练实测 1,604ms；迁移本体 264ms）

- 演练：候选 migrator `migrateToLatest`，executed=[0093,0094,0095,0096]，idempotent_replay_error=null（drill log T2-MIGRATED 行；x08-migration.json）。
- 生产映射要点：compose 栈内由 migrate 一次性服务承担（deploy/compose.yaml:48-62），与业务服务 `service_completed_successfully` 依赖联动（§2.2）；执行前后各查一次迁移水位（§8 命令 b）。

### T3 新栈起（演练实测 3,239ms）

- 演练：候选栈（59f7367）control-api/gateway/worker 起，worker 同进程内官方余额同步 tick＋套餐续订 tick 共存（drill log T3-NEW-STACK-UP 行）；登录；窗口内新登记 API 资源C（零同步尝试，作 T4 runner 路径目标）。
- 生产映射要点：按 §2 compose 栈整体切换（migrate 成功后 control-api/gateway/worker/web 依次拉起）。

### T4 验证断言 A-E（演练实测 4,621ms）

| 组 | 断言（x08-result.json id） | 内容 |
|---|---|---|
| A 资金零增量＋退役端点 | A1-A4 | finance_event / subscription 周期 / activation_attempt / ledger 计数：切换窗口内零新增（仅 T0 计划内基线＋T1 在途收尾各 1 笔）；A5 七个退役端点全部 410＋`api_funding_management_retired`（HTTP 层逐端点证据在 A5 detail） |
| B 静默与收尾 | B1-B5 | 见 T1 |
| C worker 切换 | C1-C4 | 旧 worker 停/新 worker 运行（PID 3592→4112）；新 worker runner 路径新官方余额快照落库（快照 C1=2→live=4）；手动刷新 SUCCEEDED（balance 110.50 CNY 模拟上游）；新旧 worker 续订 tick 均正常输出 |
| D 套餐续订不变 | D1-D3 | auto_renewal enabled 新旧一致；周期行起止逐字一致；subscription-periods HTTP 新旧栈响应一致 |
| E 无旁路无外呼 | E1-E4 | fetch 守卫 7 行 BLOCKED=0、非本地 finalUrl=0（x08-fetch-guard.jsonl）；mock 权威终值 chat=3/balance=4/other=0 与计划逐一对应（x08-mock-stats.json）；ai_request=3 全 SUCCEEDED、SETTLED=3；零真实付款（方法局限如实记录于 E4 detail） |
| X 跨栈一致 | X1-X2 | T0 旧栈消费金额 0.00100000 经新栈 /usage 与 DB 三处一致；窗口内无期初资源新消费 0.00060000 正常结算（SETTLED） |

---

## 6. 回退操作单（重点）

### 6.0 路线裁定（WP6/plan.md §3 总指挥裁定 1）

- **主路线＝整库备份恢复**（rollback.sh 模式，§4.2）；**辅路线＝down 迁移链**（X07 演练验证过）。两者边界：任何"down 链不可行"的库状态（0095 多行）只能走主路线。

### 6.1 主路线：整库备份恢复

- **适用场景**：切换后功能性回退（新栈缺陷/行为不符预期）；0095 多行态库；任何涉及数据面回退的场景。
- **前置条件**：存在切换前（T2 迁移执行前）的备份制品且已过非空校验（§4.1:46 同款）；运维 Owner 独立授权（rollback.sh:6 定级）；已通知用户停止操作（rollback.sh:12 回退前告知义务）。
- **步骤要点**：停新栈业务服务（保留 postgres）→dropdb/createdb 重建目标库→灌全量快照→校验恢复后迁移头＝备份点水位（0092_employee_monthly_quota）→重建**旧版本**镜像并以旧栈起服务（rollback.sh:13"回退后需重新构建旧版本镜像"）→按 §5 T0 同款做回退后基线快照。
- **切换后新消费的处理说明（两难，如实写明）**：整库恢复会把库回滚到备份点——切换窗口后的新消费行（如 X08 的 T4 新消费 0.00060000）会随整库恢复**从库中消失**（回到备份点即备份点之后的一切皆不在）。这既是数据回退也是消费记录回退：账面不丢的是"备份点之前的全部事实"，备份点之后的消费需从新栈服务日志/上游侧核对后人工评估是否补录，而**任何补录都不得伪造金额或期初**（红线见 6.4）。本清单不对"切换后新消费是否补录"替用户裁定——发布窗口应尽量缩短（T1 停旧写后到回退决定间的写入量即暴露窗口），并在回退决定时冻结写入。
- **备份数据完整性的演练佐证**：X07 断言 2/3 的 8 组受保护行集摘要机制（wp6-rollback-drill.integration.test.ts:100-109,:122-124）可直接用于"恢复后行集摘要 vs 备份点摘要"核对（该测试用 sha256 摘要证明 down 链零丢失；整库恢复同理可核对）。

### 6.2 辅路线：down 迁移链（演练验证过）

- **适用场景**：仅结构性回退（退回 0092 水位但保留全部业务数据），且库满足全部守卫前置。
- **步骤**（X07 实证顺序，Evidence/WP6-20261104/logs/wp6-rollback-drill.log＋legacy-ae506fe-read-check.output.md §1(1)）：
  1. 停新栈业务服务（先完成 §5 T1 同款停写收尾）。
  2. down 链 0096→0095→0094→0093：0096 down 删瞬态表（可接受，§3）；0095 down 先过多行守卫（见 6.3）；0094 down 恢复种入触发器（**副作用见 6.4，须先读**）；0093 down 纯删列。
  3. **0092 幂等重放**：down 链到位后水位暂落 0091，重放 0092 up（空 down 的逆操作，全 IF NOT EXISTS）使水位＝0092（§3-X07 实证要点 2）。
  4. 以旧版本（ae506fe）栈起服务；回退后基线快照。
- **多步 down 的执行层事实**：CLI `db:rollback` 一次只退一个迁移（packages/database/src/migrator.ts:71-83 单步 migrateDown；packages/database/package.json:15-16）；退四步需循环四次或使用测试层 rollbackTo helper（packages/database/src/__tests-integration__/migration-rollback.ts:17-30，500 次安全上限）。生产执行方式属实施期定制，本清单不虚构现成命令。
- **重入性**：X07 准备段二次执行实证 down 链可重入（migrateToLatest 仅执行 0093-0096 四项→再次 down 链到 0092；legacy-ae506fe-read-check.output.md §1b＋logs/legacy-ae506fe-read-check.prepare.log）。

### 6.3 0095 down 多行守卫处理

- 守卫：0095_official_balance_sync_decouple.js:22-34——`provider_resource_operating_sync_attempt` 存在同键（enterprise_id, provider_resource_id, sync_day）多行时 down **抛错拒绝**（"P1 周期门禁产物，重建 daily_uq 唯一索引会失败；回滚被拒绝"）。
- 实证：X07 断言 4a 多行态拒绝、daily_uq 保持不存在、数据原样（wp6-rollback-drill.integration.test.ts:480）；4b 单行态成功（:509）。
- **裁定写入操作单**：多行态被拒绝时，该库**只能走主路线（整库备份恢复）**；**不得**为了满足 down 而删除或合并多行 attempt 数据（attempt 表受不可变触发器管治，0095 文件头；强删既违反数据保留红线也破坏审计事实）。上线后 P1 周期同步（默认 15 分钟）运行一段时间后同日多行几乎必然出现——即**辅路线随上线时间推移迅速失效，主路线是唯一长期可靠回退路径**。
- 执行前自检命令要点（只读）：按 §8 命令风格查询 `SELECT count(*) FROM (SELECT … FROM provider_resource_operating_sync_attempt GROUP BY enterprise_id, provider_resource_id, sync_day HAVING count(*)>1 LIMIT 1) t`，>0 行即主路线。

### 6.4 回退不得恢复 API 期初门槛（本 change 的核心回退约束）

- **机制事实**：0094 down 会逐字恢复 0081 种入触发器（0094:29-52；0081_provider_finance_activation.js:185-205）——回退后**新建** API 资源会重新获得 PENDING 行。X07 断言 5b 实证：down 后新建资源即刻被种入 PENDING（wp6-rollback-drill.integration.test.ts:396-407）；5a 实证已存在资源不被追溯种入。
- **旧代码（ae506fe）准入实证**（Evidence/WP6-20261104/logs/legacy-ae506fe-read-check.output.md「结论三行式」，原始值 logs/legacy-ae506fe-read-check.output.json）：
  1. **无 finance_state 行的资源被旧候选包含**（included=true，可服务）——ae506fe `listServableResources`（resource-pool-repository:421-458）对无记录资源按"未纳入门禁"语义放行；
  2. **带 PENDING 行的资源被旧过滤排除**（included=false）——即回退后新建的资源（被恢复触发器标记 PENDING）在旧代码下**不可服务**；这是行为边界，不是数据丢失；
  3. **已结算消费金额旧代码可读可结算**——`listLedgerLines` 逐字读出 0.00104000/0.00052000；`loadWindowOperatingFinance` 聚合 totalSpends=[{CNY,0.00208000}]（incompleteReason=`OPENING_BALANCE_MISSING:2` 为仪表盘桥接口径差异，不阻断读取）；旧结算写路径在 0092 水位成功落新消费（created=true）并随即可读；员工月度额度行（RAW_TOKEN limit=1000000/used=1200）旧代码可读——**受原额度约束**在回退后成立。
- **回退包要求**（三条，写入候选交付）：
  - a) 回退到纯旧代码时，切换后新建的资源若尚无 finance 行（即未被 PENDING 污染），仍可服务；其切换后消费的数据可读、可结算已实证（X2＋legacy 三行式结论 3）。
  - b) **回退期间新建资源会重新 PENDING 且旧代码拒绝服务**——若需这些资源在回退窗口内可服务，应优先走**前滚修复**（在新候选上修复缺陷后重新发布，0094 up 会再次退役触发器、PENDING 行留档不影响服务），而非回退；确需回退时应**在回退窗口冻结新建 API 资源操作**（回退完成、旧栈就绪后再放开——放开即回到旧准入语义，新建资源需走旧代码的期初门槛流程，这是旧版本本身的既定行为，不由本回退操作单改造）。
  - c) **不要求任何补期初操作**——回退后新建资源的 PENDING 行是恢复触发器的如实产物，不做任何 INSERT 补造（X07 断言 3d：期初/充值类 finance 事件全程 0；legacy 实证 finance_events=0 全程）。

### 6.5 回退红线（违反任何一条即操作无效）

1. **不删除新用量**：无论主/辅路线，不以回退为名删除、合并或改写任何 ledger_line/usage_event/ai_request 消费事实（辅路线 X07 断言 3 的 8 组摘要逐字不变即此红线的数据层表述；主路线恢复到备份点属整库语义，见 6.1 的两难说明，不属"删除"操作）。
2. **不补造资金**：不 INSERT 任何期初/充值/更正类 finance 事件，不虚构余额（X07 断言 3d＋legacy 实证 finance_events=0）。
3. **不改 0092-0096 迁移文件**：回退全程零触碰迁移文件本体（WP5/report.md §3 红线证伪同口径延续）；0095 多行被拒时改走主路线而不是改守卫。

---

## 7. 已知边界与口径

### 7.1 官方余额端点硬编码（S4 发现，零改码边界）

- `DEEPSEEK_BALANCE_ENDPOINT = "https://api.deepseek.com/user/balance"` 为包级常量（packages/provider-adapters/src/provider-operating-facts.ts:30），**不走 capability_set/凭证侧配置**——发布后如需代理或换端点，需另行评估改码，本轮不处理。
- 本轮演练的隔离手段＝零改码 fetch 层守卫（环境级 NODE_OPTIONS 预载，Evidence/WP6-20261104/scripts/x08-fetch-guard.mjs）：把对该硬编码 URL 的调用重定向到模拟上游（x08-fetch-guard.jsonl 共 7 行 redirected_to_mock，BLOCKED=0）。生产发布**不得**依赖该守卫——它是演练工具，不是产品行为。

### 7.2 X08 断言 A 口径（总指挥已裁定）

- A 组"资金四表零增量"的口径：**T0 订阅登记 1 行为计划内基线增量**（切换前置动作），切换窗口（T1 起）内零新增（x08-result.json A1 detail："资金事件全程仅 T0 旧栈订阅登记 1 行，切换窗口内零新增"；A4 同口径区分 T1 在途收尾 +1）。该口径为 WP6 总指挥裁定（WP6/plan.md §3 裁定 3 时序断言集），不是"全程零写入"。

### 7.3 W20-10 P95 复验结果：**FAIL（3 样本全部超线，环境定性维持，不放宽阈值）**

- 用例＝packages/database/src/__tests-integration__/w20-standard-capacity.integration.test.ts:209,:281-282；阈值未动（commonAdmin≤500 / subjectUsage≤800 / resourceUtilization≤1000 / departmentBill≤1000）。
- 候选 HEAD `59f7367` 隔离复跑 3 样本（S5 两样本＋总指挥对照样本 1）：

| 指标（阈值） | 样本1 | 样本2 | 样本3（总指挥，清理演练容器后） |
|---|---|---|---|
| commonAdminP95（≤500） | 5.74 | 7.99 | 3.77 |
| subjectUsageP95（≤800） | 593.47 | 597.23 | 540.79 |
| **resourceUtilizationP95（≤1000）** | **1437.27 FAIL** | **1425.91 FAIL** | **1468.11 FAIL** |
| **departmentBillP95（≤1000）** | **1249.75 FAIL** | **1151.98 FAIL** | **1175.65 FAIL** |

- 对照说明：WP5 四点 986/1018/1094/1187（1 过 3 超贴线震荡）→ 本轮 3 样本 1426-1468（全部超线且劣于 WP5 全部四点），departmentBill 由绿转红。样本 3 已清理 WP6 演练容器（wp6-x07-drill/wp6-x08-pg）后由总指挥执行，数值无改善——**排除本轮演练容器负载归因，本机（colima VM）当前负载状态即该量级**。日志：`Evidence/WP6-20261104/logs/w20-capacity-rerun-sample{1,2,3-commander}.log`。
- 定性：与 WP5 §5-① 一致——本机环境容量 flake、路径零触碰（WP6 业务改动仅 D-1~D-4 走查修复：web 前端＋control-api gateway-requests 字段透出，均不触及该查询路径）。**复验结论如实记 FAIL**；CI/发布环境标定复验为发布前置事项（本清单不冒充通过）。

---

## 8. 附录：生产只读补核命令清单（S6 用）

以下命令**全部只读**（docker ps / docker inspect / psql SELECT / printenv / ls），无任何写操作；请在生产主机执行并回执输出，回执后回填本清单"生产状态"节。仓库内无现成只读通道，采用发布脚本同款 `docker exec ic-postgres psql` 模式（先例：deploy/scripts/release-wecom-report-delivery-20261019.sh:14）。

a) **各服务镜像/容器版本**：

```bash
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}' | grep -E 'ic-(control-api|gateway|worker|web|postgres|redis)'
docker inspect --format '{{.Name}} image={{.Config.Image}} revision={{index .Config.Labels "org.opencontainers.image.revision"}}' ic-control-api ic-gateway ic-worker ic-web 2>/dev/null
```

（ic-gateway/ic-web 容器名按仓库先例类推：ic-postgres/ic-control-api/ic-worker/ic-web 见 release-wecom-report-delivery-20261019.sh:14,36 与 release-home-opening-20261002-bt.sh:35,44,60；实际容器名清单以 `docker ps` 输出为准。）

b) **迁移水位**（注意：表名是 `kysely_migration`；WP0 baseline.md:32 写作 `knex_migrations` 系历史笔误，实际表名以代码为准——kysely.ts 声明＋migrator.ts 无自定义表名，先例同款查询 release-wecom-report-delivery-20261019.sh:14）：

```bash
docker exec ic-postgres sh -c 'psql -X -Atq -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT name FROM kysely_migration ORDER BY timestamp DESC LIMIT 1"'
```

c) **模式与开关现状**（只回显变量名与取值，不含密钥；如回执含疑似密钥值请删除后再回传）：

```bash
docker exec ic-control-api printenv | grep -E '^(PROVIDER_FINANCE_MODE|FEATURE_|CONTENT_RETENTION_MODE|RUNTIME_ASSURANCE_MODE|RUNTIME_ASSURANCE_WECOM_NOTIFY|NODE_ENV)='
docker exec ic-worker printenv | grep -E '^(PROVIDER_FINANCE_MODE|PROVIDER_OPERATING_SYNC_INTERVAL_MS|PROVIDER_OPERATING_BALANCE_EXPIRE_MS|PROVIDER_OPERATING_BALANCE_REFRESH_COOLDOWN_MS|WECOM_REPORT_DELIVERY_ENABLED_AT|WECOM_REPORT_DELIVERY_PAUSED)='
```

d) **备份现状**：

```bash
ls -lh /root/docker/qianliu-zhisuan/deploy/backups/ 2>/dev/null || echo "目录不存在（本身即结论）"
```

（路径依据：生产主机 `/root/docker/qianliu-zhisuan` 先例，deploy/scripts/release-weekly-retina-20261002-bt.sh:8-12；rollback.sh 的备份目录约定 `$DEPLOY_DIR/backups/*.sql.gz`，deploy/scripts/rollback.sh:10,29。）

回执回填目标：本清单新增"生产状态"节，逐项记录实测值；任一项无法获取则如实记"未核实"，不估算。

---

## 9. 状态声明

1. **本清单性质**：发布候选标识、迁移/备份说明与切换/回退操作单，附隔离环境演练记录（X07 7/7、X08 23/23）。**本清单与全部演练不构成生产部署授权**；生产部署、迁移执行（0093-0096 up）、正式发布均须用户另行明确授权（WP6/task.md §七"WP6 的计划与演练不等于生产部署授权"）。
2. **实现完成**：候选 HEAD `59f7367` 含 WP1-WP5 全部业务提交＋走查修复 D-1~D-4（715e5d0/da36ac4/68d2227）；WP5 50 条矩阵 PASS 48＋X07/X08 半段 2（原 BLOCKED-WP6，本轮补齐）。
3. **测试通过（隔离环境）**：X07 回退演练 7/7（Evidence/WP6-20261104/logs/wp6-rollback-drill.log）；X08 切换时序演练 23 断言 allPass=true（logs/x08-result.json）；旧代码（ae506fe）读回退库三行式结论 PASS（logs/legacy-ae506fe-read-check.output.md）。以上全部为隔离环境（Testcontainers/独立容器＋模拟上游），**无任何生产环境验证**。
4. **发布未执行**：本 change 的生产部署、迁移与发布动作均未发生（WP6/task.md §"已合并不等于已上线"口径延续；生产版本/迁移水位截至本文成文仍为未核实，见 §8 待补核）。
5. **业务签收**：WP5 §7 六步走查用户已 PASS 并驱动 D-1~D-4 修复（WP5/report.md §6 走查更新）；**发布签收另议**——本清单成文后如候选变化（新提交），受影响场景按指令§六.8 重验后方可进入发布流程。
6. **待办挂账**：§7.3 W20-10 复验（待 S5 回填）；§8 生产只读补核（待 S6 回执）；§4.2 备份制品格式统一（-Fc vs .sql.gz，发布前置检查项）。
