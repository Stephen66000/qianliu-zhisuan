# 仟流智算 — 项目长期记忆

## 工具链与环境

- node v22.22.2（engines `>=22.17 <23`）；pnpm **仅 corepack** 可用（裸 `pnpm` 不在 PATH）：`corepack pnpm@11.11.0 ...`。
- 一律加 `export COREPACK_ENABLE_STRICT=0`，避免 corepack 因包管理字段不匹配而拒绝执行。
- 集成测试用 testcontainer `postgres:17-alpine@sha256:742f40ea…`（与 `deploy/compose.yaml` 同 digest），需本机 Docker。
- 单包命令：`corepack pnpm@11.11.0 --filter @qianliu/<pkg> run typecheck|test|lint`；
  单文件/过滤：`--filter @qianliu/<pkg> exec vitest run --config ../../vitest.config.ts <path>`。

### 无头页面取证（截图类 `V4/Evidence/**/page-evidence/`）

本机无 Playwright 浏览器，但装有 Google Chrome，可直接用 CDP 截图，无需新增依赖。三个坑必须记住：

1. **Chrome 必须加 `--no-sandbox`**。不带时沙箱无法初始化，renderer/network 进程崩溃，
   `/json/version` 可能仍可访问但 CDP 命令全部超时 —— 症状极具误导性。
   完整参数：`--headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage --no-first-run`。
2. **Node 内置 `WebSocket` 收不到 CDP 响应**（握手成功、`message` 事件永不触发）。
   必须自研极简裸 TCP WebSocket 客户端（见 `page-evidence/ws-client.mjs`），不要浪费时间在
   `new WebSocket(...)` 上排查。
3. **Chrome 只在单次 shell 调用内存活**：用 `&` 放后台会随该次调用结束被回收。
   启动、探测/截图、清理必须写在**同一条** Bash 命令里。

取证产物用真实 `vite build` 产物 + 本地桩 `/api/*` 渲染（桩数据须在 README 中声明为桩，
不得暗示端到端）。**页面截图不是服务端行为的证据** —— 服务端由 control-api 集成测试保证。

## 验证门禁（每个工作包提交前必过）

1. `typecheck`：domain / database / control-api / web / worker 五包 `tsc --noEmit` 全 0 错误。
2. `lint`：`eslint src --max-warnings=0`（**0 警告即失败**）。含 `complexity` 门禁：默认上限 30，
   个别文件按路径放宽（最高 84）。**大函数不要用 `eslint-disable` 糊过去**，应拆分为可审阅的纯函数子步骤。
3. 单测：domain（vitest）。
4. 集成测试：**不要整目录并发跑** `src/__tests-integration__`——Docker/Argon2 并发负载会产生假红
   （`Cannot read properties of undefined (reading 'split')`、登录 401）。按套件分片、必要时 `--maxWorkers=2`。
5. 判定回归用「同一命令的 A/B 失败集差集」（`git stash push -u` + JSON reporter）：
   区分新增回归 / 既有失败 / 并发假红 / 日期脆弱夹具。
6. **`typecheck` 不覆盖集成测试**：`packages/database/tsconfig.json` 的 `exclude` 跳过
   `src/**/__tests-integration__/**`，而 eslint 也非类型感知。改动了集成测试后必须另建一份
   extends `tsconfig.base.json` 的临时 tsconfig（`include` 指向测试文件、`noEmit: true`）跑
   `tsc -p <tmp>`，否则类型错误会一路躲到 vitest 运行时才炸。

## SQL / Kysely 陷阱

- `sql.join()` 产出的是**逗号列表**（行表达式），不是数组。写 `col <> ALL(${sql.join(ids)})` 会被
  PostgreSQL 以 `42809 op ANY/ALL (array) requires array on right side` 拒绝。
  正确写法：`col <> ALL(ARRAY[${sql.join(ids.map((id) => sql`${id}::uuid`))}]::uuid[])`。
  空集合要单独走 `sql`true``/`sql`false`` 分支。

## 已知测试债与规避写法

- **迁移回滚断言不得硬编码迁移头**（如 `expect(await migrateDown(db)).toBe("0072_...")`）——任何新增迁移都会打破。
  改用 `packages/database/src/__tests-integration__/migration-rollback.ts` 的 `rollbackTo(db, target)`。
- 涉及「当前周期」的夹具不要硬编码日期窗口，按**当前上海自然月**派生（`[本月上海零点, 次月上海零点)`），
  否则会被 `bind_current_subscription_period` 守卫以 409 拒绝。
- 断言迁移数量时用 `toContain(...)`，不要断言返回集合恰好等于某单一迁移。

## 金额与财务约定

