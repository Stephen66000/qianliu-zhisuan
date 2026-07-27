# W10 Evidence：Kimi Adapter 与 Coding Plan 能力

| 项目 | 内容 |
| --- | --- |
| 工作包 | W10（Kimi Adapter 与 Coding Plan 能力） |
| 里程碑 | M3（三厂商、凭证与账号池，W09～W12） |
| Stage | Stage 03 / D2 |
| 日期 | 2026-07-27 |
| pnpm-lock.yaml sha256 | 与 M2/W09 一致（未新增依赖） |
| 迁移文件 | 无新增（复用 M1 0005 provider/provider_resource 已支持 `code: kimi` + `mode: CODING_PLAN`） |
| 结论 | **PASS** —— W10 DoD 达成（离线契约通过；真实凭证仅阻塞上线签字） |

## 1. W10 DoD 达成情况

| DoD 项（详细计划行 286，同 W09） | 结果 | Evidence |
| --- | --- | --- |
| Kimi Adapter 与 Coding Plan 能力 | ✅ | `packages/provider-adapters/src/adapters/kimi-adapter.ts` |
| usage 合同 | ✅ | `parseUsage`（原始口径，cache=0 兜底；档位倍数不折算）+ w10-kimi-e2e 断言 |
| 错误合同 | ✅ | `classifyUpstreamError`（TRD §9 全分类）+ 单测 |
| 健康合同 | ✅ | 复用 ProviderAdapter 能力声明 + committed 边界（同 W06/W09 形状） |
| 离线契约通过 | ✅ | provider-adapters 35 单测（含 kimi-adapter 11 新增）+ gateway 28 集成测试全绿 |
| 真实凭证仅阻塞上线签字 | ✅ | DEP-PROVIDER-CREDENTIALS 未解锁；Adapter 形状经 StubUpstream 验证 |

## 2. 本工作包交付物

### 2.1 KimiAdapter（`packages/provider-adapters/src/adapters/kimi-adapter.ts`）
- `providerCode = "kimi"`
- 能力声明：`chat`/`messages`/`stream`/`tools`/`coding_plan`。Kimi 当前公开 Coding Plan 不区分 prompt cache 分项，故**不声明 `prompt_cache`**（与 DeepSeek 区分，与智谱同处理）。
- 模型映射：`qianliu-kimi-k3` → `kimi-k3`（TRD §6.4 行 437 的别名；TRD §7.3 行 489 一期首用模型 Kimi K3；资源接入时可在 `upstream_models` 覆盖）。
- `invoke`：注入 `UpstreamCaller`（StubUpstream / 真实 fetch），透传 Outcome。
- `parseUsage`：OpenAI 兼容形状（prompt_tokens/completion_tokens），`cache=0`，`quality=PROVIDER_REPORTED`。**保留原始 Token/Prompt 口径，不做任何倍数折算**。
- `classifyUpstreamError`：TRD §9 全分类（401/403→UPSTREAM_CREDENTIAL_INVALID、429→UPSTREAM_RATE_LIMITED、5xx→UPSTREAM_TEMPORARY、402→UPSTREAM_BILLING_BLOCKED 等）。

### 2.2 注册表落地（`apps/gateway/src/pipeline/adapter-registry.ts`）
- 启用 W09 预留的 `case "kimi": return new KimiAdapter(caller);` 分支。
- 三厂商注册完整：deepseek / zhipu / kimi；未注册 code 仍抛 `unsupported_provider_code`（不静默降级）。

### 2.3 测试
- `packages/provider-adapters/src/__tests__/kimi-adapter.test.ts`：11 单测（StubUpstream(providerCode=kimi) 5 模式 + 能力声明 + 模型映射 + usage 原始口径 + TRD §9 错误分类 + committed 边界）。
- `apps/gateway/src/__tests-integration__/w10-kimi-e2e.test.ts`：5 集成测试（seed provider.code=kimi + CODING_PLAN resource + qianliu-kimi-k3 别名 + model_route）。

## 3. 边界确认（W10 不做项）

