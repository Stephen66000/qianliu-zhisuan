# C2 验证记录（R01 F01—F05 修复）

日期：2026-09-10。基线不变：`4898df5`，分支 `codex/quota-pricing-review-20260905`，仅本地未提交改动。
C1 与 R01 证据原样保留于 `../C1/`、`../R01/`。

## 1. Findings 修复对照

| Finding | 修复 | 回归证据 |
| --- | --- | --- |
| F01 费用缺口隐藏+仍比较 | 前端：任一期 `incompleteReason` 非空 → 不输出百分比，delta 显示“金额存在缺口，不计算百分比”，卡片明示“金额不完整：{缺口中文说明}，已展示已知部分”，已知金额保留；后端：缺口规则抽取为区间化 `countFinanceGaps`（provider-finance-gaps.ts），月度汇总与首页同期窗口共用同一权威 SQL（含 API_COST_CURRENCY_MISSING/CONFLICT、OPENING_BALANCE_MISSING、SUBSCRIPTION_PERIOD_MISSING、CASH_PAID_CNY_MISSING，不再只查 UNKNOWN_COST） | web 测试 2 项（本期缺口/同期缺口）；集成测试“R01-F01 资金读模型同期窗口复用权威缺口规则”；真实 DARK 模式端到端响应含双侧缺口码 |
| F02 同期 Token 质量丢失 | 契约 previous 增加 `usageQuality`/`unknownCount`；前端 `tokenPeriodComparable` 要求**双期**完整（非 UNKNOWN 且 unknownCount=0）才允许百分比，同期不完整在脚注注明“上月同期含未知/估算用量” | web 测试 2 项（本期 unknownCount=1 且 EXACT / 同期 UNKNOWN）；集成测试“R01-F02 同期质量进入契约”（seed UNKNOWN 行 → previous.usageQuality=UNKNOWN） |
| F03 新鲜同步掩盖同厂商过期/缺失 | 逐资源判定 NOT_RUN/STALE/FAILED/OK 后聚合；任一资源失败/缺失/过期即暴露，关注信息给出范围（“其中 N 项资源…”），FAILED 附错误码；不再用最大时间判全体 | 集成测试“R01-F03 混合新鲜度/缺失/失败”（1 新鲜 + 1 过期 + 1 未同步 + 失败带码）；真实环境响应可见范围文案 |
| F04 多币种越界 | 卡片主币种大字 + 其余币种独立行（16px），主数值按长度自适应字号（≤9/≤13/其余三档）；容器不再整行 nowrap | web 测试（分行断言 + 大金额 text-[18px] 档位断言）；浏览器 1440：主 144px + 附 226px 均在 260px 卡内、无页面溢出；1024 深浅色同样通过 |
| F05 深色 soft 底缺透明度 | tokens.css 新增主题感知状态类 `ql-status-{success,warning,danger,neutral}`（深色按规范 §3.3 用原色 16% 透明度）；资源区状态标签与“N 家需关注”改用该类 | 浏览器实测深色：背景 `rgba(217,119,87,0.16)`、前景 `rgb(240,160,126)`；浅深截图各 2 张 |

R01 审计探针（3 项）已纳入正式回归并以更强断言通过（不比较 + 缺口可见 + 金额保留）。

## 2. 审核证据边界项核对

- **权限/开关**：新增路由级集成测试（401 未登录；跨企业厂商不可见，providerCount=0）。开关核对：`FEATURE_USAGE_OVERVIEW_V2` 关闭时 `/usage?tab=overview` 会落请求明细（Usage.tsx:74），首页员工卡降级链接 `/usage`（web 测试覆盖），未开启任何全局开关。
- **性能记录**（e2e 夹具库，pg `log_statement=all` + fastify 计时）：单次 `GET /dashboard/home` = **28 条 SQL**（不含会话校验），冷调用 145ms / 稳态 32–63ms / 首次编译后 60–107ms；无厂商数量放大。getBill 整份草稿为费用口径权威来源（summary 依赖其中多数查询），保留复用并在 handoff 说明；员工概览走 metrics 路径未拉趋势排名的前端渲染（后端 getOverview 一次聚合）。
- **金融同期缺口**：见 F01 行；DARK 端到端实测：current=[CNY 12800, USD 5000] + `API_OPENING_BALANCE_MISSING×2`，previous basis=FINANCE_READ_MODEL + `API_USAGE_COST_UNKNOWN:2、API_COST_CURRENCY_MISSING:2`。
- **术语文案**（非阻断建议）：费用卡“同期按资金账本口径聚合/余额桥接口径聚合”保留在 hint 行（12px 辅助位），主视觉无工程术语；“排他边界”仅出现在截断脚注。如 Codex 认为需进一步弱化，列入下轮。

## 3. 命令回执（.log 同目录）

| 命令 | 退出码 |
| --- | --- |
| `pnpm -r typecheck` / `pnpm -r lint` / `pnpm -r build` | 0 / 0 / 0 |
| `node scripts/check-source-size.mjs` / `check-architecture.mjs` | 0 / 0 |
| web 全量 vitest | 0（51 文件 / 264 用例，含 Dashboard 20） |
| database 新增测试（单测 6 + 集成 6） | 0 |
| control-api 新增（路由权限 2）+ release 契约 | 0 |
| control-api provider-finance 集成（抽取回归） | 0（9/9） |
| `quality:duplication` | 0（新文件无克隆命中） |

既有失败状态与 C1 相同（迁移 0065–0067 断言，非本任务引入，见 C1/validation.md §3；本轮未重跑全量套件，新增与受影响测试均单独复跑通过）。

## 4. 修复过程记录

- 门禁首跑两处失败：DashboardPage 复杂度 37>30（文案计算内联）→ 抽取 `buildOverviewCards` 到展示模型；provider-finance-repository.ts 408 行（gap 抽取后超标）→ 独立 `provider-finance-gaps.ts` 模块。复跑通过。
- 集成夹具三次失败修正：金融事件须 ≥ 切换时点（改 MIGRATION 来源）、事件与订阅周期受 DEFERRABLE 闭合触发器须同事务、周期边界须北京零点且带 finance_event_id 的周期 source 须 PURCHASE/RENEWAL。
- 本地验证期间发现旧 control-api 进程占用 8788 导致 DARK 未生效（EADDRINUSE 被旧进程遮蔽），清理僵尸进程后复测；属环境问题，非代码问题。

## 5. 浏览器复测（截图 4 张，screenshots/）

- 浅色 1440：多币种分行（¥12,800.00 + USD 5,000.00）、缺口文案、无溢出；
- 深色 1440：状态标签 16% 透明度底（rgba 实测）、关注数量标签同修复；
- 1024 深色 + 浅色：无溢出、无越界（scrollWidth==clientWidth、卡片内元素不越卡）；
- Token 卡跳转 /resources?tab=usage-overview + 后退返回 /dashboard 复验通过。
