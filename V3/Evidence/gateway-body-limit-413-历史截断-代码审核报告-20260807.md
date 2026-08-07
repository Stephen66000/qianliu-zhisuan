# 代码审核报告：Gateway bodyLimit 413 修复 + 历史截断安全网

| 项目 | 内容 |
| --- | --- |
| 审核对象 | 分支 `fix/gateway-body-limit-413`，两个 commit：`816b446`（① bodyLimit+413归因）、`f1528d1`（② 历史截断） |
| 审核日期 | 2026-08-07 |
| 改动规模 | 11 文件，+499 / -2 行（含 3 个新增测试文件、1 个新增源文件） |
| 触发背景 | 生产报 `FST_ERR_CTP_BODY_TOO_LARGE / status=413 / reason=unknown`；直连智谱正常、走仟流几轮即 413 |
| 审核结论 | **技术：READY（可合并）；合规：非正式 Audit** — 见 §7 第二轮独立审核。两轮共修 P1×1 + P2×3（G-3/F-1/H-1/C-1，commit `3a92392`）；P1 已清零，剩余 P2/P3 为 follow-up。独立性 I1 + 未走 SOP 握手 = 不替代 V1.4 正式 Audit |

---

## 0. 总结论

根因诊断**确凿**：gateway Fastify 实例化（`apps/gateway/src/server.ts:43`）未设 `bodyLimit`，吃 5.8.5 默认 1MB；ZCode 每轮发累积上下文，长会话几轮过 1MB，在 `application/json` 解析阶段（进路由前）被拒。日志 `provider_code=FST_ERR_... reason=unknown` 的成因也定位清楚：gateway 原本无 `setErrorHandler`，Fastify 原生 413 走默认 JSON、被日志层记成 unknown。诊断与"直连智谱正常、走仟流即 413"的现象完全自洽。

① 的修复（抬高 bodyLimit + 统一错误归因）**止血充分且语义正确**，是必要的最小改动。② 的历史截断作为可选安全网，默认关闭、设计保守（保护 tool 配对、不改原数组），风险可控。

**但**：② 与现有额度预占（reserveQuota）存在**口径不一致**——预占按截断前的全量 body 估算、实际发送与计费按截断后的 body。预占偏高（settle 多退），方向安全，但应显式确认或修正。详见 P1-1。

---

## 1. P1 — 建议合并前处理（1 项，✅ 已修复）

### P1-1 截断与额度预占的口径不一致（✅ 已修复，commit `854aede`）

**事实**：`real-pipeline.ts` 中，
- 行 372：`effectiveBody`（截断后）在 attempt 循环**外**计算；
- 行 514-519：`reserveQuota({ estimatedCost: estimateRawTokens(body) })` 用的是**原始 `body`**（未截断）；
- 行 628：实际发给上游的是 `effectiveBody`（截断后）。

即：**额度预占按全量历史估算，实际消耗按截断后估算**。

**影响**：
- 方向**安全**（预占偏高 → settle 时多退，不会少扣）；
- 但当截断启用且频繁触发时，预占会系统性偏高，可能**误触并发租约上限 / 额度门禁**（reserveQuota 拿不到额度 → 429/503），尤其在额度紧张时；
- 计费最终按上游真实 usage settle（`settleQuota` 多退少补），故**最终金额正确**，仅中间态预占偏高。

**处置建议**（二选一）：
1. **推荐**：预占也用 `effectiveBody`——把行 519 改成 `estimateRawTokens(effectiveBody)`。语义统一，预占贴近实际发送量。
2. 若有意保守预占（防止上游实际 usage 略高于估算），在代码注释里**显式声明**这是有意为之，并说明 settle 会校正。

> 注：截断默认关闭（env 未设），此问题仅在运维开启截断时才暴露。但既然要审核，应在合并前定调。

---

## 2. P2 — 合同缝隙 / 健壮性（3 项，建议跟进不阻断）

### P2-1 截断的 token 估算对 CJK 不保守（已知，沿用既有口径）

**事实**：`history-truncation.ts:61` 用 `JSON.stringify(m).length / 4`。`estimateRawTokens`（`real-pipeline.ts:1418`）的注释明确写道此倍率"对 CJK 偏保守——实际 token 数通常更高"。

