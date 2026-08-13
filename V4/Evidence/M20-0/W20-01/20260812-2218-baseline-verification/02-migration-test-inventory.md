# 迁移与测试入口清单

## 迁移

- 代码迁移目录连续包含 `0000～0045` 共 46 个文件，无缺号、无重复。
- 当前代码头：`0045_zhipu_weekday_window_alias.js`。
- 清单 SHA-256：`ce6743db992c31c0ff09dbbd2931741cbcf4f891f41652c551718b3b6d1bbd1c`。
- `0045` SHA-256：`74ae28b311dfe486ea2e9bddbb7371c1f52b90099d2e07c2e29a6147eb15f1ff`。
- 若基于本锁继续开发，下一个迁移编号固定为 `0046`。
- 本轮未连接生产／客户／目标数据库。仓库 2026-08-11 生产 Evidence 记录 `0045` 已应用，但不能冒充 2026-08-12 的在线查询。

### 迁移安全现状

`db:migrate`／`db:rollback` 直接使用任意 `DATABASE_URL`，只有 `up/down`，缺少 status、dry-run、目标 host／库名 allowlist 和显式 mutation acknowledgement。八个测试 override 变量也可直连任意数据库：

```text
POOL043_CONTROL_DATABASE_URL
POOL043_GATEWAY_SETTLEMENT_DATABASE_URL
POOL043_W05_DATABASE_URL
POOL043_W07_DATABASE_URL
POOL043_MIGRATION_DATABASE_URL
POOL043_ACCOUNT_DATABASE_URL
POOL043_CONCURRENCY_DATABASE_URL
POOL046_MIGRATION_DATABASE_URL
```

本次全部显式 unset，仅使用自动创建／销毁的 PG17 Testcontainer；没有直接执行 `db:migrate` 或 `db:rollback`。

## 测试入口

静态清点共 136 个测试文件／1009 tests，其中包含 integration，并非纯单测。此前把 Gateway 的 `billing-rule-fixture.ts` 辅助文件误计为测试文件，并且 Web 配置漏收 `format.test.ts`；本候选已同时勘误。

| 入口 | 真实情况 |
| --- | --- |
| `typecheck`／`lint`／`build` | 11 个 workspace 真实执行 |
| 根 `test` | 已改为 `scripts/run-bounded-vitest.mjs`：workspace 串行、单 worker、文件不并行，并强制 unset 10 个 DB／Redis override |
| `test:integration` | Control API、Gateway、Worker、Database、Provider Adapters 真实；其他多个 workspace 为 echo 空壳或零测试 |
| `test:e2e` | 仅 Web Playwright 与 Gateway Codex CLI 为真实链；其余为 echo 空壳 |
| Web Vitest | 同时 include `*.test.ts`／`*.test.tsx`，完整收集 27 files／123 tests |
| `quality` | 不含 Playwright／Codex CLI E2E 或独立 `quality:mutation`，但包含根测试和现有 mutation-oriented coverage；canary 只覆盖内存日志，不能证明 PostgreSQL／Redis／Trace 全域 |
| `passWithNoTests` | 根 Vitest 开启，exit 0 不能单独证明有覆盖 |

有界入口已在同一候选验证：136 files／1009 tests 全通过，前后 Testcontainers 均为 0。独立历史输出见 `../20260812-2255-final-bounded-vitest/`；最终全量复跑原始输出见 `../20260812-2326-final-quality-rerun/quality.log`（SHA-256 `0a3d95d7…`）。
