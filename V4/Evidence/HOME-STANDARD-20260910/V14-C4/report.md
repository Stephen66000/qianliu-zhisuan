# 标准版首页 C4 · V1.4 门禁整改与复审报告（实施者自审）

日期：2026-09-10。报告目录：`V4/Evidence/HOME-STANDARD-20260910/V14-C4/`。
响应：R03 FAIL（G01 覆盖率门禁、G02 变异证据范围）+ 报告精度修正。
独立性：`actual_independence = I1`（实施者自审），仅供 Codex 复核，不构成独立第三方结论。

## 0. 候选锁（C4）

- 基线 HEAD：`4898df546fbcbc9ca292ee892cd7ae412766185a`（不变）。
- C4 tracked patch：15 文件，SHA256 `f9549068868d88fe7260774a6d7f119ffebca1f800e18e6d1eaf39f486e3855d`（相对 C3 的增量仅为 `packages/database/src/index.ts` 新增 2 个导出：`previousEmployeeWindow`、`loadWindowBridgeCosts`，供测试直接调用）。
- 新增文件 15 项逐文件 SHA256：`candidate-new-files.sha256`（较 C3 变更：standard-home-model.ts/.test.ts、integration test、costs.ts；新增 costs 纯函数单测）。
- 起止锁：STABLE（含一次审核工具自查更正：本轮无共享 reports 目录操作）。

## 1. 候选代码变化（C3 → C4）

| 文件 | 变化 | 性质 |
| --- | --- | --- |
| `packages/database/src/index.ts` | +2 导出（测试需要） | 接口层 |
| `dashboard-home-costs.ts` | **真实缺陷修复**：缺币种遗留已计价行（currency=null）进入币种分组导致 `localeCompare` 崩溃；改为跳过 null 币种行（与权威月度汇总"跳过 null 币种、以缺口呈现"口径一致），缺口仍单列 | 业务修复（由 G02b 注入测试暴露） |
| `dashboard-home-metrics.ts` | `previousEmployeeWindow` SQL 增加 `WHERE EXISTS(enterprise)`：企业不存在时显式抛 `UsageOverviewEnterpriseNotFoundError`，不再静默返回空窗 | 行为修正（防御分支由此可达） |
| 测试三处 | G01/G02 业务分支与注入回归 | 见 §2/§3 |

## 2. G01 覆盖率门禁：**已通过（真实 exit=0）**

命令与范围与 R03 完全一致（同 5 个运行时文件、原 85% 阈值、未删文件、未改阈值、未放宽断言；新增断言均为业务断言）：

```
vitest run dashboard-home.test.ts dashboard-home-costs.test.ts
          standard-home.integration.test.ts
  --coverage.include 上述 5 文件
→ exit=0；stmts 99.79% / branches 92.59% / funcs 100%
分文件：costs 100/90.47、metrics 100/94.11、providers 100/93.57、
        dashboard-home.ts 99.15/85.71、gaps 100/100
```

回执：`coverage-db.log`。新增的代表性业务断言（非空命中凑数）：

- **桥接完整**（快照齐备）：apiSpend=期初100+充值0−期末30=70、套餐300、totalSpends=[CNY 370]、`incompleteReason=null`、首页 `basis=BALANCE_BRIDGE`；
- **桥接不完整（数据级故障注入：删除期末快照）**：`apiSpendStatus=ENDING_BALANCE_MISSING`、套餐金额保留、totalSpends=[]、`incompleteReason 含"待补期末余额"`（即 R03 指认的 costs:92-94"有金额但不完整禁止比较"分支）；
- **状态恢复/非凭证异常**：EXHAUSTED-API「余额不足，需充值后等待余额同步」、EXHAUSTED-Plan「套餐额度耗尽…」、RATE_LIMITED「冷却到期后自动探测恢复」、DEGRADED+QUOTA_SYNC_RECOVERED（time_reliable）→ **PENDING_CONFIRM /「额度已恢复，待调用确认」**、ACTIVE+DEGRADED → PARTIAL_ABNORMAL；
- **bill fallback**：totalSpends 空+无原因+套餐已知 → 「不可跨币种合计；已知项保留」；
- **costs 纯函数单测**（新文件）：bridgeIncompleteReason 六分支直接驱动；
- **企业不存在**：员工同期窗口显式抛错（配合 metrics SQL 行为修正）。

