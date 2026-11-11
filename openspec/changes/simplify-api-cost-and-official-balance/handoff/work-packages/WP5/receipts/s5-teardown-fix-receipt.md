# S5 teardown 修复回执（control-api 集成测试退出码缺陷关闭）

日期：2026-11-04
worktree：`/Users/mac/Projects/仟流智算-api-decouple`（HEAD `d6550c9` ＋ 既有未提交改动，未回退任何内容）
执行者：WP5 子 Agent（GLM-5.3-Flash）

## 1. 改动文件清单（每处均为 afterAll 内 `db.destroy()` 之后、`pg.stop()` 之前插入 3 行：2 行注释 ＋ 200ms 排空等待，未改任何断言/业务逻辑）

| 文件 | 插入位置 | diff 摘要 |
|---|---|---|
| `apps/control-api/src/__tests-integration__/dashboard-finance-estimation.test.ts` | L27 afterAll | 单行 `afterAll(async () => { await db?.destroy(); await pg?.stop(); }, 60_000)` 展开为多行，destroy 与 stop 之间插入注释 ＋ `await new Promise((resolve) => setTimeout(resolve, 200));` |
| `apps/control-api/src/__tests-integration__/pool025-operating-bill.test.ts` | L146-147 | `if (db) await db.destroy();` 与 `if (pg) await pg.stop();` 之间插入同样 3 行 |
| `apps/control-api/src/__tests-integration__/provider-finance-wp07-acceptance.http.test.ts` | L144 afterAll | 单行 afterAll（含 `app?.close()`）展开为多行，destroy 与 stop 之间插入同样 3 行 |
| `apps/control-api/src/__tests-integration__/w04-provider-route.test.ts` | L62-63 | if 守卫两行之间插入同样 3 行 |
| `apps/control-api/src/__tests-integration__/w18-dashboard-usage.test.ts` | L58-59 | if 守卫两行之间插入同样 3 行 |
| `apps/control-api/src/__tests-integration__/w20-department-costs.test.ts` | L242-243 | `await db?.destroy();` 与 `await pg?.stop();` 之间插入同样 3 行 |

插入的注释（照抄合同指定文案，写法对齐先例 `packages/database/src/__tests-integration__/wp5-upgrade-immutability.integration.test.ts:396-400`）：

```ts
// teardown 加固（仅测试文件内，不涉断言）：pool.end() 的 socket 关闭是异步的，
// destroy() resolve 后 OS 层 socket 可能尚未排空；容器 stop 触发 57P01 未捕获异常导致 vitest 退出码 1。
await new Promise((resolve) => setTimeout(resolve, 200));
```

6 个文件 afterAll 结构均为标准模式（destroy → stop 相邻），无需偏离合同的最小语义处理。

## 2. 实际执行的命令

```bash
cd /Users/mac/Projects/仟流智算-api-decouple
export DOCKER_HOST=unix:///Users/mac/.colima/default/docker.sock TESTCONTAINERS_RYUK_DISABLED=true
corepack pnpm@11.11.0 --filter @qianliu/control-api run test:integration; echo "EXIT=$?"
corepack pnpm@11.11.0 --filter @qianliu/control-api run typecheck
```

## 3. 验证结果

- 集成测试：**Test Files 43 passed (43)，Tests 361 passed (361)，EXIT=0**（修复前：361/361 全过但退出码 1，15 个 teardown 期 57P01 未捕获异常）。时长 199.22s。
- 全量日志（`/tmp/wp5-integration-run.log`）中 `57P01`/`unhandled`/`Errors` 命中 **0 次**；无需升级到 500ms，200ms 一次即通过。
- typecheck：`tsc -p tsconfig.json --noEmit`，**EXIT=0**。

## 4. 边界说明（未回退、未越界）

- `w20-department-costs.test.ts` 工作区另有约 100 行**任务开始前已存在**的未提交改动（API_RECHARGE 退役迁移：正路径迁移为 PACKAGE_PURCHASE＋CP 资源、新增 AT-AFR-02 参数化负向用例），`w20-diagnostics-alerts.test.ts` 亦有既有改动——均为前序 WP 的未提交成果，本任务未触碰、未回退；本任务在该文件的实际净增量仅 afterAll 3 行。
- 未修改任何业务代码、迁移、配置或其他测试文件；未进主仓 `/Users/mac/Projects/仟流智算`。

## 5. 未解决问题 / 备注

- 竞态具随机性：本次 200ms 一次通过，不能排除极端调度下仍偶发 57P01 的可能（未做多轮复跑，合同仅在失败时允许升到 500ms）。若 CI 再现，处置方案已在注释中写明，可直接将 200 升至 500。
- 环境警告（既有，非本改动引入）：pnpm 报 unsupported engine（wanted node >=22.23.4，current v22.17.1），不影响测试与 typecheck 结果。
