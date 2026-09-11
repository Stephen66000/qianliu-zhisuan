# Change Proposal: 企业微信通讯录候选库与 AI 员工开通解耦方案

## 1. Why (背景与动机)

在当前【仟流智算】中，企业微信或 Excel 通讯录导入的逻辑是**“导入即开通”**（即导入 1,000 人会自动在 `principal` 表中创建 1,000 个使用主体，并为这 1,000 人全量分配模型配额规则与初始化授权）。

然而在真实的商业客户场景中（例如一家 1,000 人的企业）：
1. **席位与成本限制**：企业微信通讯录有 1,000 人，但企业可能只采购或批准了 300 个 AI 员工使用名额。
2. **全量建主体的副作用**：若全量创建 1,000 个 `Principal`，会导致生成海量无用 Key 待领取记录、产生无意义的配额池与规则绑定、污染账单与用量审计统计。
3. **日常开通与新建主体脱节**：当前管理后台【使用主体】页面的“新建主体”是一个纯手工输入框（管理员必须自己手打“张三 / 研发部”），无法与企业微信的唯一标识（Userid）关联，导致同名混淆、离职无法自动感知、将来无法给员工推送企微消息或图片报表。

为此，本方案旨在将**“组织通讯录（候选人员池）”**与**“AI 员工主体（实际使用池）”**彻底解耦，并提供三种极速开通操作（A-列表勾选、B-新建主体联想选择、C-上传名单批量开通），实现身份统一、权限按需下发。

---

## 2. 核心架构模型：两层人员解耦

```text
┌────────────────────────────────────────────────────────┐
│               企业微信 / Excel 原始通讯录              │
│       (1000 人：姓名、企微 UserID、头像、部门路径)      │
└──────────────────────────┬─────────────────────────────┘
                           │ 首次导入 / 每日 API 同步
                           ▼
┌────────────────────────────────────────────────────────┐
│           第一层：组织人员候选库 (Person 表)           │
│   - 保存企业全员档案 (仅表示公司有这个人)              │
│   - 不建 Principal、不分配 Key、不分配额度、不计费     │
└──────────────────────────┬─────────────────────────────┘
                           │
       ┌───────────────────┼───────────────────┐
       │ A 方式            │ B 方式            │ C 方式
       │ 通讯录列表勾选    │ 新建主体搜索点选  │ 上传 Excel 名单
       │ 批量开通 (如50人) │ 单人精准开通(1人) │ 匹配批量开通(300人)
       └───────────────────┼───────────────────┘
                           │ 调用统一开通事务 activateEmployeePrincipal
                           ▼
┌────────────────────────────────────────────────────────┐
│           第二层：AI 员工使用主体 (Principal 表)       │
│   - 只为获批的 300 人建立员工主体                      │
│   - 核心连结点: principal.person_id -> Person.id       │
│   - 自动应用模型权限规则 (employee_model_rule)          │
│   - 生成 Key 待领取凭据 & 厂商配额池 (principal_grant)  │
│   - 接入每日用量账单与项目负责人候选                   │
└────────────────────────────────────────────────────────┘
```

---

## 3. 改动范围与受影响模块 (Scope of Changes)

### 3.1 数据库与仓储层 (`packages/database`)
- **[改造] `packages/database/src/repositories/directory-import-apply.ts`**：
  - 解除“导入/同步强制创建 Principal”的绑定。导入只写入/更新 `Person`、`person_external_identity` 和 `organization_membership`。
  - 抽取统一开通事务 `activateEmployeePrincipal(trx, enterpriseId, personId)`，负责创建 Principal、绑定 `person_id` 并分配模型配额规则。
- **[改造] `packages/database/src/repositories/directory-repository.ts`**：
  - 新增批量开通方法 `activatePrincipalsByPersonIds(enterpriseId, personIds)`。
  - 新增按名单匹配开通方法 `activatePrincipalsByIdentifiers(enterpriseId, identifiers)`。
- **[改造] `packages/database/src/repositories/principal-repository.ts`**：
  - `CreatePrincipalInput` 增加可选字段 `person_id?: string | null`，创建主体时直接落地关联。

### 3.2 后端 API 服务层 (`apps/control-api`)
- **[新增接口] `POST /directory-members/activate`**：接收 `person_ids: string[]`，批量开通 AI 员工。
- **[新增接口] `POST /directory-members/activate-by-list`**：接收名单（姓名/工号/企微 UserID），自动匹配并开通。
- **[改造接口] `POST /principals`**：支持接收 `person_id`，创建关联企微自然人的员工主体。

### 3.3 前端控制台交互 (`apps/web`)
- **[改造] `apps/web/src/components/principals/DirectoryPanel.tsx`**：
  - 支持表格多选（Checkbox）、全选当前页；
  - 顶部增加【批量开通 AI】按钮与【上传名单批量开通】弹窗；
  - 表格操作列增加单人【开通 AI】操作。
- **[改造] `apps/web/src/pages/Principals.tsx`**：
  - 在【新建主体】表单中，当类型为“员工”时，姓名输入框支持输入模糊匹配企微通讯录，点选后自动带出部门并绑定 `person_id`。

---

## 4. 交付影响与向后兼容性 (Compatibility & Migration)

- **完全向后兼容**：
  - 已经存在的历史 Principal 数据不受任何影响。
  - 依然支持纯手工创建主体（当 `person_id` 为空时退化为原有的独立主体）。
- **零破坏性升级**：
  - 数据库表结构中 `principal.person_id` 原本已存在，无需执行高风险的 DDL 迁移。
  - 重复开通执行幂等保护，绝不会产生重复主体或重复授权。
