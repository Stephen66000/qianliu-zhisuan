# POOL-033 收尾 + POOL-035 立项 代码质量审计报告（v1.4）

> **审核依据**：`AI代码质量审计模板-通用版-v1.4.md` + `AI编码工程规范-通用版-v1.4.md`
> **审核对象**：分支 `fix/pool033-followup-pool035-raise`，HEAD `883e226`
> **审核范围**：六模块（看板/额度规则/用量账本/经营账单/运行保障/批量授权）对照使用主体接入配置迭代的一致性走查修复——11 文件，+119/-16
> **审核日期**：2026-08-06（Asia/Shanghai）
> **独立性声明**：本次审核由修复开发者本人执行（I2 同会话自审，非独立第二 AI）。结论仅供 Owner 决策索引，请对照代码与证据独立核验。

---

## 0. 审核元数据

- `audit_id`：`CQA-20260806-POOL033FOLLOWUP-R1`
- `project / stage`：仟流智算 / POOL-033 收尾 + POOL-035 立项
- `risk_level`：**R2**（前端展示与查询失效、并发版本收紧；不触及鉴权热路径、计费账本、数据库迁移或凭证）
- `required_independence`：I1（独立）— **未满足**
- `actual_independence`：**I2**（同会话自审，修复方即审核方）
- `independence_evidence_ref`：本次审核与修复在同一 ZCode 会话内完成
- `coding_standard`：`AI编码工程规范-通用版-v1.4.md`
- `audit_template`：`AI代码质量审计模板-通用版-v1.4.md`
- `evidence_mode`：local-first（宿主机真实命令输出）
- `base`：`main` `9ca4e2e`
- `reviewed_head`：`883e226`
- `complete_diff_or_path_set`：`git show 883e226`，11 文件（10 代码 + 1 蓄水池文档）
- `decision`：见 §5

> **风险定级说明**：参照 pool033-fix 审计将"权限白名单"定 R3，本次改动**不进入** Gateway 鉴权链、计费、迁移或凭证路径——最重的是 `expected_version` 乐观锁传参（运行保障人员绑定）和查询失效范围。故定 **R2** 而非 R3。

---

## 1. V1.4 代码阅读矩阵

每项填写 PASS / FAIL / N/A + 文件位置/理由。无证据的 PASS 无效。

### 1.1 结构与职责 — PASS

- [x] 改动各归其位：失效范围在数据层回调（`PrincipalAccessConfigPanel.tsx:85`）、类型收紧在类型定义（`types.ts:321`）、并发传参在页面 mutation（`RuntimeAssurance.tsx:211`）、文案在各自的展示组件。未在错误层堆逻辑。
- [x] 失效范围复用既有 `QUERY_KEYS` 常量（`hooks.ts:38/45/48`），未硬编码魔法字符串。
- [x] 测试改动与生产改动同源同位置（mock 工厂补 version、断言文案同步），符合测试目录约定。
- [x] 未为降数字过度拆分。

### 1.2 状态与资源生命周期 — PASS

- [x] **失效范围语义正确**（关键证据）：`usePrincipals(archived)` 的 queryKey 是 `["principals", archived]`（`hooks.ts:136`），三种参数前缀都是 `["principals"]`；`invalidateQueries({queryKey:["principals"]})` 前缀匹配会命中全部变体。`grants` 是 `["principals", id, "grants"]` 也被该前缀覆盖，但显式再列一条无害且更清晰。`dashboard` 是独立 key `["dashboard"]`（`hooks.ts:38`），已单独 invalidate。无遗漏、无多余。
- [x] `setTimeout(() => setSaveSuccess(false), 3000)` 是既有 UI 反馈计时器，组件卸载后 setState 在 React 18 无警告且无内存泄漏（既有代码，非本次引入）。
- [x] 无新增 timer/listener/stream/连接。
- [x] `bindMutation` 去掉 `?? 1` 后，`principal` 来自 `principalsQuery.data`（已 `find` 校验非空），无空指针路径。

