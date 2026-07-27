# M1~M4 代码质量 Audit · 有界复审 round 2（V1.4 §10.2）

| 项目 | 内容 |
| --- | --- |
| audit_id | `M1M4-CODE-AUDIT-20260728-ZCODE-GLM52-INDEP-R2` |
| audit_type | **代码质量有界复审（bounded code-quality re-audit）** |
| audit_round | 2（对 round 1 代码质量 FAIL 的整改做有界复审） |
| 规范条款 | `AI阶段功能与验收审计规范-通用版-v1.4.md` §10.2/§10.3 + `AI编码工程规范-通用版-v1.4.md` §8.6 |
| contract_ref | `V3/Evidence/M4/audit/M4-审核任务书-v1.md` §4 |
| based_on_remediation | `M1-M4-代码质量整改报告-QDEP1-QDOC1-主AI整改-20260728.md` |
| based_on_round1 | `M1-M4-代码质量审计报告-zcode-glm52独立会话-20260727.md`（round 1，FAIL） |
| 复审范围（仅 4 项，不重审全量） | Q-DEP-1（依赖升级 + cookie typecheck bug）+ Q-DOC-1（过期注释）+ GAP-MUT-1（变异测试 Gap 判定）+ domain 直接回归面 |
| risk_level | R3 |
| required_independence | I2（R3 最低） |
| actual_independence | **I1**（同模型族 GLM-5.2，换会话；**本会话作者链 = 本整改执行者**，见 §0.2）—— 见 §0.2 |
| reviewer_identity / model_or_verifier | ZCode 独立审核会话 / builtin:bigmodel-coding-plan/GLM-5.2 |
| round1_reviewed_head | `64b7a08`（产品代码 `8d7fe18`，impl_hash `57f3d4ad...`） |
| product_code_head（整改产品代码冻结） | `a06fa25`（Q-DEP-1+Q-DOC-1+GAP-MUT-1 整改 commit） |
| reviewed_head（本次复审） | `f353344`（HEAD；产品代码自 a06fa25 未变，其后 1 个文档 commit） |
| evidence_mode | local-first（仓库无 remote，纯本地 Git） |
| candidate_manifest | `V3/Evidence/M4/audit/candidate-lock.json`（开审重新 generate 绑定当时 HEAD） |
| implementation_hash | `a814a5a86e57a592046ba702f3fe8e2e8f1d95fce6aa060e8386fbb5f404c679`（≠ round1 `57f3d4ad`，因整改是产品语义变化，符合 §10.1 第一行） |
| start_lock_verification | `STABLE`（exit 0），2026-07-28 ~07:03 |
| end_lock_verification | `STABLE`（exit 0），2026-07-28 ~07:22 |
| remediation_diff_range | `git show a06fa25 --stat`，14 文件 +1645/-153（含 lockfile +1214） |
| **decision** | **FAIL（GAP-MUT-1 未真正消除：变异测试有界可解，主 AI 整改不彻底）** |
| callback_target | 佳哥（Owner）→ 交主 AI 补整改 stryker configFile |

---

## 0. 复审前置说明

### 0.1 复审范围与变化分类（§10.1）

整改 diff（`64b7a08 → a06fa25`）按 V1.4 §10.1 属**第一行**："产品可执行代码、测试语义、协议、部署、迁移、构建、制品、权限、安全、配置或运行工作流语义变化"（依赖版本升级 + cookie 类型增强 + stryker 配置）。原 round 1 FAIL 对新对象失效，做有界复审：聚焦 3 个旧 Finding 的修复 diff + 直接回归面（domain 108 + gateway 北向合同 e2e）。

**未触发 §10.5 全量重审**：整改未引入新架构/协议，在 round 1 required action 范围内。

### 0.2 实际独立性如实披露（重要）

- 任务书要求 R3 最低 **I2**。**本次实际独立性 = I1**：新会话、未参与 M1~M4 作者链与本次整改、未读作者链/整改会话过程聊天、只读冻结输入（任务书 + round 1 代码质量报告 + 整改报告 + 候选代码 + 尺子规范）。但模型为 **GLM-5.2，与主 AI 作者链同为 GLM 系列模型族**。
- **关键披露（用户在 brief 中已明示）**：本次复审的委托方就是"做了整改的主 AI"——即整改执行者与审核委托方同模型族、同人角色链。但**本审核会话本身是新会话、独立执行、只读、未参与整改决策**。按 V1.4 §2.5 + 附录 A，同模型族换会话仍为 I1，不构成 I2。
- 佳哥须独立判断：(a) 接受 I1 结论；(b) 要求 I2（不同模型族）复核。本结论在 I1 独立性下出具，技术证据扎实（命令真实运行 + 代码逐行核对 + 亲自跑 stryker 产出真实变异分数），但模型族偏见风险未消除。

