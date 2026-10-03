# Coding Plan 窗口额度提示与自动恢复开发计划 v1.1

> 日期：2026-10-03（Asia/Shanghai）
> 状态：`PLAN_REVIEW_PASS / IMPLEMENTATION_NOT_AUTHORIZED / DEPLOYMENT_NOT_AUTHORIZED`
> 分析基线：`7f3557f7afabcd6665aea39932895899272e318b`。
> 本稿替代 v1.0；v1.0 和初审报告保留。只修订方案，不编写业务代码或迁移文件。

## 1. 目标与范围

Kimi／智谱 Coding Plan 5 小时或周额度耗尽时，原 Key 用户收到具体窗口、预计恢复时间及自动恢复说明；厂商确认全部相关窗口恢复后自动允许新请求，无需管理员点击同步、验证、更新或恢复。

不追查历史 Kimi 403，不新增首页、付费许可 UI、调度服务或存储平台。真实鉴权、停用、权限及账本保持各自语义。失败请求不后台重放，耗尽请求不自动转用其他模型、付费 API 或已购余额。本轮仅修订文档。

| 初审发现 | 确定方案 |
|---|---|
| F1 耗尽事实丢失 | 资源行存当前耗尽记录与单调额度 revision；正余量才清除，不无限回溯旧零值 |
| F2 到期提前放行 | 明确耗尽进入 EXHAUSTED；当前记录参与准入；到时只查询额度，不生成半开 |
| F3 初始付费回退 | 状态过滤前固定 PLAN_ONLY；本次无 CP→API 例外 |
| F4 旧结果覆盖新故障 | 查询前捕获凭证／配置／资源版本与额度 revision；条件提交窗口、资源、Key 和关联事件 |
| P2-1 时间有效期 | 10 分钟只限制首次快照兜底，保存的厂商未来重置事实持续可展示 |
| P2-2 接口合同 | 冻结窗口字段、来源、未知原因、兼容错误码及同源重试时间 |
| P2-3 前置异常 | 现有 Worker 内独立捕错，前置任务失败仍尝试 quota Tick |

## 2. 用户提示与时间

文案沿用用户确认模板：“Kimi 厂商 5 小时额度已用完，预计 10 月 3 日 01:16（北京时间）恢复，系统将自动恢复服务，请届时重试。”周额度替换窗口名称并使用周时间。两项都耗尽时写明两项，整体预计时间取较晚值；任何阻断时间未知时说明整体时间暂未知及自动检查。只知道套餐耗尽而无法归属窗口时写“套餐额度”，不猜成周额度。

时间到达但余量未确认时：“Kimi 厂商周额度已用完，已到预计恢复时间，系统正在自动确认，请稍后重试。”不把下一次查询时间冒充厂商恢复时间。中文统一 Asia/Shanghai，跨年补全年份。

每窗口时间优先级：明确同窗口上游未来 reset_at → 明确窗口耗尽响应的 Retry-After → 同企业／资源／窗口、SUCCESS、remaining<=0、最后成功不超过10分钟的快照。非法日期、负间隔、跨资源、失败快照及过去时间不能填预计时间。不得以报错时间加5小时或7天计算。

首次采信后存入当前耗尽记录，记录内厂商指定的未来重置点不因10分钟过去失效；后续成功查询可以更新日期或证实恢复，失败不抹掉仍在未来的日期。原预计点已过去时整体 next_reset_at=null，显示正在确认。用户整体时间取同资源阻断窗口 max，检查可先在较早点进行。

首次错误、准入拒绝及等待期间重复请求共用呈现。普通频率／并发429、主体额度、权限及管理员策略不套用窗口文案。首次失败指向实际失败资源；多个CP资源的池级原因不可用一个账号时间代表。新请求存在健康CP可沿用该模型原始选路；当次遇到明确耗尽后不新增其他资源 Attempt。

## 3. 北向字段与兼容

未提交耗尽返回 HTTP429、type=rate_limit_error、request_id及x-request-id；已提交流沿用合法协议内错误，不改HTTP状态、不伪装成功、不追加其他模型输出。

