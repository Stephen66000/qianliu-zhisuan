# M1~M4 有界功能复审报告（round 3 · R2-N1 单项）· V1.4 §10.2 / §10.3

| 项目 | 内容 |
| --- | --- |
| audit_id | `M1M4-FUNC-AUDIT-20260727-ZCODE-GLM52-INDEP-R3` |
| audit_type | **有界功能复审（bounded functional re-audit，单项）** |
| audit_round | 3（对 round 2 REMAINING 的 R2-N1 补修做有界复审） |
| 规范条款 | `AI阶段功能与验收审计规范-通用版-v1.4.md` §10.2 / §10.3 |
| contract_ref | `V3/Evidence/M4/audit/M4-审核任务书-v1.md`（任务书 v2，§8 round 3 委托） |
| based_on_round2 | `M1-M4-有界功能复审-round2-zcode-glm52独立会话-20260727.md`（round 2，FAIL/REMAINING，暴露 R2-N1） |
| based_on_remediation | commit `8d7fe18`（`fix(gateway): R2-N1 额度归因用调用者主体，不从候选行取`） |
| 复审范围（有界，不重审全量） | **仅 R2-N1 修复 diff（commit 8d7fe18）+ 直接回归面** |
| 直接回归面 | `r2-n1-principal-ownership.test.ts` + w09/w10/w12/w16/w18 CODING_PLAN e2e |
| risk_level | R3 |
| required_independence | I2（R3 最低） |
| actual_independence | **I1**（同模型族 GLM，换会话）—— 见 §0.2 |
| reviewer_identity | ZCode 独立审核会话（builtin:bigmodel-coding-plan/GLM-5.2） |
| round2_reviewed_head | `387fe99a4fb9da1db99842bcb656dcca1d2d8130` |
| round2_product_code_head | `b7bc04003cfcec6d0494ebc77a711cc042381ee6` |
| reviewed_head（本次复审） | `9decb8a11b8d6f5ef32d363443604f8ca124dd20`（HEAD；R2-N1 补修在 `8d7fe18`，其后仅 Evidence/lock 文档 commit） |
| remediation_commit（R2-N1） | `8d7fe1850ff5b6905ee4111c4ce7c11b251ee64b`（2 文件 +177/-2） |
| evidence_mode | local-first（仓库无 remote，纯本地 Git commit + 工作树） |
| candidate_manifest | `V3/Evidence/M4/audit/candidate-lock.json`（复审开审重新 generate 绑定当时 HEAD） |
| implementation_hash（开审=结审） | `57f3d4ad186253859ff09978b9437992e91ccec3a3316eb7fab1cdac88475402`（与 round 2 的 `cbd7e00...` **不同**——反映 8d7fe18 的 principalId 修复，符合预期） |
| start_lock_verification | `STABLE`（exit 0），2026-07-27 ~23:22 |
| end_lock_verification | `STABLE`（exit 0），2026-07-27 ~23:26 |
| **decision** | **PASS（R2-N1 CLOSED；F-12 整体 CLOSED；round 2 REMAINING 消除）** |
| callback_target | 佳哥（Owner） |

---

## 0. 复审前置说明

### 0.1 复审范围与变化分类（§10.1）

R2-N1 补修 diff（`387fe99 → 8d7fe18`，2 文件 +177/-2）按 V1.4 §10.1 变化分类表属**第一行**："产品可执行代码、测试语义……变化"。

依据 §10.2，对单项新 blocker 的补修做有界复审：**仅审 R2-N1 修复 diff + 直接回归面，不重审 F-01/F-03/F-02（round 2 已 CLOSED，本次补修未碰它们）**。round 2 已明确"未触发 §10.5 全量重审"，本次补修改动面更小（real-pipeline 单文件 +1 测试），同样不触发全量重审。