### 0.3 只读合规

- 复审期间**未修改任何产品代码、测试、迁移、部署、状态账本**。
- 唯一持久写动作：开审按任务书 §2 重新 generate `candidate-lock.json`。
- **临时实验文件已全部还原**：为核验 GAP-MUT-1，临时创建 `packages/domain/vitest.config.ts` + 改 `stryker.config.json`（绝对路径 configFile）跑 stryker，**跑完立即 `git checkout`/`rm` 还原**。结审 `git status` 仅 candidate-lock.json M，产品代码零变更（§附录步骤 14 核验）。
- 未执行 push/remote/PR/对外上传（仓库无 remote）。
- **未整改、未下发、未推进、未 push**。

---

## 1. 复审执行概览

### 1.1 直接实测命令（A 级 Evidence）

任务书 brief 明确提示："corepack 缓存可能故障，关键命令建议直接调 node_modules/.bin 绕过"。本次对**最关键的 typecheck**采用直接 tsc（绕过 pnpm script）。

| 命令 | 退出码 | 实测结果 | 整改报告声明 | 对照 |
| --- | --- | --- | --- | --- |
| 对象锁 generate（开审） | 0 | impl_hash=`a814a5a8...` | （未声明具体值） | ✓ STABLE |
| 对象锁 verify（开审） | 0 | STABLE，5 drift 全 false | STABLE | ✓ |
| **typecheck（control-api，直接根 tsc，清 tsbuildinfo 缓存）** | **0** | **零错误零输出** | "control-api cookie 类型已修，0 错误" | ✓ **真绿，独立坐实** |
| `pnpm typecheck`（全 11 包） | 0 | 11 包全 Done | 11 包全 Done | ✓ |
| `pnpm lint`（--max-warnings=0） | 0 | 11 包全 Done | 11 包全 Done | ✓ |
| `pnpm test`（domain 直接 + gateway 北向） | 0 | domain **108** + gateway **69**（含 w05/w08/w09/w10 北向全过） | domain 108 + gateway 69 | ✓ |
| `pnpm build` | 0 | 11 包全 Done | 11 包全 Done | ✓ |
| `pnpm evidence:canary` | 0 | postgres/redis/logs/traces 全 0 | 全 0 | ✓ |
| `pnpm audit`（undici/fastify 过滤） | — | **undici/fastify 未出现在漏洞列表**（清零） | 清零 | ✓ |
| 对象锁 verify（结审） | 0 | STABLE | STABLE | ✓ |

### 1.2 typecheck 诚信问题独立坐实（本轮重点核验项）

整改报告 §3 披露："round 1 代码质量审核时 typecheck 实际是坏的（control-api 6 个 cookie TS2339 错误），round 1 报告 §3.1 'typecheck PASS 11 包 Done' 与此矛盾"。**本复审独立复现验证**：

1. **清掉 `apps/control-api/tsconfig.tsbuildinfo` 增量缓存**（`incremental: true` 会缓存上次结果）。
2. **临时移走 `cookie-types.d.ts`**（整改修复文件）。
3. 直接根 tsc 跑 control-api tsconfig：**报出 6 个 TS2339 错误**（`setCookie`/`clearCookie`/`cookies` 不存在于 FastifyReply/FastifyRequest），与整改报告 §3 说的"6 个"逐字吻合。
4. 还原 cookie-types.d.ts + 清缓存重跑：**exit 0，零输出**。

**结论**：
- round 1 代码质量报告 §3.1 "typecheck PASS" **失实属实**——control-api 当时确有 6 个类型错误。可能的掩盖机制：`incremental: true` + tsbuildinfo 缓存（若缓存是旧的有效态，tsc 跳过重检）；或审核时 corepack/pnpm 中间层故障（整改报告 §3.1 推测）。
- **cookie-types.d.ts 修复真实有效**：根因（base tsconfig `verbatimModuleSyntax: true` + NodeNext 模块解析下，`@fastify/cookie@11.1.2` 包内 `types/index.d.ts` 的 `declare module 'fastify'` 增强不被合并到编译单元）正确——我核验了包内 types 确有该增强，但在该 tsconfig 组合下不加载；src 内同内容 .d.ts 生效。
- round 1 其余结论的可信度：typecheck 失实只影响 §3.1 typecheck 门禁的"PASS"标注（实际当时应 FAIL）。round 1 其他维度（结构/依赖架构/类型逃生舱扫描/测试语义）基于真实代码阅读，不受此影响。

