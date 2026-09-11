# OpenSpec 方案包索引

本目录为【仟流智算】项目的 OpenSpec 规范驱动开发（SDD）工作区。

---

## 正在进行中的变更方案 (In-Flight Changes)

### 📁 `wecom-contact-activation`
* **目标**：企业微信通讯录候选库与 AI 员工开通解耦方案（A/B/C 三合一开通）。
* **工件文档清单**：
  1. [`proposal.md`](changes/wecom-contact-activation/proposal.md) —— 背景、动机、两层人员模型（候选池 vs 主体池）及受影响范围。
  2. [`specs/activation-scenarios.md`](changes/wecom-contact-activation/specs/activation-scenarios.md) —— 业务规格与验收场景（Given / When / Then）。
  3. [`design.md`](changes/wecom-contact-activation/design.md) —— 针对仟流智算代码库（Fastify + Kysely + React）的详细技术设计、API 契约与数据库事务。
  4. [`tasks.md`](changes/wecom-contact-activation/tasks.md) —— 可执行的打钩开发任务清单（Phase 1 至 Phase 4）。

---

## 致其他开发 AI (To AI Assistants: Claude Code / Cursor / Windsurf / etc.)

请严格按照以下步骤执行开发：
1. 先阅读 `proposal.md` 了解两层解耦设计的核心目的；
2. 阅读 `design.md` 熟悉涉及的数据库仓储、Fastify 路由与 React 组件改造方案；
3. 按照 `tasks.md` 中的步骤（Phase 1 数据库 -> Phase 2 API -> Phase 3 前端 -> Phase 4 验收）逐项实施代码并运行单元测试验证，每完成一项在 `tasks.md` 中打钩 `[x]`；
4. 任何逻辑实现必须以 `specs/activation-scenarios.md` 中定义的 Given/When/Then 验收标准为准。
