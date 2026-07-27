# M2 Evidence：Gateway 内核和 DeepSeek 纵向闭环（W05+W06+W07+W08）

| 项目 | 内容 |
| --- | --- |
| 里程碑 | M2（Gateway 内核和 DeepSeek 纵向闭环） |
| 工作包 | W05（北向合同）+ W06（DeepSeek Adapter）+ W07（账本闭环）+ W08（端到端） |
| Stage | Stage 03 / D1-D2 |
| 日期 | 2026-07-27 |
| pnpm-lock.yaml sha256 | `c0b0a7ac0d888829bbdf29694abbd72631e862f2f4838815cf7ad295abf424cb` |
| 迁移文件 | 10 个（M1 的 7 个 + M2 新增 3 个：0007/0008/0009） |
| gateway 集成测试 | 18 个全通过 |
| 结论 | **PASS** —— M2 中间 Audit 通过 |

## 1. M2 DoD 达成情况

| DoD 项（详细计划行 118） | 结果 | Evidence |
| --- | --- | --- |
| WT-03/05/11/12/14 DeepSeek 路径 | ✅ | w05/w07/w08 集成测试 |
| 重复结算为 0 | ✅ | w07-ledger.test.ts：UNIQUE(ai_request_id) + ON CONFLICT DO NOTHING |
| 正文 canary 为 0 | ✅ | w07-ledger.test.ts：账本表扫描 0 命中 |
| request_id 贯穿 | ✅ | w08-e2e.test.ts：request/attempt/usage/line/transaction 全引用 |

## 2. WT 代表性运行链覆盖

| WT | 运行链 | 集成测试 |
| --- | --- | --- |
| WT-03 员工首次调用 | models → chat → usage 归因 → 账本落账 | w08-e2e.test.ts |
| WT-05 用量账本可见 | 三维度 Token（input/cache/output）+ API 费用 | w08-e2e.test.ts |
| WT-11 双 Attempt 一个汇总 | 两条不可覆盖 ledger_line + 唯一 ledger_transaction | w07-ledger.test.ts |
| WT-12 流式提交后中断 | StubUpstream failAfterChunk → committed=true 后失败（committed 边界） | provider-adapters 单元测试 |
| WT-14 未支持能力 | 422 + capability_not_supported + 不可重试 | w05/w08 测试 |

## 3. 北向合同冻结（W05，基于 OpenAI/Anthropic 官方规范）

- GET /v1/models → `{ object:"list", data:[{id,object:"model",owned_by:"qianliu"}] }`
- POST /v1/chat/completions 非流式 → `chat.completion` + `choices` + `usage.prompt_tokens/completion_tokens/total_tokens`
- POST /v1/chat/completions 流式 → SSE `chat.completion.chunk` + `data: [DONE]`
- POST /v1/messages → Anthropic `message` + `content blocks` + `usage.input_tokens/output_tokens`
- 错误 envelope → `{ error:{message,type,code,param,retryable,request_id} }`（OpenAI 兼容）
- 能力不支持 → **422** + `capability_not_supported`（WT-14 冻结值）
- request_id 贯穿响应头 `x-request-id`

## 4. DeepSeek Adapter + Stub 上游（W06）

- StubUpstream 5 种模式：SUCCESS/STREAM(含 failAfterChunk)/ERROR/TIMEOUT/CANCEL
- DeepSeekAdapter：能力声明（chat/messages/stream/tools/prompt_cache）、模型映射（alias→upstream）、usage 三维度解析（prompt_tokens_details.cached_tokens）、错误归一化（TRD §9 全分类）
- committed 边界：首个有效输出后 committed=true，之后失败记 STREAM_INTERRUPTED_AFTER_COMMIT
- 真实 DeepSeek HTTP 在 DEP-PROVIDER-CREDENTIALS 解锁后接入（UpstreamCaller 注入点）

## 5. 账本闭环与幂等（W07 核心）

### 数据库表（迁移 0007/0008/0009，6 张）
- ai_request：稳定 ID（Gateway 分配）、principal_id、protocol、status
- route_candidate：候选资源快照、priority/weight、reason_code
- upstream_attempt：序号、资源、http_status、response_committed、error_classification
- usage_event：input/output/cache tokens、usage_quality、**dedup_key UNIQUE**
- ledger_line：不可覆盖明细、api_cost（decimal）、resource_mode
- ledger_transaction：**UNIQUE(ai_request_id)**、汇总 token/费用、attempt_count

### 重复结算为 0 的机制
- ledger_transaction UNIQUE(ai_request_id) + `onConflict doNothing` → 同一请求只有一个结算
- usage_event UNIQUE(dedup_key) + `onConflict doNothing` → 同一计量事实不重复记账
- 验证测试：重复 createLedgerTransactionIfAbsent 返回 undefined，DB 仍只 1 条

### 正文 canary 为 0
- ai_request 只存元数据（model/protocol/status），绝不存 messages/prompt/system
- 扫描 6 张账本表的 row_to_json::text，canary 命中 0（M2 DoD 硬门禁通过）

## 6. 端到端 DeepSeek 代表链（W08）

real-pipeline 串联 StubUpstream + DeepSeekAdapter + GatewayLedgerRepository：
- 创建请求意图 → 候选快照 → Attempt → Adapter 调用 → usage/ledger_line/ledger_transaction 写入 → 北向响应
- 计价简化（M2）：固定单价 input $0.001/1k + output $0.002/1k；完整规则版本在 W13
- request_id 贯穿所有账本对象（验证通过）

## 7. 正式工程命令实测（M2 Audit）

| 命令 | 结果 |
| --- | --- |
| typecheck | ✅ 11 包 |
| lint | ✅ 11 包 |
| test（单测） | ✅ 全通过（含 provider-adapters 13、database 4、observability 4、其他） |
| test:integration | ✅ database 4 + gateway 18 + control-api 23 |
| build | ✅ 11 包 |

## 8. 残余风险与后续

- **真实 DeepSeek 回归**：StubUpstream 验证了 Adapter 形状；真实 DeepSeek HTTP 调用在 DEP-PROVIDER-CREDENTIALS 解锁后由佳哥跑（W06 上线签字门禁）
- **多 Attempt failover**：M2 单 Attempt；committed=false 后切换下一候选在 W12（路由评分）
- **计价规则版本**：M2 固定价格；billing_rule_version + 分时规则在 W13
- **额度热路径**：M2 不消费 quota_counter；Redis 预占/释放/耗尽停止在 W14
- **流式 SSE 端到端**：W05 stub 验证了 SSE 形状；real-pipeline 流式端到端在 W08 简化为非流式（流式 + committed 边界在 StubUpstream 单元测试覆盖）
- **诊断 API**：/gateway-requests/{id} 端点（TRD §11.2）的数据已全部落库，API 路由在 W08 未单独实现（数据可查，路由在 M5 Web 诊断页接入时补）

## 9. 集成点（为 M3 预留）

- W09/W10（智谱/Kimi Adapter）复用 ProviderAdapter 接口 + StubUpstream 模式
- W11（账号池状态机）用 provider_resource.credential_* + 健康分数
- W12（路由评分）用 route_candidate.score_factors + committed 边界
- W13（计价规则版本）用 ledger_line.api_cost + billing_rule_version
- W14（额度热路径）用 quota_counter + Redis 并发租约
