# WP07 实施记录 — 候选 C3

日期：2026-09-21。范围：综合回归、不变性、页面验收、性能记录。

## 1. 不变性（B01/S1–S8）

`project-allocation-invariance.integration.test.ts`（receipts 经 wp07-invariance.txt，1/1）：
配置成员/权重并完成计算前后，S1 原始表（ledger/usage/request 摘要）、S2 员工账、S3 项目账旧口径、S4 经营总览（generatedAt 归一化为读时字段）、S8 用量总览物化状态（桶+水位+脏桶）全部一致；ledger 行数不变；仅归集新表出现数据。S5/S6/S7 未单独建快照——其读取不经过本模块任何代码路径（部门聚合、财务投影、首页），S4 的 getBill 内部含部门证据聚合，作为代理覆盖；如实记录该覆盖边界。

## 2. U01 真实浏览器验收

隔离栈：专用 `qianliu_e2e` Postgres（docker，55432）+ control-api:18701 + vite:18702（代理 Origin 改写要求 WEB_ORIGIN 同时含 18701/18702——vite proxyReq 将 Origin 改写为 API 源）。链路实测：
登录 → `/principals/:id/project-members` 添加成员（E2E 固定员工，权重 60%，日期 2026-09-21）→ 表格出现"参与中 60.00%"→ 启用归集 → 执行批次 → `/operating-bill/projects/:id/allocation?month=2026-09`：状态卡"可用/计算于 13:47:25"、未分配 302 Token（权重余量）、明细表 60/40 拆分行（成员规则分摊（60.00%）与未配对行）。截图 `screenshots/u01-01-members.png`、`u01-04-allocation-detail.png`（已提交）。
另提交 Playwright spec `apps/web/e2e/project-allocation.spec.ts`；共享 webServer 命令在 worktree 下存在 tsx env-file 顺序问题（`ERR_MODULE_NOT_FOUND: watch`），故本次以手动栈验收，spec 留作 CI 修复后回归。

## 3. 全量门禁与基线对照（receipts/）

- typecheck/lint：exit 0（wp07-typecheck/lint.txt）。
- 单测/集成按包顺序执行：domain 203/203、worker 94/94 全绿；database 461 通过 6 失败、control-api 358 通过 9 失败、gateway 321 通过 2 失败。
- **基线对照（2b33719，未含 C3 的独立 worktree 实测）**：standard-home ×4、pool042 ×1、exception-center 套件级、gateway pool043-settlement ×2、pool027 套件级（登录掷硬币：同 created_at 双企业 + /auth/login 取第一企业）在基线即红——归一化失败清单 diff **IDENTICAL**（DB/GW 两组；README.md 记录命令与退出码）。w20-capacity 与 pool026 并行红、单跑通过（当前代码实测）。
- 结论：本模块**零回归**；上述红为基线既有问题，移交对应模块 Owner，不冒充通过。

## 4. 性能（合同 §C）

M1 Pro 16GB/PG17 容器；小规模金标（5 源行）端到端 <1s。100 万行/月规模目标未在本机验证——**性能证据缺口如实记录**（需独立压测环境；w20-capacity 提供的 100 万行基线框架可在后续复用）。
