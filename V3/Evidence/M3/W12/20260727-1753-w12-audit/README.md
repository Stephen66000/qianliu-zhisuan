# W12 Evidence：多因子路由与 Affinity

| 项目 | 内容 |
| --- | --- |
| 工作包 | W12（硬过滤、多因子归一化、稳定 tie-break、Affinity、提交前切换、提交后不切换） |
| 里程碑 | M3（三厂商、凭证与账号池，W09～W12）—— **M3 收口** |
| Stage | Stage 03 / D2 |
| 日期 | 2026-07-27 |
| pnpm-lock.yaml sha256 | 与 W11 一致（无外部新依赖） |
| 迁移文件 | 无新增（复用 0005 model_route priority/weight + 0007 route_candidate score_factors/total_score/reason_code） |
| 结论 | **PASS** —— W12 DoD 达成（属性测试回放 100%、WT-13/18 通过、提交前/后边界守住） |

## 1. W12 DoD 达成情况

| DoD 项（详细计划行 288） | 结果 | Evidence |
| --- | --- | --- |
| 硬过滤 | ✅ | `listServableResources`（W11）∩ model_route 启用；评分在过滤之后（TRD §9 行 583） |
| 多因子归一化 | ✅ | `routing-policy.ts`：static_weight（归一化）/health（DEGRADED 0.6、probe 0.3）/affinity，版本化 `ROUTING_POLICY(w12-v1)` |
| 稳定 tie-break | ✅ | 同分按 resourceId 字典序；属性测试 100 组随机候选打乱顺序选中者恒定 |
| Affinity | ✅ | WT-13：会话命中原资源；仅评分因子不绕过硬约束（affinity 资源被隔离则不参与） |
| 提交前切换 | ✅ | committed=false + 可切换错误 → 排除已试重评；attempt switch_reason 落库 |
| 提交后不切换 | ✅ | STREAM_INTERRUPTED_AFTER_COMMIT → 单 Attempt，不拼接第二上游（WT-12 边界） |
| 属性测试、回放 100% | ✅ | `routing-policy.test.ts`：顺序无关 + 同输入逐因子一致 |
| WT-13/18 | ✅ | `w12-routing.test.ts` 6 集成 |

## 2. 本工作包交付物

### 2.1 评分器（`packages/domain/src/routing-policy.ts`）
确定性纯函数 `scoreAndSelect(candidates, affinityResourceId, excludeResourceIds)`：
1. 排除已尝试（failover 重评）；2. 最小 priority 组参与竞争；3. 组内多因子加权（在场因子权重归一化）；4. 总分最高选中，同分 resourceId 字典序。
因子框架预留容量/负载/错误率/TTFT/额度/重置时间/成本（W15/W16 数据源就绪后接入，absent 因子不计入）。

### 2.2 多候选 pipeline（`apps/gateway/src/pipeline/real-pipeline.ts` 重写）
- `deps.findResource` → `deps.listCandidates` + `poolRepo` + `resolveAffinity` + `maxAttempts`。
- Attempt 循环：每次冻结 route_candidate（score_factors 含 factors + policy_version + affinity_resource_id,total_score,reason_code,WT-18 可解释）→ Adapter 调用 → 结果驱动 W11 状态机 → committed=false 且 isSwitchable → 排除重评；committed=true → break。
- 无健康候选 → 503 `no_healthy_candidate` 不无账放行（TRD §14 行 854）。

### 2.3 仓储扩展（`gateway-ledger-repository.ts`）
`createRouteCandidate` 支持 score_factors/total_score；新增 `listRouteCandidates`。

### 2.4 测试
- `routing-policy.test.ts`：10 单测（healthScore、priority 分组、weight 归一化、DEGRADED 健康降权双向边界、Affinity、tie-break 顺序无关、failover 排除、属性测试 100 组 + 回放）。
- `w12-routing.test.ts`：6 集成（WT-13 Affinity 命中、WT-18 因子冻结、提交前切换双 Attempt 双明细、提交后不切换、无健康候选 503、优先级接管）。
- w08/w09/w10 三个集成测试适配新 deps（listCandidates + poolRepo），回归全绿。

## 3. 关键修正（测试预期）

初版 `DEGRADED 健康降权可逆转 weight 优势` 用例预期错误（weight 3:1 时 0.54 > 0.50,weight 优势仍胜）。修正为双向边界断言：weight 2:1 健康者胜（0.533>0.507)、weight 3:1 weight 优势胜（0.54>0.50)。评分器行为本身正确，是测试算术预期错误。

## 4. 边界确认（W12 不做项）

- 容量/负载/错误率/TTFT/额度/成本因子：数据源（resource_runtime_snapshot）归 W15/W16，框架已预留 absent 处理。
- 经营调度策略（dispatch_policy）：W16；当前评分只用静态 priority/weight + 健康 + Affinity。
- 额度预占/耗尽停止热路径：W14（total_deducted_quota 仍 0）。
- 真实凭证：DEP-PROVIDER-CREDENTIALS 解锁后佳哥跑。

## 5. 正式工程命令实测（W12 Audit，2026-07-27 17:53 于佳哥 Mac 执行）

| 命令 | 结果 |
| --- | --- |
| typecheck | ✅ 11 包全 Done |
| lint | ✅ 11 包全 Done（--max-warnings=0） |
| test（单测+集成） | ✅ domain **33**（routing-policy 10 + resource-lifecycle 19 + 原 4）、provider-adapters 35、gateway（**w12-routing 6** + w07/w08/w09/w10/w11 回归）、control-api 23、database 4、config 4、contracts 2、observability 4 |
| build | ✅ 11 包全 Done |
| evidence:canary | ✅ postgres/redis/logs/traces 全 0 |

执行环境：macOS，corepack pnpm@11.11.0，Docker Desktop（Testcontainer PG17）。

## 6. M3 里程碑收口

M3（三厂商、凭证与账号池，W09～W12）四个工作包全部 PASS：
- W09 智谱 Adapter + 多厂商注册表
- W10 Kimi Adapter（三厂商齐备）
- W11 凭证生命周期与账号池状态机
- W12 多因子路由与 Affinity + 提交前切换

WT-03/05/07/13/18/19 覆盖；三厂商 Adapter 形状、状态机、评分器均确定性可回放；正文 canary 全 0。
真实凭证上线签字仍受 DEP-PROVIDER-CREDENTIALS 阻塞（M3 不签字）。

## 7. 残余风险与后续

- **真实三厂商回归**：StubUpstream 验证形状；真实 HTTP 在 DEP-PROVIDER-CREDENTIALS 解锁后佳哥跑。
- **运行时因子数据源**：resource_runtime_snapshot（TTFT/错误率/健康分数）归 W15/W16；评分框架已预留。
- **W13 计价**：raw_*_tokens 原始口径 + api_cost=null（CODING_PLAN）已就位，高峰/档位倍数折算在 W13 版本化规则实现。

## 8. 为 M4 预留的集成点

- **W13 计价规则版本**：route_candidate 已冻结策略版本 w12-v1；ledger_line raw_*_tokens + api_cost 为计价留好事实底座。
- **W14 额度门禁**：评分选中资源后、Attempt 前的额度预占点（pipeline 步骤 3b 前）。
- **W16 经营调度**：ROUTING_POLICY 因子权重版本化，dispatch_policy 可在硬过滤后、评分前注入允许范围。