| error字段 | 冻结合同 |
|---|---|
| provider | 可明确时 canonical kimi／zhipu，跨厂商池无法归属时省略 |
| quota_block_scope | RESOURCE 或 MODEL_POOL |
| quota_windows | 按 FIVE_HOUR、WEEKLY 排序的数组，每项为 type、reset_at、reset_source |
| quota_window_unknown | boolean；证明套餐耗尽但窗口无法归属时为true，空数组不表示已恢复 |
| reset_at | ISO或null；不含资源凭证或内部故障ID |
| reset_source | UPSTREAM_RESET_AT／UPSTREAM_RETRY_AFTER／PROVIDER_SNAPSHOT／EXHAUSTION_RECORD／null |
| next_reset_at | 同资源全部阻断时间的max ISO；未知、已过去或多资源不可聚合为null |
| not_calculable_reason | null／PROVIDER_RESET_TIME_UNKNOWN／PROVIDER_RESET_TIME_PASSED／MULTIPLE_RESOURCE_RESET_TIMES |
| retry_after_ms | 有未来整体时间时max(1000,ceil(reset-now))，否则省略 |
| retryable | 可信未来时间时true，表示届时可发起新请求；否则false，用户仍可稍后手动重试 |

有next_reset_at时Retry-After=ceil(retry_after_ms/1000)，三者同源。该信息不使Gateway自动重放；客户端是否遵循等待时间单独验收，不能声称服务端控制客户端行为。

既有code语义：首次5小时为 upstream_window_exhausted，首次周／双窗口／未知套餐为 upstream_quota_exhausted，准入有耗尽记录为 provider_quota_exhausted。普通冷却仍 resource_rate_limited，权限错误不改为额度错误。

示例（合成周额度响应，假定响应时刻为2026-10-05T02:16:00Z，此时Retry-After为3600秒；实际值仍由真实响应时刻派生）：

```json
{"error":{"message":"Kimi 厂商周额度已用完，预计 10 月 5 日 11:16（北京时间）恢复，系统将自动恢复服务，请届时重试。","type":"rate_limit_error","code":"upstream_quota_exhausted","provider":"kimi","quota_block_scope":"RESOURCE","quota_windows":[{"type":"WEEKLY","reset_at":"2026-10-05T03:16:00.000Z","reset_source":"UPSTREAM_RESET_AT"}],"quota_window_unknown":false,"next_reset_at":"2026-10-05T03:16:00.000Z","not_calculable_reason":null,"retry_after_ms":3600000,"retryable":true,"request_id":"example-request"}}
```

时间未知时reset_at、reset_source、next_reset_at为null，not_calculable_reason=PROVIDER_RESET_TIME_UNKNOWN，retryable=false，无Retry-After。双窗口例为quota_windows同时包含FIVE_HOUR和WEEKLY，整体next_reset_at取两者较晚值；任一时间null则整体null。

未提交响应的Chat、Messages、Responses沿用当前Gateway共有的`{error:{...}}`外壳和HTTP429，本轮只扩展error内字段，不更换端点外壳；协议集成测试逐端点核对。已提交流使用各自既有Writer错误事件，至少承载同一message/code/request_id，不强行注入未提交HTTP头。多资源无法聚合时scope=MODEL_POOL、next_reset_at=null、reason=MULTIPLE_RESOURCE_RESET_TIMES，quota_windows=[]、quota_window_unknown=true，中文说明套餐资源受阻但整体时间未知，不伪装成一个账号的双窗口。

## 4. 当前耗尽记录与最小迁移（F1）

确定采用additive迁移，候选 `0087_coding_plan_quota_block_state`，真正实施前核对迁移头和编号冲突。本轮不创建迁移代码。

- provider_resource增加 `quota_state_revision bigint NOT NULL DEFAULT 0` 和 `quota_block_state jsonb NULL`。
- availability_event增加nullable `quota_block_incident_id uuid`，只关联明确CP耗尽来源事件；无新平台表。
- block严格白名单schema v1：schemaVersion=1、incidentId、credentialVersion（沿用当前nullable版本精确比较）、startedAt、unknownWindow、windows。windows只允许FIVE_HOUR/WEEKLY，每项存observedAt、resetAt、resetSource，无凭证／正文／原始厂商消息。
- NULL表示无活跃新合同记录；windows={}且unknownWindow=true表示有未知窗口的套餐阻断，不能当成恢复。

