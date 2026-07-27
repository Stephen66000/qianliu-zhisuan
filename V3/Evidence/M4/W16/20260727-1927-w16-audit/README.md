# W16 Evidence：经营调度与节省

| 项目 | 内容 |
| --- | --- |
| 工作包 | W16（峰谷／成本／额度／周期策略、等价资源、限流／拒绝、反事实与节省） |
| 里程碑 | M4（额度／预测／调度／账本，W13～W17） |
| Stage | Stage 03 / D2 |
| 日期 | 2026-07-27 |
| pnpm-lock.yaml sha256 | `b8f671cae744c24bd8b0731576ebcf6574e0b9586ee4cc3bc1b25dd532bdf1a2`（含 W13 decimal.js，无 W16 新增依赖） |
| 迁移文件 | 新增 `0014_dispatch_policy.js`（dispatch_policy + dispatch_decision 两表） |
| 结论 | **PASS** —— W16 DoD 达成（WT-16/17；无基线为 NOT_CALCULABLE） |

## 1. W16 DoD 达成情况

| DoD 项（详细计划行 292） | 结果 | Evidence |
| --- | --- | --- |
| 峰谷／成本／额度／周期策略 | ✅ | `dispatch_policy` 匹配条件（模型/模式/资源/时间窗/价格倍率/额度比例/耗尽风险/主体范围） |
| 等价资源切换 | ✅ | SWITCH 仅在 `switch_equivalent_group` ∩ 可用候选内（TRD §9.1 行 616）；越界/无目标降级 ALLOW |
| 限流／拒绝 | ✅ | RATE_LIMIT→429 / REJECT→403，不无账放行 |
| 反事实节省 | ✅ | `computeDispatchSaving` = 反事实 − 实际；仅提示/无价格证据/基线不可比 → NOT_CALCULABLE |
| WT-16（高峰命中规则等价切换/限流/拒绝，路由可解释） | ✅ | `w16-dispatch.test.ts` SWITCH/REJECT/RATE_LIMIT 三集成 |
| WT-17（只对实际执行+有基线计算节省） | ✅ | API 模式 SWITCH 有 api_cost → saving_calculable=true；CODING_PLAN/ALLOW 仅提示 → NOT_CALCULABLE |
| 无基线为 NOT_CALCULABLE | ✅ | `dispatch_decision.saving_calculable=false` + `not_calculable_reason` |

## 2. 关键决策

1. **纯函数 + 仓储分层**（对齐 W12~W15）：`dispatch-policy.ts`（matchPolicy/decideDispatch/computeDispatchSaving，时钟注入，可回放）+ `dispatch-policy-repository.ts`（CRUD + 热路径查询 + 决策幂等落库）。
2. **首次 Attempt 做完整 dispatch 判定**：failover 重评（attemptNo>1）不重复判定，避免重复落 dispatch_decision；REJECT/RATE_LIMIT 终止循环。
3. **SWITCH 越界防护**：目标必须 ∈ 等价组 ∩ 当前可用候选；不满足时降级 ALLOW（不无账放行），记 reason code。
4. **节省语义对齐 TRD §9.1 行 628-632**：
   - CODING_PLAN 模式 `api_cost=null`（PACKAGE_INCLUDED，无价格证据）→ 节省 NOT_CALCULABLE（`baseline_not_comparable`）；
   - API 模式 SWITCH 有 api_cost → 节省可计算；
   - ALLOW 仅提示（未改变行为）→ NOT_CALCULABLE（`no_action_executed`）。
5. **历史不重算**：`dispatch_decision` 不可覆盖（UNIQUE(ai_request_id)），冻结本次理由，配置变化不改写。
6. **jsonb 列 JSON.stringify**：`match_days_of_week`/`match_principal_scope`/`switch_equivalent_group` 插入时序列化（与 billing_rule.days_of_week 同模式）。

## 3. 正式工程命令实测（W16 Audit，2026-07-27 19:27）

| 命令 | 结果 |
| --- | --- |
| typecheck | ✅ 11 包全 Done |
| lint | ✅ 11 包全 Done（--max-warnings=0） |
| test | ✅ domain **98**（dispatch-policy 26 + 原 72）、provider-adapters 35、gateway **61**（w16-dispatch 7 + 原 54）、control-api 23、database 4、config 4、contracts 2、observability 4 |
| build | ✅ 11 包全 Done |
| evidence:canary | ✅ postgres/redis/logs/traces 全 0 |

## 4. 交付物清单

| 文件 | 类型 | 说明 |
| --- | --- | --- |
| `packages/database/migrations/0014_dispatch_policy.js` | 新增 | dispatch_policy（版本化策略）+ dispatch_decision（不可覆盖决策快照） |
| `packages/database/src/kysely.ts` | 修改 | DispatchPolicyTable + DispatchDecisionTable 类型 + Database 注册 |
| `packages/database/src/__tests-integration__/migration.integration.test.ts` | 修改 | 回滚指针 0013→0014 |
| `packages/domain/src/dispatch-policy.ts` | 新增 | matchPolicy / decideDispatch / computeDispatchSaving（纯函数）+ DISPATCH_REASON 枚举 |
| `packages/domain/src/index.ts` | 修改 | 导出 W16 模块 |
| `packages/domain/src/__tests__/dispatch-policy.test.ts` | 新增 | 26 单测（匹配/动作/节省/NOT_CALCULABLE） |
| `packages/database/src/repositories/dispatch-policy-repository.ts` | 新增 | createPolicy/updateStatus/listPublishedPolicies/createDecisionIfAbsent/getDecision |
| `packages/database/src/index.ts` | 修改 | 导出 DispatchPolicyRepository |
| `apps/gateway/src/pipeline/real-pipeline.ts` | 修改 | 评分选中后/Attempt 前插入 dispatch 判定 + 决策落库 + REJECT/RATE_LIMIT 响应 |
| `apps/gateway/src/__tests-integration__/w16-dispatch.test.ts` | 新增 | 7 集成测试（WT-16 切换/拒绝/限流 + WT-17 CODING_PLAN/API 节省 + canary） |

## 5. 边界确认（W16 不做项）

- 对账任务（→ W17）；耗尽提前告警 alert_event（→ W25 worker）。
- 反事实基线的精细重算：W16 简化为 SWITCH 时基线≈目标成本（等价组同档位）；W17 对账按原 winner 规则重算细化。
- 真实凭证（DEP-PROVIDER-CREDENTIALS 解锁后佳哥跑）。
- RATE_LIMIT 实际计数：W16 标记限流动作 + 状态码；Redis 实时计数窗口在 W25。

## 6. 为 W17 预留的集成点

- **对账任务**：`dispatch_decision` 的 counterfactual/actual/saving 是 W17 重复/丢失检测的输入。
- **节省精细化**：W17 可按原 winner 的 billing_rule 重算 counterfactual_cost，替换 W16 简化值。
- **M4 全链回归**：W17 收尾时跑 WT-01~17 全量，确认 W13~W16 闭环。