**复审边界严格收敛**：
- 产品代码改动仅 `real-pipeline.ts`（principalId 取值来源 + 移除 failover 重赋值）。
- 新增测试 `r2-n1-principal-ownership.test.ts`（模拟生产装配）。
- **不碰** F-01 的门禁逻辑（步骤 3a-bis/3d-bis）、F-03 的聚合逻辑、F-02 的 env 校验、main.ts 的 listCandidates（生产侧返空串保留，修复在 pipeline 消费侧）。
- 直接回归面 = r2-n1 测试 + w09/w10/w12/w16/w18 CODING_PLAN e2e（任务书 §8 round 3 明确指定）。

### 0.2 实际独立性如实披露（重要）

- 任务书要求 R3 最低 **I2**。
- **本次实际独立性 = I1**：新会话、未参与 M1~M4 作者链与 R2-N1 补修、未读作者链/补修会话过程聊天、只读冻结输入（任务书 + round 1/round 2 报告 + 整改报告 + 候选代码 + commit diff）。但本会话模型为 **GLM-5.2，与主 AI 作者链同为 GLM 系列模型族**，且与 round 1/round 2 审核会话同模型族。按 V1.4 §2.5 + 附录 A"伪独立审计"反模式，同模型族换会话仍为 I1。
- **与 round 2 的独立性关系**：同模型族、不同会话，未共享上下文。本复审不修改 round 2 结论，只对 R2-N1 补修后的新候选做有界判定。
- **关键披露**：本会话（reviewer）与主 AI 作者链（做了 R2-N1 补修）**同为 GLM-5.2**。佳哥须独立判断是否接受 I1 结论或要求 I2（不同模型族）复核。本报告结论在 I1 独立性下出具。

### 0.3 只读合规

- 复审期间**未修改任何产品代码、测试、迁移、部署、PRD/TRD/计划/状态账本**。
- 唯一写动作：开审按任务书 §2 重新 generate `candidate-lock.json`（任务书明确要求）。git status 仅此一文件 M，产品代码零变更。
- 未执行任何 push/remote add/PR/对外上传（仓库无 remote，`git remote -v` 为空）。
- 副作用：跑 Testcontainer（r2-n1 + w09/w10/w12/w16/w18 集成测试自启停 PG 容器）——本地隔离容器。
- **未整改、未下发、未推进、未 push**（V1.4 §10.2 + 任务书 §0 复审 AI 职责）。

---

## 1. 复审执行概览

### 1.1 直接实测命令（A 级 Evidence）

全部在佳哥 Mac 本地真实执行，`export PATH="$PWD/.corepack-bin:$PATH"` 后从仓库根运行：

| 命令 | 退出码 | 实测结果 | 补修 commit 声明 | 对照 |
| --- | --- | --- | --- | --- |
| 对象锁 generate（开审） | 0 | GENERATED，implementation_hash=`57f3d4ad...` | — | ✓ 新 hash（反映 principalId 修复） |
| 对象锁 verify（开审） | 0 | STABLE，5 drift 标志全 false | — | ✓ |
| R2-N1 回归测试 `r2-n1-principal-ownership.test.ts` | 0 | **1/1 PASS**（POST /v1/chat/completions → 200；quota_counter.used > 0；tx.principal_id = PRINCIPAL_ID） | 新增 1 用例 | ✓ |
| 直接回归面 w09/w10/w12/w16/w18（CODING_PLAN e2e） | 0 | **30/30 PASS**（w09 5 + w10 5 + w12 6 + w16 7 + w18 7） | 全绿 | ✓ |
| 对象锁 verify（结审） | 0 | STABLE，hash 与开审一致 | STABLE | ✓ |

**测试数核验**：gateway 集成测试 r2-n1(1) + w09(5) + w10(5) + w12(6) + w16(7) + w18(7) = 31，全部 PASS。补修 commit 声明"gateway 69"（含单元 + 集成），与本次实测的集成子集一致。

> 注：本次有界复审**未重跑全工程 typecheck/lint/build/canary/PoC**——理由：(a) round 2 已对同一产品代码基线（b7bc040）全工程复测全绿，本次补修 diff 仅 2 文件（real-pipeline 1 处取值改 const + 移除 1 行 + 新增测试），改动语义已被 vitest 编译执行覆盖（集成测试真实跑了 createRealPipeline）；(b) 任务书 §8 round 3 明确"仅审 R2-N1 修复 diff + 直接回归面，不重审全量"。typecheck/lint 的全工程复测可作为佳哥 triage 时的可选项，非本有界复审的必要 Evidence。

