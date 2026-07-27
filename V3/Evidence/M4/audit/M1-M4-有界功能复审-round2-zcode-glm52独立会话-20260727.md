# M1~M4 有界功能复审报告（round 2）· V1.4 §10.2

| 项目 | 内容 |
| --- | --- |
| audit_id | `M1M4-FUNC-AUDIT-20260727-ZCODE-GLM52-INDEP-R2` |
| audit_type | **有界功能复审（bounded functional re-audit）** |
| audit_round | 2（对 round 1 FAIL 的整改做有界复审） |
| 规范条款 | `AI阶段功能与验收审计规范-通用版-v1.4.md` §10.2 / §10.3 / §10.5 |
| contract_ref | `V3/Evidence/M4/audit/M4-审核任务书-v1.md`（任务书 v2） |
| based_on_remediation | `M1-M4-整改报告-F01F03F12F02-主AI整改-20260727.md`（`M1M4-REMEDIATION-20260727-MAIN-AI`） |
| based_on_round1 | `M1-M4-功能与验收审计报告-zcode-glm52独立会话-20260727.md`（round 1，FAIL） |
| 复审范围（仅 4 项，不重审全量） | F-01 / F-03 / F-12（round 1 P1）+ F-02（P2 同批） |
| risk_level | R3 |
| required_independence | I2（R3 最低） |
| actual_independence | **I1**（同模型族 GLM，换会话）—— 见 §0.2 |
| reviewer_identity | ZCode 独立审核会话（builtin:bigmodel-coding-plan/GLM-5.2） |
| base_head（round 1 FAIL 候选） | `b2c94655bfc9e24a533cf8c595df2062082eeed7` |
| product_code_head（整改产品代码冻结） | `b7bc04003cfcec6d0494ebc77a711cc042381ee6` |
| reviewed_head（本次复审） | `387fe99a4fb9da1db99842bcb656dcca1d2d8130`（HEAD；产品代码自 b7bc040 未变，其后仅 Evidence/lock 文档 commit） |
| evidence_mode | local-first（仓库无 remote，纯本地 Git commit + 工作树） |
| candidate_manifest | `V3/Evidence/M4/audit/candidate-lock.json`（复审开审重新 generate 绑定当时 HEAD） |
| implementation_hash | `cbd7e00ba4969b7c1c2aa7e7d3b628c0531b38e681457aa46e0b0e14e8c550b4`（与整改报告冻结值**逐字符一致**） |
| start_lock_verification | `STABLE`（exit 0），2026-07-27 ~22:52 |
| end_lock_verification | `STABLE`（exit 0），2026-07-27 ~22:58 |
| remediation_diff_range | `git diff b2c9465 b7bc040`，10 文件 +664/-39（单 commit） |
| **decision** | **FAIL（REMAINING：F-12 残留 + 新 blocker R2-N1）** |
| callback_target | 佳哥（Owner）→ 交主 AI 有界补整改 |

---

## 0. 复审前置说明

### 0.1 复审范围与变化分类（§10.1）

整改 diff（`b2c9465 → b7bc040`）按 V1.4 §10.1 变化分类表属**第一行**："产品可执行代码、测试语义、协议、部署、迁移、构建、制品、权限、安全、配置或运行工作流语义变化"。

依据 §10.1，原 round 1 FAIL 对新对象**失效**，须做"受影响合同、修改 diff 和直接回归面的有界功能复审"。本次复审据此执行：聚焦 4 个旧 Finding 的修复 diff + 直接回归面（F-01 在 real-pipeline 步骤 3a-bis/3d-bis 插入，直接回归面 = w08~w16 全部 e2e + 新增 w18）。

**未触发 §10.5 全量重审**：整改未引入新架构/协议/生产路径契约（real-pipeline 架构未变，仅 main.ts 注入对象切换），变更在原 Finding required action 范围内。

### 0.2 实际独立性如实披露（重要）

