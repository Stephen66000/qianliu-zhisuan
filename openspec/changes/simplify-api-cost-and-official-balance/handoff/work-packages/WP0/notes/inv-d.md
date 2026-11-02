# Inv-D 调查笔记：迁移清单、测试基建、CI、环境（只读）

日期：2026-11-02；基线：origin/main `ae506fed47d21865420afa91137e8b244072933e`。

## 1. 迁移水位

- `packages/database/migrations/` 共 93 个（0000-0092），origin/main 与工作树一致（`git ls-tree origin/main` 核对）。
- **0092_employee_monthly_quota.js 已被员工月度额度占用**（PR #7 合并；生产未执行该迁移——用户声明）。本 change 新迁移从 **0093** 起，逐号盘点后选用。
- 本 change 相关既有迁移：0026（operating snapshot 表）、0061（strict_writes_enabled＋守卫）、0081/0082/0083（资金激活/候选草稿/事件合同触发器）、0084/0085（历史用量/未迁移标记）、0086（费用处置）、0091（recorded cost 记账政策）、0087（套餐额度阻断状态）。

## 2. 测试脚本真实 vs 占位（以 origin/main 的 package.json 为准）

| 包 | 脚本 | 状态 |
|---|---|---|
| control-api | test / test:integration | 真实（vitest，集成目录） |
| control-api | **test:e2e | `echo 'control-api e2e deferred to M1' && exit 0` —— 占位，不作验收证据** |
| worker | test / test:integration | 真实 |
| worker | **test:e2e | `echo 'worker e2e deferred' && exit 0` —— 占位** |
| web | test | 真实（vitest） |
| web | **test:integration | `echo 'web integration deferred' && exit 0` —— 占位** |
| web | test:e2e | 真实（Playwright；globalSetup 会迁移/清库/播种，必须专用 `_e2e` 库） |
| database | test:integration | 真实（容器化 PostgreSQL 夹具） |
| gateway | test:integration | 真实 |
| 根 | test | `node scripts/run-bounded-vitest.mjs` |
| 根 | vitest.config.ts:17 | **`passWithNoTests: true`** —— 0 tests 退出码为成功，验收必须核对非零用例数 |

包管理：`corepack pnpm@11.11.0`；CI 使用 `--frozen-lockfile`。

## 3. CI（origin/main:.github/workflows/ci.yml）

job 步骤：checkout → pnpm setup → `corepack pnpm@11.11.0 install --frozen-lockfile`（:44）→ 安装 codex CLI（:45）→ playwright chromium（:46）→ `run quality`（:47）→ `run quality:mutation`（:48）→ `run test:e2e`（:49）。
- `quality` 串联 coverage 池（domain/changed/pool029/pool030/pool040/pool043）＋ `quality:coverage:ratchet`（棘轮，不擅自降阈值）。
- `quality:mutation` 至少含 pool039（database＋gateway stryker）。
- GitHub combined status/workflow_runs 查询曾返回空（baseline-update §1）——**不能写"CI 已通过"**；本 change 改动包的 CI 结果由 WP5/WP6 在实际候选上取得。

## 4. 环境

- 隔离测试：Docker PostgreSQL 容器夹具（database 集成）；Web E2E 专用 `_e2e` 库；模拟上游注入（既有集成测试模式）。
- 生产：**未核实**——本会话无服务器/数据库只读权限。最近已知统一基线 7a3204f（2026-10-02，历史记忆，仅作参考非当前事实）；用户声明 PR #7 未部署、0092 未在生产执行。生产核实所需：服务器只读访问（镜像 tag/容器版本）、迁移水位查询（如 knex_migrations 表）、`PROVIDER_FINANCE_MODE` 与 strict_writes_enabled 实际取值。WP6 前完成，无法核实则明确记录。
- 仓库无 AGENTS.md（根目录与 apps/packages 均无）。
- `.zcode/` 已被 .gitignore（:52）忽略；`.zcode/agents/glm-flash.md` 为本包新增执行基建（模型绑定 GLM-5.3-Flash），不入库。

## 5. 命令入口（已在 origin/main 核实脚本存在）

开发计划 §6 列出的 `corepack pnpm@11.11.0 --filter <pkg> run test[:integration]`、`openspec validate simplify-api-cost-and-official-balance --strict --no-interactive` 入口与实际 scripts 对齐（占位三项除外，见 §2）。