---

## 2. Finding 逐项判定（§10.2：CLOSED / REMAINING / REGRESSED / NEW_DIRECT_REGRESSION）

### Q-DEP-1 · 依赖漏洞（round 1 P2）→ **CLOSED**

**整改验证**：

1. **版本升级 diff 独立核验**（`git show a06fa25` + 当前 package.json）：
   - undici 7.16.0 → **7.29.0**（gateway + provider-adapters 生产 deps）。✓
   - fastify 5.6.1 → **5.8.5**（gateway + control-api 生产 deps）。✓
   - @fastify/cookie 11.0.2 → **11.1.2**（control-api，适配 fastify 5.8.x）。✓
   - 与整改报告 §1 一致，无隐藏变更。
2. **pnpm audit 独立跑**：undici/fastify 在漏洞列表 **grep 未出现**（exit 1 = 清零确认）。剩余 16 漏洞（1 low/7 moderate/7 high/1 critical）全为 `@eslint/plugin-kit`/`@opentelemetry/core`/`brace-expansion`/`esbuild`/`kysely`/`qs`/`uuid`/`vite`/`vitest`——开发依赖或工具链，**不在 Q-DEP-1 范围**。
   - **数字偏差如实记录**：整改报告 §1 说"剩余 15"，本复审数到 **16**。差异可能为 unique 包数 vs advisory 条目数的统计口径，**不影响 undici/fastify 清零结论**。建议主 AI 复核口径。
3. **附带 cookie typecheck bug 修复**：见 §1.2，独立坐实有效。
4. **北向合同 e2e 直接回归面**（fastify 升级影响 body 校验，是 Q-DEP-1 直接回归面）：gateway 69 全绿，含 w05（北向合同 10）/w08（DeepSeek 4）/w09（智谱 5）/w10（Kimi 5）全过。**零回归**。

**结论**：Q-DEP-1 required action（升级 undici≥7.24.0 + fastify≥5.7.2 + 重跑 audit 清零）全部落实。**CLOSED**。

---

### Q-DOC-1 · main.ts:68 过期注释（round 1 P3）→ **CLOSED**

**整改验证**（`git show a06fa25 -- apps/gateway/src/main.ts`）：

- 注释由 `// 由 pipeline 从 allCandidates 填充（生产查询不直接带 principal_id）` 改为 `// 路由候选不携带主体；pipeline 用已认证的 principal.principalId 做额度/账本归因（R2-N1）`。
- 与 R2-N1 修复后实际行为（pipeline 用 `principal.principalId`，候选行 principalId 为 dead code）**吻合**。

**结论**：注释与实现一致。**CLOSED**。

---

### GAP-MUT-1 · 变异测试（round 1 P1 阻断）→ **REMAINING（整改不彻底：阻塞点有界可解，主 AI 未试到）**

这是本轮最关键的判定，**与整改报告结论分歧**。我亲自跑 stryker 验证。

**整改报告 §1 GAP-MUT-1 声称**："stryker sandbox + pnpm workspace + 共享 vitest config 三重冲突，`{configDirectory}` 占位符在 sandbox 内不被替换，是 stryker 在 pnpm monorepo 下的已知生态问题，非代码缺陷"，故登记 Evidence Gap 未产出分数。

**本复审独立验证（3 次实验）**：

1. **实验 1：原状跑 stryker**（`packages/domain/stryker.config.json` 原始 `{configDirectory}/vitest.config.ts`）→ 失败，错误：`Could not resolve ".../.stryker-tmp/sandbox-XXX/{configDirectory}/vitest.config.ts"`。**印证整改报告说的 `{configDirectory}` 不替换问题属实**。
2. **实验 2：workaround A（整改报告建议的"给 domain 包独立 vitest config"）**——临时建 `packages/domain/vitest.config.ts`，仍用 `{configDirectory}` 占位符 → **仍失败**，同一错误。**证明整改报告建议的 workaround A 不够**：根因不是"config 文件不存在"，而是 `{configDirectory}` 占位符本身不被替换。
3. **实验 3：configFile 改绝对路径**（`/Users/mac/.../packages/domain/vitest.config.ts`）→ **成功！stryker 跑通，产出真实变异分数**。