- 任务书要求 R3 最低 **I2**（I1 + 不同模型族/独立验证器/未进作者链的 Reviewer）。
- **本次实际独立性 = I1**：新会话、未参与 M1~M4 作者链与整改、未读作者链/整改会话过程聊天、只读冻结输入（任务书 + round 1 报告 + 整改报告 + 候选代码 + diff）。但本会话模型为 **GLM-5.2，与主 AI 作者链同为 GLM 系列模型族**，且与 round 1 审核会话同模型族。按 V1.4 §2.5 + 附录 A"伪独立审计"反模式，同模型族换会话仍为 I1。
- **与 round 1 的独立性关系**：同模型族、不同会话，未共享上下文。round 1 的 Finding 集合已冻结（finding_freeze_at 21:20），本复审不修改 round 1 结论，只对整改后的新候选做有界判定。
- 按 SOP §3.3，R3 实际独立性低于冻结等级时，Planning 须提高补偿控制或返回 NO_GO。**本结论在 I1 独立性下出具，佳哥须独立判断是否接受 I1 结论或要求 I2（不同模型族）复核**。

### 0.3 只读合规

- 复审期间**未修改任何产品代码、测试、迁移、部署、PRD/TRD/计划/状态账本**。
- 唯一写动作：开审按任务书 §2 重新 generate `candidate-lock.json`（任务书明确要求）。git status 仅此一文件 M，产品代码零变更。
- 未执行任何 push/remote add/PR/对外上传（仓库无 remote，`git remote -v` 为空）。
- 副作用：跑 Testcontainer（database/gateway/control-api 集成测试自启停 PG 容器）、PoC 复用已起的 persistent-gateway docker-compose（healthy）——均为本地隔离容器。
- **未整改、未下发、未推进、未 push**（V1.4 §10.2 + 任务书 §0 复审 AI 职责）。

---

## 1. 复审执行概览

### 1.1 直接实测命令（A 级 Evidence）

全部在佳哥 Mac 本地真实执行，`export PATH="$PWD/.corepack-bin:$PATH"` 后从仓库根运行：

| 命令 | 退出码 | 实测结果 | 整改报告声明 | 对照 |
| --- | --- | --- | --- | --- |
| 对象锁 generate（开审） | 0 | GENERATED，implementation_hash=`cbd7e00...` | `cbd7e00...` | ✓ **逐字符一致**（产品代码自 b7bc040 未变） |
| 对象锁 verify（开审） | 0 | STABLE，5 drift 标志全 false | STABLE | ✓ |
| `pnpm typecheck` | 0 | 11 包全 Done | 11 包全 Done | ✓ |
| `pnpm lint`（--max-warnings=0） | 0 | 11 包全 Done | 11 包全 Done | ✓ |
| `pnpm test` | 0 | domain **108** / gateway **68** / database **8** / control-api **23** / provider-adapters **35** / contracts 2 / config 4 / observability 4 = **252 passed, 0 fail/skip/todo** | 252 passed | ✓ 数字逐项吻合 |
| `pnpm build` | 0 | 11 包全 Done（worker 真实代码，web dist 产物生成） | 11 包全 Done | ✓ |
| `pnpm evidence:canary` | 0 | postgres=0 / redis=0 / logs=0 / traces=0 / total=0 | total=0 | ✓ |
| PoC `pnpm test`（persistent-gateway） | 0 | 12/12 pass（docker-compose PG+Redis 已 healthy） | 12/12 | ✓ |
| 对象锁 verify（结审） | 0 | STABLE | STABLE | ✓ |

**测试数增量核验**：gateway 61→68（+7，全部来自新增 `w18-quota-pipeline.test.ts` 的 F-01/F-03 用例），其余包未变。整改报告"252 passed"声明属实，独立复测吻合。

### 1.2 整改 diff 独立核验（§10.2 "不只看修复 diff"）

`git diff b2c9465 b7bc040 --stat`：10 文件，+664/-39，单 commit。

| 文件 | 变更性质 | 关联 Finding |
| --- | --- | --- |
| `apps/gateway/src/pipeline/real-pipeline.ts` | 产品代码：quotaRepo 必填 + 步骤 3a-bis 门禁 + 3d-bis 结算 + 事务聚合改 SUM(line) + estimateRawTokens | F-01 / F-03 |
| `apps/gateway/src/main.ts` | 产品代码：stubPipeline → createRealPipeline + requireEnv（pepper） | F-12 / F-02 |
| `apps/control-api/src/main.ts` | 产品代码：新增 requireEnv 校验 3 个敏感 env | F-02 |
| `apps/control-api/src/server.ts` | 注释（dev fallback 标注"仅测试态可达"，代码 fallback 保留） | F-02 |
| `apps/gateway/src/__tests-integration__/w18-quota-pipeline.test.ts` | 新增 7 用例（F-01-1~6 + F-03） | F-01 / F-03 验证 |
| `w08/w09/w10/w12/w16` e2e | 测试 seed：补 quotaRepo deps + CODING_PLAN 补 grant/counter + F-03 断言适配 | F-01 回归面 |

