# ADR：运行保障规则版本、六态迁移与运行配置

| 项目 | 内容 |
| --- | --- |
| ADR | `ADR-RUNTIME-ASSURANCE-FOUNDATION` |
| 日期 | 2026-08-01（Asia/Shanghai） |
| 状态 | `ACCEPTED`（RA-W01） |
| 关联变更 | `PC-20260731-11` |
| 关联迁移 | `0030_runtime_assurance_foundation.js` |

## 1. 决策

1. 可用性规则采用“稳定身份 `availability_rule` + 不可变业务版本 `availability_rule_version`”双表；不沿用 `billing_rule`、`dispatch_policy` 的单表版本模式。
2. 当前运行保障只服务一个本地工作空间，新增七张表不含 `tenant_id`、`enterprise_id`，不增加企业选择器或租户隔离中间件。既有表的历史企业边界不在 RA-W01 重构。
3. `provider_resource.status` 既有六态暂不改写；`0030` 只增加 Schema。W05B 必须先用本文规则做只读盘点和 Shadow 对比，得到审核 Evidence 后才能执行数据迁移。
4. 平台运行配置固定为 `OFF / OBSERVE / ENFORCE`，安全默认 `OBSERVE`；企微正式通知默认关闭。配置项为：
   - `RUNTIME_ASSURANCE_MODE=OFF|OBSERVE|ENFORCE`
   - `RUNTIME_ASSURANCE_WECOM_NOTIFY=true|false`
5. 企业微信只建一条有效自建应用配置，后续按人员内部成员 `userid` 定向发送；不设计通知群或群机器人 Webhook。

## 2. 为什么选择双表

| 维度 | 既有单表模式 | 双表模式 | 结论 |
| --- | --- | --- | --- |
| 稳定 URL／对象身份 | 每个版本都是新行，缺少稳定规则身份 | `availability_rule.id` 永久稳定 | 双表更清晰 |
| 草稿与已发布并存 | 需要额外 lineage 字段约定 | 同一规则下版本状态明确 | 双表更清晰 |
| 预约生效／失效 | 可实现，但身份与版本混在一行 | 生效边界只属于版本 | 双表更清晰 |
| 编辑已发布规则 | 容易误写原行 | 新建 `DRAFT`，旧 `PUBLISHED` 不覆盖 | 双表更安全 |
| 回滚 | 复制旧行时难表达“回到哪个稳定对象” | 从历史版本生成同一规则的新版本 | 双表更清晰 |
| 事件冻结 | 可冻结行 ID，但难同时表达稳定规则 | 事件冻结规则 ID、版本行 ID、业务版本号 | 双表更可审计 |

`billing_rule` 和 `dispatch_policy` 已有实现不在本工作包重构。运行保障对稳定身份、草稿、预约、历史和事件冻结的要求更强，强行统一成单表会把 lineage 约定推到应用代码，风险高于新增一张身份表。

业务版本与并发版本必须区分：

- `rule_version`：同一稳定规则下单调递增的业务版本；
- `version`：当前行写操作的单调乐观锁；
- 已发布版本禁止原地覆盖；编辑、停用、重新启用和回滚都生成新业务版本。

## 3. Schema 边界

`0030` 新增：

- `person`、`person_external_identity`；
- `availability_rule`、`availability_rule_version`、`availability_event`；
- `notification_endpoint`、`notification_delivery`。

既有表只做加法变更：

- `principal.person_id`、`principal.owner_person_id`、`principal.version`；
- `alert_event.availability_event_id`。

人员关系先保持 nullable，避免 RA-W02 完成映射前破坏既有主体写路径。RA-W02 必须在 API 层执行：启用的人主体有 `person_id`、启用的项目主体有 `owner_person_id`；历史缺口盘点完成后再评估数据库约束验证。

`notification_endpoint.secret_ciphertext` 只允许密文，另存指纹；`notification_delivery` 不保存自由消息正文。Secret、access token、上游原始正文不得进入普通字段、日志或 Evidence。

## 4. 既有六态迁移方案

RA-W01 不直接更新生产或本地业务数据。W05B 执行前按每个资源的当前状态、最近 `resource_status_event`、规范化信号和活跃事件做只读盘点：

| 旧状态 | 目标健康 | 目标可用性 | 迁移条件 |
| --- | --- | --- | --- |
| `ACTIVE` | `ACTIVE` | `ALLOW` | 直接保留 |
| `DEGRADED` | `DEGRADED` | `ALLOW` | 直接保留 |
| `UNAVAILABLE` | `DEGRADED` | `ALLOW` | 最近原因是 5xx、超时、网络、连续失败或普通限流等技术故障 |
| `UNAVAILABLE` | `DEGRADED` | `BLOCKED_UPSTREAM / BLOCKED_SCHEDULE` | 只有存在已确认上游信号／计划规则，并创建对应 Shadow 事件候选 |
| `EXHAUSTED` | `DEGRADED` 或既有事实展示 | `BLOCKED_UPSTREAM` | 必须有 Adapter 确认额度信号及恢复证据 |
| `EXPIRED` | `DEGRADED` 或既有事实展示 | `BLOCKED_UPSTREAM` | 必须有已确认套餐／凭证过期证据 |
| `CREDENTIAL_INVALID` | `DEGRADED` | `BLOCKED_UPSTREAM` | 必须有已确认凭证拒绝证据 |

没有确认来源的 `EXHAUSTED / EXPIRED / CREDENTIAL_INVALID / UNAVAILABLE` 一律进入 `REVIEW_REQUIRED`，不得只凭旧状态自动创建正式熔断事件，也不得无证据自动放行。

Shadow 对比至少输出：资源 ID、旧状态、最近稳定 reason code、候选健康状态、候选可用性、证据来源、是否需人工复核。正式迁移只能在 `OBSERVE` 窗口完成误判复核后执行。

## 5. 三级运行模式

| 模式 | 规则判断 | Shadow／预警 | 正式事件 | 阻断请求 | 正式企微通知 |
| --- | --- | --- | --- | --- | --- |
| `OFF` | 否 | 否 | 否 | 否 | 否 |
| `OBSERVE` | 是 | 是 | 否 | 否 | 否 |
| `ENFORCE` | 是 | 是 | 是 | 按已发布规则 | 还需企微开关为 `true` |

配置加载严格校验枚举和小写布尔值；`enforce`、`TRUE` 等值启动失败，避免误开启。运行模式是全系统灰度／回退开关，不替代厂商、模型或资源规则启停。

## 6. 回滚与后续边界

- `0030 down` 删除新增表和新增关系列，不修改 `provider_resource` 六态数据；本地回滚可逆。
- 一旦产生正式人员、事件或通知历史，发布回滚优先保留加法 Schema，通过 `OFF` 和通知关闭回退功能，不做破坏性生产降级。
- RA-W01 不实现规则匹配、事件写入、Gateway 硬熔断、Worker 恢复或企微发送；这些分别属于 RA-W03～W06。
