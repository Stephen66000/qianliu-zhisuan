# WP05 交接（候选 C1 · HOME-STANDARD-20260910）

日期：2026-09-10。实施：ZCode；下一步：Codex 独立审核（R01）。**本文件不构成审核通过结论。**

## 1. 候选标识与冻结

- 候选：`HOME-STANDARD-C1-20260910`
- 基线：分支 `codex/quota-pricing-review-20260905`，HEAD `4898df546fbcbc9ca292ee892cd7ae412766185a`（未提交、未推送、未合并、未部署）
- tracked 差异 patch：`candidate-tracked.patch`，SHA256 `0d1897cac230b5cb082d253ecf1dd72c2c761252b16875cbfa8e68f5aee6adc0`
- 新增（untracked）代码文件逐文件 SHA256：`candidate-new-files.sha256`
- 自本文件写入起，ZCode 不再修改该候选；后续修复将产生新候选标识（C2…），不把本候选结论套用其上。

## 2. 改动文件清单

修改（tracked，见 candidate-tracked.patch，13 文件 +529/−927）：

| 文件 | 改动 |
| --- | --- |
| `apps/web/src/pages/Dashboard.tsx` | 重写为标准版两分区（四卡 + 接入资源），五跳转 |
| `apps/web/src/pages/Dashboard.test.tsx` | 重写为 13 用例（三态/字段/五跳转/可比性/资源区） |
| `apps/web/src/api/hooks.ts` | 新增 `useStandardHome` + query key |
| `apps/web/src/api/reporting-types.ts` | 新增 StandardHome* 类型（镜像后端） |
| `apps/web/src/components/dashboard/Zone.tsx` | 新增可选 `action`（标题行右侧链接），向后兼容 |
| `apps/web/src/components/operating-bill/OperatingBillShell.tsx` | 导出既有 `sectionUrl`（一行，无行为变化） |
| `apps/control-api/src/dashboard/routes.ts` | 新增 `GET /dashboard/home`（requireAuth，组合聚合） |
| `packages/database/src/index.ts` | 导出新类型与函数 |
| 删除 5 个旧首页组件 | DashboardEmployeeUsagePanel / EarliestExhaustionCard / MetricCard / OverageList / ResourceAttentionList（仅旧首页使用，被新组件替代） |

新增（untracked，见 candidate-new-files.sha256）：

| 文件 | 内容 |
| --- | --- |
| `packages/database/src/repositories/dashboard-home-types.ts` | 契约类型 |
| `packages/database/src/repositories/dashboard-home-metrics.ts` | 同期窗口 + Token/员工/项目指标（与目的页同源 SQL） |
| `packages/database/src/repositories/dashboard-home-providers.ts` | 资源区按厂商聚合 + 状态标签/关注模板 |
| `packages/database/src/repositories/dashboard-home-costs.ts` | 上月同期费用（资金读模型/余额桥接两口径） |
| `packages/database/src/repositories/dashboard-home.ts` | 组合器 `getStandardHomeSummary` |
| `packages/database/src/repositories/dashboard-home.test.ts` | 同期窗口纯函数 6 用例 |
| `packages/database/src/__tests-integration__/standard-home.integration.test.ts` | 真实 PG 集成 2 用例 |
| `apps/web/src/components/dashboard/OverviewMetricCard.tsx` | 可点击指标卡（Token 唯一青色焦点） |
| `apps/web/src/components/dashboard/ProviderResourcesPanel.tsx` | 厂商资源表 |
| `apps/web/src/components/dashboard/standard-home-model.ts` | 纯展示格式化 + 可比性规则 |
| `文档/仟流智算各模块功能与计算口径说明.md` | AC09：新增「0 首页看板」章节（该目录整体 untracked，属既有状态） |

证据目录：`V4/Evidence/HOME-STANDARD-20260910/C1/`（baseline.md、contract.md、validation.md、11 个命令回执 .log、candidate-tracked.patch、candidate-new-files.sha256、screenshots/ 9 张）。

## 3. 完成项

