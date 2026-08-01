# RA-W06 冻结信号字典评审整改 Evidence

- 时间：2026-08-01 14:10 Asia/Shanghai
- 问题：Worker 企微文案表含 3 个非法死分支（`ACCOUNT_SUSPENDED` / `ACCOUNT_EXPIRED` / `AUTHENTICATION_FAILED`），并缺失合法的 `RATE_LIMIT_RETRY_AFTER`。
- 处置：移除 Worker 私有字典；在 Domain 建立与 `UnifiedAvailabilitySignal` 精确对应的 7 项共享摘要，由 Gateway 和 Worker 同时调用。`satisfies Record<UnifiedAvailabilitySignal, string>` 使后续多键、少键在类型检查阶段失败。
- 文案：`RATE_LIMIT_RETRY_AFTER` 统一为“上游明确要求稍后重试”；其余 6 项与原 Gateway 冻结文案一致。
- 依赖：Worker 增加对 `@qianliu/domain` 的显式 workspace 依赖，lockfile 同步。
- 差异处置：仅修改信号摘要的单一来源、两个消费点、定向测试和必要依赖；未改动 `mapToClassification`、`recoverDueEvents` 或其他已有修改。

## 验证结果

- 冻结字典定向测试：9 files / 135 tests PASS（新增断言：映射键精确等于冻结 7 信号，限流文案精确匹配）。
- Worker 集成：1 file / 4 tests PASS。
- Gateway 运行保障定向集成：1 file / 3 tests PASS。
- Full typecheck：PASS。
- Full lint：PASS。
- Full build：PASS（仅有已知 Web chunk size warning）。
- Full test：478 tests PASS。
- Explicit integration：211 tests PASS。
- Chromium 本地 E2E：22/22 PASS in 28.5s，使用专用本地 `_e2e` 数据库和避开已有 Docker 端口的临时本地端口。
- `git diff --check`：PASS。
- 死信号在 Worker 中的定向扫描：0 命中。

## 边界与结论

- 未访问生产数据，未部署 Mac Mini，未执行 Git 分支、提交或合并。Evidence 不含 Secret。
- P1 已闭环；运行保障本地开发完成状态保持有效。
- 真实上游、真实客户端中文展示、真实企微成员到达、Mac Mini 备份／迁移／回滚／部署与生产只读核验仍为 `PENDING_EXTERNAL`，本轮未伪报。
