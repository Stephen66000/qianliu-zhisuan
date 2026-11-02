# Design

## Context

本设计基于本地 `2a2fdbe3c52b6853d12be476a6162221fc8163fe` 与 2026-11-01 已完成的生产只读核账；动机及范围见 proposal。用户已明确选择“每月额度，每月 1 日重置”，未要求关闭允许超额。

| 事实 | 已证结果 | 设计约束 |
|---|---|---|
| 十月成功员工账本 | 22607 次，2709467730 Token | 作为回归输入，不能为余额重算而改量 |
| API / 套餐 | API 2020667201 Token；套餐扣减 388884913 | API 额度事实与 API 金额、套餐扣减分开 |
| 员工 / 项目授权 | 员工 22 亿，项目 3 亿 | 员工报告不含项目池 |
| 超额策略 | 12 条员工授权均允许超额 | 超分配量不等于禁止超额策略失效 |
| 旧计数周期 | 2026-09-19 起，next_reset_at 全空 | 十月不能冒充已按月重置；不清空旧账 |
| 本次生产 Worker | `ic-worker:model-labels-45e1c3a6ca61` running/healthy | B 段不能只发 Worker |

现有 `ledger_line.deducted_quota` 对 API 为空是厂商计费合同，并非应填零或填 raw Token 的列。现有 `quota_counter` 对套餐使用折算量，不能直接把它改成全厂商 raw Token 而悄悄改变已有套餐额度语义。

## Goals / Non-Goals

**Goals**

1. 员工每月获得配置的厂商池额度，1 日零点进入新账，旧月可查。
2. API 计内部 raw Token；套餐保留冻结倍率，允许超额照常计量与呈现。
3. 同一月份/截止时间的个人与团队额度一致；报告范围、日期与模型占比一致。
4. 旧数据按证明程度展示；修复不产生第二次厂商费用、不重发已成功消息。

**Non-Goals**

- 不改项目额度、Key 原始 Token 限额、厂商账户余额、厂商套餐窗口、价格和自动换路由策略。
- 不做通用预算平台、不支持任意自定义周期、不新增财务账本重算或现金追缴功能。
- 不因历史空缺自动补扣，不为未知消费创造确定值；不承袭旧部署/重发授权。

## Decisions

### D01 月度规则和超额规则分开

- 月份由企业时区决定，本次企业为 Asia/Shanghai。周期为 `[月初, 下月初)`，下一月初始化已用/预占为零，上月余额不结转。
- 月额度模板沿用 `principal_grant.quota_value`；有效授权在月初领取全月额度，月中首次授权领取完整配置值，不按天折减。
- 月内 SET 改本月上限，ADD 增加本月上限；两者保留已用、预占，并更新以后月份采用的模板。未来才生效的授权变更不提前增加本月额度。
- 停用/撤权仍即时阻断；同一员工、厂商、本月再启用复用原月账，不获得第二份未用账。
- `allow_overage=true` 不拦正常调用，但照记已用及超额；false 按预占判不足则在上游前拒绝。实际用量可能大于估计，记录实际超额并阻断后续请求，不承诺截断已生成输出或精确零超调。
- 企业时区进入月账后冻结，不在本周期中随服务器时区或配置变更重切边界。
- 额度基础在本月账建立后同样冻结，月中不得把 raw Token 已用改解释为套餐折算量；需要更换基础时从另一个明确的新周期生效并独立核账。

选择理由：用户选择的是每月重置，并未选择改变额度单位、超额开关或厂商计费。直接清零旧 `quota_counter` 会丢掉旧月、把跨月结算扣入新月；直接按 30 天滚动也不满足自然月。

### D02 最小持久化：月账、Attempt 额度事实，复用现有审计

以下结构已在本地实现于 additive `0092_employee_monthly_quota.js`（核对本地迁移头为 0091），隔离 PostgreSQL 已验证；尚未执行生产迁移，发布前仍须重新核对生产迁移头。

| 结构 | 关键字段/约束 | 用途 |
|---|---|---|
| `enterprise.employee_quota_monthly_from`（新增可空） | 企业时区月初，未到时保持 legacy | 明确新规则生效月份，避免月中清零 |
| `principal_grant.quota_basis`（新增可空） | `RAW_TOKEN` / `PLAN_QUOTA`；与模型路由模式核对 | 让员工池额度单位明确，不靠前端猜测 |
| `principal_quota_period`（新增） | 企业、员工、厂商、period_key 唯一；period_start/end、timezone、basis、limit_value、used_value、reserved_value、quality、open_grant_version | 稳定按员工 × 厂商 × 月保存额度，不因重建 Grant 逃过已用 |
| `principal_quota_usage`（新增） | 企业、request_id、attempt_no 唯一；upstream_attempt_id 可唯一关联；period_id、grant_id/version、basis、estimate、actual、status、usage_quality、时间 | 持久化预占、实际归属和状态，旧月晚结算不会误扣新月 |
| `operation_log.change_summary`（扩展既有合同） | `principal_quota.change` 事件含 schemaVersion、企业/员工/厂商/月、before/after、SET/ADD/停启/策略、来源版本和原因 | 授权变化与月账同事务保留前后事实，不另造通用事件平台 |

