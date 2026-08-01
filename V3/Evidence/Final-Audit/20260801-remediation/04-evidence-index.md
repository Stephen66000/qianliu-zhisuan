# 2026-08-01 顺序整改 Evidence Index

## 候选身份

- 基线提交：`425d16fc6de403991967fd5033922c278fb8368c`
- 候选形态：未提交工作树；未执行 commit、push、PR 或 merge。已通过校验后的增量包部署到 Mac Mini 正式环境。
- 候选对象：`01-candidate-lock.sha256` 的 58 个产品代码、测试、依赖、部署和门禁条目。
- 对象锁 SHA-256：`7f266b1928d9212d18df20f9883920f7e93d254281309f3b63dfe29752d5d348`
- 部署增量包 SHA-256：`0ee4eeb022ab5d1058da97eff41b84c21c9b879fd21e5be31750922d478fc4a5`
- 正式活跃目录：`/Users/stephen/releases/qianliu-zhisuan-v0.3.0-7f266b19-20260801/deploy`
- 生产备份目录：`/Users/stephen/backups/qianliu-zhisuan/20260801-2108-7f266b19`

## 复现命令

```bash
corepack pnpm@11.11.0 run quality
corepack pnpm@11.11.0 run quality:mutation
corepack pnpm@11.11.0 run test:e2e
```

本地实际结果：514 项单元/集成测试、Web 22/22 E2E、Gateway Codex E2E、Domain 87.55% 变异分、Worker 100% 变异分均通过。第一次 E2E 因本机 8788 已占用未进入测试，随后使用独立端口和一次性数据库复跑通过，未停止用户现有服务。

## 证据边界

- CI 工作流已配置相同门禁，但本地通过不等价于 GitHub Actions 已运行。
- 正式部署与服务/安全冒烟已通过；日志 canary 为零，但 PG/Redis/Trace 的正式环境泄漏扫描尚未执行，因此不能直接标记完整生产发布审核通过。
- 两条 UU 临时 SSH 映射在部署验证后已停用并永久删除。
- 对象锁内任一文件变化后，本 Evidence 失效，必须重新运行门禁并生成新锁。
