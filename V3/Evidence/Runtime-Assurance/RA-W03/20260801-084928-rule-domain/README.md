# RA-W03 规则领域模型 Evidence

- 时间：2026-08-01 08:49 Asia/Shanghai
- 实现：`UPSTREAM_SIGNAL`、`SCHEDULE_BLOCK`、`OBSERVATION_ALERT` 三类规则；稳定身份＋不可变版本；草稿、发布、编辑派生新版、停用、历史和回滚。
- 确定性：作用域特异度、`BLOCK` 优先、priority、版本的稳定排序；支持规则时区、跨夜时间窗和冲突拒绝。
- 主要文件：`packages/domain/src/runtime-assurance.ts`、`packages/domain/src/__tests__/runtime-assurance.test.ts`、`packages/database/src/repositories/runtime-assurance-repository.ts`。
- 验证：Domain 134/134（其中运行保障 8 个定向用例）；Control API 集成 77/77；Web 规则交互单测通过。
- 迁移：仍使用 RA-W01 已验证的 `0030`，本工作包无额外 Schema 变更。
- 结论：本地开发门禁 PASS。