- 金额一律 `decimal.js`，账户金额 8 位小数、人民币实付 2 位小数；DB 数值读出后必须经 `money()` 归一，
  否则出现 `"1"` vs `"1.00000000"` 的等值不等字符串回归。
- **余额公式唯一实现**：`packages/domain/src/provider-finance-balance-components.ts`
  （`openingBalance + corrections + recharges + reconciliations + legacyCostAdjustments + reversals − usageDebits`）。
  冲销/历史成本事件行**已带正负号**，不得在调用点再取反；禁止另写 `.plus/.minus` 链。
- 资金切换时点固定 `2026-08-31T16:00:00.000Z`（上海 9/1 0 点）。
- **静默排空门禁与四字段修复的口径（WP03 复核裁决后确立）**：`collectDrainReport` 只允许
  「候选已冻结的固定修复行主键」从 `unpairedUsageLines` 计数中豁免（`excludeLedgerLineIds`），
  `IN_PROGRESS` 请求 / 未结束 `upstream_attempt` / `PENDING` 交易**永不豁免**。豁免集必须等于候选存档的
  `usage_repair_baseline`，且排空判定必须在**候选复验之后**（否则陈旧候选可拿过期行集绕过门禁）。
  否则「切换后创建 + `settled_at IS NULL` + 确定可修复」的终态行会被当成在途结算，使 PFH-04 主路径不可达。
- 构造「未定价但不构成经营账单缺口」的用量行夹具需**零 Token**（`countFinanceGaps` 的
  `API_USAGE_COST_UNKNOWN` 只统计有 Token 的行），否则预检直接 `NO_GO`、无法隔离排空门禁本身。

## 已知系统性缺陷（P0，未修，需独立立项）

- **迁移里 `defaultTo("now()")` 落库为常量默认值**：Kysely 把 JS 字符串渲染为引号字面量 `DEFAULT 'now()'`，
  PostgreSQL 在 DDL 时求值并存成**常量**。实测 `enterprise.created_at` 的 `column_default` =
  `'<迁移执行时刻>'::timestamptz`，同库内所有行 `created_at` **完全相同**（`count(distinct created_at)=1`）。
  **共 41 列 / 16 个迁移受影响**，仓库内无一处使用 `defaultTo(sql\`now()\`)`。
  后果：所有 `ORDER BY created_at` 退化为按 id 排序。修复方向：加法迁移 `ALTER COLUMN ... SET DEFAULT now()` + 回填评估。
- **多企业夹具的登录抖动（由上一条引发）**：单企业口径 `/auth/login` 取「`created_at` 最早、同值按 `id` 排序」的第一条企业，
  `created_at` 全等时退化为按随机 UUID 排序 ⇒ 约 **50%** 概率把管理员会话落到隔离企业 → 401。
  约定收口方式（沿用既有先例 `pool027` / `system-settings-v2` / `pool043-operating-bill-accounts`）：为夹具显式锚定
  互不相同的 `created_at`（被测企业更早），**只改测试数据、不改断言语义**。
- **回滚链测试必须锚定「目标迁移」而非当时的迁移头**：`rollbackTo(db, "<target>")`。
  `packages/database/src/__tests-integration__/migration-rollback.ts` 与
  `apps/control-api/src/__tests-integration__/migration-rollback.ts` 是两份同语义副本（后者因前者位于测试目录、
  不属对外导出面而另存）。
- 既有测试债基线：database 全量集成 17 文件 / 20 用例红（多为迁移头漂移断言）；
  gateway `pool043-operating-bill-settlement` 2 用例红（零用量 `api_cost: null` vs `"0.00000000"`）。
  二者在 WP03 基线上**逐字一致**，报告既有问题时直接引用该基线结论，不必重复排查。

## 交付与协作约定

- 实现只在独立 worktree 内进行（如 `仟流智算-provider-finance-init-20260921`），主目录 `/Users/mac/Projects/仟流智算`
  视为脏工作区，不修改其既有文件。
- 每个工作包的 GO/NO-GO 报告**必须**落在隔离 worktree 内，归档为
  `V4/Evidence/<CHANGE>-<DATE>/V4-WP<NN>-<主题>-GO-NO-GO报告-<YYYYMMDD>.md`
  （沿用 `V4/Evidence/<CHANGE>-<DATE>/` 既有目录惯例；`V4/Evidence/` 顶层只放目录、不放散落文件）。
  **禁止**写入主目录 `/Users/mac/Projects/仟流智算` 根 —— 2026-09-22 曾因此被判授权边界违规、WP04 暂时 HOLD。
- 严格按授权范围执行；未获授权不得进入下一工作包。禁止：部署、生产迁移/金额录入/激活、`--no-verify`、
  修改 hook 或安全门禁、推送远端。