`principal_quota_usage.status` 为 RESERVED / SETTLED / RELEASED / UNKNOWN。actual 为 bigint 或空：未知不是零。新报表读确定已用与未结清预占，存在未知项时不声称精确余额。

余额公式按单个同口径厂商池计算：

```text
rawTokens = input + output                         // cache 是 input 子集，不再相加
API internalUsage = rawTokens                     // 不写入 deducted_quota
Coding Plan internalUsage = frozen deducted_quota // 不重算最新倍率
available = max(0, limit - used - reserved)
confirmedOverage = max(0, used - limit)
```

数据不变量：`reserved >= 0`；每条实耗只入账一次；月账确定已用等于本月确定额度消费之和（加有来源的明确调整）。有预占时可用不是“总额减实耗”；预占不能算成已确认超额。

原 `quota_counter` 保留 legacy 数据；B 段生效后，新员工月度账不再把它作为读写权威。不做新旧双写后再由报表猜选哪一个。项目等未切换对象继续旧流程。

不同基础不合计为“总剩余 Token”。当前三池可明确映射 DeepSeek API → RAW_TOKEN、智谱/Kimi 套餐 → PLAN_QUOTA。若实际预检发现同一厂商池同时承载不可比较基础，则本批切换 NO_GO，列出池及路线；不静默改变路由。本变更不开发一个通用混合单位引擎。

结构成本的依据是已发生的缺失：API 没有额度事实、旧周期不可回放、用户新增每月重置要求；两张关系表分别承载月账和实际 Attempt，不加通用规则 DSL、后台自动修复器或独立分布式锁系统。

### D03 复用网关流程，分离额度与套餐并发租约

1. 在现有即时授权核验后解析员工厂商池、basis、当前月份和已生效策略。
2. 进入月度规则前继续 legacy；月度规则生效后，通过统一 `reserveEmployeeQuota` 为 API/套餐创建或锁定月账并记录一次预占。API 估计为 raw，套餐估计按冻结倍率折算。
3. `reserveCodingPlanQuota` 中的套餐并发租约继续只用于套餐；不得为了给 API 加额度，顺带给 API 套上套餐窗口或并发限制。
4. 预占行以 request_id + attempt_no 关联创建中的 Attempt；正式 Attempt 创建时绑定 upstream_attempt_id，访问上游前核实绑定。创建失败走现有释放路径，不发送上游。
5. `persistAttemptUsageEvidence` 保留原计费字段；额度实际值从真实 raw 或冻结套餐扣减取得，不把 null API 扣减转为零内部消费。
6. 拓展现有 `quota_settlements` 的月度分支，携带 period_id 和 usage_id；在 `gateway-ledger-settlement` 的现有终态事务与幂等护栏内更新已用、释放预占、冻结额度事实。
7. failover 中已消费 Attempt 的提前结算、失败终态、上游前拒绝、撤权清理均传递原 period/usage，而非按“当前月”查找。新 Attempt 独立确定月份。
8. 已访问上游但用量未知时保留 UNKNOWN 与保守预占，沿用现有待核处理。无需新增自动后台退款；Key 的独立限额与清理仍按原合同运行。

重点变更位置：`pipeline-attempt-preparation.ts`、`pipeline-attempt-execution.ts`、`attempt-usage-settlement.ts`、`pipeline-failure-settlement.ts`、`revoked-attempt-settlement.ts`、`real-pipeline-types.ts`；数据库 `quota-gate-repository.ts`、`gateway-ledger-settlement.ts`、`gateway-ledger-terminal-rejection.ts` 及相关类型。

### D04 月初初始化是按月建账，不是物理清零

- 新增 Worker 月度额度初始化任务，企业本地时间每月 1 日零点开始，按当前有效员工授权创建新月账；重复 tick 依赖唯一键与事务，不增加总额。
- Gateway 请求和 Control API 的**当前月查询**也经同一 `ensureCurrentQuotaPeriod` 初始化，确保 Worker 重启/延迟不会延用旧月。历史报表查询只读，不能用今天授权创建一个旧月账。
- 月初建账和月中管理员修改对同一员工厂商月账采用现有事务行锁；延续现有项目锁顺序，不引入 Redis 锁。管理员修改与 before/after 审计同事务。
- 到期月不再接纳新预占，但仍可接收属于它的旧 Attempt 结算。12 月 1 日 00:02 完成的 11 月 Attempt 回写 11 月，12 月统计不被扣除。
- 未结清月报明确暂定状态；已冻结的投递内容不因晚结算静默改图或自动再发。

