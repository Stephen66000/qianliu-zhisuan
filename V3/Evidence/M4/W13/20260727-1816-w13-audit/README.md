# W13 Evidence：统一 Token 事实与计价规则版本

| 项目 | 内容 |
| --- | --- |
| 工作包 | W13（统一 Token 事实、Decimal 金额、价格／倍率／周期规则版本、逐 Attempt 计价） |
| 里程碑 | M4（额度／预测／调度／账本，W13～W17） |
| Stage | Stage 03 / D2 |
| 日期 | 2026-07-27 |
| pnpm-lock.yaml sha256 | 无外部新依赖（decimal.js 10.6.0 为工程规则基线，domain 声明使用） |
| 迁移文件 | 新增 `0011_billing_rule.js`（billing_rule 表 + ledger_line 规则版本列） |
| 结论 | **PASS** —— W13 DoD 达成（版本化计价、高峰/档位倍数落地、历史不重算、decimal 精度） |

## 1. W13 DoD 达成情况

| DoD 项（详细计划行 289） | 结果 | Evidence |
| --- | --- | --- |
| 统一 Token 事实 | ✅ | usage_event input/output/cache + ledger_line.raw_*_tokens 原始口径保留 |
| Decimal 金额 | ✅ | decimal.js 10.6.0；`computeApiCostFromRule`/`computeDeductedQuota` 精度测试（大 token 数无浮点误差） |
| 价格／倍率／周期规则版本 | ✅ | `billing_rule` 表（TIME_WINDOW/MODEL_TIER/CACHE_STATE/API_PRICE + rule_version + effective_from/to） |
| 逐 Attempt 计价 | ✅ | real-pipeline `computeBilling` 按 attempt 开始时间+资源+模型匹配；ledger_line 冻结 rule_version/multiplier |
| 历史不重算 | ✅ | 版本冻结测试：改规则后历史 attempt 重算仍命中旧版本 |
| 高峰/档位倍数 | ✅ | 智谱 14:00–18:00 UTC+8 高峰 ×3/非高峰 ×2；Kimi highspeed 档位 ×3 |
| WT-05 | ✅ | 原始用量 + 实际扣减 + 命中规则版本同时可见 |

## 2. 本工作包交付物

### 2.1 迁移 0011（`billing_rule`）
版本化计价规则表：适用资源/模型、规则类型、rule_version、effective_from/to、时段（timezone/days_of_week/start/end_time）、multiplier、cache 三分项价格、priority、source（调研文档要求保存来源）。`ledger_line` 增加 billing_rule_id/rule_version/multiplier（每 Attempt 冻结命中规则）。

### 2.2 规则匹配（`packages/domain/src/billing-rule.ts`）
确定性纯函数：`toZonedTime`（Intl 时区转换）+ `matchesTimeWindow`（星期+起止，支持跨午夜）+ `matchMultiplierRule`（时段/档位→倍率，优先级+特异性排序）+ `matchPriceRule`（API_PRICE）+ `computeDeductedQuota`（raw×multiplier，decimal 整数）+ `computeApiCostFromRule`（cache 命中/未命中/输出分项×单价，decimal 8 位）。

### 2.3 pipeline 计价（`real-pipeline.ts` `computeBilling`）
- CODING_PLAN：api_cost=null（PACKAGE_INCLUDED 语义，不写数值 0），deducted_quota=raw×matched_multiplier（无规则 multiplier="1" 原始口径）。
- API：API_PRICE 规则计价；无规则回退 M2 简化价（过渡期）。
- ledger_line + ledger_transaction 均按规则版本写入。

### 2.4 测试
- `billing-rule.test.ts`：14 单测（时区/时段边界/星期/跨午夜/优先级/特异性/版本冻结/decimal 精度）。
- `w13-billing.test.ts`：4 集成（智谱高峰×3非高峰×2、Kimi 档位×3、API cache 分项、版本冻结不重算）。

## 3. 关键修正（测试预期）

初版「生效区间」测试用 TIME_WINDOW 规则 + 1970 年时间戳（epoch 500/1500ms）,1970-01-01 08:00 CST 不在 14:00–18:00 窗口内导致匹配 null。改 MODEL_TIER（无时段）专注验版本边界。实现本身正确，是测试时间窗设计错误。

## 4. 边界确认（W13 不做项）

- 周期重置任务（重置幂等执行器）：归 worker（W25）；规则字段（周期锚点/下一重置）已在 schema 层预留口径。
- 额度预占/并发租约/耗尽停止热路径：W14。
- 供给预测：W15；经营调度：W16。
- 真实凭证：DEP-PROVIDER-CREDENTIALS。

## 5. 正式工程命令实测（W13 Audit）

| 命令 | 结果 |
| --- | --- |
| install | ✅ Already up to date（无外部新依赖） |
| typecheck | ✅ 11 包全 Done |
| lint | ✅ 11 包全 Done（--max-warnings=0） |
| test | ✅ domain **47**（billing-rule 14 + routing 10 + lifecycle 19 + 原 4）、provider-adapters 35、gateway 集成 **44**（**w13-billing 4** + w07/w08/w09/w10/w11/w12 回归 40）、control-api 23、database 4、config 4、contracts 2、observability 4 |
| build | ✅ 11 包全 Done |
| evidence:canary | ✅ postgres/redis/logs/traces 全 0 |

## 6. 残余风险与后续

- **真实厂商计价核对**：倍数规则按调研文档录入（智谱 ×3/×2、Kimi 档位 ×3）；真实账单核对在 DEP-PROVIDER-CREDENTIALS 解锁后佳哥跑。
- **周期重置执行器**：规则字段就绪；幂等重置任务归 worker（W25）。
- **CACHE_STATE 规则类型**：schema 已支持，DeepSeek 缓存定价细则在真实凭证回归时按厂商返回校准。

## 7. 为 W14~W16 预留的集成点

- **W14 额度门禁**：ledger_line.deducted_quota 已按倍率落账；额度预占在 pipeline 步骤 3b 前插入。
- **W15 供给预测**：usage_event + deducted_quota 为消耗速度计算的事实底座。
- **W16 经营调度**：billing_rule 版本 + dispatch_policy 可联合决定等价资源切换的成本边界；反事实节省用 rule_version 冻结。