首次明确耗尽或当前凭证成功查询证明窗口零值时创建incident。未解除期间合并新耗尽窗口，每次新故障递增revision，包括同状态故障；单窗口当次成功remaining>0只解除该窗口，缺失／UNSUPPORTED／FAILED／STALE不解除。全部解除清空record，下一周期产生新incident，不能无限追溯旧零值。

Kimi始终要求当次5小时和周均可知且>0。智谱要求5小时可知且>0、当次返回其他窗口也>0，并要求所有已记录阻断窗口当次>0。unknownWindow套餐阻断须当次两窗口均可知且>0才解除，缺失周不作为恢复证据。

有活跃额度记录时凭证更换废弃旧incident并创建新凭证unknownWindow待确认记录，递增revision；不把新凭证推定为有余量。真实鉴权恢复资格不改变。

旧资源不扫描或改写历史403。发布窗口先用新代码GET当前凭证额度初始化明确零值，并关联同资源明确QUOTA_EXHAUSTED来源事件；普通429无证据不转成耗尽。无法归属历史事件保持独立阻断并列出验收缺口，不猜历史凭证／故障代次。

## 5. 到期门禁与自动恢复（F2）

CP明确窗口／套餐耗尽统一副作用 UPSTREAM_BILLING_BLOCKED→EXHAUSTED并保存block；普通频率429仍RATE_LIMITED。Gateway候选过滤和Attempt前检查block，不能只看status。即使人工恢复或迟到成功将status设为DEGRADED，活跃block仍阻止生成；相关管理恢复入口尊重此额度门禁，不改变鉴权恢复资格。

到时只安排GET。带当前incident标签的额度事件不由recoverDueEvents按时钟关闭，由有效额度事务关闭；无标签普通频率、计划停用、鉴权和其他手动阻断保持原行为。关联额度事件即使原规则为MANUAL，也随证实恢复自动解除，管理员无需第二道操作。

仍零值／缺失必需窗口时保持阻断，下一检查取已耗尽窗口的最早未来点；未知或查询失败取now+5min。nextCheck仅调度，永不填next_reset_at。全部恢复后自动DEGRADED、刷新原有效Key模型集合并解除关联额度事件；正常请求成功后ACTIVE。其他阻断不因额度恢复解除。

## 6. 初始选路与付费保护（F3）

本次不增加付费例外。状态过滤前，从同企业、当前有效Key、目标模型的原始有效Grant与启用未归档路由集合判定intent：存在已授权CP路由即PLAN_ONLY，临时耗尽不改变；API-only模型沿用原行为。

PLAN_ONLY在初始候选、dispatch SWITCH、重选和Attempt前四处排除API。明确耗尽结束请求，不转用别的模型、资源或余额；新请求可选该模型原配置健康CP，没有健康CP就返回阻断。allow_overage、api_fallback_enabled、技术授权、余额及未验证请求头均不能解除门禁。以后额外付费许可另立明确可审计设计，本次不接受任何隐式许可。

## 7. 条件提交与事务（F4）

Worker和管理员手动额度GET共用提交入口。GET前短事务读取queryToken：enterpriseId/resourceId、resource.version、credential_version、quota_state_revision、incidentId、实际端点配置hash、queryStartedAt；网络在事务外。

提交先锁资源，再provider FOR SHARE核对状态／归档／配置，全部token匹配才允许更新。旧结果标SUPERSEDED（仅元数据），不得写当前窗口、状态、nextCheck或事件。revision防同状态新故障，credential_version防旧凭证，hash防端点变化；不以updated_at代替故障代次。

同事务顺序：条件核验→FIVE_HOUR/WEEKLY固定顺序写入→合并／解除block→状态迁移→仅关闭同resource+incident的额度事件→按主体ID稳定排序、沿用现有授权互斥刷新Key→revision+1及审计。需提供trx接口，不能串接各自开事务的旧仓储方法。任何一步失败全回滚，不先放行后补Key；已撤销Key／Grant不复活。

