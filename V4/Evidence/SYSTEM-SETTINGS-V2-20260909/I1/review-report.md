# SYSTEM-SETTINGS-V2 — I1 独立审阅冻结报告

结论：**FAIL**。本轮一次性冻结 3 项 Finding：P1 × 1、P2 × 2。未修代码、未改原测试、未改作者 Evidence 或候选清单。结论仅为用户指定的 I1，不是 I2、业务验收或部署结论。

## 对象与独立性

- Reviewer：settings_v2_i1，新上下文、无实现过程历史；未调用其他 agent。
- Contract：本目录 `contract.md`。按用户明确限制只做变更阅读及最小直接复现，不以缺少重型流程文书阻断。
- Base：`eb1ed123ec8e919cad0e78947c9cd9c441dee352`。
- 候选：`../candidate.json`，97 个文件，声明摘要 `5fa0d1fe4d33e75b4afedf7c7d3abe3cb9746d8fc630ab8d2df79e79a4419f1c`。
- 开始锁：父会话独立验证 STABLE；结束锁：本 Reviewer 再读全部 97 个文件，`reviewer-end-lock.json` 为 STABLE。
- 输入：系统设置功能规划的 V1/V2 实施安排、父会话提供的确认范围、冻结源码、v1.4 Audit 模板及 SOP §3.4。作者交付声明不作为 PASS 依据。

## 冻结 Findings

### I1-F01 · P1 · 强制退出后认证轮询进入登录跳转与请求循环

**位置：** `apps/web/src/api/auth.ts:21-22`（本次新增 30 秒轮询）；关联 `apps/web/src/pages/Login.tsx:30-35`、`apps/web/src/components/RequireAuth.tsx:32-33`。

**触发：** 管理员在浏览器正常登录并保持页面打开；另一会话通过本次新增的 `DELETE /admin-sessions/:id` 撤销该浏览器会话。新轮询下一次获得 401。

**实际：** 服务端撤销返回 204，29.954 秒后 /auth/me 首次返回 401。React Query 的失败后台重取仍保留先前 session.data；RequireAuth 根据 401 跳到 /login，而 LoginPage 仅检查旧 data 又跳回受保护页，反复挂载造成认证请求风暴。原始日志记录首个 401 后 1.5 秒内完成 **1,842 次** /auth/me 401；停止隔离浏览器前共 26,189 次。一次 DOM 取样可短暂看到登录表单，这不表示循环停止；截图因持续跳转 30 秒超时。本轮未声称取得成功截图。

**影响：** 本版“强制退出后重新登录”链路不能稳定完成，单个失效会话产生高频重复认证请求。后端权限撤销本身有效，没有证据表明旧会话继续获得业务数据。

**归属：** LoginPage 无条件相信旧 data 的逻辑原已存在；本轮新加入周期轮询和管理员主动撤销功能，把它组合成打开页面无需任何后续操作即可自动触发的问题。本报告不把原有 LoginPage 整体认定为本次新增，不宣称已运行基线对照浏览器。

**v1.4：** §2.2 状态、重试及退出生命周期；§2.7 关键异常状态转换。

**最小处置：** 认证失效时统一清理/废弃旧认证数据；登录页只有在当前会话确认有效且无认证错误时跳转。补一个真实浏览器会话撤销后停留可登录页面、认证请求次数有界的回归。不要仅移除轮询来掩盖撤销反馈。

**证据：** `reproduce.ts`、`negative-reproduction.log`、`negative-reproduction.json`、`revocation-log-summary.json`。

### I1-F02 · P2 · 使用主体操作岗无法使用现有组织通讯录入口

**位置：** `packages/contracts/src/admin-permissions.ts:29-33`；调用链 `apps/control-api/src/admins/access.ts:25-26`。

**触发：** `FEATURE_DIRECTORY_IMPORT=true`，超级管理员创建并授予自定义岗位 `principals: {view:true, operate:true}`；岗位成员进入现有“使用主体 → 组织通讯录”。

**实际：** 同一岗位 `GET /directory-members=200`，但 `GET /directory-sources/WECOM=403`、`GET /directory-excel-template=403`；超级管理员对后二者均为 200。原因是新增模块映射仅包括 directory-members，遗漏 directory-sources、directory-sync-runs、directory-excel-template、directory-excel-imports、directory-import-runs，全部落入 unknown deny。原页面仍调用这些端点并显示模板下载/同步/上传功能。

**影响：** 已勾选使用主体操作权限仍不能完成原有通讯录操作。下载模板都被拒绝，不能通过单独勾选其他模块修复这些未映射路由。

**归属与范围：** 路由和组织通讯录页面是基线已有功能；误拒绝来自本次新增授权映射。本项要求维持已有业务入口的授权可用性，不要求建设本版暂缓的“集成与同步”设置页。规划明确暂缓不要求删除其他业务页面已有相关能力。

**v1.4：** §2.3 权限边界合同；§2.7 实际入口及关键分支回归。

