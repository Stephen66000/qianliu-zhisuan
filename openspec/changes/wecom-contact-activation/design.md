# Technical Design: 企业微信通讯录与 AI 员工开通架构设计

本文档为研发工程师及 AI 编码助手提供详细的架构与实现设计指南。

---

## 1. 架构总览与数据流

```text
               +----------------------------------+
               |  企微 API 同步 / Excel 导入      |
               +-----------------+----------------+
                                 |
                                 v  applyItemTransaction
               +----------------------------------+
               | Person 表 (自然人候选库)         |
               | - id, name, employee_number      |
               | - person_external_identity (企微)|
               +-----------------+----------------+
                                 |
           [ 触发开通: A方式勾选 / B方式点选 / C方式传表 ]
                                 |
                                 v  activateEmployeePrincipal
               +----------------------------------+
               | Principal 表 (AI 员工主体)       |
               | - id, type='EMPLOYEE'            |
               | - person_id -> Person.id         |
               +-----------------+----------------+
                                 |
                                 v  applyPublishedEmployeeRules
               +----------------------------------+
               | 配额池与模型规则分配             |
               | - principal_grant (Token配额池)  |
               | - quota_counter                  |
               | - employee_model_rule_assignment |
               +----------------------------------+
```

---

## 2. 数据库与仓储层详细改造设计 (`packages/database`)

### 2.1 改造 `directory-import-apply.ts`
* **文件路径**：`packages/database/src/repositories/directory-import-apply.ts`
* **核心改动**：
  1. 废除 `applyItemTransaction`（约第 257~282 行）中在自然人无对应 Principal 时自动调用 `insertInto("principal")` 的逻辑。
  2. 导入时仅执行：
     - `Person` 的创建/属性更新；
     - `person_external_identity`（绑定企微 `provider_user_id` 即 `userid`）；
     - `ensureOrganizationPath` 维护部门树及 `organization_membership` 职务从属。
  3. 提取公开的业务事务方法：
     ```typescript
     export async function activateEmployeePrincipal(
       trx: Transaction<Database>,
       enterpriseId: string,
       personId: string,
       now: Date = new Date(),
     ): Promise<{ principalId: string; created: boolean; rulesApplied: number }>
     ```
     - 检查该 `personId` 是否已有未归档的 `EMPLOYEE` 主体：
       - 若已有，直接返回现有 `principalId`，`created: false`；
       - 若无，根据 `Person` 记录的 `name` 和部门路径，插入 `Principal`（写入 `person_id`）；
       - 调用已有的 `applyPublishedEmployeeRules(trx, enterpriseId, principal.id, now)` 自动分配生效的模型规则与配额；
       - 写入操作审计日志 `operation_log`。

### 2.2 扩展 `directory-repository.ts`
* **文件路径**：`packages/database/src/repositories/directory-repository.ts`
* **新增方法**：
  ```typescript
  async activateMembers(enterpriseId: string, personIds: string[]): Promise<{
    activatedCount: number;
    alreadyActiveCount: number;
    results: Array<{ personId: string; principalId: string; status: "ACTIVATED" | "ALREADY_ACTIVE" }>;
  }>
  ```
  - 开启 Kysely 事务，对 `personIds` 批量加锁处理，循环调用 `activateEmployeePrincipal`。

### 2.3 扩展 `principal-repository.ts`
* **文件路径**：`packages/database/src/repositories/principal-repository.ts`
* **改动**：
  - 更新接口 `CreatePrincipalInput`：
    ```typescript
    export interface CreatePrincipalInput {
      enterprise_id: string;
      type: "EMPLOYEE" | "PROJECT";
      name: string;
      department_label?: string | null;
      person_id?: string | null; // 新增可选字段
    }
    ```
  - 在 `create(input: CreatePrincipalInput)` 中增加字段映射：
    ```typescript
    person_id: input.person_id ?? null,
    ```

---

## 3. 控制台 API 服务端改造设计 (`apps/control-api`)

### 3.1 改造 `apps/control-api/src/principals/routes.ts`
* **在 Schema 中允许 `person_id`**：
  ```typescript
  const CreatePrincipalSchema = z.object({
    type: z.enum(["EMPLOYEE", "PROJECT"]),
    name: z.string().min(1).max(255),
    department_label: z.string().max(255).optional(),
    person_id: z.string().uuid().nullable().optional(), // 新增
  });
  ```