### 1.2 R2-N1 补修 diff 独立核验（§10.2 "不只看修复 diff"）

`git show 8d7fe18 --stat`：2 文件 +177/-2，单 commit。

| 文件 | 变更性质 | 关联 |
| --- | --- | --- |
| `apps/gateway/src/pipeline/real-pipeline.ts` | 产品代码：principalId 从候选行改为已认证调用者；移除 failover 重赋值 | R2-N1 根因修复 |
| `apps/gateway/src/__tests-integration__/r2-n1-principal-ownership.test.ts` | 新增 1 用例（模拟生产装配 listCandidates 返空 principalId） | R2-N1 回归堵生产/测试分叉 |

diff 与补修 commit message 描述一致，无隐藏变更、无顺手改其他 Finding（§10.3 禁止；F-01/F-03/F-02 全未碰，已逐行核验 real-pipeline diff 仅 2 处）。

---

## 2. R2-N1 逐项判定（§10.2 核心）

### R2-N1 · 生产 CODING_PLAN 恒 REJECT_NO_GRANT（round 2 新 blocker，P1）→ **CLOSED**

#### 2.1 required action 落实核验

round 2 报告 §4.1 给出的最小 required action（两选一）：
- (a) main.ts listCandidates 从 `request.principal` 注入 principalId；或
- (b) real-pipeline 步骤 3a-bis 用 `principal.principalId`（已认证）而非候选行 principalId 作为 reserve 键。

**补修采用方案 (b)**（pipeline 消费侧修复，更优——见下）。

**`real-pipeline.ts` 独立读核**（line 162-166）：

```ts
// R2-N1 修复：额度/账本归因用已认证的调用者主体（principal.principalId），
// 不是候选行的 principalId。生产 listCandidates 不知道调用者会填空串，
// 导致 CODING_PLAN 的 reserveQuota 查不到授权误拒（503）。
// 额度本就归调用者，不归路由候选。
const principalId = principal.principalId;
```

逐项核验：

1. **取值来源改为已认证调用者**：`principal.principalId`（`let` → `const`）。✓
2. **`principal` 对象可靠性核验**（`auth/principal-auth.ts:89-93`）：
   - `request.principal` 由 Bearer Key 认证中间件注入，`principalId = row.principal_id`（principal_key join principal 表的真实主键，line 52/90）。
   - 认证链路校验：HMAC-pepper digest 比对 `principal_key.key_digest`（line 58）+ key ACTIVE + principal ACTIVE + 未过期（line 61-87）。
   - **结论**：`principal.principalId` 是已认证、可信、稳定的调用者主体 ID。比候选行的 `principalId`（路由配置带出，生产填空串）可靠性高一个量级。✓ **修复根基正确**。
3. **reserveQuota 匹配闭环核验**（`quota-gate-repository.ts:48-56`）：
   - 按 `(enterprise_id, principal_id, provider, model_alias, status=ACTIVE)` 查 grant。
   - `principal.principalId` 必然匹配 seed 的 grant（测试和生产都按真实 principal 建 grant）；候选行空串必然不匹配。
   - **结论**：修复后生产路径 CODING_PLAN 的 reserveQuota 能查到 grant → ALLOW → 200。R2-N1 根因（空串查不到 grant）消除。✓
4. **failover 重赋值移除核验**（原 line 294 已删）：
   - 原代码：`principalId = allCandidates.find((c) => c.resourceId === cand.resourceId)?.principalId ?? principalId;`（双 Attempt 时按候选资源切 principalId）。
   - 移除后：双 Attempt 时 principalId 恒为 `principal.principalId`（const），两次 Attempt 的 reserveQuota/ledger_line/settleQuota 都归同一调用者。
   - **正确性论证**：额度本就归调用者，不归路由候选。同一调用者的 grant 跨 provider failover 会命中不同 grant（按 provider+model_alias 查），但 principal_id 维度一致——这是正确语义。原重赋值反而引入"按候选资源切主体"的潜在错误（候选行的 principalId 本就不可靠）。✓ **移除是修复，非回归**。