diff 与整改报告 §1 描述一致，无隐藏变更、无顺手改 P2/P3（§10.3 禁止）。

---

## 2. Finding 逐项判定（§10.2 核心：CLOSED / REMAINING / REGRESSED / NEW_DIRECT_REGRESSION）

### F-01 · 额度门禁接入 real-pipeline 热路径（round 1 P1）→ **CLOSED**

**整改验证**（`real-pipeline.ts` 独立读核）：

1. `RealPipelineDeps.quotaRepo: QuotaGateRepository` 必填（line 70，注释明示"M4 DoD 核心验收"）。✓
2. 步骤 3a-bis（line 248-283）门禁插入点正确——在评分选中 winner 后、createAttempt（3b）前：
   - `acquireLease`（按 provider_resource_id 并发限流）→ null 则排除资源重评（`continue`）。✓
   - `reserveQuota`（按 grant 键预占）→ 非 ALLOW/ALLOW_OVERAGE 则释放租约 + 排除重评。✓
   - 仅 CODING_PLAN 触发（API 模式 `cand.mode !== "CODING_PLAN"` 跳过），符合"API 模式无 deducted_quota"设计。✓
3. 步骤 3d-bis（line 374-387）结算插入点正确——在 ledger_line 写入后、切换判定（3e）前：
   - committed 成功 → `settleQuota(grantId, reservedEstimate, actualDeducted)`，actual 来自 attemptBilling.deductedQuota（W13 倍率后口径）。✓
   - 失败/可切换 → `releaseQuota(grantId, reservedEstimate)` 释放。✓
   - lease 在两路径后均 releaseLease（line 386）。✓
4. `estimateRawTokens`（line 631-646）保守上界估算（messages JSON 字符数/4 + 256 output 预留），无 tokenizer 依赖；multiplier="1" 口径预占，settle 多退少补容忍误差。设计合理。✓

**仓储签名独立核验**（`packages/database/src/repositories/quota-gate-repository.ts`）：
- `acquireLease`/`reserveQuota`/`settleQuota`/`releaseQuota`/`releaseLease` 签名与 pipeline 调用参数逐项匹配。✓
- `reserveQuota` 用 `forUpdate()` 行锁查 counter + 判定 + 预占（used += estimated）在同一事务。✓
- `settleQuota` 行锁 + `settleQuota(used, estimated, actual)` 纯函数多退少补 + 重算 overage。✓

**验证测试**（`w18-quota-pipeline.test.ts` 7 用例，全部 PASS）：
- F-01-1：CODING_PLAN 成功 → `quota_counter.used_value` = ledger_line.deducted_quota（150n = 100+50）。✓ **回写核心验证**
- F-01-2：额度耗尽（quota_value=1）→ 503 `no_healthy_candidate`，counter.used=0。✓
- F-01-3：并发达 concurrency_limit=1（手动占满 lease）→ 503。✓
- F-01-4：allow_overage=true → 200 + counter.used > 1（超额回写）。✓
- F-01-5：API 模式（无 grant）→ 200，门禁跳过，total_api_cost > 0。✓ **不被误拒**
- F-01-6：双 Attempt failover（A 429 无 usage → release；B 成功 → settle）→ counter.used = 仅成功 Attempt deducted。✓
- F-03：聚合一致性（见下）。

**直接回归面（§10.2 重点）**：w08~w16 e2e 全部 PASS（见 §3）。F-01 插入未破坏现有形状。

**结论**：F-01 required action 全部落实，能力在生产热路径生效（测试装配），根因消除。**CLOSED**。

> 注：F-01 的"在生产 main.ts 入口真实生效"依赖 F-12（main.ts 注入 real-pipeline）。F-12 的残留问题见下——它会影响 F-01 在生产路径的实际可达性，但不影响 F-01 整改本身（pipeline 层门禁逻辑正确）。

---

### F-03 · ledger_transaction token 聚合用 finalOutcome 而非明细之和（round 1 P1）→ **CLOSED**

