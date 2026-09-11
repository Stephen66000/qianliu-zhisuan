# Specifications: 企业微信通讯录与 AI 员工开通规格细则

本文档定义了企业微信通讯录候选库管理与 AI 员工主体开通的业务规格和验收场景（Requirements & Scenarios）。

---

## 1. Requirement: 两层人员模型与导入解耦 (Two-Layer Person/Principal Decoupling)

系统 SHALL 将企业全员通讯录存储于组织人员候选库（`Person` 表及相关外部身份表），且在导入或同步通讯录时，默认不得自动创建 AI 员工使用主体（`Principal` 表）。

### Scenario 1.1: 首次导入 1,000 名企业微信成员
- **GIVEN** 企业管理员上传包含 1,000 名员工的企业微信通讯录（Excel 或 API 同步）
- **WHEN** 导入执行完成
- **THEN** 数据库中新增/更新 1,000 条 `Person` 记录，建立对应的部门架构与任职关系
- **AND** 系统**不得自动新增**任何 `Principal`（使用主体）记录
- **AND** 通讯录列表中这 1,000 人状态统一显示为“未开通”，待开通主体数量显示为 0

### Scenario 1.2: 重复同步幂等性
- **GIVEN** 已成功同步 1,000 名员工，且其中 300 名已被开通为 AI 员工主体
- **WHEN** 系统再次执行每日自动同步或重新上传相同文件
- **THEN** 已开通的 300 名主体的 Key、配额规则、账单与历史用量保持完好，不得被重置或覆盖
- **AND** 700 名未开通员工继续保持“未开通”状态

---

## 2. Requirement: A 方式 —— 通讯录列表批量开通 (Mode A: Directory List Batch Activation)

管理员 SHALL 能够在通讯录成员列表页面通过复选框单选、多选或按部门全选未开通人员，并执行一键批量开通。

### Scenario 2.1: 列表多选开通
- **GIVEN** 管理员在通讯录列表中筛选或搜索出多名“未开通”状态的员工
- **WHEN** 管理员勾选其中 5 名员工并点击【批量开通 AI】
- **THEN** 系统发起 `POST /directory-members/activate` 请求
- **AND** 后台在单个事务中为这 5 名员工分别创建 `Principal` 记录（`type='EMPLOYEE'`, `person_id=Person.id`）
- **AND** 自动为每个新主体绑定当前生效的全部员工模型授权规则与厂商配额池
- **AND** 界面实时刷新，这 5 名员工的状态更新为“已建立”，接入配置状态变为“PENDING”

### Scenario 2.2: 忽略已开通人员的幂等保护
- **GIVEN** 管理员选中的列表中同时包含了“未开通”和“已开通”的员工
- **WHEN** 管理员点击【批量开通 AI】
- **THEN** 系统只为“未开通”人员创建新主体，对“已开通”人员安全跳过，返回开通成功的增量数量，不报错

---

## 3. Requirement: B 方式 —— 新建主体搜索点选 (Mode B: Create Principal Autocomplete)

在【使用主体】页面中，管理员新建员工主体时，系统 SHALL 提供从企微通讯录中搜索并点选候选人的能力，自动填充并锁定该员工的 `person_id`。

### Scenario 3.1: 搜索企微候选人并自动带出部门
- **GIVEN** 管理员打开【新建主体】表单，选择类型为“员工 (EMPLOYEE)”
- **WHEN** 管理员在“名称”输入框输入关键词（如“李”）
- **THEN** 输入框下方出现候选下拉浮层，展示匹配的企微成员列表（包含：姓名、部门路径、企微账号）
- **AND** 当管理员点击选中候选人“李四（技术部/架构组）”时：
  - “名称”输入框自动填充为“李四”；
  - “部门/标签”输入框自动填充为“技术部/架构组”；
  - 表单隐式记录选中人员的 `person_id`。

### Scenario 3.2: 提交创建并绑定企微账号
- **GIVEN** 管理员通过搜索点选了企微员工并提交表单
- **WHEN** 系统向 `POST /principals` 发起创建请求
- **THEN** 后台创建出的 `Principal` 记录中 `person_id` 字段精确指向该员工的 `Person.id`
- **AND** 主体列表即刻显示该员工主体，且与企业微信通讯录形成双向打通。

---

## 4. Requirement: C 方式 —— 上传 Excel 名单批量开通 (Mode C: Upload Excel List Activation)

管理员 SHALL 能够上传仅包含员工工号、企微账号或姓名的一维名单 Excel 文件，系统自动匹配候选库后完成批量开通。

### Scenario 4.1: 成功匹配并批量开通
- **GIVEN** 企业已有 1,000 名候选人员库，管理员上传一份包含 300 个工号的 Excel 文件
- **WHEN** 系统解析文件并调用 `/directory-members/activate-by-list`
- **THEN** 系统精确匹配出 300 名对应的候选员工，并在后台批量创建 300 个 `Principal` 主体
- **AND** 返回成功结果：`{ activated_count: 300, already_active_count: 0, not_found: [] }`

### Scenario 4.2: 存在未匹配人员时的友好反馈
- **GIVEN** 上传的名单中有 2 个工号在通讯录候选库中不存在
- **WHEN** 系统执行匹配开通
- **THEN** 系统为有效匹配的人员正常开通，同时在界面弹出提示框，明确列出未找到的 2 个工号，便于管理员核实。