### D05 授权和读取只保留一个权威口径

- `principal-access-config-repository.ts` 与 `employee-model-rule-repository.ts` 的 SET/ADD/停启路径统一调用月账调整器，保留现有 `allow_overage`；新旧授权标识对应同一员工厂商月账。
- `GET /principals/:id/access-configuration` 的池数据增加 period_key/start/end、quota_basis、limit/used/reserved/available/overage、completeness 和 policyEffectiveFrom。数量通过十进制整数字符串传输，避免前端精度丢失。
- 新月度策略未生效时返回 `LEGACY_PENDING_RECONCILIATION` 及旧周期起点，不能用新字段假装已月度化。
- 员工接入配置响应的旧 `summary.total_quota` 改为 null，并带 `quota_aggregation=PER_PROVIDER`，避免 API 继续提供混合基础总量；池内数值为十进制字符串。项目保留原接口计数来源。旧型号级员工创建入口在已配置月度切换时返回明确 409，引导厂商池配置，防止再建无法归月的授权。
- Web 现有配置与已用/剩余展示接同一读取合同，注明月份、单位与允许超额；本变更不扩为全站改版。
- 实施时全量检索 `quota_counter` 的直接读写，对员工月度对象改接新源；项目、Key 和财务账本不得被一并替换。

### D06 统一报告事实，而不是分别修每张图的减法

新增共享 `EmployeeReportFacts` 投影（拟位于 `apps/worker/src/reporting/report-facts.ts`，配合数据库仓储），一次 repeatable-read 只读快照取完 Overview、模型、额度和完整性；复用 Overview 的查询实现并提供已有事务入口，避免嵌套事务各读一份时点。

```text
period: type/start/end/timezone/label
quotaAsOf: weekEndExclusive 或 monthEndExclusive
scope: EMPLOYEE + enterpriseId
activity: successful settled requests / realTokens / activeEmployees
models: allModelCount / displayedTopModels / fullDenominator
quota: perProvider[basis,period,limit,used,reserved,available,overage,quality]
factVersion / generatedAt / provenance / completeness
```

- 活动统计延续成功已结算口径，标注“成功请求统计”；真实失败实耗另计内部额度，避免把两种范围强行对齐。
- 日报模型查询显式传入员工过滤；团队周报额度不含项目；模型 TopN 截取在完整集合/分母之后，文案“共 N 个，展示 Top3”。Flash 格式化回归保留。
- 自然期间由共享时间工具用企业时区解析；删除个人周报的 `getFullYear/getMonth + Date.UTC` 月界拼接。
- 周报的额度月份取 `weekEndExclusive − 1ms` 所在自然月，并显示“截至 M月D日”；例如 11 月 2 日发上一周报告，额度状态为截至 11 月 1 日的 11 月状态。
- 月报按额度归属月读取消费，跨月晚结算显示结清质量；活动用量仍按现有账本结算时间统计，二者差异有说明。
- 报告同时冻结业务截止时点和事实读取时点：额度归属/配置按业务截止取，结算可信度截至本次生成时刻判断。尚未结清则明确暂定，后续完成不反写已 SENT 的图文。
- 图片与文字只使用这份冻结事实，不再各自查余额。仍由现有 `deliverReport` 持久化 png/text、逐消息回执和内容 hash。

### D07 图片与文字的具体变化

保持白底、现有字体/配色、1080px 导出宽度、成员表与模型表骨架，仅调整额度区内容和必要高度。

| 区域 | A 段（尚无新月账） | B 段生效后的正式月报 |
|---|---|---|
| 额度摘要三格 | `额度范围：3个厂商池` / `历史余额：待核账` / `超额策略：允许超额`（按实际策略生成） | `月度厂商池：3个` / `额度状态：X项超额，Y项待核` / `超额策略：全部允许/部分允许/全部禁止` |
| 使用摘要三格 | 22607 次 / 27.1 亿真实 Token / 8740.2 万每天（十月证据） | 当月对应真实请求/用量/日均 |
| 额度明细区 | 厂商、单位、月内可证使用、历史余额状态；旧 22 亿如引用仅标“旧授权配置，非已证月额度” | 厂商、计量基础、当月分配、已用、可用/超额；预占或待核加简洁说明 |
| 成员与模型 | 员工统一范围；模型总数与 Top3 分开 | 同左 |
| 个人卡片 | 旧周期不可重建时“截至日期的余额：待核账” | 同源当月各池额度状态，不再显示混合单位的一个“剩余额度” |
| 文字 | 同图的用量与待核说明，不复述错误 18.1 亿 | 同图的月份、真实用量、超额/待核摘要 |

