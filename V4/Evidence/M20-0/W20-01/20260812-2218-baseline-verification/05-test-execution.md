# 测试执行记录

对象起点：HEAD `6fc1bec2…`、tree `198b071b…`、dirty=false；验证对象为该起点加本轮最小测试基线 diff。所有 DB override 与 `DATABASE_URL/REDIS_URL` 保持 unset；数据库变更仅发生于自动销毁的 PG17 Testcontainers。

最终有界测试的精确命令由 `scripts/run-bounded-vitest.mjs` 固化。中间诊断、最终 `quality`、Web Playwright 与 Gateway Codex CLI 的原始 stdout／stderr、起止时间、退出码与 SHA-256 均保留，不用二次摘要替代原始 Evidence。

| 命令 | 结果 | 摘要／未覆盖 |
| --- | --- | --- |
| `corepack pnpm@11.11.0 install --frozen-lockfile` | exit 0 | 12 workspaces，785 packages；复用本机 store，argon2 install 成功 |
| `corepack pnpm@11.11.0 run typecheck` | exit 0 | 11 workspaces 全部完成 |
| `corepack pnpm@11.11.0 run lint` | exit 0 | 11 workspaces，warnings=0 |
| `corepack pnpm@11.11.0 run build` | exit 0 | 全 workspace 完成；Web 产物成功，存在既有 633.08 kB chunk warning |
| 原根 `corepack pnpm@11.11.0 run test` | **exit 1（历史诊断）** | workspace×文件并发触发 Testcontainers hook 120s 超时；不是最终门禁结果 |
| 修正后根 `corepack pnpm@11.11.0 run test` | **exit 0** | 2026-08-12 22:54～22:59；136 files／1009 tests PASS；非 Web 109／886，Web 27／123；前后 Testcontainers=0 |
| 最小特征测试 `Sidebar.test.tsx` | exit 0 | 1 file／1 test；显式锁定 1.0 十个主导航 href |
| Web typecheck／修改文件 ESLint | exit 0 | E2E 十入口清单、Vitest 收集配置和有界 runner 均通过静态检查 |
| Playwright `--list` | exit 0 | 收集 1 file／28 tests |
| Web Playwright E2E | **exit 0** | 专用 PG17 `_e2e` 库，Chromium `140.0.7339.16` rev 1187；首轮发现 `/admins` 标题匹配歧义并最小修正，全量复跑 28／28 PASS；日志 SHA-256 `a5835dcb…` |
| Gateway Codex CLI E2E | **exit 0** | 固定 `@openai/codex 0.146.0`；两次本地 Responses 流式请求、两笔合成结算成功，未调用真实模型；日志 SHA-256 `1a181766…` |
| 最终 `corepack pnpm@11.11.0 run quality` | **exit 0** | 2026-08-12 23:26～23:32；根测试 136 files／1009 tests，build、13 个 coverage ratchet scope、架构、源码大小、0.81% 重复率、依赖安全和许可证门禁全通过；日志 SHA-256 `0a3d95d7…` |
| 相关 mutation | N/A | 本轮只修改测试编排／收集／断言，未改产品确定性高风险模块；`quality` 自带的现有 mutation-oriented coverage 全通过，不扩大为全仓无关 mutation run |
| 敏感信息 canary | 日志 pass；全域 N/A | 已扫日志且 0 hits；命令明确未扫 PG／Redis／Trace。本次无生产、存储、Secret 或 Trace 实现差异，不把未扫范围冒充为通过 |

## 根测试编排收口

旧根 `test` 同时并发多个 workspace，Control API／Gateway 内又默认并行多个测试文件；每个 integration 文件通常独立启动 PG17，导致部分 `beforeAll(startPostgresContainer)` 达 120 秒超时。

本候选只做最小治理：根 `test` 委托有界 runner，Web 收集补上 `.test.ts`。第一次全量 `quality` 在 coverage ratchet 失败，原因是工程要求 `pool040-gateway` summary，但原 `quality:coverage` 从未生成它；补上该已存配置的执行入口后，针对性 11／11 和最终全量 `quality` 均通过。这是真实的门禁编排修复，不是降低阈值。

Web E2E 的专用容器和 Codex CLI 临时目录已清理，相关端口无监听；Playwright 浏览器作为锁定测试依赖保留在用户缓存。未执行迁移回滚、性能专项或 AI Eval：本轮无迁移、产品运行代码、Prompt、Agent 或工具行为变化。
