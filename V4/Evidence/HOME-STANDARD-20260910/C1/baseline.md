# WP00 实施基线（候选 C1）

记录时间：2026-09-10（ZCode 实施开始前）

## 1. 真实工作区状态

- 工作区：`/Users/mac/Projects/仟流智算`
- 分支：`codex/quota-pricing-review-20260905`
- HEAD：`4898df546fbcbc9ca292ee892cd7ae412766185a`（`feat(resources): display official DeepSeek model versions without changing routing`）
- 与计划记录的差异：计划只读观察时 HEAD 为 `72a69f7`；当前 HEAD 在其之上多了 1 个提交 `4898df5`（DeepSeek 模型版本展示，不涉及首页/账单聚合路径）。该提交已包含在本次基线中。
- 未提交 tracked 改动：仅 `V4/仟流智算-2.0-问题蓄水池.md`（其他任务文档，**本任务不触碰**）。
- 未提交 untracked：`V4/Evidence/**`（历史任务证据）、`V4/*.md` 计划与方案文档、`原型/**`、`文档/**`。`apps/`、`packages/`、`scripts/` 下**无未提交代码改动**。
- 结论：代码区干净，直接在当前工作区实施即可包含用户已验收的最新功能与本计划、原型；不再新建分支或工作副本（避免丢失未提交的计划/原型输入）。全程不执行 git commit / push / merge。

## 2. 输入摘要与哈希

| 输入 | 路径 | SHA256 |
| --- | --- | --- |
| 最终原型 HTML | `原型/首页标准版/首页原型.html` | `bd348d82f586809960e0487aaa4aaae9772de406b8e78a9dcda55da38e3a437e` |
| 模块口径说明（仓库） | `文档/仟流智算各模块功能与计算口径说明.md` | `b551088b06c75bd866bfa432e7f1f59ea93b4d28971738b16eeac6b418b9c215` |
| 模块口径说明（桌面） | `/Users/mac/Desktop/仟流智算各模块功能与计算口径说明.md` | `b551088b06c75bd866bfa432e7f1f59ea93b4d28971738b16eeac6b418b9c215` |

- 仓库版与桌面版口径说明 **SHA256 完全一致**，无版本差异，以该版本为准。
- 设计规范：`/Users/mac/Documents/AI专区/仟流 规范与体系/视觉规范/仟流 Web 产品视觉规范 1.0.md`（已通读；现有 `apps/web/src/styles/tokens.css` 已实现同一套语义令牌）。
- 原型 PNG 仅视觉参考；点击目标一律以计划第 3 节为准。原型中的数字、厂商、状态均为示例，**不进入正式代码**。

## 3. 本任务允许修改/新增的文件（归属声明）

允许修改（首页路径独占，无其他任务共享）：

- `apps/web/src/pages/Dashboard.tsx`、`apps/web/src/pages/Dashboard.test.tsx`
- `apps/web/src/components/dashboard/**`（新增标准版首页组件；`Zone.tsx`、`MetricCard.tsx` 等如需小改）
- `apps/web/src/api/`（新增/调整首页相关客户端 hook 与类型：`hooks.ts`、`reporting-types.ts`/`types.ts`）
- `apps/control-api/src/dashboard/routes.ts`（新增只读聚合端点）
- `packages/database/src/repositories/dashboard-*`（新增标准版首页聚合与同期查询）
- `packages/database/src/repositories/usage-overview-repository.ts`（如需为同期对比增加显式区间方法；不改既有 `getOverview` 行为）
- `packages/database/src/index.ts`（导出新类型）
- `文档/仟流智算各模块功能与计算口径说明.md`（AC09：补首页章节）
- `V4/Evidence/HOME-STANDARD-20260910/C1/**`（本任务证据）

不触碰：`V4/仟流智算-2.0-问题蓄水池.md`、其他 `V4/Evidence/**`、`apps/gateway`、`apps/worker`、`packages/domain`（只读引用）、既有经营账单/用量仓储的现有函数行为（只新增或以参数复用）。

## 4. 适用项目规则与门禁

- 工程规范：`/Users/mac/Projects/仟流AI开发SOP/双审核参考-v1.4/AI编码工程规范-通用版-v1.4.md`（Codex 审核参照；ZCode 侧执行现有适用门禁）。
- 风险分级：中（页面重写 + 新增只读聚合；无 migration、无权限模型变更、无算法重写）。
- 必跑门禁：`pnpm -r typecheck`、`pnpm -r lint`、相关 vitest（web Dashboard 测试 + database 新聚合测试 + control-api 路由测试）；按变更风险执行架构/重复度抽查。不重开全项目历史审计。
- 明确禁止：样例常量入正式代码、伪造资源锚点 URL、前端复制计价/分摊/健康判定算法、提交/推送/合并/部署、数据库迁移（本任务无需）。

## 5. 已知并行工作

- 工作树内除上述文档外无其他未提交代码改动；`V4/Evidence/RUNTIME-ADMIN-20260907/**` 等为历史任务证据目录（只读）。
- 若实施期间出现新的共享文件冲突（如 `packages/database/src/index.ts` 同时被他人修改），先报告冲突再继续不冲突部分。
