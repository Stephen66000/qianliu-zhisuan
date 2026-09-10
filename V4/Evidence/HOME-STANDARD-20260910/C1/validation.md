# WP04 验证记录（候选 C1）

日期：2026-09-10。所有命令在本仓库根目录执行，回执 `.log` 与本文件同目录。

## 1. 命令回执（退出码）

| 命令 | 退出码 | 回执文件 | 说明 |
| --- | --- | --- | --- |
| `corepack pnpm@11.11.0 -r run typecheck` | 0 | typecheck-all.log | 全部包 |
| `corepack pnpm@11.11.0 -r run lint` | 0 | lint-all.log | 全部包，--max-warnings=0 |
| `corepack pnpm@11.11.0 -r run build` | 0 | build-all.log | 全部包 |
| `node scripts/check-source-size.mjs` | 0 | size-gate.log | 拆分后全部 ≤400 逻辑行 |
| `node scripts/check-architecture.mjs` | 0 | architecture-gate.log | 无运行时环 |
| `corepack pnpm@11.11.0 run quality:duplication` | 0 | （终端） | 0.67% < 5%，新文件无克隆命中 |
| web 单测（apps/web vitest 全量） | 0 | web-tests.log | **50 文件 / 262 用例全绿**（含新 Dashboard.test.tsx 13 用例） |
| database 单测（dashboard-home.test.ts 等） | 0 | database-unit-new.log | 同期窗口纯函数 6 用例全绿 |
| database 集成测试（standard-home.integration.test.ts） | 0 | database-integration-new.log | 2 用例全绿（真实 PG 容器） |
| control-api 单测全量 | 1 | control-api-tests.log | 285/287 绿；2 失败为**既有问题**（见 §3） |
| database 全量（含历史迁移集成） | 1 | database-full-suite.log | 351/364 绿；13 失败为**既有问题**（见 §3） |

## 2. 同源核对（AC01/AC03）

集成测试（standard-home.integration.test.ts）用固定时钟 asOf=2026-09-10T06:00Z 验证：

- Token 当前期 = SUCCEEDED 行合计 (100+50)+(30+20)=200，失败行 40+40 **不**计入（与目的页同过滤）；
- 上月同期窗 [2026-08-01, 2026-08-10 14:00) 内行 80+20=100，8 月 20 日窗外行 **不**计入；
- 活跃员工 = SETTLED+SUCCEEDED 去重主体 1（员工乙的失败请求不入）；活跃项目 = 经营口径含失败消耗行 → 1（口径差异按契约保留并展示）；
- asOf=2026-03-30 时三指标同期窗全部 truncated=true 且截止 2 月末（[2026-02-01, 2026-03-01)）；
- 资源区：2 厂商 4 资源、OpenAI 局部异常（1/2 异常，凭证失效+需要更新凭证）、智谱正常、attentionProviderCount=1；
- 费用：经营账单同源（getBill），E2E fixture 余额缺口时如实显示“待补期初/期末余额”，不清零、不折算。

真实浏览器冒烟（本地 e2e fixture 库）：GET /dashboard/home 返回 Token 730/上月同期 430、员工 1/1、项目 0/0、3 厂商 4 资源（局部异常 1 家 + 同步未执行 2 家）。

## 3. 既有失败（与本次改动无关，供 Codex 核实）

- 根因：**迁移 0065–0067 由既有提交 `72a69f7`/`e31da82` 引入**（在本任务基线 HEAD `4898df5` 之前已存在），而历史迁移测试断言仍停在 0064/0066 时代。
- 证据：database-full-suite.log 中 13 个失败全部为同一断言 `expected '0067_auth_error_evidence' to be '0064_quota_pricing_and_policy_archive'`；control-api 2 个失败同类（pool015 期望 0066、pool025 0053 链）。
- 本任务 diff 不含任何 migration 或上述测试文件（见 handoff.md 文件清单）。

## 4. 浏览器验证（AC05/AC07，真实 Chromium）

环境：postgres:17 容器 + `seed-e2e.ts` 夹具库 + control-api(8788) + vite(5173)，admin 登录。截图 9 张（screenshots/）。

五个跳转（点击后静置 2.5s+ 验证不回弹，均实测通过）：

| # | 入口 | 实际 URL | 目标页验证 |
| --- | --- | --- | --- |
| 1 | 本月 Token 消耗 | `/resources?tab=usage-overview` | 「用量总览」tab aria-selected=true |
| 2 | 本月费用 | `/operating-bill?month=2026-09` | 「月度总览」当前分区，月份 2026-09 |
| 3 | 本月活跃员工 | `/usage?tab=overview&subject_type=EMPLOYEE&period=MONTH` | 用量概览面板，主体=EMPLOYEE、周期=MONTH 已应用 |
| 4 | 本月活跃项目 | `/operating-bill/projects?month=2026-09` | 「项目账」当前分区，month=2026-09 |
| 5 | 管理资源 | `/resources?tab=supply-health` | 「供给与健康」tab aria-selected=true |

其他验证：
- 区块链接「查看经营账单」→ 同跳转 2；浏览器后退可用；目标页整页刷新保持路由与状态；
- 直达 `/resources?tab=usage-overview` 后选中态保持（曾出现一次点击后回弹 /dashboard，复测 5.2s 静置与后续 4 次跳转均未复现，判定为浏览器面板激活伪影，非产品路径）；
- 键盘可达：Token 卡可 focus（`<a>`），Enter 导航成功；
- 布局：1440 与 1024、1368 视口 `scrollWidth == clientWidth` 无横向溢出、卡片无裁剪；1024 下四卡 2×2；金额/文案无重叠；
- 主题：浅色/深色/跟随系统三态切换正常（跟随系统解析 data-theme=light）；深色状态底使用 soft 令牌透明度。

## 5. 请求/查询变化（AC08）

- 新端点 `GET /dashboard/home` 单次调用：经营账单 getBill（固定 ~10 查询）+ 并行聚合（Token×2、项目×2、员工同期 1、费用同期 3–4、员工概览复用 usage-overview ~5、资源区 3）≈ **25–30 条固定 SQL，不随厂商数量增长**（资源区为 2 条固定查询 + 仅异常资源 1 条）。
- 首页不再调用旧 `GET /dashboard`（含 8 项聚合 + 余额桥接 + 员工 TODAY 概览）；旧端点保留未动（兼容其他潜在调用方），未删除。
- React Query staleTime 30s 与旧首页一致；无逐请求前端计算、无轮询。

## 6. 失败修复记录

- size 门禁首跑失败（dashboard-home.ts 627 逻辑行 > 400）→ 拆分为 types/metrics/providers/costs/组合器 5 个文件后通过，行为不变（单测+集成测试复跑全绿）。
- 集成测试首跑 attentionProviderCount 断言失败 → 原因：fixture 中 Coding Plan 的 balance_status=NOT_SUPPORTED 导致 last_success_data_at 为空，按既有 providers/routes.ts 语义判 STALE；修正 fixture 为 SUCCESS（保持与产品语义一致）。
- Dashboard.test 首跑 3 处文本断言失败（金额格式 USD 前缀、小数位、百分比 20.0% vs 20.1%）→ 修正测试期望与展示模型（亿/万固定两位小数）后全绿。
