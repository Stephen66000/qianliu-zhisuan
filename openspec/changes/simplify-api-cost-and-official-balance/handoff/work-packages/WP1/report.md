# WP1 结包报告：同源费用估算读取（tasks 2.1～2.3）

包：WP1；总指挥/模型：GLM-5.3（zcode 会话）；实施：glm-flash 子 Agent（GLM-5.3-Flash，`thoughtLevel: high`，用户指定档位），串行 S1→S2→S3a→S3b→S3c 五份合同。日期：2026-11-02～03。**结论：通过**（遗留项见 §4.2，均不阻塞 WP2）。

## 1. 基线与工作区状态

- 起点基线：`62f12de58dff44065399e9cf8ac99faf217809f3`（分支 `codex/simplify-api-cost-and-official-balance`；＝远端 main `ae506fed…933e`＋两笔纯文档提交，包含关系与远端 SHA 均复核）。
- 终点基线：`75a82fe`（`feat(cost-estimation): align annual analysis api spend…`）← `9bf1560`（`feat(cost-estimation): add same-source API cost estimation reading (WP1 tasks 2.1-2.3)`，34 文件）← `62f12de`。
- 提交后工作区：仅未跟踪的本包文档与证据（本次随包另行提交，见 §2）。
- 中途阻塞记录：本会话曾因 glm-flash 定义缺 `thoughtLevel` 无法启动（Agent 定义会话启动时缓存），以 BLOCKER 中期报告结过一次任务；用户续做并指定 high 档后解除，详见 [BLOCKER-glm-flash.md](BLOCKER-glm-flash.md)。定义文件已修复（`.zcode/agents/glm-flash.md`，仓库外）。

## 2. 计划 vs 实际交付

| 计划（plan.md §5） | 实际 | 提交/证据 |
|---|---|---|
| S1（2.1）：迁移 0093＋C1 聚合入口＋依据链＋测试 | 完成：`api-cost-estimation.ts`（loadApiCostEstimation）、`0093_billing_rule_source_status.js`、domain/gateway/规则入口 source_status 链、集成 10 用例 | 9bf1560；s1-receipt |
| S2（2.2）：未知/部分/失败重试/处置语义 | 完成：真实结算入口 5 用例（0.03 重试、重复终态幂等、处置不变、请求内混币、零与未知并存）；生产代码零改动 | 9bf1560；s2-receipt |
| S3a（2.3 前半）：总览/首页/同期/洞察对齐 | 完成：API remainingQuota 余额覆盖移除、基础聚合层注入估算（finance 双路同值）、首页 API 分量切估算、同期窗口金额段切估算、洞察证据对齐；跨读取方字面值核对 4 用例 | 9bf1560；s3a-receipt |
| S3b（2.3 后半）：首页 finance 开路径/模型行/账单当前期/部门项目/合同文档 | 完成：projectDashboardFinance API 分量透传估算、模型行 settled_at＋处置投影、账单 draft 主口径切估算（桥接字段保留、关账版本零改动）、部门/项目判定（已同源或历史口径，file:line 记录）、`api-estimation-contract.md` | 9bf1560；s3b-receipt |
| S3c（2.3 追加）：年度聚合 | 完成：`operating-analysis-repository.ts` 月度 apiSpend/apiSpendComplete 切估算（轨迹字段保留）；4 新用例 | 75a82fe；s3c-receipt |

- 业务提交 2 笔（34＋2 文件，+2752/−150）；本报告提交：tasks.md 勾选 2.1–2.3＋WP1 handoff 文档（plan/report/contracts/S1/BLOCKER/api-estimation-contract v1.1）＋V4 证据。
- 接口/配置变化：新增只读聚合入口 `loadApiCostEstimation`（见合同文档 §1）；`billing_rule.source_status`（0093，NOT NULL DEFAULT 'UNVERIFIED'）＋规则读写路由可选字段；无删除性接口变化，响应形状兼容（API 费用字段语义换源，断言迁移已注明依据）。

## 3. 验证记录（总指挥独立复跑为准；子 Agent 自跑见各回执）

| 验证 | 结果 |
|---|---|
| database 估算五套件（estimation/attempts/readers-alignment/draft-model-alignment/operating-analysis） | **33/33**（总指挥复跑） |
| domain 全量 | 407/407 |
| control-api 全量集成（含 S3b/S3c 后状态） | **342/342** |
| gateway billing-evidence | 8/8（S3b 另跑 w08-e2e 13/13） |
| database 全量集成 | 558/559（唯一失败 w20-standard-capacity P95 计时，见 §4.2-4） |
| typecheck/lint（database/domain/gateway/control-api） | 全 0 退出 |
| 既有断言迁移 | pool025×8、wp07×1、w20-resource-insights×1、pool042×1、consumer-projection×2、dashboard-projection×3、operating-analysis×1——逐处注明依据（ACE-03 场景2/AFR-06/AFR-07/裁定），无删除无放宽 |

