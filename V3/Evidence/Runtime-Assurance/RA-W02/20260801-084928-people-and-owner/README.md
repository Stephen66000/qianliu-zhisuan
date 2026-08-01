# RA-W02 人员与负责人 Evidence

- 时间：2026-08-01 08:49 Asia/Shanghai
- 基线：RA-W01 本地 `0030_runtime_assurance_foundation.js`；未部署 Mac Mini。
- 实现：自然人 CRUD、企微内部 `userid` 唯一绑定、人主体关联人员、项目主体关联负责人、乐观锁和人员停用前移交门禁。
- 主要文件：`packages/database/src/repositories/runtime-assurance-repository.ts`、`apps/control-api/src/runtime-assurance/routes.ts`、`apps/web/src/pages/RuntimeAssurance.tsx`。
- 验证：Control API 集成测试 77/77；Web 单测 53/53；Chromium E2E 22/22。
- 边界：新增人员与运行保障表无 `tenant_id` / `enterprise_id`；既有 `principal.enterprise_id` 不改造。
- 风险：真实试点人员 `userid` 和项目负责人名单待 Owner 在部署验收阶段录入。
- 结论：本地开发门禁 PASS。