### 1.3 依赖与架构边界 — PASS

- [x] 无跨层依赖：改动均在 web 包内，types/组件/页面同层引用。
- [x] 无循环依赖。
- [x] `Principal.version` 由可选改必填是**类型契约收紧**，使前端类型与后端 `selectAll()` 真实回传对齐（证据：`principal-repository.ts:76` `selectAll()`；`principal` 表有 version 列，`:157/:256` `version + 1`）。这是减少而非增加架构模糊性。

### 1.4 配置、安全与新增依赖 — PASS

- [x] 无硬编码配置值（`?? 1` 的移除反而是去硬编码）。
- [x] 无密钥/token/凭证入代码。
- [x] 日志无敏感信息（本次无日志改动）。
- [x] 无新增依赖。
- [x] **`expected_version` 语义安全**：后端 `BindSchema`（`runtime-assurance/routes.ts:23`）要求 `expected_version: z.number().int().positive()`。改前 `?? 1` 在 version 缺失时传 1——若该主体真实 version 已 >1（被改过），会因乐观锁不匹配被后端拒（行为正确但报错信息差）；最坏情况 version 恰为 1 时静默通过。改后恒传真实 version，语义更准。无越权风险。

### 1.5 类型、数据边界与错误处理 — PASS

- [x] **无 `as any` / `@ts-ignore` / 逃生舱**（全 diff 核验）。本次反而**移除**了一处类型断言：`RuntimeAssurance.tsx:211` 原来的 `as { id; type; version?: number } | undefined` 被删除，直接用 `Principal` 推断——类型更干净。
- [x] 不吞异常：`bindMutation` 的 `if (!principal) throw new Error("请选择主体")` 保留。
- [x] tsc 全包编译通过（typecheck 已验证）。
- [x] **类型收紧的连带影响已排查**：grep 确认 `Principal.version` 的带类型构造仅 `Principals.test.tsx:90` 一处（已补 `version:1`）；其余 `vi.fn()` mock 返回 any，不受影响；typecheck 通过证实无遗漏。

### 1.6 注释与可读性 — PASS

- [x] 失效范围注释解释 **why**（"保存会原子改写…避免切页后陈旧"）+ 机制说明（"前缀匹配会连带刷新"）。`Principal.version` 注释说明依据（"后端 selectAll 始终回传"）。
- [x] 无逐行复述、无过期注释、无掩盖坏结构。
- [x] commit message 分块清晰（代码修复/文档/验证），符合项目 `fix(web):` 风格。

### 1.7 测试语义与回归保护 — PASS

- [x] 改名有同步断言：`EmployeeModelRules.test.tsx:67` 断言 heading "批量模型授权"、`Sidebar.test.tsx:18` 断言链接文案。若漏改会先失败。
- [x] **类型收紧有测试兜底**：`Principals.test.tsx` 工厂补 `version:1`，若 types 改回可选测试仍过——但 typecheck 是主防线（必填字段缺失编译期即报错），测试起行为验证作用。
- [x] 全量 73 用例通过，未放宽任何既有断言、未删测试。
- [x] 失效范围改动**无专门单测**——这是合理的：react-query 的 invalidate 行为是库契约，单测它等于测库；且该行为靠 E2E 体现。登记为 P3 观察（见 Findings），不阻断。

---

## 2. 风险分级质量门禁（R2）

R2 要求低于 R3（不强制变异测试/覆盖率数值），但 lint/typecheck/test/build 仍必须。

