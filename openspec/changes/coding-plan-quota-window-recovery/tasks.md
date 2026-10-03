# Tasks

> v1.1实施清单；实施授权已由用户于2026-10-03在最新 main（`a3fa0b5`）上开启；部署仍 `DEPLOYMENT_NOT_AUTHORIZED`。
> 状态：20/22 勾选（5.4/5.5 部署与客户端验收未完成，未授权）。2026-10-03 复核三缺陷已修复；2.2/5.2 已补本地验收（见交付报告 §3.2）。
> 实施记录与验证证据：`V4/Evidence/CODING-PLAN-QUOTA-WINDOW-20261003/实施交付报告-20261003.md`。
> 2026-10-03 用户明确授权本功能 commit 与 GitHub push；5.4/5.5 的部署及客户端业务验收仍未执行。

## 1. 基线、合同与持久化

- [x] 1.1 明确实施授权后锁候选SHA/tree、迁移头及工作区改动，验证基线与来源一致。（分支 `codex/quota-window-recovery-20261003` 基于 `a3fa0b5`；迁移头核对 0086 → 新增 0087；报告附基线对照）
- [x] 1.2 实现计划§3的Contracts/Outcome窗口字段及错误码，合同测试验证已知、未知、双窗口、池范围和重试时间同源，并验证资源selectAll响应不会泄露内部block。（`QuotaBlockErrorDetail` 冻结类型 + `quota-window-presentation.test.ts` 9例 + provider 列表投影为硬编码白名单，结构上不可能携带新列）
- [x] 1.3 编写最小additive迁移与DB类型，隔离PG验证默认值、严格记录解析、有事实时down保护。（`0087_coding_plan_quota_block_state`；集成测试 3 例覆盖默认值/down拒绝/白名单解析）
- [x] 1.4 实现incident及revision生命周期，测试周字段消失、重启、真正清除、新周期及凭证轮换验证F1。（`packages/domain/src/quota-block.ts` 纯函数 17 例 + 仓储集成 9 例；重启安全＝事实全部在 PG）

## 2. 条件提交与前提失效

- [x] 2.1 实现queryToken与成功／失败提交，测试同token并发、端点变化、轮换和新EXHAUSTED均无旧结果覆盖。（`QuotaBlockRepository` capture/commit；SUPERSEDED 集成用例：轮换、revision、双提交首次胜出）
- [x] 2.2 窗口、block／状态、Key与关联额度事件同trx提交，阶段故障注入验证全回滚并核对与授权撤销的锁顺序。（`quota-block-transaction-faults.integration.test.ts` 7 例：四阶段 BEFORE 触发器注入异常→整事务回滚快照一致、失败提交保鲜阶段回滚、注入清除后可正常恢复、恢复提交与授权撤销 8 轮并发交替无死锁逃逸/无部分状态——资源锁→主体锁单向序）
- [x] 2.3 故障／成功、调度、管理员恢复／轮换／归档使token失效，测试迟到失败和管理并发不穿透block。（recordFailure/recordSuccess CP 递增 revision；管理更新/恢复/轮换递增；归档由 token 核验的 archived_at/provider 状态拦截；迟到失败 SUPERSEDED 集成用例）
- [x] 2.4 Worker与管理员额度GET接到同一条件提交入口，竞争测试验证没有独立双写或错误解封。（`runCodingPlanQuotaTick` 与 `POST /provider-resources/:id/quota-sync` 共用 capture/commit；同 token 双结果只接受首次）
- [x] 2.5 明确耗尽故障与quota事件同资源优先事务创建并绑定incident，测试无先建事件后回填的部分状态。（`recordCodingPlanExhaustionFault` + `recordQuotaIncidentSignal` 同事务；集成用例断言 incidentId 绑定与同 incident 去重）

## 3. Gateway门禁及提示