- WP00—WP04 全部完成（baseline / contract / 后端聚合+路由 / 前端两分区+五跳转 / 测试+浏览器验证），详见 validation.md。
- AC01–AC09 自测情况见 validation.md §2、§4、§5；无样例常量入正式代码；无 migration；无权限/开关边界变更。
- 原型示例数字、示例厂商（Kimi/OpenAI 等）均未进入业务代码；浏览器截图中的数据来自本地 e2e 夹具库（`seed-e2e.ts`，产品既有测试设施）。

## 4. 未解决项 / 需 Codex 判断

1. **既有失败（非本候选引入）**：database 全量 13 失败、control-api 2 失败，全部为迁移版本断言（`expected '0067_auth_error_evidence' to be '0064/0066_…'`；0065–0067 来自既有提交 `72a69f7`/`e31da82`）。证据：validation.md §3。
2. **口径差异（按计划显式报告，未强行对齐）**：contract.md §5 六条 —— Token 目的页筛 SUCCEEDED 不筛结算 vs 经营费用不筛状态；员工卡（用量概览口径）vs 旧首页 activeEmployeeCount（筛主体 ACTIVE）；项目卡数 vs 项目账分页 total（含未归属行）；Token/费用/项目=北京时间 vs 员工=企业时区。
3. **状态标签映射复制**：`dashboard-home-providers.ts` 内嵌 health-routes.ts 的 STATUS_LABEL 镜像（packages/domain 按基线声明未触碰）；若 Codex 认为应上移共享包，请在 review 中给出结论。
4. **旧端点 `GET /dashboard` 保留未删**（避免破坏未知调用方）；若确认无其他消费方，可在下一候选清理。
5. **一次浏览器回弹伪影**（点击 Token 卡后约 3 秒回 /dashboard，复测 5 次未复现；直达/刷新/后退均稳定）——原因未定位，怀疑 IAB 面板激活伪影；如 Codex 复现请提出。
6. `文档/` 目录整体 untracked 属既有工作区状态；模块说明更新包含在候选内但不在 tracked patch 中（见 §2 说明）。

## 5. 本地复现方式

```bash
# 数据库夹具 + 双服务（与 WP04 浏览器验证相同）
docker run -d --name home-standard-pg -e POSTGRES_DB=qianliu_e2e -e POSTGRES_USER=qianliu \
  -e POSTGRES_PASSWORD=qianliu_dev_only -p 127.0.0.1:5433:5432 postgres:17-alpine
cd apps/control-api && DATABASE_URL='postgres://qianliu:qianliu_dev_only@127.0.0.1:5433/qianliu_e2e' \
  corepack pnpm@11.11.0 exec tsx src/cli/seed-e2e.ts
# control-api：需 COOKIE_SECRET、GATEWAY_KEY_PEPPER、SESSION_AFFINITY_HMAC_KEY（≥16 字符）、
# CREDENTIAL_KEK（base64 32 字节）、DATABASE_URL 同上、CONTROL_API_PORT=8788、WEB_ORIGIN=http://127.0.0.1:5173
# web：apps/web 下 vite --port 5173；登录 admin / admin123 → /dashboard
```

门禁复跑（回执在证据目录）：`pnpm -r typecheck / lint / build`、`node scripts/check-source-size.mjs`、`node scripts/check-architecture.mjs`、apps/web vitest、packages/database `src/repositories/dashboard-home.test.ts` 与 `src/__tests-integration__/standard-home.integration.test.ts`。

## 6. 已知风险

- `/dashboard/home` 单次约 25–30 条固定 SQL（含 getBill 全量草稿构建）；无厂商数量放大，但比旧 `/dashboard`（约 10 条）重。已记录于 validation.md §5，如 Codex 认为超预算可加缓存或瘦身 getBill 路径。
- 费用同期在资金读模型口径下用 UNKNOWN_COST 计数近似完整性标记（完整 gap 机制在 loadMonthlyFinanceSummary，未逐条镜像）；已知部分如实保留并显示原因。
- 深色/浅色验证基于组件令牌与实测截图；未做 WCAG 定量抽查（规范 §12 的对比度由令牌体系保证，未逐一测量）。