**含义辨析**：这里"保守"指**预占方向**（估算偏低 → 预占不足，settle 补足）。但对**截断**而言，估算偏低意味着**可能少裁**（实际 token 比估算高，裁后仍可能超上游窗口）。两个方向对"保守"的定义相反。

**影响**：截断启用后，CJK 重的会话可能裁得不够（估算 80k 但实际 100k）。不致命（最坏撞上游上下文上限，由上游兜底），但削弱截断的有效性。

**处置建议**：文档化此特性；若要更保守，CJK 比例高的场景可把 `GATEWAY_HISTORY_KEEP_TOKENS` 设得更低留余量。无需改代码。

### P2-2 ② 的 tool 配对保护仅覆盖"孤立 tool 消息"单点

**事实**：`history-truncation.ts:129-147` 的配对保护只处理保留段**开头是孤立 tool 消息**（对应 assistant 被截掉）的情况。代码注释（行 130-132）也明示"这里只处理最常见的破坏点"。

**未覆盖的场景**：保留段**第一条 assistant 带 tool_calls，但其部分 tool 响应被截在保留段外**（assistant 在、tool 响应丢）。这种情况会产生"有调用无结果"的 assistant，上游可能报错。

**影响**：实际触发概率低（需要裁剪点恰好落在 assistant 与其 tool 响应之间，且 assistant 在保留段内），但非零。

**处置建议**：作为已知限制记录；若上线后观察到工具调用相关报错，再补"反向配对保护"（保留段首 assistant 若有 tool_calls，检查其响应是否完整，不完整则一并丢弃）。不阻断本次合并。

### P2-3 ② 缺端到端集成测试（仅纯函数单测）

**事实**：② 有 14 个纯函数单测（覆盖算法分支），但无通过 `createRealPipeline` + `StubUpstream` 的端到端测试来验证"裁剪后的 body 确实到达 adapter"。

**影响**：接入点 `real-pipeline.ts:372` 的 `effectiveBody` 构造、行 628 的透传，仅靠 typecheck 保证类型正确，未验证运行时行为（如截断是否真的在 attempt 循环外只执行一次、`body.messages` 是否正确传入）。

**处置建议**：补一个 w08-e2e 风格的端到端用例（注入开启的 config + 超大 messages，断言 `stub.calls[0].request.body.messages` 被裁）。当前因 w08 集成测试套件存在预先失败的 fixture 问题（见 §4），暂缓；建议 fixture 修复后补。

---

## 3. P3 — 一致性 / 编辑性（2 项）

### P3-1 错误信息文案笔误："正整数字节"（✅ 已修复，commit `854aede`）

**事实**：`server.ts:52`（① 的 `readRequestBodyLimit`）抛错文案 `"GATEWAY_REQUEST_BODY_LIMIT_BYTES 必须是正整数字节"`；`history-truncation.ts:45`（②）也有 `"GATEWAY_HISTORY_TRUNCATE_AT_TOKENS 必须是正整数字节"`。

但 ② 的单位是 **token**，不是字节——文案应去掉"字节"。① 的"字节"是对的（bodyLimit 单位是字节）。

**处置**：`history-truncation.ts:45` 改为 `"必须是正整数"`（去掉"字节"）。

### P3-2 control-api 重复定义 `readRequestBodyLimit`

**事实**：`gateway/server.ts` 和 `control-api/server.ts` 各自内联了一份几乎相同的 `readRequestBodyLimit`（仅 env 名和默认值不同）。

**影响**：轻微重复。当前两份的差异（env 名、默认值）使得提取到共享包价值有限，可接受。

**处置**：可选——若后续有第三个服务需要，再提取到共享 util。本次不处理。

---

## 4. 预先存在的问题（非本次改动引入，仅记录）

gateway 集成测试套件（`__tests-integration__/w08/w18/...`）存在一批**预先失败的用例**，模式为"期望 200 实际 403"（鉴权/授权层）。

**已验证非本次回归**：对 w08、w18 分别用 `git stash` 在干净树上重跑，失败用例数与改动后完全一致（w08: 7 失败；w18: 11 失败）。这些失败与 bodyLimit / 截断无关，是 fixture/环境问题，建议独立排查。