* **在创建逻辑中**：如果提供了 `person_id`，创建后若该企业配置了“全员生效”的规则，同样触发配额池自动分配。

### 3.2 改造 `apps/control-api/src/directory/routes.ts`
* **新增接口 1：批量开通 AI**
  ```http
  POST /directory-members/activate
  Content-Type: application/json
  Authorization: Bearer <session_token>

  {
    "person_ids": ["uuid-1", "uuid-2"]
  }
  ```
  - **响应**：
    ```json
    {
      "activated_count": 2,
      "already_active_count": 0,
      "items": [
        { "person_id": "uuid-1", "principal_id": "pr-uuid-1", "status": "ACTIVATED" },
        { "person_id": "uuid-2", "principal_id": "pr-uuid-2", "status": "ACTIVATED" }
      ]
    }
    ```

* **新增接口 2：按名单匹配批量开通**
  ```http
  POST /directory-members/activate-by-list
  Content-Type: application/json

  {
    "identifiers": ["zhangsan", "wangwu", "00192"]
  }
  ```
  - **匹配规则**：在 `person` 表（`name`、`employee_number`）及 `person_external_identity` 表（`provider_user_id`）中查找匹配。
  - **响应**：返回开通数量及未找到的条目（`not_found: string[]`）。

---

## 4. 前端交互与页面组件设计 (`apps/web`)

### 4.1 通讯录管理组件 `DirectoryPanel.tsx` 交互重构
* **文件路径**：`apps/web/src/components/principals/DirectoryPanel.tsx`
* **交互元素**：
  1. **批量操作工具栏**：
     - 当表格中有被勾选行时，浮现操作条：显示 `已选择 N 人`；
     - 提供按钮：`【批量开通 AI】`（带确认弹窗），点击调用 `useActivateDirectoryMembers`；
     - 增加下拉筛选：【全部人员】/【仅未开通】/【已开通】。
  2. **表格列增强**：
     - 第 1 列：Checkbox 复选框，表头支持全选当前页；
     - 操作列：
       - 若 `principal_status` 为空或“未建立”，展示蓝色按钮 `开通 AI`；
       - 若已开通，展示绿色 `已开通` 标签与对应的 Principal 快速跳转链接。
  3. **C 方式上传开通弹窗**：
     - 在 Excel 导入区域旁增加按钮：`【上传名单开通 AI】`；
     - 弹出 Modal：支持拖拽上传名单 Excel（含模板下载），上传后前端解析或提交后台，展示识别结果并确认开通。

### 4.2 主体创建弹窗 `Principals.tsx` 联想点选重构
* **文件路径**：`apps/web/src/pages/Principals.tsx`
* **交互元素**：
  - 当弹窗选择“员工 (EMPLOYEE)”时：
  - “名称”字段改造为带下拉候选项的自动联想输入框；
  - 输入时防抖调用 `/directory-members?search=<keyword>`；
  - 下拉列表展示匹配的员工卡片：
    ```text
    ┌────────────────────────────────────────┐
    │ 张三                                   │
    │ 研发部 / 基础架构组 · 企微账号: zhangsan │
    └────────────────────────────────────────┘
    ```
  - 点击候选人后：
    - `name` 填入真实姓名；
    - `department_label` 填入部门名称；
    - 表单状态绑定 `person_id`；
    - 用户点击“创建”，一键生成打通企微的主体。

---

## 5. 安全、幂等与事务保障

1. **企业租户隔离（Tenant Isolation）**：
   - 所有的开通和查询必须无条件带上 `enterprise_id = req.admin.enterpriseId`。严防跨租户开通。
2. **并发安全与数据库锁**：
   - 在 `activateEmployeePrincipal` 中，对 `Person` 记录加行锁 `forUpdate()`，防止管理员对同一人员重复并发点击开通产生双重 Principal。
3. **撤销与停用语义一致性**：
   - 当未来由于企微每日同步发现员工离职时，系统仅需针对该 `person_id` 对应的 `Principal` 设置 `status = 'DISABLED'`，历史账单与用量完整保留，Key 立即失效。