**整改验证**（`real-pipeline.ts` line 398-436 独立读核）：

1. transaction 聚合改为基于 `listLedgerLines(requestId)` 求和：
   - `total_input_tokens` = `SUM(line.raw_input_tokens)`（bigint 累加）。✓
   - `total_output_tokens` / `total_cache_tokens` / `total_deducted_quota` 同。✓
   - `total_api_cost` = `SUM(Number(line.api_cost ?? "0"))` + `toFixed(8)`。注释论证"单请求明细 ≤ maxAttempts（≤2 条），double 精度无误差"——合理。✓
2. **删除** transaction 级二次 `computeBilling`（原 line 341-349 已移除）——明细已冻结 billing_rule/multiplier/cost，事务级不再二次匹配。✓ **根因修复**：消除 Date.now() 选不同规则版本隐患。
3. dispatch 节 `actualCost` 复用 `transactionApiCost`（line 441），不再二次 computeBilling。✓ 一致性。
4. `usage_quality` 取首条明细 line，无明细回退 finalOutcome。合理。✓

**对账可检测性反向印证**（`reconciliation-repository.ts` line 266-277）：
- SETTLEMENT_MISMATCH 扫描 `lt.total_input_tokens <> SUM(ll.raw_input_tokens)`。修复前（finalOutcome）双 Attempt failover 场景必触发此扫描；修复后（SUM line）恒等。**修复确实消除了对账能检测到的偏差**，反向印证 F-03 是真实 bug 且已修。✓

**验证测试**：
- w18 用例 7（F-03）：单 Attempt 成功 → `tx.total_*` = SUM(line.raw_*)，四维度（input/output/cache/deducted）全等。PASS。✓
- w09/w10 断言适配：`tx.total_api_cost === "0"` → `Number(tx.total_api_cost) === 0`（聚合后 CODING_PLAN 为 "0.00000000" 或 null，数值断言更稳健）。PASS。✓

**未覆盖的边界（ Evidence Gap，非 REMAINING）**：w18 用例 7 只测单 Attempt；双 Attempt 且**两 Attempt 均产生 usage**（非首失败 zeroUsage）时 transaction=SUM(line) 的端到端断言未直接覆盖（F-01-6 的双 Attempt 是首 Attempt 429 zeroUsage，只有 1 条 line）。但聚合逻辑是 `listLedgerLines` 全量求和，对 N 条 line 数学上恒成立，且对账扫描会兜底。记为局部 Evidence Gap，不阻断。

**结论**：F-03 required action 全部落实，违反冻结条款（TRD §5.7 行 348 + §10.1 行 653）的根因（用末次 Attempt usage）已消除，改为明细求和。**CLOSED**。

---

### F-12 · 生产入口 main.ts 注入 stubPipeline（round 1 P1）→ **REMAINING（整改主体 CLOSED，但暴露 1 个生产路径 wiring 残留 → 新 blocker R2-N1）**

**整改主体验证**（`apps/gateway/src/main.ts` 独立读核）：

1. `stubPipeline` → `createRealPipeline`（line 17/72）。✓ 生产入口切换为真实代表链。
2. 注入全部真实 deps：`ledgerRepo` / `poolRepo` / `dispatchRepo` / `quotaRepo`（全部 `new Repo(db)`）。✓ 含 F-01 必需的 quotaRepo。
3. `listCandidates`：内联 model_route join 查询（line 40-70），与 w08~w16 集成测试一致。✓
4. caller = StubUpstream 包装（line 32-37）。Evidence 显式披露（main.ts 顶部注释 line 4-13）：生产部署 contract = real-pipeline，caller = stub 形状，真实 fetch 待 DEP-PROVIDER-CREDENTIALS。✓

**F-12 required action 落实情况**：main.ts 切 real-pipeline + 注入真实 deps + caller stub 显式披露——主体满足 round 1 required action。

**但独立读核发现生产路径 wiring 残留（升级为新 blocker R2-N1）**：

> **R2-N1（新 blocker 候选）：生产 main.ts 的 listCandidates 返回 `principalId: ""`，导致 CODING_PLAN 模式额度门禁（F-01）在生产路径恒 REJECT_NO_GRANT。**

