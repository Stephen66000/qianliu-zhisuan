# W09 Evidence：智谱 Adapter 与多厂商 pipeline 串联

| 项目 | 内容 |
| --- | --- |
| 工作包 | W09（智谱 Adapter 与 Coding Plan 能力） |
| 里程碑 | M3（三厂商、凭证与账号池，W09～W12） |
| Stage | Stage 03 / D2 |
| 日期 | 2026-07-27 |
| pnpm-lock.yaml sha256 | `c0b0a7ac0d888829bbdf29694abbd72631e862f2f4838815cf7ad295abf424cb`（与 M2 一致，未新增依赖） |
| 迁移文件 | 无新增（复用 M1 0005 provider/provider_resource 已支持 `code: zhipu` + `mode: CODING_PLAN`） |
| 结论 | **PASS** —— W09 DoD 达成（离线契约通过；真实凭证仅阻塞上线签字） |

## 1. W09 DoD 达成情况

| DoD 项（详细计划行 285） | 结果 | Evidence |
| --- | --- | --- |
| 智谱 Adapter 与 Coding Plan 能力 | ✅ | `packages/provider-adapters/src/adapters/zhipu-adapter.ts` |
| usage 合同 | ✅ | `parseUsage`（原始口径，cache=0 兜底）+ w09-zhipu-e2e 断言 |
| 错误合同 | ✅ | `classifyUpstreamError`（TRD §9 全分类）+ 单测 |
| 健康合同 | ✅ | 复用 ProviderAdapter 能力声明 + committed 边界（同 W06 形状） |
| 离线契约通过 | ✅ | provider-adapters 24 单测 + gateway 23 集成测试全绿 |
| 真实凭证仅阻塞上线签字 | ✅ | DEP-PROVIDER-CREDENTIALS 未解锁；Adapter 形状经 StubUpstream 验证 |

## 2. 本工作包交付物

### 2.1 ZhipuAdapter（`packages/provider-adapters/src/adapters/zhipu-adapter.ts`）
- `providerCode = "zhipu"`
- 能力声明：`chat`/`messages`/`stream`/`tools`/`coding_plan`。智谱当前公开 Coding Plan 不区分 prompt cache 分项，故**不声明 `prompt_cache`**（与 DeepSeek 区分）。
- 模型映射：`qianliu-glm-coding` → `glm-5.2`（调研文档确认的当前 Coding Plan 模型；资源接入时可在 `upstream_models` 覆盖）。
- `invoke`：注入 `UpstreamCaller`（StubUpstream / 真实 fetch），透传 Outcome。
- `parseUsage`：OpenAI 兼容形状（prompt_tokens/completion_tokens），`cache=0`，`quality=PROVIDER_REPORTED`。**保留原始 Token/Prompt 口径，不做高峰倍数折算**（倍数属版本化计价规则，归 W13）。
- `classifyUpstreamError`：TRD §9 全分类（401/403→UPSTREAM_CREDENTIAL_INVALID、429→UPSTREAM_RATE_LIMITED、5xx→UPSTREAM_TEMPORARY、402→UPSTREAM_BILLING_BLOCKED 等）。

### 2.2 StubUpstream 泛化（`stub-upstream.ts`）
- `StubUpstreamConfig` 增加 `providerCode?: "deepseek" | "zhipu" | "kimi"`（默认 `"deepseek"`，向后兼容）。
- 同一 Stub 基础设施可代表不同厂商上游，复用全部 5 种故障模式（SUCCESS/STREAM+failAfterChunk/ERROR/TIMEOUT/CANCEL）。

### 2.3 多厂商 pipeline（解除 deepseek 硬编码）
- 新增 `apps/gateway/src/pipeline/adapter-registry.ts`：`resolveAdapter(providerCode, caller)` 注册表工厂。
- `real-pipeline.ts`：`deps.adapter`（单一）→ `deps.caller` + `resolveAdapter(resource.providerCode)`；`findResource` join `provider.code` 带出 `providerCode`。W10 Kimi 落地后只需在注册表加一行。
- Coding Plan 账本边界（TRD §7.2 / §10）：`mode=CODING_PLAN` 时 `api_cost=null`、`total_api_cost="0"`（套餐模式不产生 API 费用；扣减额度归 W13/W14）。

## 3. WT 代表性运行链覆盖（M3 需求—验收追踪行 315）

| WT | 运行链 | 测试 |
| --- | --- | --- |
| WT-03 员工首次调用（智谱） | models(qianliu-glm-coding) → chat → usage 归因 → 账本落账 | w09-zhipu-e2e.test.ts |
| WT-05 用量账本可见 | usage 原始口径（input/output，cache=0）+ Coding Plan api_cost=null | w09-zhipu-e2e.test.ts |
| WT-13 多厂商路由候选（前置） | findResource 带出 providerCode，注册表选到 ZhipuAdapter | w09-zhipu-e2e.test.ts |
| canary 0 | 智谱请求正文在 6 张账本表 0 命中（METADATA_ONLY） | w09-zhipu-e2e.test.ts |

## 4. 正式工程命令实测（W09 Audit）

| 命令 | 结果 |
| --- | --- |
| typecheck | ✅ 11 包全 Done |
| lint | ✅ 11 包全 Done（--max-warnings=0） |
| test（单测） | ✅ provider-adapters 24（含 zhipu-adapter 11 新增）、database 4、observability 4、其他 |
| test:integration | ✅ database 4 + gateway 23（w09 5 + w05/w07/w08 18）+ control-api 23 |
| build | ✅ 11 包全 Done |
| evidence:canary | ✅ postgres/redis/logs/traces 全 0 |

## 5. 残余风险与后续

- **真实智谱回归**：StubUpstream 验证了 Adapter 形状；真实智谱 HTTP 调用在 `DEP-PROVIDER-CREDENTIALS` 解锁后由佳哥跑（W09 上线签字门禁）。parseUsage 按智谱 OpenAI 兼容形状实现，若真实返回结构差异，在真实回归时按 TRD §7/§9 微调并记 Planning Change。
- **高峰扣减倍数**：W09 只保原始用量；14:00–18:00（UTC+8）的高峰倍数属版本化计价规则，归 W13（调研文档「以具体资源上已生效的规则版本为准」）。
- **套餐额度扣减**：W09 `total_deducted_quota=0`（未消费）；预占/耗尽停止在 W14。
- **OAuth/套餐会话刷新退避**：Adapter 接收 SUBSCRIPTION_SESSION 凭证类型，但刷新状态机在 W11。
- **多 Attempt failover**：W09 单 Attempt；committed=false 后切换下一候选在 W12（路由评分）。

## 6. 为 M3 后续工作包预留的集成点

- **W10 Kimi Adapter**：复用 ProviderAdapter 接口 + 泛化后的 StubUpstream（providerCode=kimi）+ `adapter-registry.ts` 加一行 `case "kimi"`。
- **W11 账号池状态机**：用 `provider_resource.credential_*` + Adapter 的 `classifyUpstreamError`（凭证失效/限流/耗尽）驱动状态迁移与冷却。
- **W12 路由评分**：`route_candidate` 已记录候选资源；按 `providerCode` 选 Adapter 的注册表为多候选 failover 提供解析点。
- **W13 计价规则版本**：`ledger_line.api_cost=null`（CODING_PLAN）+ `raw_*_tokens` 原始口径为倍数折算留好事实底座。
