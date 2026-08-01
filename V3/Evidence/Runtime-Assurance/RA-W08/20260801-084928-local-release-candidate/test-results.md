# 测试结果摘要

2026-08-01 在 `/Users/mac/Projects/仟流智算` 执行。最终门禁通过系统 Corepack 统一使用项目锁定的 Node 22.17.1；编译、测试与 E2E 全部通过，无 engine warning。Playwright 启动命令也显式改为 `corepack pnpm`，避免子进程落到非冻结运行时。

- Full typecheck: PASS
- Full lint: PASS
- Full unit/integration test command: PASS
- Explicit integration command: PASS
- Worker integration: 4/4 PASS（含并发事件去重、人主体、项目负责人、缺失 userid、触发／恢复和限频退避）
- Worker 锁互斥测试改用“首个任务已进入锁区”握手，移除依赖 50ms 睡眠的调度竞态；连续独立执行两次及全量 integration 均 PASS。
- Full build: PASS
- Chromium local E2E: 22/22 PASS in 28.6s
- RA Gateway targeted evidence: 3/3 PASS
- Secret/token canary scan of captured logs: 0 matches