- **精确证据**：
  - `main.ts:68` `listCandidates` 映射返回 `principalId: ""`（注释"由 pipeline 从 allCandidates 填充"——但 pipeline 不填充，见下）。
  - `real-pipeline.ts:162` `let principalId = allCandidates[0]!.principalId;` —— 从候选行取，**非**从已认证主体 `request.principal.principalId`（line 105，可用但未用于 reserve）。
  - `real-pipeline.ts:270` `reserveQuota({ ... principalId, ... })` 用此变量。
  - `quota-gate-repository.ts:48-56` reserveQuota 按 `(enterprise_id, principal_id, provider, model_alias, status=ACTIVE)` 查 grant；`principalId=""` 查不到任何 grant → 返回 `REJECT_NO_GRANT`（`grantId: null`）。
  - 后果：生产路径所有 CODING_PLAN 请求（智谱/Kimi 套餐模式）在步骤 3a-bis 恒被排除资源 → 无健康候选 → 503。F-01 门禁在生产路径失效（不是"耗尽才拒"，而是"恒拒"）。
- **对比测试路径**：w09/w10/w12/w16/w18 的 listCandidates 显式返回 `principalId: PRINCIPAL_ID`（真实主体），故测试全绿、F-01 验证成立；生产 main.ts 返回空串，行为分叉。**生产数据面与测试数据面在 CODING_PLAN 额度门禁上不是同一行为**。
- **为什么不是 F-01 的直接回归**：`principalId` 变量的 wiring（line 162/293）在 round 1 FAIL 候选 `b2c9465` 已是 `allCandidates[0]!.principalId`（`git show b2c9465:...real-pipeline.ts` line 155/249 确认），F-01 整改 diff **未改动**该 wiring——只是复用了既有变量传给新增的 reserveQuota。根因是 F-12 切到 real-pipeline 后，生产 listCandidates 未补 principalId，使既有潜在 wiring 问题**首次可达**。
- **§10.3 新 blocker 五项门评估**：
  1. **直接命中冻结合同**：TRD §8.2 行 527-537（请求前额度预占/结算）—— ✓ 命中。
  2. **位于受支持生产路径**：⚠ **部分**。F-12 已把 main.ts 切到 real-pipeline，生产路径架构上是 real-pipeline；但 caller = StubUpstream（模拟上游，非真实 HTTP），DEP-PROVIDER-CREDENTIALS 未解锁（任务书 §5.3 已披露为环境限制，round 1 §1.3 标 C 级）。即生产路径"形已就位、上游未真连"。principalId wiring 缺陷在此过渡态真实可达。
  3. **稳定复现**：✓ 逻辑必然（空串匹配不到 grant）。
  4. **影响 P0/P1**：✓ P1（生产 CODING_PLAN 全拒）。
  5. **无安全且有界恢复**：✓ 有界 fix 存在（main.ts listCandidates 从 `request.principal` 取 principalId，或 pipeline 直接用 `principal.principalId`）。
  - 五项中第 2 项"受支持生产路径"处于过渡态（caller=stub）。综合判断：这是 F-12 整改暴露的真实 wiring 残留，有界可修，**登记为本轮新 blocker 候选 R2-N1**（P1），交佳哥 triage；不与"候选冻结后不顺手修 P2"冲突（R2-N1 是 round 1 冻结后、整改引入可达性的新问题，按 §10.2/§10.3 处理）。

**结论**：F-12 主体（main.ts 切 real-pipeline + 真实 deps + stub caller 披露）**CLOSED**；但整改暴露生产路径 principalId wiring 残留 → **整体判 REMAINING**（R2-N1 须补整改后才能判 F-12 完全 CLOSED）。

---

### F-02 · 三个敏感 env 有硬编码 dev fallback（round 1 P2 同批）→ **CLOSED**

**整改验证**（独立读核 `gateway/main.ts` + `control-api/main.ts` + `control-api/server.ts`）：

1. `gateway/main.ts:23` `requireEnv("GATEWAY_KEY_PEPPER")` —— 生产入口缺失即 `process.exit(1)`。✓
2. `control-api/main.ts:25-27` 启动前 requireEnv 校验 `GATEWAY_KEY_PEPPER` / `CREDENTIAL_KEK` / `COOKIE_SECRET`。✓
3. `requireEnv` 实现（两文件一致）：env 缺失 → stderr + `process.exit(1)`，**不提供 fallback**。✓
4. `control-api/server.ts` 的 dev fallback 保留（line 77/90/100），但注释明示"仅测试态可达；生产入口 main.ts 已用 requireEnv 拦截缺失"。

