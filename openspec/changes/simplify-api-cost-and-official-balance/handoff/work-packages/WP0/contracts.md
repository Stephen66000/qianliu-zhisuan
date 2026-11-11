# WP0 契约与参数（task 1.2 产物）

版本：v1.0；日期：2026-11-02。本文件把 development-plan §5 的合同草案落到**实际路由与字段**，作为 WP1-WP4 委派合同的基准。标注【事实】= 代码已核实存在；【新增】= 本 change 需新建；【待确认】= 需用户/业务验收人拍板，实施先以可配置参数承接，不得硬编码冒充已确认。

## 1. 五个接口合同

### C1 API费用估算读取【新增聚合，复用既有事实】

- 事实基础：Gateway `computeBilling`/`computeBillingFromRule`（billing.ts:26/:81）已产出 `apiCost`（无规则→null）；Attempt 结算落库含用量/费用/币种/规则快照（attempt-usage-settlement.ts）。
- 聚合读取（Database 层统一入口，WP1 实施；HTTP 挂载沿用各既有资源/账单路由的响应字段扩展）返回：

| 字段 | 类型 | 语义 |
|---|---|---|
| `scope`/`period` | 资源/期间 | 统计范围与企业时区期间 |
| `amounts` | `[{currency, amount}]` | 按币种**已知金额**（8 位金额格式），不混币相加 |
| `completeness` | `KNOWN_PARTIAL \| KNOWN_COMPLETE \| ZERO_CONFIRMED` | 完整性；未知≠零（ACE-04） |
| `gap` | `{reason, count}` | 缺口原因/条数（缺价格/用量未知/未迁移/依据待核） |
| `price_basis` | `{rule_version, source_status}` | 价格依据状态：**`source_status` 为【新增】字段**（billing_rule 现无来源/核实概念，见 notes/inv-b.md §1） |

- 约束：不依赖资金账户键/期初/余额差；`finance-usage-overview.ts:21-26` 的 remainingQuota 覆盖行为移除（余额走 C2）。

### C2 官方余额读取【新增读取，复用快照表】

- 事实基础：`provider_resource_operating_snapshot`（0026）含 source/balance/组成/available/balance_updated_at；官方来源筛选 `source='PROVIDER_SYNC'`（runner.ts:65 同口径）；适配器仅 deepseek+API 有数据（provider-operating-facts.ts:51）。
- 响应字段（挂资源详情/列表路由，字段级扩展）：

| 字段 | 语义 |
|---|---|
| `supported` | 该厂商是否已适配（false→显示"暂不支持"，绝不零值冒充） |
| `total_balance` / `currency` / `composition{granted,topped}` / `available` | 官方总额与组成（不再相加，OAB-01） |
| `last_success_at` | 最近**成功采集**时间（≠页面打开时间） |
| `status` | `SYNCING \| OK \| FAILED \| EXPIRED \| NEVER_SYNCED \| UNSUPPORTED`（失败与过期可叠加：FAILED 时可同时 EXPIRED） |
| `last_attempt` | `{at, outcome, reason}`（失败尝试与成功值分离，OAB-04） |
| `next_refresh_at` | 冷却/在途判定后的下次可刷新时间 |

- 手动刷新【新增端点】：`POST /provider-resources/:id/official-balance/refresh`（权限 `resources.operate`【事实：写权限名，activation-routes.ts:24-26】；响应 `{state: ACCEPTED\|IN_PROGRESS\|COOLDOWN, retry_after_seconds}`；不返回凭证；失败不覆盖上次成功值）。

### C3 旧 API 资金写退役响应【新增合同】

- 对 inv-a.md §1.1 判定为退役的端点（W1/W2/W3/W4/W9/W10/W11 及 W7/W8 的 API 资金事实分支）：原鉴权/权限完成后返回 **`410` + `{error: "api_funding_management_retired"}`**【待确认：状态码与错误码为 design D3 建议，WP0 维持建议，WP2 形成最终合同后冻结】。
- 不接受成功空操作；不写资金事实/候选；套餐端点（W5/W6）与 quiescence（A3/A4）不受影响。
- 混合候选（A1/A2）：含 API 资金事实的旧候选 → 拒绝并说明，不静默激活（AFR-01 场景 3）。

