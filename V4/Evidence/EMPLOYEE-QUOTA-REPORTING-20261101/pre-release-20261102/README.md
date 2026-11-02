# 员工月度额度与报表：上线前验收

日期：2026-11-02。状态：**原范围本地验收已通过并收口，生产未改变**。当前结论以 [最终验收记录](最终验收结论-20261102.md) 和 [机器记录](final-acceptance.json) 为准；下表保留阶段过程，不能把旧的“待完成”再作为当前状态。

本目录接续 11 月 1 日定向实施证据，保留首次失败、真实复现、修复与复验。分支仍为 `codex/employee-quota-monthly-reporting`，基线 HEAD 为 `2a2fdbe3c52b6853d12be476a6162221fc8163fe`；它不是新代码的提交 SHA。工作区尚未提交、推送、迁移或部署。

## 已证结果与未完成项

| 检查 | 当前结果 | 证据和范围 |
|---|---|---|
| 六项文件大小问题 | 已按职责拆分；实际全仓 source-size 通过 | size.log；没有提高 400 行门槛或增加大小例外 |
| Chrome 浏览器端到端 | 36 通过、0 失败、0 跳过 | e2e/final-result.json；真实本地 API/Web/PG 与合成 HTTP 上游，无真实模型扣费或企微发送 |
| Control API 全包 | 63 文件、457 通过、0 失败、0 跳过 | control-api/final-result.json；后续公共数据库源修完成后仍需核对有效性 |
| 数据库完整非容量组 | 第三锁文件/Node22.23.4 下 102 文件、772 通过、0 失败、0 跳过 | database-full-remediation/database-third-lock-non-capacity-canonical.result.json；诊断 fixture 不混入业务计数，容量独立单列 |
| 百万行容量 | 最终候选原文件完整 2 项通过，四项原 P95 门槛全部达标 | database-full-remediation/capacity-third-lock-final-work-mem16.result.json；100 万行、2 次预热、20 次采样、原门槛/锁文件不变，75.10秒；未开启数值打印，不编精确 P95；旧失败保留 |
| 原 13 组覆盖率 ratchet | 已通过；高风险源文件补全与最后源修报告待重新绑定 | coverage/；抽出的 Gateway reservation 和 DB pool-writer 已要求整文件纳入，不能沿用遗漏文件的旧结论 |
| 变异测试 | 16 份唯一业务报告已实跑；DB 处置门禁仍阻断 | mutation/report-scope-and-latest-results.json；重跑不算新套件，诊断 probe 不算业务通过 |
| Linux 候选容器 | 最终 Node22.23.4/第三锁文件的四个 amd64 镜像构建与运行通过 | security-refresh/container/；0092、真正0091 Worker兼容、健康/反代/tick/Canvas通过；一致版合成输入及PNG另列 consistent-preview/，原图/输入保留 |
| 官方 Codex CLI 本地协议端到端 | 已通过 | codex-local-protocol-e2e.log；真实 CLI/Gateway/PG、合成上游，不是真实外部模型调用 |
| OpenSpec 严格校验 | 通过 | `openspec validate reconcile-employee-quota-and-reporting --strict`；不是生产业务验收 |
| 依赖安全审计 | 第三候选移除全部 ignore 后实际审计 0 条，已获实际业务范围收口确认 | security/audit-after-third-no-ignore.json；原 67 条公告已修，额外未用 WorkbookReader 仍单列 UNCERTIFIED/FAIL，不扩大第三方接口修复 |
| typecheck/lint/build 与静态门禁 | 新运行时完整检查通过；唯一后续 API 资源调整的18定向/静态增量通过 | security/third-candidate/；最后新增的纯测试文件类型与lint检查单列，最终清单仍待汇总 |

## 真实缺陷与修复边界

- 员工界面的跨池额度减真实 Token、零值显示“无限”、窄屏滚动问题已修复并做浏览器验收。项目/部门原合同保持。
- API 月度额度只冻结原始 Token 预算，不提前冻结现金价格；最终授权价格仍决定实际金额。套餐沿用冻结倍率。真实 PG 验证 API 金额 0.02800000、实际 1200 Token、API deducted_quota=null。
- 兼容账本入口遗漏 api_cost_status 已修复。最终回归又复现旧正金额与零消费 Attempt 混合、不同币种汇总为空时的状态误判；保留正确失败用例，只修状态推断顺序，不改金额、费率或历史事实。
- 百万行资源查询仅在已有快照事务内设置 `SET LOCAL work_mem='16MB'`，减少落盘归并；原 SQL、数据口径与迁移未改。每个排序操作较默认4MB增加12MiB预算，并非整个事务总内存上限，事务结束恢复原值；真实容量原断言最终全部通过。

## 门禁完整性

原大小、覆盖率、容量、变异分数门槛和TEST_DEBT上限没有放宽。新增职责文件纳入相应覆盖/变异范围；只排除生成目录，未删实际生产源分母。新增月度代码的三个严格等价变体另按精确身份登记，不能用同文件数量上限接纳任意新变体。

本次新登记的等价变异仅限已审阅的 3 个文件：月界/余额 6 项、Gateway 管线 2 项、超时工厂 1 项。证明见 mutation/。月界循环项只适用于已只读核实的单企业 Asia/Shanghai、2026 年起业务及固定 Node/ICU/tzdata，不能推广到任意时区。门禁校验精确变异身份和来源 SHA；运行时或证明来源变化即失败，不能用该登记接受新测试债。独立临时副本的三种负向检查确认来源、运行时、变异身份变化均被拒绝。

原根处置门禁读 8 份报告；本次工厂登记后读 9 份。额外实跑报告按其原分数门槛单列，不称为所有存活变异为零，也不把未纳入根处置门禁的数百个存活变异隐去。

## 生产预检与业务边界

通过既有授权生产终端完成只读核对，未绕过认证：生产 schema 0091，0092 未安装；单企业 Asia/Shanghai、12 个员工厂商池均允许超额。当前 Gateway/API/Web 为 cancelled-cost-4691a9a847cf，Worker 为 model-labels-45e1c3a6ca61。当前生产源 4691a9a847cfa690da8f7bdb2688945dc11bd234 是本地 HEAD 祖先。详细限制见 production-readonly-preflight.json；未把未探测的服务 HTTP 健康伪称通过。

当前没有执行新提交、推送、合并、0092 生产迁移、月度开关配置、部署、历史补扣或企微更正发送。实际切换月与服务版本还需发布前最终预检。固定时钟、隔离 PG、合成图文、容器启动不替代上线后的真实月界和接收确认。

原企微可靠性观察继续分层保留：10 月 26 日、11 月 2 日周报只读核对取得自动任务和逐消息有效回执且无异常重复；接收人确认与旧内容问题仍单列待验，不能充当本次新实现的生产验收。

## 本次范围收口

用户指出耗时过长后，主 agent 承认将兼容验收扩大到未使用的 ExcelJS 流读接口及重复验证，随后明确收回原实际业务范围；用户回复“同意，不要过度开发”。因此未用 WorkbookReader 的诊断失败透明保留，不再作为本次交付阻断，不开发第三方补丁、不新增功能。继续处理实际资源查询容量门禁与原有数据库变异检查，以及受影响的必要复验。