**设计权衡独立评估**：不在 `buildControlApi` 内 throw（会破坏所有 control-api 测试，因测试调 `buildControlApi(db)` 不传 env）；改为生产入口 main.ts 拦截。这是合理的最小改动面 + 满足"生产忘配即启动失败"要求。✓

**生产可达性核验**：测试不 import main.ts（两文件顶部注释明示"测试不 import 此文件，避免触发 listen"），故生产入口的 requireEnv 在测试态不可达、生产态强制——边界清晰。✓

**F-02 required action 落实**：env 缺失即启动失败（不依赖 buildControlApi 内 fallback）。✓

**结论**：F-02 required action 全部落实，生产忘配即启动失败。**CLOSED**。

---

## 3. 直接回归面（§10.2 重点：F-01 插入是否引入直接回归）

任务书明确要求"重点检查 F-01 插入是否引入直接回归（w08~w16 现有 e2e）"。

### 3.1 w08~w16 e2e 回归（全部 PASS）

F-01 在 real-pipeline 步骤 3a-bis/3d-bis 插入额度门禁，直接回归面 = 所有经 real-pipeline 的 e2e。整改对现有 e2e 的适配（`git diff` 核验）：

| 测试 | 模式 | 适配内容 | 结果 |
| --- | --- | --- | --- |
| w08（DeepSeek e2e） | API | 仅补 `quotaRepo` deps（API 模式跳过门禁，无需 grant） | 4/4 PASS |
| w09（智谱 e2e） | CODING_PLAN | 补 quotaRepo + principal_grant(zhipu/qianliu-glm-coding, 1_000_000) + quota_counter + F-03 断言适配 | 5/5 PASS |
| w10（Kimi e2e） | CODING_PLAN | 补 quotaRepo + principal_grant(kimi/qianliu-kimi-k3, 1_000_000) + quota_counter + F-03 断言适配 | 5/5 PASS |
| w12（路由/双 Attempt） | CODING_PLAN | 补 quotaRepo + 共享 grant(kimi, 10_000_000，覆盖双资源多用例) | 全 PASS |
| w16（经营调度） | CODING_PLAN(zhipu) + API(deepseek) | 补 quotaRepo + zhipu grant(10_000_000)；deepseek API 组无需 grant | 7/7 PASS |

**回归结论**：F-01 插入对 w08~w16 现有形状**零破坏**。适配仅限"补 deps + CODING_PLAN 补 grant seed + F-03 数值断言"，无测试逻辑被 mock/弱化，无核心规则被绕过。**无直接回归**。

### 3.2 全工程回归

typecheck/lint/build/canary 全 exit 0；test 252 passed（+7 w18）。PoC 12/12。见 §1.1。

### 3.3 直接回归面小结

- **REGRESSED（F-01/F-03/F-12/F-02 任一引入的代码回归）**：**无**。整改 diff 在 w08~w16 全绿，无现有用例因整改而失败或被改弱。
- **NEW_DIRECT_REGRESSION**：**无代码级直接回归**。R2-N1（principalId wiring）是 F-12 切换 main.ts 暴露的**生产路径 wiring 残留**，非整改 diff 引入的新代码缺陷（wiring 在 b2c9465 已存在），归类为新 blocker 候选而非 NEW_DIRECT_REGRESSION。

---

## 4. 判定汇总

| Finding | round 1 | 整改 | round 2 判定 | 依据 |
| --- | --- | --- | --- | --- |
| F-01 额度门禁接入热路径 | P1 | CLOSED | **CLOSED** | pipeline 门禁逻辑正确 + w18 7 用例验证 + w08~w16 零回归 |
| F-03 账本聚合 finalOutcome→SUM(line) | P1 | CLOSED | **CLOSED** | 根因消除 + 对账可检测性反向印证 + w18 验证 |
| F-12 main.ts 切 real-pipeline | P1 | CLOSED | **REMAINING** | 主体 CLOSED，但暴露 R2-N1（生产 principalId wiring） |
| F-02 敏感 env dev fallback | P2 | CLOSED | **CLOSED** | 生产入口 requireEnv + 测试态 fallback 边界清晰 |
| R2-N1 生产 CODING_PLAN 恒 REJECT_NO_GRANT（新） | — | — | **新 blocker 候选（P1）** | §10.3 五项门评估，第 2 项处于 caller=stub 过渡态 |