**实验 3 产出的真实变异分数（5 个 R3 核心规则文件，全部跑通）**：

| 文件 | mutation score | covered | # killed | # survived | # no cov |
| --- | --- | --- | --- | --- | --- |
| **All files** | **78.55%** | 85.57% | 498 | 84 | 52 |
| reconciliation.ts | 96.23% | 96.23% | 51 | 2 | 0 |
| quota-gate.ts | 90.57% | 90.57% | 48 | 5 | 0 |
| dispatch-policy.ts | 83.41% | 89.16% | 181 | 22 | 14 |
| routing-policy.ts | 78.35% | 78.35% | 76 | 21 | 0 |
| billing-rule.ts | 66.36% | 80.68% | 142 | 34 | 38 |

**判定逆转的依据**：

- **GAP-MUT-1 不是"工具链基础设施级阻塞"**：stryker 9.6.1 + vitest-runner 在本项目完全可跑，绝对路径 configFile 即可绕过 `{configDirectory}` 占位符 bug。这是**有界可解的工具链配置问题**，不是"生态未解 issue"。
- **主 AI 整改不彻底**：只试了 `{configDirectory}` 占位符 + workaround A（独立 config），未试绝对路径；停在"阻塞点如实记录"，登记 Gap。但绝对路径方案能让 5 个 R3 文件全部产出分数——**变异测试 Evidence 实际可产出，主 AI 未产出**。
- **变异分数本身证明测试有效性中等偏上**：78.55% 总分，reconciliation/quota-gate（资金/额度核心）≥90% 优秀；但 **billing-rule 66.36%（34 survived + 38 no coverage）低于 stryker.config.json 自己定的 low=80 阈值**——计价规则有真实测试盲区。这恰恰是变异测试的价值：它抓到了 round 1 功能 Audit 抓不到的测试语义缺口。

**§10.3 / §8.6 判定**：
- 规范 §8.6 "R3 核心业务规则原则上必须执行变异测试"；§8.8 "未运行不能写成 PASS"。
- round 1 据此判 GAP-MUT-1 为阻断性 Evidence Gap（P1）——**该判定正确**。
- 整改后 stryker 已配置 + **实际可跑通**（本复审证明），但主 AI 未产出分数、未补测幸存变异，仍登记 Gap。**阻断性 Gap 未真正消除** → PASS 必要条件"P1=0 + 阻断性 Gap=0"未满足。

**结论**：GAP-MUT-1 **REMAINING**。变异测试基础设施已就位且有界可解（绝对路径 configFile），但主 AI 整改停在"登记 Gap"未实际跑通产出分数。**须补整改**：改 stryker.config.json 用绝对路径 configFile（或等价方案）→ 跑出 5 文件变异分数 → 对低于阈值（billing-rule 66.36%、routing-policy 78.35%）的幸存变异补测试或显式登记接受残余 → 新候选重锁 → round 3 有界复审。

> **重要**：本复审已用临时绝对路径 configFile 跑出全部分数（上表），主 AI 补整改时可直接采用该方案 + 参考 survived/no-cov 清单补测。临时实验文件已全部还原，未污染候选。

---

## 3. 直接回归面（§10.2）

### 3.1 domain 直接回归面（108 单测）

domain 是 R3 核心规则所在 + stryker 配置所在包，是 Q-DEP-1（依赖升级）+ GAP-MUT-1（stryker 配置）的直接回归面。`vitest run`：**108 passed**（billing-rule 14 / quota-gate / dispatch-policy 26 / routing-policy 10 / reconciliation / supply-forecast 14 / resource-lifecycle 19 / domain 4）。**零回归**。

### 3.2 gateway 北向合同 e2e（fastify 升级直接回归面）

fastify 5.6.1→5.8.5 影响 body 校验/路由，直接回归面 = 北向合同。gateway 69 全绿，含 w05/w08/w09/w10。**零回归**。

### 3.3 直接回归面小结

- **REGRESSED**：**无**。Q-DEP-1 升级对 domain 108 + gateway 69 零破坏。
- **NEW_DIRECT_REGRESSION**：**无**。cookie-types.d.ts 是纯类型增强（无运行时代码），stryker 配置不影响 vitest 正常运行。