残余未覆盖（如实登记，不构成门禁失败）：metrics:184（SQL 聚合恒返回一行的 `?.` 兜底）、providers 4 处稀有文案组合、dashboard-home.ts:102 旁路——均为防御性分支。

## 3. G02 变异证据：核心规则映射 + 有界增量变异 + 定向故障注入

**核心变更 → 保护证据映射表**（不外推到全部高风险逻辑）：

| 核心规则 | 保护证据 | 范围与限制 |
| --- | --- | --- |
| 同期窗口（大小月/半开/截断） | Stryker 17/17 killed（C1，`dashboard-home-metrics.ts:24-44`）+ 6 单测 | 仅该函数；SQL 构建函数不在变异范围（需 DB runner，未做） |
| **双期可比性 + 费用完整性文案**（G02a 本轮新增） | Stryker `standard-home-model.ts:37-95,133-168,170-243`：**243 变异体，killed 218，score 89.71%（exit=0，break=80）**；runner=model 单测 22 项 | 存活 24 + 未覆盖 1 的构成与定性见 `mutation-web.log`、`mutation/reports/home-model.json`：主要为展示串字面量（措辞级）与少量等价变异（如 `?? []` 在 previous=null 分支行为不变）；数值/符号/舍入等逻辑变异被杀死——[更正 R04：mutant 132/127（币种一致性/当期单币守卫）当时存活且非等价，已在 C5 补断言杀死；逐项定性见 V14-C5] |
| **费用完整性缺口规则**（G02b 本轮新增） | `countFinanceGaps` 六码正/反控制数据级定向故障注入（真实 PG）：每码注入应计数事实并断言计数；反控制（RESOLVED 解决记录、已登记现金、已关联订阅周期、有期初事件、窗口外事实）断言不计数 | 覆盖 6 个缺口码的判定与窗口过滤；未覆盖 legacy_cost_resolution 全生命周期管理界面流程 |
| 资源状态/恢复证据 | G01 状态恢复集成断言（PENDING_CONFIRM/恢复文案/局部降级）+ 既有 13 项测试 | 未做变异（文案与查询聚合为主） |
| 权限/租户隔离 | 路由 401 + 跨租户集成测试（C2） | 不变 |

回执：`mutation-web.log`、`mutation/reports/home-model.json`、`gate-database-candidate-tests.log`（含 G02b 用例 13/13）。

**G02b 附带产出**：注入测试暴露并修复了一个真实缺陷（缺币种遗留行导致首页费用同期聚合崩溃，见 §1），属门禁补强的直接收益。

## 4. 基线失败归因（逐项，修正 V14-C2 §4 的外推）

方法：干净 worktree @ `4898df5`（无候选），直连主仓 node_modules，逐一运行 C1 全量日志中的失败文件。回执：`baseline-db-batch1.log`、`baseline-db-batch2.log`、`baseline-db-capacity.log`、`baseline-api.log`。

