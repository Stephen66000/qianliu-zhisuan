# RA-W01 测试命令与结果

运行时：Node `v22.17.1`，pnpm `11.11.0`。

| 命令 | 结果 |
| --- | --- |
| `corepack pnpm@11.11.0 -r run typecheck` | PASS |
| `corepack pnpm@11.11.0 -r run lint` | PASS |
| `corepack pnpm@11.11.0 -r run test` | PASS |
| `corepack pnpm@11.11.0 --filter @qianliu/database run test:integration` | PASS，8 files／21 tests |
| `corepack pnpm@11.11.0 --workspace-concurrency=1 -r run test:integration` | PASS：Provider 3、Database 21、Control API 70、Gateway 103 |
| `corepack pnpm@11.11.0 -r run build` | PASS，Web 1745 modules |
| 以脱敏本地 E2E 环境变量运行 `corepack pnpm@11.11.0 --filter @qianliu/web run test:e2e` | PASS，Chromium 21/21 |

迁移专项命令：

1. 在临时 PostgreSQL 17 空库运行 `corepack pnpm@11.11.0 db:migrate`：`0000～0030` 共 31 个迁移成功；
2. 运行 `corepack pnpm@11.11.0 db:rollback`：`0030` 回滚成功；
3. 再运行 `corepack pnpm@11.11.0 db:migrate`：`0030` 重升成功；
4. 回滚前后 columns／constraints／indexes 指纹一致；临时容器已删除。

过程异常：递归并发集成测试有一次在 Testcontainers 停库时产生 PostgreSQL `57P01` 未处理事件，测试断言均已通过但进程返回 1。数据库包单独复跑通过，随后降低工作区包并发完整复跑通过。另一次 E2E 已 21/21 通过，但清理脚本误用了 zsh 只读变量名 `status`，导致包装命令返回 1；改名为 `test_exit` 后完整复跑返回 0，临时容器已删除。这两项均为测试编排问题，不是业务断言失败。

所有环境值均为本地一次性测试值；本文不记录连接串、密码、Key、Cookie 或任何真实 Secret。
