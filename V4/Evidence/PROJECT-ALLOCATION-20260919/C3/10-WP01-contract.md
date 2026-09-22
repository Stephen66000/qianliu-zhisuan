# WP01 数据与计算合同（冻结）— 候选 C3

日期：2026-09-21。依据：v1.2 计划（052df0b 重启修订版）§3–§9；基线 2b33719 代码事实（00-WP00 §4）。本文件为 WP02–WP06 唯一实施输入。

## 1. 术语与优先级（v1.2 §4.2）

`allocation_source ∈ {PROJECT_DIRECT, MANUAL_ASSIGNMENT, MEMBERSHIP_RULE, UNALLOCATED}`，逐源行按序短路判定：① 源主体=PROJECT → 直接调用（目标=自身）；② 源行 EMPLOYEE 且该请求存在 `operating_bill_request_project_assignment` → 人工指定；③ 请求开始时点存在有效参与∩权重∩核算窗口 → 成员规则分摊（100% 专属规则同此）；④ 未分配（带原因码）。①②不进员工待分配池；池内一行可产生多项目份额+未分配份额。人工指定只读 assignment 表（请求唯一），不按部门推断。明细只读。

## 2. 时间合同

1. 关系匹配时间＝`ai_request.started_at`；同请求所有行同时点匹配。
2. 入账月份＝`account_at`（finance 开启用 settled_at，否则 created_at）按北京自然月。
3. 明细双时间戳 `request_started_at` + `accounted_at`。
4. 日期→排他边界按 **Asia/Shanghai 00:00（UTC+08:00）**（P3-1）；区间半开 `[from, until)`，until 可空。
5. 接口存 timestamptz；展示 Asia/Shanghai。
6. Token：输入+输出为总量；缓存/推理细分分别分配不重复计入；质量原样保留。

## 3. 数据模型（8+4 张表；迁移编号按开工时实际迁移头）

通用：全部含 `enterprise_id`；跨表引用一律复合 `(enterprise_id, id)` FK；管理归集层禁止回写原始行。

