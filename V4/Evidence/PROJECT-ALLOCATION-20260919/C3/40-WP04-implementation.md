# WP04/WP05 实施记录 — 候选 C3

日期：2026-09-21。范围：成员/规则/生命周期/状态 API + 面板 UI；项目账汇总/明细/未分配。

## API（apps/control-api/src/principals/project-allocation-routes.ts + operating-bills/project-allocation-routes.ts）

- 成员 GET/POST、修订 POST、核算生命周期 POST、企业级完整规则集合 GET（principals operate，P2-2 负例 403/404）、意图 preview/versions POST（P2-1 口径）。
- 日期边界语义修正（P3-1 实施发现）：`parseBoundary(value, field, exclusive)`——加入/生效（含式）按该日 00:00+08；退出/权重 until（排他式）按次日 00:00+08；生命周期 ENDED 模式在仓储内按 `effectiveAtIsDateOnly` 补 +1 天。
- 错误映射 11 §4（含 allocation_policy_conflict 附 retryPreview、weight_exceeded 冲突段、统一 not_found）；审计 action 命名按合同 §4。
- 项目账：status/runs/enablement（POST 有 billing operate）、allocation-lines（固定 run 分页）、unallocated；`GET /operating-bills/:month/projects` 原位增强（allocation/allocationStatus/unallocated 字段附加，旧字段不变，未启用不返回假 0）。
- 读模型仓储 `project-allocation-read-repository.ts`：状态（stale 由 dirty 代次推导）、项目汇总（来源拆分+目标内请求去重）、未分配汇总（含资源级余量）、明细分页。

## UI（apps/web）

- `api/project-allocation.ts` hooks（独立文件，不编辑 hooks.ts）；`pages/ProjectMembers.tsx`（成员表/加入/退出/权重意图预览-发布含 P2-1 容量展示/核算生命周期；文案含"不代表实际工作内容""不设置规则仍可正常使用 AI"）；`pages/OperatingBillProjectAllocation.tsx`（状态卡/未分配/促发/明细表/分页）。
- 列表入口：Principals 行"成员与归集"；OperatingBillProjects 追加"归集"列与详情链接；App 路由 `/principals/:projectId/project-members`、`/operating-bill/projects/:principalId/allocation`。

## 测试回执

- API 集成 11/11（receipts/wp04-api.txt）：含权限负例（viewer 403/404）、日期边界 ISO 断言（10-20 → 10-20T16:00:00Z）、OCC/超配/幂等重放、增强列表旧字段保留、GET 纯读零任务。
- web 回归 OperatingBillAccounts 11/11；build exit 0（receipts/wp04-web-build.txt）。

## 实施发现（供 R01）

- API 测试抓出三处真实缺陷并修复：`leftAt:null` 被 `new Date(null)` 变 epoch；enablement 审计 target_id 复合字符串违反 uuid 列；企业级入口缺主体校验（跨企业 200→404）。
- 意图段开放式（validUntil:null）在参与区间有界时被正确拒绝（RULE_OUTSIDE_MEMBERSHIP）——合同行为，测试段须闭合。
