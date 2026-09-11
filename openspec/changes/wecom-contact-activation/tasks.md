# Implementation Tasks: 企业微信通讯录候选库与 AI 员工开通

本清单供工程师或 AI 编码助手分步执行与打钩验收。

---

## Phase 1: 数据库与仓储层重构 (`packages/database`)

- [x] **1.1 改造导入人员事务逻辑**
  - 文件：`packages/database/src/repositories/directory-import-apply.ts`
  - 任务：
    - 移除导入时无条件执行 `insertInto("principal")` 的逻辑，使 Excel 导入与 API 同步默认只创建 `Person` 自然人候选档案及外部身份。
    - 编写并导出 `activateEmployeePrincipal(trx, enterpriseId, personId, now)` 独立开通事务方法。
    - 确保新主体的 `person_id` 字段正确写入，并调用 `applyPublishedEmployeeRules` 为新主体分配通用额度与规则。

- [x] **1.2 扩展 DirectoryRepository 批量开通能力**
  - 文件：`packages/database/src/repositories/directory-repository.ts`
  - 任务：
    - 实现 `activateMembers(enterpriseId, personIds)` 事务方法，支持批量锁定并开通人员。
    - 实现 `activateMembersByIdentifiers(enterpriseId, identifiers)` 方法，根据姓名/工号/企微账号进行模糊或精准检索并批量开通。

- [x] **1.3 扩展 PrincipalRepository 创建参数**
  - 文件：`packages/database/src/repositories/principal-repository.ts`
  - 任务：
    - 在 `CreatePrincipalInput` 中增加 `person_id?: string | null` 字段。
    - 在 `create` 方法中将 `person_id` 写入 `principal` 数据表。

- [x] **1.4 单元与集成测试验证**
  - 文件：`packages/database/src/__tests-integration__/directory-repository.integration.test.ts`
  - 任务：
    - 编写测试验证：导入包含 10 人测试通讯录，断言创建 10 条 `Person` 记录，但 `principal` 表中新增为 0。
    - 编写测试验证：调用 `activateMembers` 传入其中 3 人的 `person_id`，断言生成 3 个有效的主体，且 `person_id` 严格对应。
    - 编写测试验证：重复对同一人执行开通，断言具备幂等性（不重复建人，返回已开通状态）。

---

## Phase 2: 后端 Control-API 路由与契约 (`apps/control-api`)

- [x] **2.1 增加批量开通 API 接口**
  - 文件：`apps/control-api/src/directory/routes.ts`
  - 任务：
    - 定义 `ActivateMembersSchema = z.object({ person_ids: z.array(z.string().uuid()).min(1).max(1000) })`。
    - 注册 `POST /directory-members/activate` 路由（需 `requireAuth` 守卫）。
    - 调用仓储层方法执行批量开通，记录管理员操作日志（`operation_log`）。

- [x] **2.2 增加名单匹配批量开通 API 接口**
  - 文件：`apps/control-api/src/directory/routes.ts`
  - 任务：
    - 定义 `ActivateByListSchema = z.object({ identifiers: z.array(z.string().trim()).min(1).max(1000) })`。
    - 注册 `POST /directory-members/activate-by-list` 路由。
    - 返回 `{ activated_count, already_active_count, not_found: [] }` 结构。

- [x] **2.3 改造主体创建接口支持绑定企微自然人**
  - 文件：`apps/control-api/src/principals/routes.ts`
  - 任务：
    - 在 `CreatePrincipalSchema` 增加 `person_id: z.string().uuid().nullable().optional()`。
    - 在创建主体成功后，如果带有 `person_id`，联动执行相关规则初始化并在操作日志中保留关联标记。

- [x] **2.4 API 接口测试验证**
  - 文件：`apps/control-api/src/__tests-integration__/w20-directory.test.ts`
  - 任务：
    - 编写自动化接口测试，测试 `/directory-members/activate` 批量开通流程。
    - 编写测试测试跨租户访问防护（不能开通其他企业的 Person）。

---

## Phase 3: 前端交互与组件实现 (`apps/web`)

- [x] **3.1 扩展前端 API Hooks**
  - 文件：`apps/web/src/api/v2-hooks.ts` 与 `apps/web/src/api/v2-types.ts`
  - 任务：
    - 增加 `useActivateDirectoryMembers()` mutation hook。
    - 增加 `useActivateDirectoryMembersByList()` mutation hook。

- [x] **3.2 改造通讯录面板 DirectoryPanel (A 方式 & C 方式)**
  - 文件：`apps/web/src/components/principals/DirectoryPanel.tsx`
  - 任务：
    - **A 方式**：
      - 表格第一列增加复选框，支持表头全选当前页与反选。
      - 增加状态筛选过滤器（全部 / 未开通 / 已开通）。
      - 增加批量操作条：显示已选人数，点击【批量开通 AI】执行开通并实时刷新列表缓存。
      - 表格右侧操作列增加单行【开通 AI】按钮。
    - **C 方式**：
      - 顶部操作栏增加【上传名单批量开通】按钮。
      - 弹出模态框：支持上传 `.xlsx` 格式名单，上传后展示解析结果并调用 `activate-by-list`。

- [x] **3.3 改造新建主体弹窗 Principals (B 方式)**
  - 文件：`apps/web/src/pages/Principals.tsx`
  - 任务：
    - 在新建主体表单中，当 `type === "EMPLOYEE"` 时：
    - 引入企微候选人联想搜索组件：用户输入姓名时，调用 `/directory-members?search=` 获取候选人列表。
    - 下拉展示候选人卡片（姓名、部门、企微账号）。
    - 点击候选人后，自动填充姓名、部门并绑定 `person_id`。

- [x] **3.4 前端页面单元测试与组件测试**
  - 文件：`apps/web/src/pages/Principals.test.tsx`
  - 任务：
    - 补充新建主体联想选择企微人员并成功提交的组件测试用例。
    - 补充 DirectoryPanel 批量勾选并开通的组件测试用例。

---

## Phase 4: 全链路联调与验收验证

- [x] **4.1 端到端场景全覆盖验收**
  - 验证 Scenario 1.1：导入 1000 人，确认候选人池增加 1000 人，主体表无新增。
  - 验证 Scenario 2.1：A 方式勾选 5 人批量开通，确认生成 5 个主体且模型配额规则已配置。
  - 验证 Scenario 3.1：B 方式在新建主体弹窗搜索点选 1 人，确认自动填充并成功开通。
  - 验证 Scenario 4.1：C 方式上传一份包含工号的名单，确认秒级匹配开通。
- [x] **4.2 审查与归档**
  - 确认所有自动化测试全部通过（`pnpm test`）。
  - 执行规范审查，准备合并入主代码库。
