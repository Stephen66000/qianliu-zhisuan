# C2 交接（HOME-STANDARD-20260910 · R01 修复候选）

日期：2026-09-10。实施：ZCode；状态：**待 Codex 复核（R02）**。本文件不构成审核通过结论。
C1（`../C1/`）与 R01（`../R01/`）证据原样保留，未覆盖。

## 1. 候选标识与冻结

- 候选：`HOME-STANDARD-C2-20260910`（基于 R01 FAIL 修复；C1 patch `0d1897ca…` → C2 patch 如下）
- 基线：分支 `codex/quota-pricing-review-20260905`，HEAD `4898df546fbcbc9ca292ee892cd7ae412766185a`（未提交、未推送、未合并、未部署）
- tracked 差异：`candidate-tracked.patch`，SHA256 `c1f9bd3ad326f909a05e31fa87a465d1ac9d6cae0d7ee800da199d02a523b5a2`（15 文件，+663/−980）
- 新增文件逐文件 SHA256：`candidate-new-files.sha256`（13 项）
- 自本文件写入起不再修改本候选；后续修复产生 C3。

## 2. 相对 C1 的差异（R01 F01—F05 修复）

修改（tracked）：

| 文件 | C2 变化 |
| --- | --- |
| `packages/database/src/repositories/provider-finance-repository.ts` | 权威缺口 SQL 抽出为区间化共享函数（行为不变，provider-finance 集成 9/9 复验） |
| `apps/web/src/styles/tokens.css` | 新增 `ql-status-*` 主题感知状态类（深色 16% 透明度） |
| `apps/web/src/pages/Dashboard.tsx` | 卡片文案/可比性改由 `buildOverviewCards` 模型构建；员工卡按开关降级 `/usage`；复杂度回落门禁内 |
| `apps/web/src/pages/Dashboard.test.tsx` | 13 → 20 用例（R01 探针强化版 + 开关降级 + 大金额档位 + 同步范围） |
| `apps/web/src/api/reporting-types.ts` | token previous 契约补充 usageQuality/unknownCount |
| `apps/control-api/src/dashboard/routes.ts`、`apps/web/src/api/hooks.ts`、`Zone.tsx`、`OperatingBillShell.tsx`、`packages/database/src/index.ts` | 与 C1 相同（无新变化） |

新增（相对 C1 多出/变化）：

| 文件 | 说明 |
| --- | --- |
| `packages/database/src/repositories/provider-finance-gaps.ts` | **新**：区间化权威缺口计数（月度汇总与首页同期共用） |
| `apps/control-api/src/__tests-integration__/standard-home-route.integration.test.ts` | **新**：401 + 跨租户隔离 |
| `dashboard-home-*.ts`、`standard-home.integration.test.ts`、`dashboard-home.test.ts`、web 组件三件 | 同 C1 位置，内容更新（F02 契约、F03 逐资源聚合、F04 分行、回归扩展） |

不再触碰 C1 范围外文件；`文档/…口径说明.md` 与 C1 相同（hash 一致 `54efea87…`，本轮无口径变更）。

## 3. 完成项

- F01—F05 全部修复并各配回归（对照表见 validation.md §1）；R01 三项审计探针以更强断言纳入正式套件并通过。
- 审核证据边界项：权限 401/跨租户、开关降级、金融同期缺口、性能记录（28 SQL/次、稳态 32–63ms）均已补齐（validation.md §2）。
- 全部门禁绿：typecheck/lint/build/size/architecture/duplication、web 全量 264 用例、新增 database 12 + control-api 2 + provider-finance 9。

## 4. 未解决项 / 供 Codex 复核判断

1. **性能口径**：28 条 SQL 中约 10 条来自 getBill 整份草稿构建（费用口径权威来源，summary 依赖其多数查询）；本轮未做缓存或瘦身（避免复制口径风险）。数据量为夹具级（数行账本）；生产量级耗时未测。如需上限，可评估 getBill 请求级缓存或 summary 专用路径（需另行口径一致性论证）。
2. **术语文案**（R01 非阻断建议）：口径说明保留在 hint 行，未改主视觉；如需进一步去工程化请给出期望文案。
3. **StatusTag 共享组件**（dashboard/StatusTag.tsx）同样使用 `bg-ql-*-soft`（深色同样缺透明度）——属 C1 之前既有问题且被多页面使用，本轮只修了首页自有标签（新增 ql-status-* 类未动共享组件）；如需统一迁移建议另立小任务。
4. 既有迁移断言失败（C1/validation.md §3）本轮未处理、未复跑全量；与本候选无关的结论维持“实施者报告”。
5. e2e 夹具厂商均无同步记录时，正常厂商会显示“尚未执行经营数据同步”关注信息——与 `providers/routes.ts` 的 SYNC_NOT_RUN→STALE 语义一致（有事实依据），但视觉上“需关注”计数变多；如 Codex 认为未配置同步不应计入“需关注”pill，请明确判定。

## 5. 本地复现

与 C1 handoff §5 相同（postgres 容器 + seed-e2e + 双服务 + admin/admin123）。
多币种/缺口场景：以 `PROVIDER_FINANCE_MODE=DARK` 启动 control-api，并按 `C2/validation.md` §2 的夹具（两资源各写一条 PRICED_USAGE：CNY 12800 / USD 5000）复现 F01/F04 页面效果。
注意清理 8788 端口旧进程（本轮曾因旧进程遮蔽导致模式未生效）。

## 6. 已知风险

- 缺口中文映射 `costGapLabel` 为展示层映射（权威语义在 countFinanceGaps 码表）；新增缺口码若未同步映射会显示原始码（可读但可改进）。
- 大金额自适应按字符长度三档（≤9/≤13/其余），极端宽度（如 20+ 字符多币种主值）未实测超过 22px 档；1024/1440 已验证边界。
- 深色 neutral 状态类用 surface-muted/0.6，浅色为实色；对比度未做定量 WCAG 抽查（令牌体系保证，规范 §12 未逐点测量）。
