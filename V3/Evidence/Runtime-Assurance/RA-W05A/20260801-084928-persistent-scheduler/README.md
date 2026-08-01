# RA-W05A 持续调度器 Evidence

- 时间：2026-08-01 08:49 Asia/Shanghai
- 实现：`runtime-assurance-once`、`runtime-assurance-scheduler`、SIGTERM/SIGINT 优雅停止、PostgreSQL advisory lock 单调度责任方、`FOR UPDATE SKIP LOCKED` Outbox 领取、超时 claim 恢复、`/health` 健康检查。
- 部署合同：Worker 镜像默认启动常驻调度命令；Compose 定义 30s 周期和容器内健康检查。本轮未执行部署。
- 主要文件：`apps/worker/src/runtime-assurance/scheduler.ts`、`runner.ts`、`apps/worker/src/main.ts`、`apps/worker/Dockerfile`、`deploy/compose.yaml`。
- 验证：Worker 集成 4/4，包含两实例互斥锁验证；全量 typecheck/lint/build PASS。
- 结论：本地开发门禁 PASS；生产调度责任方实际运行状态 PENDING_DEPLOYMENT。