case 对照（AT- 非浏览器部分）：AT-ACE-02✓（0.00104000 字面值＋价格版本链）、03✓（无资金表数据产出估算）、04✓（3 元部分合计/零确认/未知缺口）、05✓（0.03 重试＋处置不变＋重复终态幂等）、07✓（混币分列）、08✓（CONFIRMED_ZERO_NO_UPSTREAM 语义，DB 层）、09✓、10✓、12 期间口径✓（settled_at 半开窗，跨月归集机制既有测试维持）。AT-ACE-01/06/11/13/14 的浏览器/联调部分＝待 WP4/WP5（本包不填 PASS）。

## 4. 审核发现、裁定与未解决项

### 4.1 总指挥裁定（已入合同文档 §4）
1. **缺口码双权威**：金额＝估算（C1）；缺口文案＝资金域权威 `countOperatingExpenseGaps`（含 OPENING_BALANCE_MISSING 等）。理由：估算缺口码无资金事实/历史聚合覆盖表达，直接替换违反 AFR-06 并回归 3 个钉死套件；WP2 退役资金缺口时统一。
2. **桥接字段保留待 WP2/WP4**：账单 draft 的 opening/ending/recharge/balanceBridgeFacts/apiSpendStatus 照常产出；`apiCost` 主值已切估算；`operating-bill-finance-projection.ts`（finance 开路径资金覆盖）未改。
3. S3a/S3b 提出的夹具修正（补生产结算链必写列）与断言语义等价迁移——认可（依据注明充分）。
4. 年度统计对齐从 S3b 移交后由 S3c 收口（追加合同）。

### 4.2 未解决/未核实（移交）
| 项 | 状态 | 影响 |
|---|---|---|
| 生产版本/迁移水位/开关（WP0 遗留） | BLOCKED | WP6 前必须补核 |
| P1-P6 参数（P6 已由本包落地 source_status 草案值） | P1-P5 待用户确认 | P4/P5 需在 WP2 前冻结 |
| w20-standard-capacity P95 计时 | 本机超预算约 5% 且**干净基线克隆复现同值失败**（预存环境漂移，非 WP1 回归；S1/S2 期曾隔离通过，机器负载相关） | 不阻塞本包；CI 环境自会裁定；如持续红灯由用户决定预算调整 |
| `settled_at IS NULL` 行不进任何窗口 | 既有口径（生产链必写）；seed 工具例外已记录 | 无 |
| 首页 finance 开路径 monthlyRechargeAmount(s) 仍为资金读模型值 | 待 WP2/WP4 | 与 ACE 估算语义无冲突 |

### 4.3 执行方式
- 五份合同全部交 glm-flash 串行实施；总指挥只做计划/合同/审核/独立复跑/记录（§3 全部为总指挥实跑）。子 Agent 未自审；两次 git 提交均在合同明文授权下进行。
- 范围外改动检查：两次提交 `--stat` 逐文件对照允许清单，零越界；未触碰 W5/W6、0081/0083/0061、resource-pool-repository、官方余额/worker、web、员工月度额度、已关账版本内容。

## 5. 本包结论

**通过**。退出条件逐项：C1 聚合存在且有"无资金账户产出估算"集成证据✓；ACE-02/03/04/05/07/08/09/10/12 非浏览器部分自动化证据✓（字面值金额）；同范围同期间同币种跨读取方可核对（首页/总览/同期/账单/年度 vs 统一入口）✓；混币不相加✓；历史处置/原始用量/规则快照/关账版本不改写（快照对比断言＋pool025 关账版本不变）✓。tasks.md 2.1–2.3 已勾选。待联调（WP4 页面、WP5 50 条总验收、WP6 候选）未执行，本包未冒充端到端 PASS。

## 6. WP2 启动交接

- 基线：worktree `/Users/mac/Projects/仟流智算-api-decouple`，分支 `codex/simplify-api-cost-and-official-balance`，HEAD `75a82fe`（含 ae506fed 主线）；接手先复核 HEAD/分支/status 与远端 main。
- 依赖与输入：本报告、[api-estimation-contract.md](api-estimation-contract.md) v1.1（金额/缺口双权威、桥接字段保留边界、WP2 需统一缺口码时同步迁移 standard-home V14-C2/C3、finance-period-cost-integrity、home-cost-comparison 钉死断言）、WP0 contracts.md §1 C3/C4（退役响应/套餐保留）、notes/inv-a.md（19 写入口清单）。
- 注意：WP2 前 P4（410 响应）/P5（刷新权限）需用户确认；0094 起编号；不动 0093 与本包聚合语义；测试证据只认真实入口；glm-flash 先探针再委派；年度/账单的资金轨迹字段退役时按合同文档 §4 裁定 2 处理。
- 下一任务启动指令：

> 读取并执行 `/Users/mac/Projects/仟流智算-api-decouple/openspec/changes/simplify-api-cost-and-official-balance/handoff/work-packages/WP0/../zcode-commander-instructions.md` 同款指令（task.md），当前工作包改为 **WP2**（tasks 4.1～4.4），上一包交接记录改为 `handoff/work-packages/WP1/report.md`（已通过）。开发执行子 Agent `glm-flash`（thoughtLevel: high）；开工先复核基线 HEAD `75a82fe` 与远端 main 包含关系。
