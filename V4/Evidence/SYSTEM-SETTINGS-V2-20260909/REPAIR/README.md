# 第二版 I1 三项问题修复

2026-09-09，按用户要求依次修复 I1-F01、F02、F03。没有扩展第二版范围，没有提交、推送、部署或修改生产数据库。原 I1 报告及候选保持原样；本目录保存修复后候选和验证。

| 问题 | 修复 | 验证结果 |
|---|---|---|
| F01 失效会话跳转／请求循环 | /auth/me 的401明确写回匿名状态 null，旧认证数据被替换，匿名状态停止定时轮询；登录页遇到错误不再相信旧数据；登录成功等待会话刷新后导航 | 新增回归先证明旧缓存不被清除，再通过。真实独立 PG＋Chrome 撤销返回204，仅观察到1次401，稳定停留登录页并可重新登录 |
| F02 通讯录端点未映射 | 将现有 directory-sources、directory-sync-runs、directory-excel-template、directory-excel-imports、directory-import-runs 显式归入使用主体 | 两项回归先复现403，修复后来源／模板读取、配置保存、任务创建和查询通过；只读岗拒绝写入，撤权后拒绝读取，未知端点仍拒绝 |
| F03 新审计来源UNKNOWN | 当前事务内审计写入明确标记来源：人工管理操作ADMIN，目录后台应用／完成／失败SYSTEM；SQL写入同步补齐；未知来源文案不再武断称为历史记录 | 真实主体创建／停用及目录后台应用回归先失败后通过；人工与系统来源区分正确，原UNKNOWN行未改写 |

F02 修复的是既有组织通讯录入口，不新增暂缓的“集成与同步”设置模块。F03 没有把数据库默认值改为ADMIN，也没有倒推或批量修改历史数据。

## 本轮验证

- API 5个文件22项通过：settings-directory-permissions、settings-audit-source、system-settings-v2、pool015-admin-lifecycle、w20-department-costs。
- Web 6个文件13项通过：auth、SystemSettings、Admins、Settings、admins hooks、Sidebar。
- F01 真实浏览器验证脚本：scripts/verify-session-revocation.ts；数据为独立测试数据库，F01-browser.json 记录撤销、请求数、稳定登录页和再次登录结果，截图为 F01-login-after-revoke.png。
- Control API、Web、Database、Contracts、Worker 类型检查通过；修复文件 ESLint、source-size 和 git diff 检查通过；Web 构建通过。原有大bundle提示仍保留，没有做打包重构。
- 过程中修正了测试夹具缺少Excel必需元数据、非multipart请求应返回406的断言，以及一处审计字段编辑落点错误；最终相关功能与类型检查均通过，没有跳过失败场景。

## 证据与状态

- candidate.json：修复后所有候选文件摘要，以及相对原I1候选的 repair_paths。
- api-verification.log / web-verification.log / types-verification.log：本轮最终验证输出。
- F01-browser.json：浏览器专项结果。

三项均已修复并完成作者回归验证。本记录不是独立 I1 复审 PASS，不覆盖此前 I1/review-report.md 的 FAIL 结论；未做新一轮全面审核。