- [x] 3.1 Provider明确窗口／套餐耗尽归一化，合成码和语义测试证明普通429及真实鉴权保持独立；不调查旧403。（`mapToClassification(outcome, mode)`：CP WINDOW_EXHAUSTED→UPSTREAM_BILLING_BLOCKED；w18/RA-W04/CPQW 合成用例；主体额度仍 DOWNSTREAM_AUTH_OR_QUOTA）
- [x] 3.2 实现可信时间及持久reset呈现，测试10分钟兜底、长周等待、时间过点、跨年、双窗口max及未知。（快照兜底限10分钟且要求 remaining<=0；过点→PROVIDER_RESET_TIME_PASSED+确认中文案；跨年补全年份；单元 9 例 + w18 快照兜底例）
- [x] 3.3 首次、准入和隔离重试接同一呈现，三协议／已提交流测试验证机器字段与中文原因，不伪装成功。（共用 `quotaWindowPresentation`；chat/messages 集成用例；已提交流 `streamWriter.fail` 承载同 message/code；Responses 同 `{error:{...}}` 外壳）
- [x] 3.4 过滤前固定PLAN_ONLY，初选／SWITCH／重选／Attempt前排除API，混合CP/API测试为零付费Attempt，API-only对照通过。（`scopePlanOnlyCandidates` + SWITCH 候选集 + Attempt 前防线；CPQW 集成 B3 用例 + API-only 对照）
- [x] 3.5 明确耗尽硬阻断且不追加Attempt，测试到期但Worker未查询、失败、人工status改变均零生成半开。（`listServableResources` 排除活跃 block + Attempt 前门禁；集成用例：管理改 status 仍零生成、重复请求零上游调用）

## 4. Worker恢复

- [x] 4.1 沿用定点及5分钟检查并执行全阻断窗口条件，Kimi双窗、智谱周缺失、未知套餐、一窗仍零测试无需管理员操作。（提交入口内 `applyQuotaObservation`；Kimi 双窗恢复、周 UNSUPPORTED 不解除、unknown 双窗确认、一窗仍零保持阻断；worker runner 集成 3 例）
- [x] 4.2 关联额度事件排除纯时钟恢复，事务中闭环；普通频率、鉴权、计划停用和未归属事件对照不误清。（`recoverDueEvents` 排除 `quota_block_incident_id IS NOT NULL`；恢复事务关闭同 incident 事件；无标签事件行为不变）
- [x] 4.3 前置任务独立捕错仍尝试quota，前置异常、单资源失败及初始化错误测试保证其他资源和下Tick继续，且整轮失败及health不被catch伪装成功。（`runIsolatedOperationalTask`/`summarizeIsolatedOperationalRound` + 单元测试；worker runner 单资源失败逐资源隔离原有）

## 5. 验证与发布准备

- [x] 5.1 对应v1.0 A1—A14及v1.1 B1—B9整理证据，定向回归/typecheck/lint/build通过或单列基线失败。（见实施交付报告：定向回归全部通过；基线存量失败单列——与本变更无关）
- [x] 5.2 隔离PG完整原Key耗尽→重试提示→自动恢复→成功调用，验证撤权、缓存失效、零付费回退、零后台重放及预占／租约释放。（`cpqw-key-recovery-chain.test.ts` 2 例：耗尽当刻租约 released_at+预占 counter=0；等待期重试零上游零新 Attempt；恢复自动重算 Key 缓存（阻断期被清空→自动恢复）；同 Key 200 且计量 150、租约再释放；撤权对照恢复后仍 403 非额度提示、不复活、零上游）
- [x] 5.3 准备最小迁移、旧资源GET初始化、混合路由影响与安全回滚，证明旧镜像缺门禁时受保护流量不直接重开。（迁移已备；GET 初始化＝提交入口在存量资源上确认零值即建 incident；发布/回滚步骤见报告 §发布与回滚）
- [ ] 5.4 独立部署授权后一步一条操作发布，验证镜像/schema/Worker，保存备份和回滚信息；未授权前不执行。（部署未授权）
- [ ] 5.5 实际客户端确认中文提示可见与原Key自动恢复，分别报告技术、部署及业务验收。（待部署后）