5. **归因一致性提升**：real-pipeline 中 principalId 的 7 处用途（createRequest line 112 / affinity 153 / R2-N1 定义 166 / dispatchInput 188 / dispatch 203 / reserveQuota 274 / ledgerLine 362 / ledgerTransaction 424）**修复前有 1 处用候选行（line 166/274/362）、其余用 `principal.principalId`**；**修复后全部统一为 `principal.principalId`**。一致性提升，无残留候选行取值。✓

#### 2.2 回归测试断言强度核验（`r2-n1-principal-ownership.test.ts`）

测试设计精准堵住 round 2 指出的"生产/测试分叉"：

1. **模拟生产装配**（line 95-130）：listCandidates 内联 model_route join 查询（与 main.ts 生产实现逐字一致），返回 `principalId: ""`（line 128 注释"模拟生产 main.ts 的 R2-N1 根因"）。**这是关键——测试不再手动填真实主体 ID，而是复刻生产空串行为**。
2. **断言三维度**（line 145-170）：
   - **请求成功**：`expect(res.statusCode).toBe(200)`（修复前会是 503）。✓
   - **额度回写**：`expect(BigInt(counter.used_value)).toBeGreaterThan(0n)`（quota_counter 被结算校正回写）。✓ **F-01 门禁在生产装配下真实生效**
   - **归因正确**：`expect(tx!.principal_id).toBe(PRINCIPAL_ID)`（ledger_transaction 归因到调用者，非空串）。✓ **堵住归因错位**
3. **测试隔离**：Testcontainer 自启停 PG，randomUUID enterprise/principal/grant，无跨测试污染。✓

**断言强度评估**：测试精准复刻生产 listCandidates 空串行为，三维度断言（200 + counter 回写 + 归因）覆盖 R2-N1 的全部症状。修复前该测试必然 fail（reserveQuota 空串 → REJECT_NO_GRANT → 503，statusCode 断言失败）；修复后 pass。**测试有效，非自证陷阱**。✓

#### 2.3 直接回归面（§10.2 重点：principalId 改动是否破坏现有 CODING_PLAN e2e）

任务书 §8 round 3 指定直接回归面：w09/w10/w12/w16/w18 CODING_PLAN e2e。本次全部实测：

| 测试 | 模式 | listCandidates 的 principalId | 修复前行为 | 修复后行为 | 结果 |
| --- | --- | --- | --- | --- | --- |
| w09（智谱 e2e） | CODING_PLAN | 手动填 PRINCIPAL_ID（真实） | reserveQuota 用候选行 PRINCIPAL_ID → 匹配 grant → 200 | reserveQuota 用 `principal.principalId`（=PRINCIPAL_ID，认证注入同值）→ 匹配 grant → 200 | **5/5 PASS** |
| w10（Kimi e2e） | CODING_PLAN | 手动填 PRINCIPAL_ID | 同上 | 同上 | **5/5 PASS** |
| w12（路由/双 Attempt） | CODING_PLAN | 手动填 PRINCIPAL_ID | 双 Attempt 用候选行切 principalId（原 line 294 重赋值） | 双 Attempt 恒用 `principal.principalId`（const） | **6/6 PASS** |
| w16（经营调度） | CODING_PLAN(zhipu) + API(deepseek) | 手动填 PRINCIPAL_ID | 同 w09 | 同 w09 | **7/7 PASS** |
| w18（额度门禁） | CODING_PLAN | 手动填 PRINCIPAL_ID | F-01 门禁用候选行 principalId | F-01 门禁用 `principal.principalId` | **7/7 PASS** |

**关键洞察（生产/测试分叉的根源）**：w09/w10/w12/w16/w18 的 listCandidates **手动填 `principalId: PRINCIPAL_ID`**（真实主体），而生产 main.ts 填空串。修复前两套装配在测试里 principalId 值相同（PRINCIPAL_ID），所以测试全绿却掩盖生产空串问题；修复后用 `principal.principalId`，测试（认证注入 PRINCIPAL_ID）和生产（认证注入真实主体）**统一**用调用者——这正是 R2-N1 修复的核心价值：消除生产/测试行为分叉。