**最小处置：** 将这些已有端点按确认的业务归属显式纳入权限映射，并验证查看/操作分离；保留未知端点默认拒绝。

**证据：** `negative-reproduction.json` 的 directory 数组；原始请求/响应在同名 log。

### I1-F03 · P2 · 新发生的已知人工操作仍被标成历史未知来源

**位置：** `packages/database/migrations/0072_admin_roles_security.js:19-20`、`apps/web/src/components/settings/AuditPanel.tsx:42`；实际写入链 `packages/database/src/repositories/principal-repository.ts:374-384`。

**触发：** 本候选运行后，由已登录管理员新增 PROJECT 主体，再调用 `PATCH /principals/:id` 停用，随后在新的审计日志查询该操作。

**实际：** 停用返回 200，刚生成的 `principal.disable` 审计返回 `actor_name="I1 owner"`，但 `actor_source="UNKNOWN"`；新 UI 将它显示为“历史记录 · 来源未标注”。原因是只给 AuditRepository.write 和少数本次写入设置 actor_source，而现有事务内直接写 operation_log 的人工/系统任务继续使用新列 UNKNOWN 默认值。比如主体停用就是这一路径。

**影响：** 本版承诺覆盖“当前已有业务及本次新增功能”的人工/系统来源识别没有完成；刚发生且已知来源的记录被误标为历史未知。管理员身份本身仍保留，未出现审计记录丢失。

**归属：** 原事务写入代码没有 actor_source 是旧事实；新增字段与来源显示在未完成现有写入接入时产生本轮错误语义。历史 UNKNOWN 的保留本身不是缺陷，也不要求伪造历史来源。

**v1.4：** §2.3 审计边界；§2.5 状态与原因真实可解释；§2.7 实际实现与关键分支。

**最小处置：** 为当前实际人工/系统写入链补充显式来源，历史行仍可保留 UNKNOWN；使用上述真实停用动作作回归。不能把数据库默认值简单全改为 ADMIN，以免系统任务误归属人工。

**证据：** `negative-reproduction.json` 的 audit 数组，`negative-reproduction.log` 的创建/停用/查询链。

## 阅读与验证矩阵

- §2.1 结构职责：PASS（本轮范围）。已读所有新增生产文件与实质修改；API 入口、权限合同、仓储和 UI 分层没有新增依赖反向引用。单纯 data-write-action 修改按共同 CSS/组件模式合并核对；迁移链测试改动核对增量迁移顺序，不扩大为全库治理。
- §2.2 状态与生命周期：FAIL，I1-F01。角色/安全乐观锁和事务、最后超级管理员的企业级锁、会话撤销企业边界均有对应实现。失败认证缓存退出路径存在已复现循环。
- §2.3 依赖与架构边界：FAIL，I1-F02/F03。后端未知路由 fail-closed 有效，但既有端点归属不完整；审计新来源合同未接全当前写入。
- §2.4 配置与安全：当前直接检查未发现权限提升、跨企业会话撤销或明文凭证新增泄漏。管理员、岗位与安全策略写入限制为超级管理员；这些专项正向/拒绝测试由父会话本轮重跑通过。权限可用性缺口见 F02，不夸大为安全旁路。
- §2.5 类型与错误：FAIL，F01/F03 的失效状态及来源语义。新增边界使用 Zod 校验，日期无效值、越界范围、岗位未知模块会拒绝。复现脚本中的宽类型仅用于 Reviewer 临时工具，不属于候选实现。
- §2.6 注释与可读性：本轮未发现需单独阻断的注释错误；来源历史文案问题归并 F03。
- §2.7 测试语义：FAIL，已有测试未覆盖撤销后真实浏览器稳定恢复、全量已有目录端点授权及事务内审计来源。已有绿色计数不覆盖这些负向场景。

机械证据仅报告实际执行范围：

- 父会话本轮直接 API 回归：2 文件 / 9 项 PASS，`api-regression.log`。
- 父会话本轮直接 Web 回归：5 文件 / 12 项 PASS，`web-regression.log`。
- Reviewer 隔离 PG + Chrome + 实际 API 负向复现：上述三项得到实际返回；脚本末段截图超时、退出码 1 已原样保留。此脚本不是 PASS 测试，未将失败运行包装为成功。
- 复现过程只写临时测试数据库，强制停止的 Chrome PID 32538 是本脚本创建的隔离浏览器；随后 finally 关闭 Vite、API、DB 和测试容器。未接触用户浏览器或生产数据库。
- 全库 lint/typecheck/build、coverage/ratchet、复杂度、重复率、依赖治理、变异：按用户/Contract 排除，未运行也不声称 PASS。无新增第三方依赖，依赖引入专项 N/A。

## 冻结与回传

`finding_freeze_complete=true`；`p0=0, p1=1, p2=2, p3=0`。本轮不追加新的调查方向，不提出无关重构或第二轮审阅要求。

请求下一动作：父会话向用户回传 FAIL 及三项有界处置；如何处置由用户/Planning 决定。本 Reviewer 不修候选、不更新主状态、不提交或部署。