---

## 4. 判定汇总

| Finding | round 1 | 整改 | round 2 判定 | 依据 |
| --- | --- | --- | --- | --- |
| Q-DEP-1 依赖漏洞 + cookie typecheck bug | P2 | CLOSED | **CLOSED** | 升级 diff + audit 清零（undici/fastify grep 未出现）+ 北向 e2e 零回归 + typecheck 真绿（§1.2 坐实） |
| Q-DOC-1 过期注释 | P3 | CLOSED | **CLOSED** | 注释与 R2-N1 实现吻合 |
| GAP-MUT-1 变异测试 | P1（阻断） | 登记 Gap | **REMAINING** | 整改不彻底：绝对路径 configFile 可跑通，本复审已产出 5 文件变异分数；主 AI 未产出 |
| domain 直接回归面 | — | — | **零回归** | 108 passed |

### 4.1 未达 PASS 的具体缺口（V1.4 §6.1）

- ❌ **P1 = 0**：GAP-MUT-1 仍 REMAINING（变异测试有界可解但未产出分数）。
- ❌ **阻断性 Evidence Gap = 0**：GAP-MUT-1 阻断性 Gap 未真正消除（工具链已就位、可跑通，缺的是"实际跑 + 补测幸存"这一步）。
- ⚠ 实际独立性 I1（低于 R3 的 I2）。

### 4.2 round 1 typecheck 失实的后续影响

round 1 §3.1 typecheck 门禁标注失实（control-api 当时 6 错误）。本次整改已修，typecheck 现真绿。**但 round 1 报告作为历史档案，其"typecheck PASS"记录不准**——建议佳哥/主 AI 在 round 1 报告追加勘误备注（不修改原结论，仅标注失实 + 已由 round 2 坐实修复），保持档案诚信。

---

## 5. Decision

### 5.1 结论：**FAIL（GAP-MUT-1 REMAINING：变异测试有界可解，整改不彻底）**

依据 V1.4 §10.2 + §8.6 + §8.8：
- Q-DEP-1 / Q-DOC-1 两项 **CLOSED**（整改扎实，独立坐实，零回归）。
- GAP-MUT-1 **REMAINING**：round 1 判其为阻断性 Gap 正确；整改配置了 stryker 但停在"登记 Gap"，未实际产出分数。**本复审独立证明 stryker 在本项目可跑通**（绝对路径 configFile），并已产出 5 文件变异分数（总 78.55%，billing-rule 66.36% 低于自定阈值）——即阻断性 Gap 实际有界可解，主 AI 未走完最后一步。
- 仍有 P1（GAP-MUT-1）未关闭 → 不得 PASS（§6.1 + §10.4）。

### 5.2 与 round 1 的关系（§10.2 "旧 FAIL 不自动覆盖"）

- round 1 的 Q-DEP-1（P2）/ Q-DOC-1（P3）已重新证明 CLOSED。
- round 1 的 GAP-MUT-1（P1 阻断）**未自动继承任何 PASS**：本复审独立验证发现整改不彻底，判定 REMAINING。
- **GAP-MUT-1 的性质在 round 2 被精化**：round 1 时它是"工具完全缺失"的阻断 Gap；round 2 时它是"工具已就位、有界可解、但未跑完"的阻断 Gap。阻塞强度下降（从"缺工具"到"缺最后一步"），但仍阻断。

### 5.3 是否触发 §10.5 全量重审

**未触发**。GAP-MUT-1 补整改是 stryker configFile 1 行改 + 跑分数 + 补测幸存变异，在当前冻结合同内可收口。建议走 round 3 有界复审（仅 GAP-MUT-1）。

### 5.4 回传

- `decision`：**FAIL（GAP-MUT-1 REMAINING）**
- `audit_round`：2（代码质量有界复审）
- `reviewed_object`：HEAD `f353344`，产品代码冻结 `a06fa25`，impl_hash `a814a5a8...`
- `start/end_lock_verification`：STABLE / STABLE（exit 0）
- `closed_findings`：Q-DEP-1、Q-DOC-1（2 项）
- `remaining_findings`：GAP-MUT-1（P1，有界可解未跑完）
- `regressed / new_direct_regression`：无
- `independence`：I1（同模型族，见 §0.2）
- `requested_next_action`：主 AI 补整改 GAP-MUT-1——
  1. 改 `packages/domain/stryker.config.json` 的 `vitest.configFile` 为绝对路径（或等价可跑通方案）。
  2. 跑出 5 文件变异分数（本复审已验证可跑，分数见 §2 表）。
  3. 对低于自定 low=80 阈值的文件（billing-rule 66.36%、routing-policy 78.35%）补测幸存变异，或显式登记接受残余（须佳哥书面接受）。
  4. crypto/key（在 provider-adapters 包）变异测试本轮未覆盖，随 GAP-MUT-1 一起处置或登记。
  5. 新候选重锁 → round 3 有界复审（仅 GAP-MUT-1）。