**双 Attempt failover 特别核验**（w18 F-01-6 + w12）：
- w18 F-01-6 用例（line 310-348）验证双资源 failover：首 Attempt 429 zeroUsage → releaseQuota 释放；第二 Attempt 成功 → settleQuota 结算。断言 `attempts.length === 2`、`lines.length === 1`（429 无明细）、`counter.used === 仅成功 Attempt 的 deducted_quota`。
- R2-N1 移除原 line 294 重赋值后，双 Attempt principalId 恒为调用者——首失败 release 与第二成功 settle 命中同一 grant（同 provider/alias），归因正确。**F-01-6 PASS 证明双 Attempt 归因未因移除重赋值而回归**。✓

**回归结论**：principalId 改 const + 移除 failover 重赋值对 w09/w10/w12/w16/w18 现有形状**零破坏**。无测试逻辑被 mock/弱化，无核心规则被绕过。**无直接回归**。

#### 2.4 main.ts 残留观察（非 blocker）

独立读核 `main.ts:68`：生产 listCandidates 仍返 `principalId: ""`，注释仍写"由 pipeline 从 allCandidates 填充"。

- **行为影响**：**无**。修复后 pipeline 用 `principal.principalId`，候选行的 principalId 字段变成 dead code（pipeline 不再读它）。生产空串无害。
- **文档准确性**：注释"由 pipeline 从 allCandidates 填充"现在不准确（pipeline 已不从 allCandidates 取）。属文档残留，不影响行为，不构成 blocker。
- **建议（P3，非阻断）**：后续可清理 main.ts listCandidates 的 principalId 字段（或更新注释为"pipeline 用调用者主体，此字段已弃用"）。本复审不要求主 AI 在本次收口内处理——记为观察项交佳哥 triage。

#### 2.5 结论

R2-N1 required action（方案 b：pipeline 用 `principal.principalId`）**全部落实**：
- 根因（候选行空串 principalId → reserveQuota 查不到 grant → 503）消除。
- 生产/测试行为分叉消除（统一用调用者主体）。
- 回归测试精准堵住分叉（模拟生产空串装配 + 三维度断言）。
- 直接回归面 w09/w10/w12/w16/w18 零破坏（30/30 PASS）。
- 双 Attempt failover 归因正确（w18 F-01-6 + w12 验证）。

**R2-N1 → CLOSED**。

---

## 3. F-12 收口判定

round 2 报告 §2 F-12 判定："主体 CLOSED（main.ts 切 real-pipeline + 真实 deps + stub caller 披露），但暴露 R2-N1 → 整体 REMAINING"。

本次 R2-N1 CLOSED 后：
- F-12 主体（round 2 已 CLOSED）：main.ts 切 createRealPipeline + 注入全部真实 deps（含 quotaRepo）+ caller=stub 显式披露。**维持 CLOSED**。
- R2-N1（F-12 衍生的生产路径 wiring 残留）：**本次 CLOSED**。

**F-12 → 整体 CLOSED**（round 2 的 REMAINING 消除）。

---

## 4. 判定汇总

| Finding | round 2 | round 3 判定 | 依据 |
| --- | --- | --- | --- |
| F-01 额度门禁接入热路径 | CLOSED | 不重审（本次未碰） | round 2 已 CLOSED；R2-N1 修复反而让 F-01 门禁在生产路径真实生效 |
| F-03 账本聚合 finalOutcome→SUM(line) | CLOSED | 不重审（本次未碰） | round 2 已 CLOSED |
| F-12 main.ts 切 real-pipeline | REMAINING（主体 CLOSED + R2-N1） | **CLOSED** | R2-N1 CLOSED → F-12 整体 CLOSED |
| F-02 敏感 env dev fallback | CLOSED | 不重审（本次未碰） | round 2 已 CLOSED |
| R2-N1 生产 CODING_PLAN 恒 REJECT_NO_GRANT | 新 blocker（P1） | **CLOSED** | 方案 b 落实 + 回归测试 + 直接回归面 30/30 |

