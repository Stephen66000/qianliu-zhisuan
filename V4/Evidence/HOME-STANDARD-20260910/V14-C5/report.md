# 标准版首页 C5 · V1.4 门禁证据补全（R04 G02 收口，实施者自审）

日期：2026-09-10。独立性：`actual_independence = I1`（实施者自审），仅供 Codex 复核（R05）。
响应范围：仅 R04 剩余项 G02（存活变异处置）+ 报告精度修正；G01/功能问题已由 R04 关闭，未重开。未修改正确业务逻辑、未改阈值、未删核心变异范围、未重跑无变化 UI/覆盖、未触碰共享 reports 目录。

## 0. 候选锁（C5）

- HEAD：`4898df546fbcbc9ca292ee892cd7ae412766185a`（不变）。
- C5 tracked patch：**与 C4 字节一致**，SHA256 `f9549068868d88fe7260774a6d7f119ffebca1f800e18e6d1eaf39f486e3855d`（本轮仅改 untracked 测试文件）。
- 新增文件 15 项逐文件 SHA256：`candidate-new-files.sha256`（变化项：standard-home-model.test.ts、integration test；其余与 C4 一致）。
- 起止锁 STABLE（结束锁复测 hash 一致）。

## 1. mutant 132/127 关闭（R04 核心要求）

在**实际 mutation runner 所用**的 `standard-home-model.test.ts` 补 4 项 `moneyChangePercent` 守卫测试（R04 复现的两个场景原样覆盖）：

| 测试 | 断言 | 对应变异 | 复跑 |
| --- | --- | --- | --- |
| 币种不一致（当期 CNY 200 / 同期 USD 100） | **null** | #132（L138 币种一致性检查→false） | **Killed** |
| 当期多币（CNY 200+USD 50）对同期单币（CNY 100） | **null** | #127（L137 当期单币检查→false） | **Killed** |
| 同期多币对当期单币 | null | （对称守卫） | Killed |
| 同币种单币（200/100） | "+100.0%" | （守卫不误杀） | Killed |

同范围复跑（同 3 行区间、同阈值、同 runner）：**exit=0，243 变异体，killed 237、score 97.53%**。L137/L138 现无任何非 Killed 变异（按 location+replacement 匹配核验）。回执：`mutation-web.log`、`mutation/reports/home-model.json`。

## 2. 其余存活逐项定性（全部 8+1 项，无一笼统）

最终非 Killed 共 6 项（另有 1 项 NoCoverage），每项经**手工注入 ground truth**（临时改写源码→执行 runner 全部测试→恢复并校验 hash）或等价性推导判定：

| ID | 位置 | 变异（replacement） | 行为影响（实测/推导） | 定性 | 处置 |
| --- | --- | --- | --- | --- | --- |
| #8 | L41 | 条件 → false（删除 `previousScaled === null` 析支） | 非法上期串时 `null <= 0n` 弱化为 0 → 被第三析支 `<= 0n` 截获，仍返回 null | **等价**（第三析支子聚合 null 情形） | 注入实测 SURVIVED，接受 |
| #16 | L43 | `delta < 0n` → `delta <= 0n` | delta=0n 时 `-0n === 0n`，magnitude/tenths/输出不变 | **等价** | 注入实测 SURVIVED，接受 |
| #86 | L74 | 质量守卫 → false | (UNKNOWN, 0) → 返回 null ≠ 「上月同期含未知用量」 | **非等价 → 已检测** | 已有断言命中；ground truth 注入 DETECTED（`同期质量说明文案` 测试失败） |
| #207 | L212 | 模板串 → 空 | 「上月同期 不可完整计算」→「上月同期 」 | **非等价 → 已检测** | 已有精确断言 `toBe("上月同期 不可完整计算")` 命中；ground truth 注入 DETECTED；Stryker 标 NoCoverage 系 V8 模板映射假阳性 |
| #175 | L193 | `?? []` → `?? ["Stryker was here"]` | 变异 fallback 仅在 `cost.previous=null` 分支可及；该分支先行返回固定文案且 percent 对垃圾输入恒 null | **等价**（不可达 fallback） | 注入实测 SURVIVED，接受 |
| #178 | L196 | 同 #175 | 同上（后续 previousAllZero/length 分支仅 previous 非 null 时可达，`?.` 不触发） | **等价** | 注入实测 SURVIVED，接受 |

（上一轮已处理的 L182 #155/157/158 三个逻辑变异：新增"可比且上期为 0"与"不可比且上期为 0"两个区分性用例后，本轮复跑全部 Killed；L198 Regex/every→some 类：新增 0.50/00/0.00/混合零值用例后全部 Killed。）

**汇总**：243 = Stryker killed 237 + ground truth 检测 3（#8/#86/#207，Stryker 归因假阳性）+ 等价 3（#16/#175/#178）。有效杀死 240/243 ≈ **98.8%**。

**工具局限存证**：Stryker vitest-runner 对本文件存在少量归因假阳性（#8/#86/#207 在 ground truth 注入下测试确定失败，却被标 Survived/NoCoverage）——已以 `mutation/` 目录配置副本 + 本报告表格存证；该工具问题不影响"测试可检测变异"这一结论（ground truth 为准）。

## 3. 测试与计数更正

| 套件 | 数量 | 状态 |
| --- | --- | --- |
| web 全量 | 52 文件 / **305 用例**（model 34、Dashboard 21） | exit 0（gate-web-tests.log） |
| DB 候选 | **25 项**（窗口单测 6 + costs 单测 6 + PG 集成 13） | exit 0（gate-database-candidate-tests.log） |
| control-api（沿袭） | 路由 2 + 金融回归 9 | exit 0（C4 回执沿用，本轮无相关变更） |

计数更正：C4 handoff"DB 18 项"为笔误，正确为 **25**（已在 C4/handoff.md 与 V14-C4/report.md 原文处加更正标记）。前端 43 项（Dashboard 21 + model 22）在 R04 复核后因本轮新增扩为 model 34 → web 全量 305。

## 4. 门禁汇总（C5 回执，全部 exit 0）

typecheck 全仓、lint 全仓（--max-warnings=0）、size（≤400 行）、web 全量 305、DB 候选 25、变异 97.53%（exit 0）。G01 覆盖率未重开（R04 已关闭，C4/coverage-db.log 与 R03/coverage.log 沿袭）。architecture/duplication 无相关变化（无新生产代码）。

## 5. Findings 与残余

| ID | 级别 | 内容 | 处置 |
| --- | --- | --- | --- |
| F-M | P3（已处置） | Stryker 归因假阳性 3 个（#8/#86/#207） | ground truth 注入存证；工具局限记录 |
| F-N | P3（已处置） | 等价变异 3 个（#16/#175/#178） | 推导写入报告，接受 |
| 沿袭 | — | 生产量级性能 / 共享 StatusTag 深色 / WCAG 定量 / F-F 产品裁决 | 未变，沿袭登记 |

`p0=0 p1=0`；阻断性 Evidence Gap=0。

## 6. Decision

- **G02 收口**：两项非等价存活（132/127）已补明确 null 断言并确认杀死；其余存活逐项定性（3 等价 + 3 归因假阳性且 ground truth 检测），无笼统表述残留。
- **V1.4 门禁状态**：G01（关闭，R04）+ G02（本轮收口）+ R01 功能项（关闭，R02）均无未决阻断；效力=实施者自审 I1，**提请 Codex 复核后作出 V1.4 最终结论**。
- 沿袭不变：未提交、未推送、未合并、未部署；本候选不含生产逻辑变更（仅测试与证据）。