### C4 套餐写/历史读【保留既有合同】

- W5/W6 及订阅周期/用量读端点原样；`strict_writes_enabled` 不统一关闭；员工月度额度/CPQW/quota_block_state（resource-pool-repository.ts:443）不动。

### C5 历史资金只读【保留既有读端点】

- inv-a.md §1.1 读入口 10 个保留，响应附旧口径标识；已关账版本冻结（AFR-06）。

## 2. 参数待决清单（全部为建议值，非用户确认）

| # | 参数 | 建议值 | 依赖 | 决策人 |
|---|---|---|---|---|
| P1 | 自动同步周期 | 15 分钟（可配置） | DeepSeek 限流数值（未核实，BLOCKED） | 用户 |
| P2 | 数据过期阈值 | 30 分钟（可配置） | — | 用户 |
| P3 | 手动刷新冷却 | 30 秒（可配置） | — | 用户 |
| P4 | 退役响应 | `410 api_funding_management_retired` | — | 用户（WP2 前冻结） |
| P5 | 刷新权限 | `resources.operate`（现有资源写权限） | 已核实权限名存在 | 用户确认即可 |
| P6 | 价格依据状态字段命名与取值 | 如 `source_status: VERIFIED\|UNVERIFIED` | WP1 迁移 | 总指挥定草案，WP1 落地 |

实施方式：全部走环境变量/配置（同 `PROVIDER_FINANCE_MODE` 模式，packages/config），默认值取建议值但文档必须写明"建议默认，可配置"。P1 在厂商限流核实前不得宣称已适配官方限制。

## 3. 切换与合并顺序（承接 development-plan §7，WP0 细化）

1. 契约/夹具（WP0 本文件＋WP1 测试夹具）→ 2. 费用读取（WP1，C1＋价格依据字段迁移）→ 3. API 资金退出/迁移（WP2，C3＋0081/0083 合同调整＋PENDING 解除）→ 4. 余额同步（WP3，C2＋刷新端点＋周期配置）→ 5. 页面/导出（WP4）→ 6. 集成验收（WP5）→ 7. 候选与回退演练（WP6）。
- 有依赖的迁移与服务代码同候选版本验证；迁移与回退约束见 baseline.md §6。
- WP2 与 WP3 串行执行（指令§三），尽管技术上部分独立。

## 4. 与三份 spec 的一致性核对（task 1.2 要求）

- ACE：C1 覆盖 ACE-01~07 字段语义（完整性/缺口/币种分列/依据状态）；价格依据状态为唯一新增字段需求，未扩产品范围。
- OAB：C2 覆盖 OAB-01~05/07；OAB-06 耗尽恢复复用 `recordBalanceSyncRecovery` 既有约束（不动）。
- AFR：C3/C4/C5 与 inv-a.md 逐入口判定对齐；AFR-02 只动 resource-pool-repository.ts:450 及联动，不动 :443/:451。
- 未发现 spec 与现有代码事实的矛盾；两处 design 表述与实现差异已按"以实际代码为准"记录（0081 文件头注释残留旧编号"0078"；"同步日唯一"为行为约束非表约束）——不改 spec，WP2/WP3 实施时以本文件与代码为准。

## 5. WP1 委派合同基准（下一包使用）

- 目标：tasks 2.1-2.3（C1 聚合＋价格依据状态字段＋同源对齐）；对应 ACE-01~07 的服务层前提。
- 源码基线：含 `ae506fed…933e` 的新 worktree/分支（baseline.md §1）。
- 允许范围：`packages/database`（聚合入口＋迁移 0093＋价格依据字段）、`apps/gateway`（仅当结算列需要补币种/依据，最小改动）、`apps/control-api`（读取路由字段扩展）、`packages/domain`（billing-rule 类型扩展）；测试按 development-plan §6 入口。
- 禁止：动 W5/W6 套餐合同、0081/0083 触发器语义（WP2 范围）、官方余额（WP3 范围）、页面（WP4 范围）；不删旧断言。
- 完成条件：ACE 服务层场景（AT-ACE-02/03/04/05/07/08/09/10/12 的非浏览器部分）有自动化证据；资金账户不存在不影响估算（AT-ACE-05）。