### 4.1 新 blocker R2-N1 详细登记（§10.3）

- **违反条款**：TRD §8.2 行 527-537（请求前额度预占）；间接影响 F-01 在生产路径的有效性。
- **精确证据**：`apps/gateway/src/main.ts:68`（listCandidates 返回 `principalId: ""`）+ `real-pipeline.ts:162/270`（principalId 取自候选行，用于 reserveQuota）+ `quota-gate-repository.ts:48-56`（按 principal_id 查 grant）。
- **真实影响**：生产路径 CODING_PLAN 模式请求恒 REJECT_NO_GRANT → 503；F-01 门禁在生产路径失效（恒拒而非耗尽拒）。
- **发生条件**：任何按 main.ts 启动 + CODING_PLAN 资源的请求。
- **稳定复现**：逻辑必然（空串≠任何 principal_id）。
- **最小 required action**：main.ts `listCandidates` 从 `request.principal`（已认证主体）注入 principalId；或在 real-pipeline 步骤 3a-bis 用 `principal.principalId`（已认证）而非候选行 principalId 作为 reserve 键。补 1 个"生产 listCandidates 装配 + CODING_PLAN 请求端到端 200"的回归测试（当前 w08~w16 用测试态 listCandidates，未覆盖生产 listCandidates 的 principalId 填充）。
- **§10.3 门**：1✓ 2⚠(过渡态) 3✓ 4✓ 5✓。第 2 项因 caller=StubUpstream 未达"真实受支持生产路径"，建议佳哥 triage 时一并考虑：是否 (a) 立即有界补修 principalId wiring（推荐，改动面极小、消除生产/测试行为分叉）；(b) 与 DEP-PROVIDER-CREDENTIALS 解锁同批处置（接受过渡态残留，但须在 Evidence 显式登记生产 CODING_PLAN 当前不可用）。

### 4.2 未达 PASS 的具体缺口（V1.4 §9.1）

- ❌ P1 = 0：R2-N1（新 P1 候选）+ F-12 因 R2-N1 判 REMAINING。
- ⚠ 实际独立性 I1（低于 R3 要求的 I2）。

---

## 5. Decision

### 5.1 结论：**FAIL**

依据 V1.4 §10.2 + §10.3：
- F-01 / F-03 / F-02 三项 **CLOSED**（整改扎实，根因消除，验证充分，零直接回归）。
- F-12 **REMAINING**：整改主体（main.ts 切 real-pipeline）CLOSED，但暴露生产路径 principalId wiring 残留 R2-N1，使 F-01 额度门禁在生产路径恒拒（CODING_PLAN）。
- R2-N1 是 round 1 冻结后的新问题，通过 §10.3 五项门（第 2 项过渡态），登记为本轮新 blocker 候选（P1）。
- 仍有 P1（R2-N1）未关闭 → 不得 PASS（§10.4）。

### 5.2 与 round 1 的关系（§10.2 "旧 FAIL 不自动覆盖"）

- round 1 的 3 个 P1（F-01/F-03/F-12）中，F-01/F-03 已重新证明 CLOSED（新候选 w18 + 对账印证 + 直接回归面全绿）；F-12 主体 CLOSED 但衍生 R2-N1。
- **新候选未自动继承 round 1 任何 PASS**（round 1 本就 FAIL）；本复审独立重新证明，结论基于新对象锁 STABLE + 真实运行 + 代码逐行核对。
- R2-N1 是本次独立复审新发现，不被旧 Finding 掩盖（§10.2 末项）。

### 5.3 是否触发 §10.5 全量重审

**未触发**。整改未引入新架构/协议/生产路径契约，R2-N1 是 main.ts wiring 的有界补修（1 文件 / ≤10 行 + 1 测试），在当前冻结合同内可收口。建议走 §10.2 第二轮有界复审（R2-N1 单项）。

### 5.4 回传

