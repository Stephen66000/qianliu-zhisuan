# Design

> 2026-10-03，v1.1；`PLAN_REVIEW_PASS / IMPLEMENTATION_NOT_AUTHORIZED / DEPLOYMENT_NOT_AUTHORIZED`。
> 唯一计划来源：`V4/Coding-Plan窗口额度提示与自动恢复开发计划-v1.1-20261003.md`。以下是确定方案，不是已实施修复；v1.0和初审证据保留。

## Context

见proposal.md的Why。基线7f3557f已有额度查询和自动恢复。旧路径逐窗口写入，以resourceId恢复，5小时被归为普通RATE_LIMITED；资源过滤可能让API成为唯一候选。需要使提示、真实额度确认、调用门禁与付费边界一致。

## Goals / Non-Goals

**Goals:** 复用现有资源、Worker及事件结构，定义持久窗口阻断、准确时间、同Key条件自动恢复和禁止隐式付费。

**Non-Goals:** 不追查历史403、不创建付费许可UI或新调度平台、不调用Chat探针、不更改纯API模型正常行为；本轮不实施或迁移。

## Decisions

### D1. 当前耗尽记录及周期（F1）

采用additive迁移，在provider_resource加入quota_block_state和quota_state_revision，在availability_event加nullable quota_block_incident_id；候选0087，实施前核编号。计划§4冻结schema v1、nullable credentialVersion、incident生命周期与新周期清除规则。

缺失／不支持不清窗口，正余量才清；unknownWindow有独立阻断含义。Kimi双窗口必需；智谱保留曾经明确的周阻断；未知套餐须当次双窗口均正余量。凭证轮换时活跃block替换为新凭证未知额度记录，不推定新凭证充足。

不采用无限回溯旧零值，避免旧凭证／旧周期永久阻断；不建新平台表。

### D2. 耗尽硬门禁（F2）

明确CP耗尽统一EXHAUSTED及block；普通频率429保持RATE_LIMITED。选路和Attempt前以block检查，时间到不生成半开。人工status改变也不得穿透block；鉴权恢复资格保持原规则。

当前incident关联事件不按时钟直接关闭，只由有效额度提交解除；普通频率、计划停用、鉴权及非关联手动阻断不变。已关联额度事件不再要求管理员点击恢复。未知时间／查询失败5分钟重试，其他按厂商窗口定点；nextCheck与next_reset_at分开。

### D3. 原始候选固定PLAN_ONLY（F3）

计划§6明确：同Key目标模型的原始有效授权集合只要有启用未归档CP路由，状态过滤前固定PLAN_ONLY；CP临时耗尽不改变意图。初选、SWITCH、重选及Attempt前排除API。API-only集合正常保留。

本次不提供CP→API额外付费许可。配置回退、allow_overage、余额和模型权限均不是支付授权；未来显式支付许可另立设计。仅末端BREAK会漏掉初选，不能作为唯一保护。

### D4. 查询归属与原子提交（F4）

GET前短事务捕获resource.version、credentialVersion、quotaRevision、incident、端点hash及queryStartedAt；网络在事务外。提交资源锁→provider共享锁核验→固定窗口顺序→block／状态→同incident额度事件→原Key集合→revision及审计，详见计划§7。只有token全部匹配提交，旧结果SUPERSEDED且不写当前事实。

成功、失败、下一检查均条件提交，两个同token结果仅接受首个。相关状态迁移、管理恢复、轮换／归档使token失效，迟到旧凭证故障也不落到新凭证。全链需要trx接口，不能拼接单独事务；复用现有principal授权互斥并核对统一锁顺序。PG冲突最多两次短事务重试，重核token但不重复GET。

实际CP上游成功或故障即使不迁移status也递增额度revision，未访问上游的Key拒绝不递增；每个有效查询提交及管理前提变更同样失效旧token，具体覆盖见计划§7。

明确耗尽的故障事实与关联事件创建也必须在同一资源优先事务，不先独立创建事件再回填incident。其他普通signal沿用原行为。不采用只有行锁或updated_at比较的方案。

### D5. 时间与新鲜度（P2-1）

首次快照兜底限制10分钟、SUCCESS及确实零值。incident内厂商指定的未来reset保持有效，不因采集老化丢失；到期未恢复next_reset_at=null，显示自动确认。未知和双窗口规则按计划§2，检查时间不冒充恢复时间。

### D6. 兼容接口（P2-2）

计划§3冻结quota_windows、quota_window_unknown、quota_block_scope、时间来源、null原因及code映射。已知未来时间retryable=true且Retry-After／retry_after_ms同源，未知retryable=false并省略时间头；并不代表Gateway后台重放。

首次、准入、隔离重试和三协议共用呈现；池级不可聚合时MODEL_POOL／MULTIPLE_RESOURCE_RESET_TIMES，不将单账号日期冒充整个池日期。客户端实际展示单独验收。

### D7. Worker异常隔离（P2-3）

infrastructure/runtime/forecast/quota各自捕错；前置异常仍尝试quota、单资源失败仍处理其他资源，下一Tick继续。DB／KEK错误保持真实失败；不新增调度平台或改变日报语义。

各任务失败保留，整轮汇总及调度health不因catch变成功；如需汇总抛异常，在独立任务尝试完成后报告，不提前跳过quota。

## Risks / Trade-offs

- [新增最小迁移] → 仅三列，无新平台，保留账本与审计；有事实时禁止破坏性down。
- [混合路由隐式付费行为改变] → PLAN_ONLY是本次明确计费边界，发布核对所有受保护模型，API-only不改。
- [厂商长期缺失曾耗尽窗口] → 保持阻断并自动查询，不用猜测解封；文案保持未知。
- [历史事件无法归属] → 新代码当前凭证GET初始化，明确额度来源才关联，未知事件保持并列验收缺口，不追查旧403。
- [原Key缓存延迟] → 按现有缓存失效／TTL核验恢复路径，不承诺毫秒级放行；不得恢复撤销权限。
- [旧镜像回滚缺新门禁] → 先暂停受保护模型，保留新事实，不直接恢复旧流量并宣称计费安全。
- [客户端忽略错误和重试头] → 服务端零后台重放、零API回退，实际提示可见性单独验收。

## Migration Plan

按计划§10：锁候选与schema，排空在途请求，additive字段后用新代码一次GET初始化，切新Gateway并核原Key及混合路由。down不删已生成事实。

回滚先暂停受保护模型再退镜像，保留block；受保护流量等安全修复候选或受控确认。实施／部署分别授权，本轮没有创建或执行迁移。

## Open Questions

只剩实际客户端是否原样展示中文提示，在候选环境验证；不影响上述实现或任务拆分。存储、门禁、付费规则、事务与调度均已作确定选择。