| 失败项（C1 全量） | 基线复现 | 归因 |
| --- | --- | --- |
| billing-rule-multi-window（0021） | 失败（batch1，`expected '0067…' to be '0064…'`） | 既有 |
| operating-snapshot-subscription-period（0063） | 失败（batch1，同因） | 既有 |
| pool043-model-identity | 失败（batch1，同因） | 既有 |
| pool046-zhipu-window-alias（0045） | 失败（batch1，同因） | 既有 |
| pool047-resource-monthly-budget | 失败（batch1，同因） | 既有 |
| principal-key-single-active（0023） | 失败（batch1，同因） | 既有 |
| provider-finance-cutover | 失败（batch2，同因） | 既有 |
| provider-finance-ledger（0059） | 失败（batch2，同因） | 既有 |
| resource-fact-reconciliation（0062） | 失败（batch2，同因） | 既有 |
| runtime-assurance-foundation（0030） | 失败（batch2，同因） | 既有 |
| w20-final-migration（2 例，0045-0051/0053） | 失败（batch2，同因 2 例） | 既有 |
| **w20-standard-capacity（P95 容量）** | **基线通过（2/2）** | **不稳定计时用例**（P95 计时型，非确定性既有失败），单列 |
| control-api pool015（0066 断言） | 失败（baseline-api.log，同因） | 既有 |
| control-api pool025（0053 断言） | 失败（baseline-api.log，同因） | 既有 |

结论修正：**13 项确定性断言失败全部在干净基线逐项复现，根因一致（迁移 0065-0067 推进而断言停留在 0064/0066 时代；0065-0067 来自基线内既有提交 `72a69f7`/`e31da82`），与首页候选无关**；1 项容量用例为计时不稳定，另列。V14-C2 §4 的外推表述已在其卷首附录更正。

## 5. 其余门禁（与 C3 相同口径复跑）

typecheck 全仓 0；lint 全仓 0（--max-warnings=0）；size 0；architecture 0；web 全量 **52 文件/292 用例**；control-api 路由 2 + 金融回归 9；duplication 未受影响（无新增生产代码克隆）。回执：`gate-*.log`。

## 6. Findings（本轮冻结）

| ID | 级别 | 内容 | 处置 |
| --- | --- | --- | --- |
| F-G | P2（已修） | `dashboard-home-costs.ts` 缺币种遗留行致同期费用聚合崩溃（G02b 注入暴露） | C4 已修：跳过 null 币种行（缺口单列），注入测试守护 |
| F-H | P3（已修） | `previousEmployeeWindow` 对不存在企业静默返回空窗 | C4 已修：显式抛 `UsageOverviewEnterpriseNotFoundError` |
| F-I | P3 | 变异存活 25 个（展示串字面量/等价变异），清单与定性已归档 | 接受为残余；后续文案测试可再收敛 |
| F-J | P3 | 容量用例 `w20-standard-capacity` 为计时不稳定 | 基线即可通过/失败漂移，建议（非本任务）为其固定资源基线或放宽计时容差 |

`p0=0 p1=0`；阻断性 Evidence Gap=0；P2 已修（F-G）；P3 已登记。

## 7. Decision

- **门禁结论**：G01 覆盖率（5 文件、85% 阈值）**真实通过**（exit=0，92.59%）；G02 变异/注入证据**已按核心规则映射补齐**并准确标注范围与限制；基线归因逐项完成。
- `decision`：**V1.4 门禁整改完成，PASS 候选（效力=实施者自审 I1，供 Codex 复核 R04）**。R03 的 FAIL 项全部关闭；是否恢复 V1.4 完成结论由 Codex 裁决。
- 残余风险：生产量级性能未测（沿袭）；共享 StatusTag 深色问题沿袭（范围外）；变异存活 25 个已定性归档。
- 未提交、未推送、未合并、未部署。C1/C2/C3/R01/R02/R03/V14-C2 证据原样保留。


---

## 更正记录（R04，2026-09-10）

1. 测试计数：DB 候选测试为 **25 项**（窗口单测 6 + costs 单测 6 + PG 集成 13），本报告此前"18 项"为笔误（R04 已核回执）。前端 43 项不变。
2. 变异结论：§3 中"数值/符号/舍入/完整性判断等逻辑变异均被杀死"存在反例（mutant 132/127 存活且非等价）。已在 C5 补 moneyChangePercent 双 null 断言并确认杀死；其余存活逐项定性（3 等价 + 3 Stryker 归因假阳性且 ground truth 检测），见 V14-C5/report.md §2。
3. 本报告的 G01/覆盖率结论与 §1/§2 修复认可维持不变。