首次明确耗尽的故障与关联额度事件创建也遵循同一资源优先事务，创建incident后直接绑定事件；不得先独立创建quota事件再回填incident。北向和资源健康仅公开安全投影，新增内部block不得随selectAll资源响应泄露到客户端；所有当前资源响应需核对投影。

相关失败／成功、额度调度、管理员恢复、凭证轮换及归档写入必须使token失效。迟到上游失败也校验实际调用的凭证与配置，不能写到新凭证。核对与现有资源／principal授权锁交叉路径的统一锁顺序；PG冲突最多两次短事务重试，每次重核token，重试不重复GET。

同一CP资源实际上游成功或故障写入，即使原status不发生迁移，也递增quota_state_revision；因Key未授权等未访问上游的拒绝不改变该revision。凭证／管理前提写入及当前额度观察的有效提交也递增，确保“同状态”不等于“同故障”。

查询失败也比较token，仅更新失败观察与nextCheck，保留block和未来reset，不能改变鉴权原因。两个同token结果只接受首次提交，其他丢弃后下个Tick重新查询。

## 8. Worker异常边界（P2-3）

沿用现有scheduler，将infrastructure/runtime/forecast/quota各自await+catch，原任务失败独立记录，前置失败仍尝试quota；quota失败不跳过其他独立任务，下一Tick继续。单资源失败不阻止其他到期资源，DB／KEK初始化错误不能冒充空成功。不新建并发调度服务或改变日报语义；自动检查以Worker持续运行且DB可用为前提。

独立捕错不把整轮伪装成功：保留各任务结果，任一必需任务失败则整轮summary标失败并反映到调度健康；若现有health依赖异常，所有独立任务尝试完成后再汇总报告，不能在quota之前提前退出。

## 9. 工作包与验收

WP1：Contracts、最小迁移、白名单block／revision及trx仓储。WP2：Provider确定性窗口识别、时间呈现、首次／准入错误、PLAN_ONLY及Attempt终止。WP3：全窗口条件恢复、事件／Key、管理写入的token失效、Worker异常边界。WP4：定向验证与发布准备。OpenSpec tasks列出每项及验证办法，全部未执行。

保留v1.0 A1—A14，增加：

| 编号 | 验收场景与通过标准 |
|---|---|
| B1 | 到期而Worker未查询／失败：零生成Attempt、零半开，具体提示仍在 |
| B2 | 周字段消失、重启、新周期：当前阻断不丢，旧零值不永久阻断，新incident不被旧结果清除 |
| B3 | CP+API初选／SWITCH／新请求：付费API Attempt=0，API-only对照不受影响 |
| B4 | GET后轮换、新EXHAUSTED、归档：token失效且无当前写入 |
| B5 | 窗口／状态／Key／事件阶段故障：全事务回滚，不出现部分放行 |
| B6 | 周等待超过10分钟后到期：未来reset持续可读，到期显示确认中，不造下一恢复日期 |
| B7 | 前置任务异常、单资源失败、初始化失败：quota仍尝试、其他资源和下Tick继续，失败独立 |
| B8 | 旧资源、真实鉴权、未归属事件：不改历史403，不误清其他阻断，旧缺口明示 |
| B9 | 客户端忽略重试时间、等待期间撤权：服务端零后台重放，不恢复撤销权限，客户端可见性单验 |

使用合成响应及隔离PG，不消耗模型额度制造故障；执行定向回归、typecheck、lint、build，基线失败单列。OpenSpec格式、技术验证、部署健康与实际客户端业务验收分开报告。

## 10. 发布、回滚与授权

迁移为additive，down不得删除已有耗尽事实。重新核对源码／schema／镜像，排空相关在途请求，新增字段后由新代码做一次额度GET初始化，再切新Gateway，核对混合路由及原Key调用。

回滚先暂停本能力受保护模型流量，保留新字段／阻断记录，只退镜像。旧代码缺少新门禁，不能直接恢复受保护流量并声称计费限制仍有效；需安全修复候选或受控确认恢复条件。其他纯API模型按原范围处理。

本轮未修改业务代码、未创建迁移文件、未提交推送或部署。实施与部署分别授权，服务器操作继续一步一条指令。