| 表 | 要点 |
| --- | --- |
| `project_accounting_profile_version` | 核算起止+版本+is_current 部分唯一；触发器：禁 DELETE，UPDATE 仅 is_current true→false，INSERT 校验 PROJECT 主体 |
| `project_membership` | 稳定 stint（project+employee+stint_index 唯一）；触发器：禁 UPDATE/DELETE，INSERT 校验 PROJECT+EMPLOYEE 同企业主体 |
| `project_membership_revision` | 冗余 project/employee 主体列；UNIQUE(membership,revision)；ACTIVE 区间 EXCLUDE（btree_gist，仅 ACTIVE 行）；幂等键部分唯一 `(enterprise,idempotency_key)`；supersedes/created_by 复合 FK；触发器：禁 DELETE，UPDATE 仅 ACTIVE→SUPERSEDED/VOID |
| `employee_project_allocation_policy` | 员工级版本+is_current+input_hash+幂等键；触发器同上模式，EMPLOYEE 校验 |
| `employee_project_allocation_rule` | policy+membership+revision 复合 FK；weight_bps 0..10000（0 合法显式段，P3-3）；区间⊆参与修订（触发器）；触发器校验 policy 同员工、修订链一致；发布后禁改 |
| `project_allocation_run` | 活动/当前/**当前发布幂等**三个部分唯一（已发布幂等索引限定 `is_current`，见 `76-CONTRACT-AMENDMENT-01`）；`CHECK (NOT is_current OR status='SUCCEEDED')`；SUCCEEDED/FAILED 仅允许 is_current true→false（输入摘要/守恒/result_hash 冻结）；QUEUED/RUNNING 身份列不可变、状态只进不退；陈旧度不入库，由**未消费的脏代次**推导：`dirty.dirty = true AND dirty.generation > run.input_dirty_generation`（`project-allocation-freeze.ts` 与只读状态同谓词） |
| `project_allocation_line` | 逐行证据：ledger/request/attempt/资源/模型、双时间戳、来源四值、权重（仅 MEMBERSHIP_RULE 非空）、policy/membership/revision 引用、token 份额 numeric(24,4)、api 金额源精度+币种、`package_cost_currency='CNY'` 固定、质量、原因码（含 HISTORICAL_UNKNOWN）；目标=零 UUID 哨兵+UNIQUE(run,line,target_type,target)；触发器：禁 UPDATE/DELETE，INSERT 校验目标是同企业 PROJECT 主体；复合 FK 全覆盖（ledger/request/attempt 三列不建 FK——热事实表代价，由装载企业过滤+守恒核对兜底） |
| `project_allocation_resource_residual` | 资源级套餐余量（C08）；复合 FK run+资源。authority 分两类：**plan-cash**（`provider_finance_event` 的 CODING_PLAN 购买/续订/冲正，低频高金额）纳入 `inputDigest` 且写入方同事务推脏；**资源快照**（`provider_resource_operating_snapshot`，高频采集、估计口径）不入摘要、不挂钩，按"下次任意输入变更刷新"接受滞后。余量不进 close ref、不进守恒，不影响结账正确性（R03 决策，见 `77-R03-P1-fix.md`）。 |
| `operating_bill_project_allocation_ref` | 账单冻结引用：bill_version 唯一+复合 FK；run FK **RESTRICT**；ref 不可变触发器 |
| `project_allocation_period` | 启用登记（首次启用事务内登记初始化任务） |
| `project_allocation_dirty` | (企业,账期) 脏代次 generation+dirty；配置写事务同事务推进 |
| `project_allocation_scan_watermark` | 按企业 `ledger_line.created_at` 水位（仅兜迟到插入；其余事实变更由写入方同事务推脏，见 R02 修复） |

共享前置（IF NOT EXISTS，down 不删）：`principal(enterprise_id,id)`、`operating_bill_version/provider_resource/unified_model(enterprise_id,id)` 复合唯一；`btree_gist` 扩展（P3-2 保守回退）。

## 4. 数值与守恒

1. BigInt 定点/numeric，禁浮点；token 份额＝`tokens×bps/10000` 4 位小数恒精确；余量份额补齐守恒。
2. 费用按源精度；同源行×种类×币种确定性最大余数（平局按目标键字典序，未分配哨兵最后；仅 bps>0 目标分尾差）。
3. API CNY、API USD、套餐 CNY 三桶分别守恒展示；未知费用行计入完整性缺口。
4. 校验族：逐行覆盖（Σ份额＝源×10⁴）、员工池守恒、全来源守恒、逐种类×币种金额守恒、资源级余量另表（不入源行公式）。
5. 次数按目标内 request 去重；跨项目不可加；不乘权重。

## 5. 更新与任务

1. 配置写事务同事务推 dirty generation；事务后 worker 消费，无同步全量扫描。
2. GET 全部纯读（任务数 0）；首次计算仅由启用登记事务创建；新结算由 worker 周期补偿扫描（ledger_line.created_at 水位+重叠回看）登记待更新，配置类与回填类变更由写入事务内直接推脏——**不改 Gateway/结算路径**（B02 最严格解释；新鲜度不足再议阶段二，需用户确认）。
3. 单任务＝部分唯一索引；同输入+算法幂等**限定当前发布**（同摘要的历史批次不复活，输入回到历史状态时确定性重发布为 current，见 `76-CONTRACT-AMENDMENT-01`）；运行中新变更只推进代次，完成后对比补算。
4. 自动刷新最小间隔默认 30s；失败有界退避（默认 3 次）；租约超时回收；执行者代次校验；SYSTEM/ADMIN actor 分记。
5. 结账：close 前校验启用账期存在 is_current run 且输入 digest 与锁定源一致（否则 `allocation_not_ready`/`allocation_stale`）；冻结只写 ref 表（run_id/schema/algorithm/input_digest/result_hash/守恒汇总/完整性/生成时间）；`sourceFacts.accountFacts` 原样；并发按既有写屏障串行。

## 6. 保留策略（P3-2 冻结）

不自动清理；被任何 run/账单版本引用的对象在引用存续期间绝不可删除；迁移 down 有数据守卫；归档/清理另立方案。

## 7. 0% 规则段（P3-3）

weight_bps=0 合法保存、进时间线与审计；结果全部未分配，原因码=WEIGHT_REMAINDER（10000）；不得折叠为"无规则"、不得改标 NO_EFFECTIVE_RULE。

## 8. 预览口径（P2-1 冻结）

同一员工、参考时点 t：`hidden_weight_bps(t)`＝无权查看项目权重和；`available_bps(t)＝10000−hidden_weight_bps(t)`；`remaining_bps(t)＝available_bps(t)−current_project_weight_bps(t)`（预览态=意图，查看态=当前生效）。可见其他项目从 remaining 继续扣减并单列展示。预览数字不替代锁内全时间线校验。算例：隐藏 3000、意图 2500 → 7000/4500。

## 9. 合同决策点（沿 C2 评审已确认方向）

D1 新增 4 张实现层表；D2 阶段一变更识别仅补偿扫描（不改 Gateway）；D3 revision 冗余列+EXCLUDE（btree_gist）；D4 逐行瞬时匹配+展示层并集分段（数值等价）；D5 run 幂等键=(企业,账期,input_digest,algorithm_version)**且限定 `is_current`**（R03 P1 修订：current 批次永远反映当前输入状态）。