### 4.1 新 blocker 扫描（§10.3）

本次独立读核 + 实测未发现任何新 blocker：
- principalId 改 const 后 7 处用途一致，无残留候选行取值。
- 移除 failover 重赋值后双 Attempt 归因正确（w18 F-01-6 + w12 验证）。
- main.ts listCandidates 空串字段成 dead code（无害），文档注释残留为 P3 观察项（非 blocker）。
- 候选锁开审=结审 STABLE，产品代码零 drift。

### 4.2 PASS 达成条件（V1.4 §9.1）

- ✓ P0/P1 = 0：R2-N1（P1）CLOSED，F-12 整体 CLOSED，无新 P1。
- ✓ 对象锁 STABLE（开审 + 结审双 verify exit 0）。
- ✓ R2-N1 required action 全部落实（方案 b + 回归测试）。
- ✓ 直接回归面全绿（r2-n1 1/1 + w09/w10/w12/w16/w18 30/30）。
- ⚠ 实际独立性 I1（低于 R3 要求的 I2）——不阻断 PASS 判定，但佳哥须独立判断是否要求 I2 复核。

---

## 5. Decision

### 5.1 结论：**PASS**

依据 V1.4 §10.2 + §10.3：
- R2-N1 **CLOSED**：方案 b（pipeline 用 `principal.principalId`）落实，根因（候选行空串查不到 grant）消除，生产/测试分叉消除，回归测试堵住分叉，直接回归面 30/30 零破坏。
- F-12 **整体 CLOSED**：主体（round 2）+ R2-N1（本次）均 CLOSED，round 2 的 REMAINING 消除。
- 无新 blocker；对象锁开审=结审 STABLE。
- P1 = 0 → 达成 PASS 必要条件（§10.4）。

### 5.2 与 round 2 的关系（§10.2 "旧 FAIL 不自动覆盖"）

- round 2 的 REMAINING（F-12 + R2-N1）经本次独立复审重新证明 CLOSED，结论基于新对象锁 STABLE + 真实运行 + 代码逐行核对，**不自动继承 round 2 任何结论**。
- round 2 已 CLOSED 的 F-01/F-03/F-02 本次未重审（有界复审边界），其 CLOSED 状态维持。
- 本次新候选（HEAD 9decb8a）未引入新 blocker。

### 5.3 是否触发 §10.5 全量重审

**未触发**。R2-N1 补修是 real-pipeline 单文件 +1 测试的有界修复，在当前冻结合同内收口，未引入新架构/协议/生产路径契约。

### 5.4 回传

- `decision`: **PASS**
- `audit_round`: 3（R2-N1 单项有界复审）
- `reviewed_object`: HEAD `9decb8a`，R2-N1 补修 commit `8d7fe18`，implementation_hash `57f3d4ad...`
- `start/end_lock_verification`: STABLE（exit 0）
- `closed_findings`: R2-N1（P1）；F-12 整体 CLOSED（round 2 REMAINING 消除）
- `remaining_findings`: 无
- `new_blocker_candidates`: 无
- `regressed`: 无
- `new_direct_regression`: 无
- `observations`（P3，非阻断，交佳哥 triage）：
  1. `main.ts:68` 注释"由 pipeline 从 allCandidates 填充"已不准确（pipeline 改用调用者主体），建议后续更新注释或清理该 dead 字段。
  2. 实际独立性 I1（同模型族 GLM），佳哥可酌情决定是否要求 I2（不同模型族）复核本 PASS 结论。
- `requested_next_action`: 佳哥独立判断是否接受 I1 的 PASS 结论。若接受 → 第一道功能 Audit 通过，可进入第二道代码质量 Audit（前提：对象锁 STABLE）；若要求 I2 → 由不同模型族独立会话复核 R2-N1。
- `requested_state_transition`: 若佳哥接受 → 可从 `READY_FOR_FUNCTIONAL_AUDIT` 推进至代码质量 Audit 开审；**代码质量 Audit PASS 前不得进入 M5**。
- `prohibited_next_action`: 不得 push/remote/PR；审核 AI 不整改、不下发、不推进。