混合金额币种不在此新增折算展示。额度明细增加后画布高度按区块增长，不通过缩小到不可读字号挤入旧 760px；任务包含长姓名、多个厂商、待核/超额长文案的 1080px 实际渲染检查。

### D08 历史核账是独立只读预览

- 拟提供 Worker/管理 CLI `quota-reconcile preview`，必填企业、员工范围、期间，只查询并输出 evidence JSON；输出中不得含密钥、完整凭据 URL 或截图无关个人资料。
- 清单逐项列 provenance、grant 版本可证性、期间、原/目标值、差额、basis、COMPLETE/UNKNOWN、修复影响及 hash。原始账本始终不改。
- 旧 API 未记内部额度不能按今天授权自动回填；只有历史映射和计量基础唯一确定的行才可提出补充事实，其他保留 UNKNOWN。
- 本方案不要求把旧 API 用量追缴为现金、不重算旧价格、不重开已结财务账期。历史写入不作为 A 段报表上线的前提。
- 受控 `apply` 仅在之后单独授权时实现/执行冻结清单，默认 dry-run；同一来源不重复补记，来源变化需新预览。新月从零开始不依赖把九、十月累计账强行迁成月账。

## Risks / Trade-offs

- **按厂商保留 raw/折算单位，无法提供一个总剩余 Token** → 保留真实用量总数，额度按单位分列。这比改变全部套餐额度基础的迁移范围更小。
- **员工预估不等于最终消耗** → 禁止超额对预占执行，实际超出如实记录，后续阻断；不扩展到截断模型输出。
- **旧月历史配置不完整** → 明确待核，不能因新月账存在而宣称旧月精确恢复。
- **跨月长请求、终态重试和中途失败** → 使用已存在的 Attempt、事务与幂等边界携带月份；这是每月重置的正常边界，不引入新的分布式协调系统。
- **只更新部分服务导致来源不一致** → B 段必须统一发布 DB/Gateway/Control API/Worker 与受影响 Web；不把旧 Worker 发布授权直接套用。
- **历史财务账已关闭** → 新内部额度事实不碰价格及经营账期；需要财务动作另行处理。

## Migration Plan

### A 段：先把报表说清楚

1. 取得实施授权后，仅修改共享报表事实、日期/范围/占比和图文展示，旧额度状态显式待核；定向工程与渲染验收。
2. 提供精确候选、报告预览、原图对照和回滚方案；获本次 A 段发布授权后发布 Worker。
3. 不触发已成功报告的自动更正发送；如用户另行授权更正，使用独立更正 bundle，保持原消息与回执。

### B 段：按月计量上线

1. 实施时重新核对全套生产 SHA、数据库 migration head、路由模式、12 条授权策略与混合池；baseline 0090/0091 仅为历史，不作为迁移目标编号。
2. 完成最小 additive 迁移与隔离 PG 验证，先部署能读旧/新规则的兼容组件；此时 monthly_from 尚未生效。
3. 新规则从激活后的首个完整自然月开始。若 2026 年 11 月完成发布，推荐 `2026-12-01T00:00:00+08:00`；错过则顺延，不能在月中直接清零。用户若要追溯 11 月，另列预览和影响批准。
4. 只读影子核对真实用量、单位、月份和准入决策，既有允许超额不变；差异不写旧计数器。
5. 正式月界后验证初始化、实际 API/套餐归属和允许/禁止超额；禁止超额和故障用隔离环境/受控对象验证，不修改真实员工开关制造故障。
6. 首次真实新月报告与周报、月报分别保留业务证据。每月额度首个生效月结束后的自然月报才可验收完整闭环，例如 12 月周期对应 2027-01-01 月报。

### 回滚

- A 段可回滚模板/查询候选，保留新投递证据，不重发旧消息。
- B 段数据库保留 additive 结构及事实，不清零/删除月账。生效前可取消未来切换；生效后先保护受影响新请求并排空已分配月份的在途结算，再回滚到识别月账的兼容版本。
- 若必须退回不认识月账的旧 Gateway，不能直接恢复接流量；需独立的流量保护、对账及恢复步骤。恢复准入前核验已有余额和在途归属。

## Open Questions

无影响方案结构的未决策略：用户已选择每月重置；超额开关维持现值；API raw 与套餐折算分列。具体发布日、迁移编号、候选 SHA 与生产混合池预检是实施时生成的参数，不伪造为本次已确认事实。

“首个完整自然月生效”是本方案的推荐切换安排，需随方案审阅确认；它不会因本文件生成而立即修改生产月份。若要求立即追溯当前月，须先更新本方案的迁移/核账部分，不能直接执行现有任务。