---

## 5. 审核通过项（已验证）

| 项 | 结论 |
| --- | --- |
| 根因诊断 | 准确，到行号，与现象自洽 |
| ① bodyLimit 抬高 | 默认 10MB 合理，env 可配，非法值 fail-fast |
| ① 413 错误归因 | `setErrorHandler` 正确拦截 `FST_ERR_CTP_BODY_TOO_LARGE`，转 OpenAI envelope；TS `unknown` 窄化用 `"code" in err` 范式与仓库一致 |
| ② 默认关闭 | env 未设 = null = 零行为变化，已单测覆盖 |
| ② tool 配对保护 | 单点保护逻辑正确，14 单测含配对场景全过 |
| ② 不变量遵守 | 截断为纯同步函数，遵守 `real-pipeline.ts:544-546` 鉴权栅栏无 await 约束 |
| ② 不改原数组 | 返回新数组，已单测 |
| typecheck | gateway / control-api / domain 三包全绿 |
| lint | 全绿 |
| 单测 | ① 5 例 + ② 14 例 + w05 端到端 2 例全过；domain 158 例全过 |

---

## 6. 合并建议

- **P1-1**（截断/预占口径）✅ 已修复（`854aede`）：预占改用 `estimateRawTokens(effectiveBody)`。
- **P3-1**（文案笔误）✅ 已修复（`854aede`）。
- 剩余 P2/P3 作为 follow-up，不阻断合并。
- ① 可独立先合（与 ② 无代码耦合，仅逻辑上互补）。
- 审核结论：**READY（可合并）**。

---

## 7. 第二轮：独立代码审核（对照 V1.4 规范，commit `3a92392`）

> 第一轮（§0-6）为作者自审。用户要求对照《AI 编码工程规范 v1.4》做独立 code 审核。本节为独立审核结论，复核了第一轮的每一项，并发现自审遗漏。

### 7.0 审核元数据与合规声明

| 项目 | 内容 |
| --- | --- |
| 规范版本 | `AI编码工程规范-通用版-v1.4.md` + `AI代码质量审计模板-通用版-v1.4.md` |
| 风险等级 | **R3**（命中"资金/计费 + 认证授权边界 + 公开协议"） |
| 实际独立性 | **I1**（同一模型/同一会话）—— **合规缺口**：R3 应为 I2（第二独立意见） |
| 审核性质 | **代码质量技术审查**，非 V1.4 合规正式 Audit（未走 SOP 开审握手 / 对象锁 / 状态账本） |
| 审核范围 | 完整 diff `main...3a92392`，7 源文件 + 5 测试文件，逐文件通读 + 子 agent 复核 |

**合规缺口（如实记录，不掩盖）**：
1. 未走 SOP `READY_FOR_CODE_AUDIT → CODE_AUDIT_IN_PROGRESS` 握手；
2. 独立性 I1 低于 R3 要求的 I2；
3. ~~项目无 `quality-gates.yaml` 覆盖层~~ **【已修正】** 项目实际已有 `V3/仟流智算-质量门禁-v1.0.json`（v1.0 JSON 格式），含 9 个 coverage ratchet scope + 5 个 mutation disposition + complexity/duplication/source_size 门禁。审核时遗漏了此文件，系事实性错误。格式（JSON v1.0）与规范示例（YAML v1.4）不同，但内容实质已覆盖规范要求的绝大部分门禁。

→ 本报告是技术结论，**不构成 V1.4 模板定义的正式 Audit PASS**。如需正式 Audit，需启动 SOP 流程（开审握手 + 第二模型 I2）。

### 7.1 独立复核：纠正第一轮的误判

| 第一轮结论 | 独立复核 | 说明 |
| --- | --- | --- |
| P1 × 0 | **P1 × 1（G-3）** | 第一轮漏掉：commit `854aede` 的 P1-1 修复（预占口径）**无任何测试保护**。改回旧代码不会有测试失败。 |
| control-api 重复"可接受不处理"（P3-2） | **改为 P2（H-1）** | control-api 版 `readRequestBodyLimit` 无单测、未 export，与 gateway 版漂移风险真实。 |