---

## 6. 做得好的地方（如实记录）

为客观呈现补修质量，记录本轮观察：
- **修复方向选优**：round 2 给出两选一方案，主 AI 选了方案 (b)（pipeline 消费侧修复）而非 (a)（main.ts 生产侧填充）。方案 (b) 更优——额度归因本就归调用者，在 pipeline 层用已认证主体是语义正确的根治，且消除了候选行 principalId 字段这个不可靠数据源（变成 dead code）。
- **归因一致性提升**：修复前 real-pipeline 的 principalId 有 1 处用候选行、其余用 `principal.principalId`（不一致）；修复后 7 处全部统一为 `principal.principalId`，消除潜在歧义。
- **回归测试精准**：r2-n1 测试不复刻 w09 的"手动填真实主体"，而是复刻生产 main.ts 的"空串装配"——精准堵住生产/测试分叉这个 R2-N1 的本质问题。三维度断言（200 + counter 回写 + 归因）覆盖全症状。
- **双 Attempt 归因正确处理**：移除 failover 重赋值后，w18 F-01-6（双资源 failover）仍 PASS，证明主 AI 正确判断了"额度归调用者，双 Attempt 不切主体"的语义。
- **改动面极小且透明**：单 commit、2 文件、+177/-2，与 commit message 描述逐项一致，无隐藏变更、无顺手改其他 Finding（§10.3 合规）。
- **对象锁一致**：开审=结审 implementation_hash `57f3d4ad...`，产品代码零 drift。

R2-N1 是 round 2 冻结后的单项 wiring 收尾，补修扎实，收口后候选达到 PASS。

---

## 附录：复审执行日志摘要

| 步骤 | 命令/动作 | 结果 |
| --- | --- | --- |
| 1 | 读任务书 §2/§8 + round 2 报告 + R2-N1 diff + principal-auth + quota-gate-repository | 理解 R2-N1 来龙去脉与判定标准 |
| 2 | git status / remote / HEAD 核验 | 工作树干净、无 remote、HEAD=9decb8a |
| 3 | `git show 8d7fe18` 独立读核 R2-N1 补修 diff | 2 文件 +177/-2，real-pipeline principalId 改 const + 移除 failover 重赋值 + 新增 r2-n1 测试 |
| 4 | 读 `principal-auth.ts` 核验 `principal.principalId` 可靠性 | Bearer Key 认证注入，已校验 key/principal ACTIVE + 未过期，可靠 |
| 5 | 读 `quota-gate-repository.ts` 核验 reserveQuota 匹配键 | 按 (enterprise, principal_id, provider, model_alias, ACTIVE) 查 grant；调用者主体必匹配 |
| 6 | 对象锁 generate（绑定当时 HEAD） | implementation_hash=`57f3d4ad...`（新 hash，反映 principalId 修复） |
| 7 | 对象锁 verify（开审） | STABLE，5 drift 全 false |
| 8 | 读 main.ts 确认生产 listCandidates 仍返空串（修复在 pipeline 消费侧） | 空串成 dead code，无害；注释残留为 P3 观察项 |
| 9 | 核验 w09/w10/w12/w16/w18 listCandidates 手动填 PRINCIPAL_ID | 确认生产/测试分叉根源；修复后统一用调用者 |
| 10 | `vitest run r2-n1-principal-ownership.test.ts` | **1/1 PASS**（200 + counter 回写 + 归因正确） |
| 11 | `vitest run w09/w10/w12/w16/w18`（直接回归面） | **30/30 PASS**（w09 5 + w10 5 + w12 6 + w16 7 + w18 7） |
| 12 | 核验 w18 F-01-6 双 Attempt failover 断言 | 双 Attempt 归因正确（首 release + 第二 settle，used 仅成功 Attempt） |
| 13 | 对象锁 verify（结审） | STABLE，hash 与开审一致，HEAD 不变 |

报告完成。回传佳哥。
