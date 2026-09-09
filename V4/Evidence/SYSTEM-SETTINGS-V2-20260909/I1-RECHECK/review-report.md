# 系统设置限定 I1 独立复审

结论：**PASS（仅原 4 项 Finding 的有界复审）**。I1-01、I1-F01、I1-F02、I1-F03 均为 **CLOSED**。本轮没有观察到这些修复直接引入的新回归。

## 对象与边界

- 日期：2026-09-09。
- Reviewer：`settings_i1_recheck`；新上下文，未继承作者实施历史，未参与候选修复；符合通用 v1.4 SOP §3.4 的 I1 会话独立定义，不声明 I2。
- 授权：只判断第一版 I1-01 与第二版 I1-F01/F02/F03 是否关闭，读取冻结源码、原报告、修复差异及直接依赖；独立浏览器复验 F01。父会话执行既有对应回归，Reviewer 读取本轮日志，不重复测试。
- 候选：`../REPAIR/candidate.json`，122 文件；声明摘要 `7706ef249c32400ca6a0d34fe808e2f8a256f4ffad927f97f396c0d47d06624f`；基线 `eb1ed123ec8e919cad0e78947c9cd9c441dee352`。
- Reviewer 首尾逐文件 SHA-256 核对均 **STABLE**；manifest 文件 SHA-256 首尾同为 `627b6e76a9fd25719b44005eec9023b58eea248af830ffc9e25d448b603c72e2`。见 `reviewer-start-lock.json`、`reviewer-end-lock.json`。
- 作者 `REPAIR/README.md` 只用于定位声明；关闭判断依据实际实现及本轮直接证据。
- 写入仅限本 `I1-RECHECK/` 目录。没有修改源码、原测试、原证据、候选或生产数据，没有提交、推送、部署，也没有展开全面审核、I2、变异或全库治理。

## 四项关闭判断

| 原 Finding | 状态 | 复审依据 |
|---|---|---|
| V1 I1-01：旧迁移链仍把 0070 当数据库头 | **CLOSED** | 17 个原直接受影响测试的升级成功列表与回退顺序已衔接当前头 0072：先 0072、再 0071、再原有迁移。0070 恢复证据回退保护测试先回退空配置的 0072/0071，再断言 0070 拒绝，验证恢复证据仍保留，末尾恢复到最新 schema。未删除原保护断言。 |
| V2 I1-F01：撤销会话后的跳转和 401 请求循环 | **CLOSED** | `auth.ts` 将 `UnauthorizedError` 转为成功完成的匿名值 `null`，替换旧认证缓存，并在匿名态停止 30 秒轮询；`RequireAuth` 对 null 跳登录页，`LoginPage` 只在有认证数据且无错误时跳回。登录成功等待认证刷新。真实浏览器撤销后只有 1 次 401，连续 32 秒停留可登录页面，再登录成功。 |
| V2 I1-F02：既有通讯录端点漏映射 | **CLOSED** | `adminRouteModule` 显式将原漏掉的 5 个目录端点根归入 `principals`。`allowsRoute` 继续以 GET/HEAD 区分查看和操作，且未知端点返回 null 后拒绝。现有路由仍按认证企业限定数据。对应 API 回归验证来源/模板读取、保存来源、创建和读取任务，以及只读拒写、撤权拒读和未知端点拒绝。 |
| V2 I1-F03：当前事务审计来源落成 UNKNOWN | **CLOSED** | 主体创建/停用及修复清单中现有人工事务写入显式 `ADMIN`；目录来源保存/任务创建为 `ADMIN`，后台应用、完成、失败及冲突为 `SYSTEM`。直接 SQL 写入同步显式标记。迁移仍保留 UNKNOWN 默认值，未伪造历史来源；UI 将 UNKNOWN 显示为“来源未标注”，不再断言它属于历史。对应真实主体停用与目录任务回归证实人工/系统来源及 UNKNOWN 行保留。 |

## 直接检查与证据

I1-01：已核对 15 个 Database 测试及 2 个 API 测试的迁移链增量，清单见 `migration-reviewed-files.json`；并读取 0071、0072 的回退保护。运行证据为父会话本轮执行的 `migration-regression.log`：3 文件、58 项通过，涵盖 `w20-final-migration`、`exception-center-contract`、`runtime-admin-migrations`。这是代表性运行验证；未声称本轮运行了全部 17 文件。

F01：读取认证 client 的 401 类型、query hook、认证闸门、登录页与新增缓存回归，沿用真实 API 和页面。独立脚本 `verify-session-revocation.ts` 由作者专项脚本复制，仅改导入/输出路径、隔离数据库名，并把登录页观察期从 1.8 秒延长到 32 秒，断言 401 数精确为 1。没有修改原脚本或覆盖 REPAIR 证据。

浏览器使用脚本专属 Chrome、Vite、API 和独立 PostgreSQL 测试容器，运行退出码 0：

- 真实登录后由另一服务端会话撤销浏览器会话，返回 204。
- 实际约 30 秒轮询收到 401 后转到 `/login`；继续观察 32 秒，401 总数保持 1，登录表单可见，URL 仍为 `/login`。
- 登录页截图 `F01-login-after-revoke.png` 已由 Reviewer 目视检查；随后再次登录成功并显示主导航。
- 机器结果 `F01-browser.json` 与原始日志 `F01-browser.log` 保存本轮证据；finally 已关闭脚本创建的浏览器、Vite、API、DB 及测试容器。

F02：检查权限合同、服务端访问判断、目录路由实际调用及对应测试。上传回归的 406 仅证明请求通过授权后被非 multipart 输入校验拒绝，不把它写成成功导入 Excel；本项关闭的是授权漏映射。

F03：检查修复清单的事务审计增量、主体停用 API 到仓储写入、目录 API 创建到 Worker 应用/失败/完成调用链、AuditRepository 与显示语义。新增来源字段留在原事务和原写入位置，未改变原业务更新及原审计身份引用。没有将后台任务保留的发起人 ID 误判为人工执行来源。

父会话本轮直接运行的对应回归，Reviewer 已读取实际日志：

| 证据 | 范围 | 结果 |
|---|---|---|
| `api-regression.log` | system-settings-v1、settings-directory-permissions、settings-audit-source | 3 文件 / 5 项 PASS |
| `web-regression.log` | auth、Settings、SystemSettings | 3 文件 / 7 项 PASS |
| `migration-regression.log` | 上述 3 个迁移/回退套件 | 3 文件 / 58 项 PASS |
| `F01-browser.json` / `.log` | 真实轮询撤销 → 稳定登录页 → 再登录 | PASS，401 × 1 |

## 回传

`finding_freeze_complete=true`；原项 `closed=4, open=0`；本限定范围新增 Finding 为 0。PASS 绑定上述修复后候选，作为原四项缺陷的关闭凭据；不改写旧 FAIL 报告，也不把本次限定复审扩大为全系统、业务验收、提交或部署结论。回传父会话，由其向用户报告并决定后续动作。