### 7.2 Finding 冻结表（第二轮，已逐项处置）

| ID | 定级 | V1.4 条款 | 位置 | 问题 | 处置 |
| --- | --- | --- | --- | --- | --- |
| **G-3** | P1 | §8.1/§8.3 测试有效性 | real-pipeline.ts:521 | P1-1 预占口径修复无回归测试 | ✅ `3a92392`：提取 `buildEffectiveBody` 纯函数 + 4 单测 |
| **F-1** | P2 | §7.3 不吞异常/观测 | history-truncation.ts:118 | 全 system 超阈值静默 no-op，观测盲区 | ✅ `3a92392`：显式 warn + 单测 |
| **H-1** | P2 | §2.1 逻辑重复 | control-api/server.ts:109 | 与 gateway 重复 readRequestBodyLimit，无单测 | ✅ `3a92392`：抽 `readPositiveIntEnv` 到 `@qianliu/config` + 两处单测 |
| C-1 | P2 | — | history-truncation.ts:108/169 | token 估算重复 reduce 两遍 | ✅ `3a92392`：复用 beforeTokens（随 F-1 修） |
| F-2 | P2 | — | history-truncation.ts:122-127 | keepTokens break 先于累加，off-by-one（方向安全） | follow-up：文档化"会略超一条" |
| F-3 | P2 | — | history-truncation.ts:133-147 | tool 配对仅覆盖"孤立 tool"，未覆盖反向 | follow-up：观察后按需补 |
| G-1 | P2 | §8.3 断言有效性 | history-truncation.test.ts:48-60 | 截断保留段断言过弱（只断"变短"） | follow-up：补条数/顺序断言 |
| B-1 | P2 | §7.3 错误处理 | server.ts:124 | error handler `reply.send(err)` 兜底是 Fastify 反模式 | follow-up：评估改 `throw err` |
| A-1 | P3 | §7.4 类型逃生舱 | real-pipeline.ts:154 | `request.principal!` 非空断言（**预先存在**，非本次引入） | 不处理（非本次范围） |
| B-2 | P3 | — | server.ts:106 | setErrorHandler 无 try/catch（风险低） | follow-up |
| D-1 | P3 | — | server.ts:118 | 413 未回显实际 bodyLimit 值 | follow-up：产品体验 |
| F-4 | P3 | — | history-truncation.ts:78-80 | 畸形 tool_call 缺 function 时 id 被丢弃 | follow-up |

**Finding 冻结完成**：P0×0，P1×0（G-3 已修），P2×5 已修 3 / follow-up 4，P3×4 全 follow-up。

### 7.3 第二轮处置后的验证证据

| 门禁 | 命令 | 结果 |
| --- | --- | --- |
| typecheck | `tsc --noEmit`（config/gateway/control-api 三包） | ✅ 全 exit 0 |
| lint | `eslint`（全部改动文件） | ✅ 全 exit 0 |
| 单测 | vitest（config 9 + gateway 60 + control-api 3） | ✅ 72 passed |
| 复杂度 | eslint complexity/max-lines-per-function | ✅ 无超阈 |
| 覆盖率 ratchet | `V3/仟流智算-质量门禁-v1.0.json`（9 scope） | ✅ 项目已有基线（本次改动未触及其 ratchet scope，未单独跑） |
| 变异测试 | stryker（apps/gateway 等多 config） | ⚠️ R3 应做增量变异；项目已有 stryker 配置，本次未跑（紧急 hotfix） |

### 7.4 第二轮最终结论

**技术结论：READY（可合并）** —— P1 已清零，关键 P2（G-3/F-1/H-1）已修复且有测试保护，剩余 P2/P3 均为 follow-up 且不阻断。

**合规结论：非正式 Audit** —— 因 I1 独立性 + 未走 SOP 握手，本报告不替代 V1.4 正式代码质量 Audit。~~无项目门禁基线~~【已修正：项目已有 `V3/仟流智算-质量门禁-v1.0.json`】。若此改动需正式 Audit PASS，应由第二独立模型（I2）在 SOP 流程下复审。