- **模型档位额度倍数**：调研文档提到 `kimi-for-coding-highspeed` 按模型档位 3 倍消耗——这是**模型档位规则，不是分时规则**；倍数折算属版本化计价规则，归 **W13**。Adapter 只保原始用量事实（TRD §7.3 行 491「按模型档位配置额度倍数」的实现位置在 W13 规则版本，不在 Adapter）。
- **周期、限流窗口和套餐有效期**（TRD §7.3 行 492）：按资源配置保存，归 W11 账号池状态机使用；W10 未触碰。
- Coding Plan 账本边界（TRD §7.3 / §10）：`mode=CODING_PLAN` 时 `api_cost=null`、`total_api_cost="0"`、`total_deducted_quota=0`（扣减额度归 W13/W14），w10-kimi-e2e 已断言，未破坏。
- 多 Attempt failover、路由评分归 W12；未引入新依赖。

## 4. WT 代表性运行链覆盖（M3 需求—验收追踪）

| WT | 运行链 | 测试 |
| --- | --- | --- |
| WT-03 员工首次调用（Kimi） | models(qianliu-kimi-k3) → chat → usage 归因 → 账本落账 | w10-kimi-e2e.test.ts |
| WT-05 用量账本可见 | usage 原始口径（input/output，cache=0）+ Coding Plan api_cost=null | w10-kimi-e2e.test.ts |
| WT-13 多厂商路由候选（前置） | findResource 带出 providerCode=kimi，注册表选到 KimiAdapter；deepseek/zhipu 分支不受影响 | w10-kimi-e2e.test.ts |
| canary 0 | Kimi 请求正文在 6 张账本表 0 命中（METADATA_ONLY） | w10-kimi-e2e.test.ts |

## 5. 正式工程命令实测（W10 Audit，2026-07-27 14:22–14:23 于佳哥 Mac 执行）

| 命令 | 结果 |
| --- | --- |
| typecheck | ✅ 11 包全 Done |
| lint | ✅ 11 包全 Done（--max-warnings=0；typescript-eslint 对 TS 5.9.3 的支持区间提示为 stderr 噪音，自 W01 起存在，不产生 ESLint warning，不判定失败；TS 版本为工程规则 §2 冻结基线，不改） |
| test（单测+集成） | ✅ provider-adapters **35**（kimi-adapter 11 新增 + zhipu 11 + deepseek 9 + secret-value 4）、gateway **28**（**w10-kimi-e2e 5** + w09 5 + w08 4 + w05/w07 14）、control-api 23、database 4、config 4、domain 4、contracts 2、observability 4 |
| build | ✅ 11 包全 Done |
| evidence:canary | ✅ postgres/redis/logs/traces 全 0（canary `W01_CANARY_PROBE_SECRET_BODY_20260727`） |

执行环境：macOS，Node v22.17.1 基线（corepack pnpm@11.11.0），Docker Desktop 运行中（Testcontainer PostgreSQL）。

## 6. 残余风险与后续

- **真实 Kimi 回归**：StubUpstream 验证了 Adapter 形状；真实 Kimi HTTP 调用在 `DEP-PROVIDER-CREDENTIALS` 解锁后由佳哥跑（W10 上线签字门禁）。parseUsage 按 Kimi OpenAI 兼容形状实现，若真实返回结构差异，在真实回归时按 TRD §7/§9 微调并记 Planning Change。
- **模型档位倍数折算**：W10 只保原始用量；`kimi-for-coding-highspeed` 等档位倍数属版本化计价规则，归 W13（调研文档「以具体资源上已生效的规则版本为准」）。
- **套餐额度扣减**：W10 `total_deducted_quota=0`（未消费）；预占/耗尽停止在 W14。
- **OAuth/套餐会话刷新退避**：Adapter 接收 SUBSCRIPTION_SESSION 凭证类型，但刷新状态机在 W11。
- **多 Attempt failover**：W10 单 Attempt；committed=false 后切换下一候选在 W12（路由评分）。

## 7. 为 M3 后续工作包预留的集成点

- **W11 账号池状态机**：三厂商 Adapter 齐备（deepseek/zhipu/kimi），`classifyUpstreamError`（凭证失效/限流/耗尽）统一驱动状态迁移与冷却；Kimi 的周期/限流窗口/套餐有效期按资源配置读取。
- **W12 路由评分**：注册表三分支完整，多候选 failover 的 Adapter 解析点就位。
- **W13 计价规则版本**：Kimi `raw_*_tokens` 原始口径 + `api_cost=null`（CODING_PLAN）为档位倍数折算留好事实底座，与智谱高峰倍数同一规则版本框架处理。
