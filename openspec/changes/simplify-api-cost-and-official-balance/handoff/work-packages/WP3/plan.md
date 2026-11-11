# WP3 本包计划：独立官方余额（tasks 3.1～3.4）

版本：v1.0；日期：2026-11-03；总指挥：GLM-5.3（zcode 会话）；实施：glm-flash 子 Agent（串行）。

## 1. 目标与对应关系

官方余额同步独立于内部资金账本运行：解除 runner 的资金模式耦合与充值记录依赖，新增受权限控制的手动刷新（冷却＋在途复用）、日内多次尝试记录、完整状态读取（成功/失败/过期/不支持分离）、既有恢复链保留与预测/告警时效校正。

| Task | Requirement | 验收 case（本包负责的后端/机制层） |
|---|---|---|
| 3.1 | OAB-01/02/03 | AT-OAB-01（组成不相加，字段层）、AT-OAB-02（手工余额≠官方）、AT-OAB-03（暂不支持）、AT-OAB-04（资金停用仍同步）；纯查询不写资金事实 |
| 3.2 | OAB-03 | AT-OAB-05（手动刷新不要求登记充值）、AT-OAB-06（无权限拒绝＋凭证不下发）、AT-X02（同日多次与冷却） |
| 3.3 | OAB-04/05 | AT-OAB-07（超时保旧值＋过期叠加）、AT-OAB-08（首次失败不显 0）、AT-OAB-09/10（同账户不合计，字段层） |
| 3.4 | OAB-06/07 | AT-OAB-11/12 机制层（同步失败不阻断、恢复证据约束）、AT-OAB-13/14（预测时效/不可计算） |

待联调（不填 PASS）：AT-OAB-01/03/07/08/09/10 浏览器展示、AT-OAB-11 联调 → WP4/WP5。

## 2. 输入基线与依赖

- 基线：worktree `/Users/mac/Projects/仟流智算-api-decouple`，分支 `codex/simplify-api-cost-and-official-balance`，HEAD `67c9aec`（含远端主线 `ae506fed…933e`，2026-11-03 复核，工作树干净）；迁移水位 0094，**本包迁移编号 0095 起**。
- 依赖：WP2 业务 `52fe37d`（退役合同/0094/准入解除，**不得触碰**）；WP1 `9bf1560`＋`75a82fe`（估算读取，不动）；WP0 `notes/inv-c.md`＋`contracts.md` §1 C2/§2 参数。
- 冻结参数（2026-11-03 用户确认）：**P1＝15 分钟**、**P2＝30 分钟**；**P3＝30 秒（用户跳过未答，按设计建议默认落地、可配置，不冒充已确认）**；P4/P5 已由 WP2 冻结（P5＝`resources.operate` 本包使用）。P1 标注"DeepSeek 官方限流数值未核实，按厂商限制可调"。

## 3. 交付物与允许范围

| 交付 | 允许修改（初定，S1 后可修正并记录依据） |
|---|---|
| runner 解耦＋周期调度（P1） | `apps/worker/src/provider-operating-sync/*`、`apps/worker/src/main.ts`、worker 调度注册处 |
| 余额状态读取（C2 字段） | `packages/database/src/repositories/provider-operating-*`（新读取入口）、`supply-forecast-repository.ts`；control-api 资源路由字段扩展 |
| 手动刷新端点（C2） | `apps/control-api/src/**`（新路由＋权限挂载）、`packages/domain`（仅类型） |
| 迁移 0095 | `packages/database/migrations/0095_*.js`（快照表 0026 本体不改；日内多次尝试约束/标识走新迁移，保留旧尝试） |
| 配置 P1/P2/P3 | 沿用 `PROVIDER_FINANCE_MODE` 同款 env/config 模式 |
| 运维文档 | 同步运维说明（周期/刷新/冷却/触发方式）＋本包回执/report |
| 测试 | worker/provider-adapters/database/control-api 对应测试文件（含 inv-c §6 核实项的测试钉死） |

**禁止**：动 0092/0093/0094 本体与语义、WP2 退役合同（410/W7/W8/O1a）、W5/W6 套餐停写、`recordBalanceSyncRecovery` 证据约束（resource-pool-repository.ts:252/:443/:451 逐字不动）、strict_writes、web 页面接线（WP4）、已关账快照、runner EXHAUSTED 恢复路径行为；不新增厂商适配/自动充值/自动抓价/汇率/账户识别；不改 spec。

## 4. 阶段与子 Agent 分工（全部 glm-flash 串行，实施者不自审）

| 阶段 | 内容 | 验收方法 |
|---|---|---|
| S1 只读调查 | runner 三耦合精确解除点、周期注册现状、快照写入器 version 机制、0095 迁移方案、刷新端点挂载点、预测读取路径、config 模式、测试盘点、`PROVIDER_API` source 取值核实；产出 `notes/inv-wp3.md` | 总指挥抽核 ≥3 项 file:line |
| S2＝3.1 | 解除 FINANCE_MODE skip（:118-125）与充值记录依赖（:58-74）；周期调度 P1；官方来源筛选读取基础（PROVIDER_SYNC）；纯查询零资金事实 | runner/worker 集成测试＋资金事实零增量断言 |
| S3＝3.2 | 迁移 0095＋手动刷新端点（P5 权限/P3 冷却/在途复用/不返回凭证）＋运维文档 | control-api 集成：成功/冷却/在途/403/410 边界；迁移正反 |
| S4＝3.3 | 状态读取完整化（supported/last_success_at/status 叠加/last_attempt/next_refresh_at）；失败保旧值；同账户多资源不合计 | 可控时钟测试：T0 成功→超时→过期叠加；首次失败不显 0 |
| S5＝3.4 | 恢复链回归钉死（隔离后证据才可解除）；预测/告警加来源＋时效筛选，缺数据→不可计算/待更新 | 恢复链既有测试回归＋预测时效用例 |
| S6 | 全量复跑（四包测试＋typecheck/lint＋openspec strict）＋收尾 | 总指挥独立复跑关键验证 |

每阶段子 Agent 回执：实际改动、命令、用例数、结果、剩余问题、证据路径。

## 5. 完成条件

- 上表各 task 后端场景有自动化证据（非零用例数），总指挥独立复跑关键验证通过。
- 快照表 0026 本体未改；旧尝试保留；0094/0092/0093 语义不变（回归确认）。
- 手动刷新：无权限 403、凭证不下发、冷却明确返回下次可刷新时间、失败不覆盖上次成功值。
- 恢复链与套餐停写语义不变；预测无有效数据时明确不可计算，无新增硬拒绝/自动换厂商。
- 范围外零改动；待联调项如实记 NOT_RUN/待 WP4。