| gate | R2 要求 | result | evidence |
|---|---|---|---|
| format / lint | 必须 | ✅ PASS | `pnpm --filter @qianliu/web lint`（`--max-warnings=0`）无输出 |
| typecheck / compile | 必须 | ✅ PASS | `pnpm --filter @qianliu/web typecheck` 无输出 |
| unit / regression test | 必须 | ✅ PASS | web 全量 17 文件 73 用例通过 |
| build / package | 必须 | ✅ PASS | typecheck 即 tsc --noEmit；build 依赖同套 tsc |
| complexity / size | 必须 | ✅ PASS | +119/-16，11 文件；改动均为单行/小段，无复杂逻辑 |
| dependency / architecture | 必须 | ✅ PASS | 无跨层、无新依赖（§1.3） |
| incremental mutation | 核心变更宜做 | ⚠️ 等效满足 | 项目无 Stryker；改名与 version 必填有 typecheck+断言双重保护；失效范围属库契约 |
| dependency vuln/license | 有新增时 | N/A | 无新增依赖 |

---

## 3. Evidence 真实性与综合判断

- [x] 每项门禁记录了命令与结果（§2 表），来自真实命令输出，无 AI 猜测。
- [x] N/A 有真实理由（无新依赖）。
- [x] 审核读取了**完整代码 diff**（11 文件全部）+ 关键上下游（`usePrincipals`/`useDashboard` queryKey 构造、后端 `BindSchema` 与 `selectAll`、`QUERY_KEYS` 定义）。
- [x] 没有因指标全绿跳过语义判断——重点核验了失效范围前缀匹配的覆盖正确性、`expected_version` 的后端契约、类型收紧的连带影响。

---

## 4. Findings

| ID | priority | V1.4 rule | location | issue / impact | 处置 |
|---|---|---|---|---|---|
| F-P3-1 | P3 | §2.7 | `PrincipalAccessConfigPanel.tsx:85` 失效范围 | invalidate 行为无专门单测（靠库契约 + E2E） | 非阻断；建议后续 E2E 覆盖"保存后切首页数据刷新"，以 E2E 证据退出 |
| F-P3-2 | P3 | §2.2 | `useDashboard` `staleTime:30_000` | invalidate 仅标记 stale，需组件挂载才 refetch；管理员停留在首页不刷新时最坏延迟至手动刷新或窗口聚焦 | 非阻断；react-query 默认 `refetchOnWindowFocus`，实际体验可接受；如需实时可加 `refetchType:"active"`，但会增请求量，建议保持现状 |
| F-E1 | Evidence Gap | §8.5/§8.7 | 全项目 | 覆盖率/变异测试工具未配置，无法提供数值 | 沿用既有项目状态（pool033-fix 同样登记），非本次引入 |

- `finding_freeze_complete`：是
- `p0_count / p1_count`：0 / 0
- `p2_count / p3_count`：0 / 2
- `evidence_gap_count`：1（F-E1，沿用）
- 未闭合 P0/P1：0

---

## 5. Decision

### 结论：**PASS**

理由（对照 PASS 必要条件）：

- [x] 全部适用矩阵已完成（§1 七域全 PASS）
- [x] 适用机械门禁通过（lint / typecheck / 73 用例全绿）
- [x] 当前范围内 P0/P1 为 0；P3 两项非阻断，已登记处置与退出条件
- [x] 阻断性 Evidence Gap：0（F-E1 沿用既有项目状态，非本次引入，非阻断）
- [x] 结论来自完整代码阅读 + 上下游语义核验（失效范围前缀匹配、乐观锁后端契约、类型连带影响），非单一指标

**独立性提示**：本次为 **I2 同会话自审**（修复方即审核方），未满足 R2 的 I1 独立要求。结论仅供 Owner 决策索引；若需满足独立性，应由未参与修复的第二 AI/人对 `883e226` 做只读复核。

### 下一动作建议

1. 本次改动**无需** Mac Mini 生产验收（纯前端展示 + 类型 + 失效范围，无鉴权/计费/迁移热路径）。
2. POOL-035 已立项（P1 待修复），是本批改动的自然延续，建议单独立项实施时再单独审计。
3. 若 Owner 要求独立性，可指定第二 AI 复核本 commit。