- `decision`: **FAIL（REMAINING）**
- `audit_round`: 2（有界功能复审）
- `reviewed_object`: HEAD `387fe99`，产品代码冻结 `b7bc040`，implementation_hash `cbd7e00...`
- `start/end_lock_verification`: STABLE（exit 0）
- `closed_findings`: F-01、F-03、F-02（3 项）
- `remaining_findings`: F-12（主体 CLOSED，待 R2-N1 收口）
- `new_blocker_candidates`: R2-N1（P1，§10.3 五项门，第 2 项过渡态）
- `regressed`: 无
- `new_direct_regression`: 无（R2-N1 非 diff 引入的代码回归，是 F-12 暴露的 wiring 残留）
- `requested_next_action`: 佳哥 triage R2-N1 →（建议）主 AI 有界补修 main.ts principalId wiring + 补生产 listCandidates 回归测试 → 新候选重锁 → round 3 有界复审（仅 R2-N1 + F-12 收口）
- `requested_state_transition`: 维持 `READY_FOR_FUNCTIONAL_AUDIT`；**PASS 前不得进入 CODE_AUDIT，不得进入 M5**
- `prohibited_next_action`: 主 AI 不得在 R2-N1 收口前进入代码质量审计；不得 push/remote/PR；审核 AI 不整改、不下发、不推进

---

## 6. 做得好的地方（如实记录）

为避免 FAIL 遮蔽整改质量，记录本轮观察到的扎实整改：
- **F-01 门禁设计严谨**：per-attempt reserve（grant 键含 provider，跨 provider failover 正确归属）、acquireLease 并发限流、settle 多退少补、release 两路径覆盖——与 TRD §8.2 冻结条款逐项对齐，w18 6 个 F-01 子用例覆盖耗尽/并发/超额/API 跳过/双 Attempt failover 全维度。
- **F-03 根因修复彻底**：不止改聚合算法，还删除 transaction 级二次 computeBilling（消除 Date.now() 版本漂移隐患），dispatch 节复用事务聚合值——一致性贯穿。对账 SETTLEMENT_MISMATCH 扫描反向印证。
- **F-02 最小改动面**：生产入口拦截 + 测试态 fallback 保留 + 注释边界清晰，未破坏 23 个 control-api 测试。
- **直接回归面控制良好**：F-01 插入对 w08~w16 零破坏，适配仅限 seed + 断言，无测试弱化。
- **整改 diff 透明**：单 commit、10 文件、与整改报告 §1 描述逐项一致，无隐藏变更、无顺手改 P2/P3。
- **对象锁一致**：implementation_hash `cbd7e00...` 与整改报告冻结值逐字符一致，产品代码自 b7bc040 零 drift。

R2-N1 是 F-12 切换暴露的 wiring 收尾问题，改动面极小（main.ts listCandidates principalId 填充），收口后候选应能快速达到 PASS。

---

## 附录：复审执行日志摘要

| 步骤 | 命令/动作 | 结果 |
| --- | --- | --- |
| 1 | 读任务书 + round 1 报告 + 整改报告 + V1.4 §10.2/§10.3/§10.5 | 理解冻结条款与复审边界 |
| 2 | git status / remote / HEAD 核验 | 工作树干净、无 remote、HEAD=387fe99 |
| 3 | 对象锁 generate（绑定当时 HEAD） | implementation_hash=`cbd7e00...`，与整改报告一致 |
| 4 | 对象锁 verify（开审） | STABLE，5 drift 全 false |
| 5 | pnpm typecheck | exit 0，11 包 Done |
| 6 | pnpm lint | exit 0，11 包 Done |
| 7 | pnpm test | exit 0，252 passed（domain 108 / gateway 68 / database 8 / control-api 23 / provider-adapters 35 / contracts 2 / config 4 / observability 4） |
| 8 | pnpm build | exit 0，11 包 Done |
| 9 | pnpm evidence:canary | exit 0，total=0 |
| 10 | PoC pnpm test（persistent-gateway） | exit 0，12/12 pass |
| 11 | 整改 diff 独立读核（real-pipeline / main.ts / server.ts / w18） | 逐项核对 F-01/F-03/F-12/F-02 |
| 12 | 直接回归面读核（w08~w16 diff + quota-gate-repository 签名 + reconciliation 扫描） | F-01 零回归；发现 R2-N1 |
| 13 | git show b2c9465 核验 principalId wiring 历史 | 确认 R2-N1 非 F-01 diff 引入 |
| 14 | 对象锁 verify（结审） | STABLE，HEAD 不变 |

报告完成。回传佳哥。