- `requested_state_transition`：维持 `CODE_AUDIT_IN_PROGRESS`；**PASS 前不得 SEALED，不得进入 M5**。
- `prohibited_next_action`：主 AI 不得在 GAP-MUT-1 收口前 SEALED；不得 push/remote/PR；审核 AI 不整改、不下发、不推进。

---

## 6. 做得好的地方（如实记录）

- **Q-DEP-1 整改彻底**：依赖升级 + 附带修复 M1~M4 既有的 cookie typecheck bug（这个 bug 比依赖漏洞本身更严重——它意味着 round 1 typecheck 失实）。整改报告 §3 主动披露"typecheck 全绿 Evidence 失实"，是诚信体现。
- **cookie-types.d.ts 根因分析准确**：精确识别 `verbatimModuleSyntax + NodeNext` 下包内 module augmentation 不合并的问题，修复方式（src 内显式 declare module）正确且最小。本复审独立复现验证。
- **北向合同零回归**：fastify 5.8.5 升级对 w05/w08/w09/w10 零影响，说明升级风险控制好。
- **stryker 配置框架到位**：5 个 R3 核心规则文件选定正确、阈值合理（low=80/break=70）、coverageAnalysis perTest——只差 configFile 路径这临门一脚。
- **整改 diff 透明**：单 commit、与整改报告 §1 一致、无顺手改 P2/P3（§10.3 合规）。

GAP-MUT-1 是"已铺好 90% 路面、缺最后 10%"的整改不彻底，补完 configFile 路径 + 跑分数 + 补测低分文件后，候选应能快速达到 PASS。

---

## 附录：复审执行日志摘要

| 步骤 | 命令/动作 | 结果 |
| --- | --- | --- |
| 1 | 读整改报告 + round 1 代码质量报告 + 任务书 | 理解范围 + cookie/typecheck 诚信问题 |
| 2 | git HEAD/status/remote 核验 | HEAD=f353344，产品代码自 a06fa25 未变，无 remote |
| 3 | 对象锁 generate（绑定 HEAD） | impl_hash=`a814a5a8...`（≠round1，产品语义变化） |
| 4 | 对象锁 verify（开审） | STABLE，5 drift 全 false |
| 5 | **control-api 直接根 tsc（绕过 pnpm）** | exit 0，零输出（真绿） |
| 6 | **typecheck 诚信复现：清 tsbuildinfo + 移走 cookie-types.d.ts** | 6 个 TS2339 错误（坐实 round 1 失实） |
| 7 | 还原 cookie-types.d.ts + 清缓存重跑 | exit 0 零输出（修复有效） |
| 8 | 依赖版本 diff 核验（git show + package.json） | undici 7.29.0 / fastify 5.8.5 / cookie 11.1.2 ✓ |
| 9 | `pnpm audit` + undici/fastify grep | 清零（未出现）；剩余 16 漏洞全非 Q-DEP-1 范围 |
| 10 | main.ts:68 注释核验（Q-DOC-1） | 与 R2-N1 实现吻合 |
| 11 | domain vitest（直接回归面） | 108 passed |
| 12 | gateway vitest（北向合同 e2e） | 69 passed（w05/w08/w09/w10 全过） |
| 13 | **stryker 实验 1：原状跑** | 失败（`{configDirectory}` 不替换） |
| 14 | **stryker 实验 2：workaround A（独立 config）** | 仍失败（占位符仍不替换） |
| 15 | **stryker 实验 3：绝对路径 configFile** | **成功，产出 5 文件变异分数（总 78.55%）** |
| 16 | 还原临时 vitest.config.ts + stryker.config.json | git checkout，产品代码零变更 |
| 17 | `pnpm lint` / `build` / `evidence:canary` | 全 exit 0 |
| 18 | 对象锁 verify（结审） | STABLE，HEAD 不变 |

报告完成。回传佳哥。
