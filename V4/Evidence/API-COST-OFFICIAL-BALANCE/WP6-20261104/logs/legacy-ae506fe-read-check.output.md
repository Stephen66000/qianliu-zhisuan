# X07 任务 B 实证记录：旧代码（ae506fe）读回退后库（0092 水位）

日期：2026-11-04；执行：glm-flash 子 Agent（WP6 S3）。演练库：docker 容器
`wp6-x07-drill`（postgres:17-alpine@sha256:742f40ea…，与 W01 测试容器同 digest 锁定），
固定端口 55433（合同建议 55432 被本机既有 ssh 隧道占用，未动它，改用 55433），
库 `wp6_x07_drill`，演练结束后保留待复核。

## 1. 执行命令与顺序

```bash
# (0) 演练库
DOCKER_HOST=unix:///Users/mac/.colima/default/docker.sock docker run -d --name wp6-x07-drill \
  -e POSTGRES_PASSWORD=qianliu -e POSTGRES_USER=postgres -e POSTGRES_DB=wp6_x07_drill \
  -p 55433:5432 postgres:17-alpine@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193

# (1) 准备段（候选代码驱动：migrateToLatest→造数→down 链→0092 重放）——候选 worktree 根
DOCKER_HOST=unix:///Users/mac/.colima/default/docker.sock \
DATABASE_URL=postgres://postgres:qianliu@127.0.0.1:55433/wp6_x07_drill \
corepack pnpm@11.11.0 exec tsx \
V4/Evidence/API-COST-OFFICIAL-BALANCE/WP6-20261104/scripts/legacy-ae506fe-read-check.prepare.ts
# 退出码 0；输出：migrateToLatest 97 项→0096；down 链
# [0096,0095,0094,0093,0092]；0092 空操作 down 后水位 0091→幂等重放→0092；
# 行数：ledger_line=2、provider_finance_event=0、finance_state=1(PENDING)、quota_period=1

# (2) 水位独立复核（psql）
docker exec wp6-x07-drill psql -U postgres -d wp6_x07_drill -t \
  -c "SELECT name FROM kysely_migration ORDER BY name DESC LIMIT 1;"
# → 0092_employee_monthly_quota

# (3) 实证段（旧 worktree 根运行；业务代码全部直引 ae506fe 源文件）
cd /Users/mac/Projects/仟流智算-wp6-legacy-ae506fe
DOCKER_HOST=unix:///Users/mac/.colima/default/docker.sock \
DATABASE_URL=postgres://postgres:qianliu@127.0.0.1:55433/wp6_x07_drill \
X07_FIXTURE_JSON=/Users/mac/Projects/仟流智算-api-decouple/V4/Evidence/API-COST-OFFICIAL-BALANCE/WP6-20261104/scripts/legacy-ae506fe-read-check.fixture.json \
corepack pnpm@11.11.0 exec tsx \
/Users/mac/Projects/仟流智算-api-decouple/V4/Evidence/API-COST-OFFICIAL-BALANCE/WP6-20261104/scripts/legacy-ae506fe-read-check.legacy-read.ts
# 退出码 0
```

依赖安装：`corepack pnpm@11.11.0 install --frozen-lockfile`（旧 worktree，退出码 0；
ae506fe 与候选 HEAD 的 pnpm-lock.yaml 零差异，`git diff ae506fe HEAD -- pnpm-lock.yaml`
0 行，无需放宽 frozen）。

## 1b. 重入验证与终态归档口径

- 准备段重跑验证（同一演练库二次执行）：migrateToLatest 仅执行 4 项（0093-0096，
  即上次 down 链的逆操作）→ 再次 down 链到 0092 → 幂等可重入（每次生成新 fixture，
  fixture.json 以最后一次为准）。日志：logs/legacy-ae506fe-read-check.prepare.log。
- 终态归档＝以最终 fixture（enterprise a236f546-…）重跑实证段的输出
  （logs/legacy-ae506fe-read-check.output.json），六项关键值与首次运行完全一致
  （准入包含/排除、两笔金额、可结算 created、窗口 CNY 0.00208000、额度 1000000/1200）。
- 演练库终态：0092 水位；两套演练 fixture 数据并存（均无 finance 期初/充值事件）；
  旧代码结算写路径新消费各一笔（CNY 0.00052000×2）。容器 wp6-x07-drill 保留待复核。

## 2. 实证结果（原始 JSON 见 logs/legacy-ae506fe-read-check.output.json）

### 结论三行式（合同要求）

- **准入＝PASS（含一处如实边界）**：旧代码 `listServableResources`（ae506fe:428）
  对「无 finance_state 行的无期初资源」**包含**（included=true，旧代码语义
  “无记录表示未纳入门禁”→可服务，ae506fe resource-pool-repository:421-458 实测返回）；
  边界：带存量 PENDING 留档行的资源被旧过滤**排除**（included=false）——即回退后
  新建的 API 资源会被恢复的种入触发器标记 PENDING，从而在旧代码候选中被排除
  （该行为即 0094 down 边界断言的另一半，WP6 候选清单须列为回退包要求，非数据丢失）。
- **可读＝PASS**：回退前已结算的两笔消费金额经旧代码 `listLedgerLines`
  （ae506fe:261）逐字读出（CNY 0.00104000 / 0.00052000，amountMatchesSeed=true）；
  旧代码费用聚合 `loadWindowOperatingFinance`（ae506fe dashboard-home-costs:36）
  读出 totalSpends=[{CNY, 0.00208000}]（＝三行 ledger 之和，含实证段新结算一行），
  incompleteReason=`OPENING_BALANCE_MISSING:2`（仪表盘桥接口径对无期初资源如实
  报缺期初——不阻断 ledger 金额读取，记为已知口径差异）。
- **可结算＝PASS**：旧代码结算写路径 `createRequest → createAttempt →
  createUsageAndLedgerLineIfAbsent`（ae506fe 原签名）在回退后库（0092 水位）成功
  落一笔新消费（created=true，CNY 0.00052000，PRICED_USAGE），且可随即读回
  （readableAfterSettle=["0.00052000"]）；旧代码额度读取
  `readQuotaPeriodsInTransaction`（ae506fe employee-quota-read-repository:65）读出
  2026-11 期 RAW_TOKEN limit=1000000 / used=1200 —— 原额度约束行对旧代码可读。

### 环境与边界备注

- 实证段对库的唯一写入＝旧结算写路径一笔新消费（实证「旧服务可结算新消费」的
  必要动作）；无期初补造、无 finance 事件新增（finance_events=0 全程）。
- 「无 finance_state 行的资源」只能在候选水位预先创建（旧库直插会被恢复的种入
  触发器自动标记 PENDING）——准备段按演练时序（候选期创建→回退）重现。
- legacy-read 脚本自身零 bare `kysely` 导入（证据目录无 node_modules 解析链，
  与 X06 脚本同约束）；业务代码全部绝对路径直引旧 worktree 源文件，杜绝误用候选代码。
