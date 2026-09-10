# 标准版首页 C5 · V14 门禁证据补全（R04 G02 收口）

日期：2026-09-10。基线不变：HEAD `4898df5`。C1–C4/R01–R04/V14-C2/V14-C4 证据原样保留。
候选：`HOME-STANDARD-C5-20260910`。tracked patch 与 C4 字节一致（`f9549068868d88fe7260774a6d7f119ffebca1f800e18e6d1eaf39f486e3855d`，本轮**仅新增测试**）；变更的 untracked 文件以 `candidate-new-files.sha256`（15 项）冻结。

## 1. R04 mutant 132/127：已补断言并被杀死

在**实际 mutation runner 所用**的 `standard-home-model.test.ts` 中新增 4 项 `moneyChangePercent` 守卫测试：

| 断言 | 对应变异体 | 复跑结果 |
| --- | --- | --- |
| 币种不一致（当期 CNY 200 / 同期 USD 100）→ **null** | #132（L138 币种一致性检查删除） | **Killed** |
| 当期多币种（CNY 200 + USD 50）对同期单币（CNY 100）→ **null** | #127（L137 当期单币检查删除） | **Killed** |
| 同期多币种对当期单币 → null（对称守卫） | — | Killed |
| 同币种单币（CNY 200/CNY 100）→ "+100.0%"（守卫不误杀） | — | Killed |

复跑同范围变异（同 3 个行区间、原阈值）：**exit=0，243 变异体 killed 237、score 97.53%**。回执：`mutation-web.log`、`mutation/reports/home-model.json`。R04 survivor-repro.json 的两个场景（null → +100.0%）被回归测试覆盖。

## 2. 其余存活逐项定性（R04 要求：位置/替换/行为影响/处置）

变异分析切换为 `coverageAnalysis: "all"`（逐变异体执行全部测试，消除 perTest 覆盖归因噪声），并对 Stryker 仍报存活的变异体逐个做**手工注入 ground truth**（临时改写源码→跑 runner 测试→恢复，恢复后文件 hash 校验一致）。

最终非 Killed 共 6 个，逐项如下（完整清单见 `mutation/reports/home-model.json`）：

| ID | 位置/替换 | 行为影响（注入实测） | 定性与处置 |
| --- | --- | --- | --- |
| #8 | L41：删除 `previousScaled === null` 守卫 | 非法上期串（如 ""）→ `null <= 0n` 在 BigInt 关系比较中弱化为 0 → 被第三个析支 `<= 0n` 截获 → 仍返回 null | **等价变异**（第三析支覆盖 null 情形）；注入实测 SURVIVED 与分析一致 |
| #16 | L43：`delta < 0n` → `delta <= 0n` | delta=0n 时 `-0n === 0n`，magnitude/符号/输出完全不变 | **等价变异**；注入实测 SURVIVED |
| #86 | L74：质量说明守卫 `UNKNOWN \|\| unknownCount>0` → false | (UNKNOWN, 0) → 返回 null 而非「上月同期含未知用量」 | **非等价，已被测试检测**：ground truth 注入 → `同期质量说明文案` 测试失败（DETECTED）；Stryker 状态标 Survived 系归因假阳性，已存证 |
| #207 | L212：模板串 → 空 | 「上月同期 不可完整计算」→「上月同期 」 | **非等价，已被测试检测**：ground truth 注入 → `上期存在但无可比金额且无原因` 测试失败（DETECTED）；Stryker 标 NoCoverage 系 V8 模板映射假阳性，已存证 |
| #175 | L193：`?? []` → `?? ["Stryker was here"]` | 变异数组仅在 `cost.previous` 为 null 的分支可及；该分支由 `!cost.previous` 先行返回固定文案，且 moneyChangePercent 对垃圾输入返回 null → 输出不变 | **等价变异**（不可达 fallback）；注入实测 SURVIVED |
| #178 | L196：同上 | 同上（previousAllZero 等后续分支仅在 previous 非 null 时可达，届时 `?.` 不触发） | **等价变异**；注入实测 SURVIVED |

（R04 点名的 id8/#86/#185 类似项：#8/#86 见上；`every→some` 类变异（原 #185）经零值格式/混合零值 3 项新用例已被杀死——本轮复跑中 L198 Regex/MethodExpression 全部 Killed。）

**汇总**：243 = killed 237 + 检测假阳性 3（#8/#86/#207，ground truth DETECTED）+ 等价 3（#16/#175/#178）。有效杀死率 **240/243 ≈ 98.8%**。不再有被笼统归类的非等价存活。

## 3. G01 状态

未重开（R04 已关闭）。附带记录：G01 整改后的最终口径为 DB 候选测试 **25 项**（窗口单测 6 + costs 纯函数单测 6 + PG 集成 13）——更正 C4 handoff/validation 中"18 项"的计数笔误（25 = 6+6+13；C4 回执 `gate-database-candidate-tests.log` 本身记录的就是 13 项那次子集运行与单测文件，合计口径见各日志）。

## 4. 门禁与测试（C5 回执，全部 exit 0）

- web 全量：**52 文件 / 305 用例**（model 单测 34，含本轮新增 10 项）
- DB 候选：**25 项**（6+6+13）
- typecheck / lint / size：全过
- 变异：`mutation-web.log`（97.53%，exit 0）+ `mutation/reports/home-model.json` + 配置副本归档（仓库内临时配置已删除）
- tracked patch hash 与 C4 一致：`f9549068…`（仅测试文件变化，均在 untracked 清单内）

## 5. Findings 与残余

- F-K (P3)：Stryker vitest-runner 对本文件存在少量归因假阳性（#8/#86/#207 ground truth DETECTED 但标记 Survived/NoCoverage）——已用手工注入存证补齐，工具问题不阻塞。
- F-L (P3)：#16/#175/#178 等价变异——数学/不可达推导已写入报告，接受。
- 沿袭残余（未变）：生产量级性能、共享 StatusTag 深色、WCAG 定量抽查、F-F 产品裁决。

**结论**：R04 指认的两项非等价存活已补断言并确认杀死；其余存活逐项定性完毕（3 等价 + 3 检测假阳性）；G02 门禁证据收口。V1.4 门禁状态（效力=实施者自审 I1）交 Codex 复核定论。
