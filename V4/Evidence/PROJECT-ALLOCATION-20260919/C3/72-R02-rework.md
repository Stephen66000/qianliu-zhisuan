# R02 返修记录 — 第三方审核 FAIL 的 6 项返修（候选基线 2a9185c）

日期：2026-09-22。工作树：`仟流智算-project-allocation-feature-20260921`，分支
`project-allocation/v12-feature-candidate-20260921`，返修前 HEAD `2a9185c`。

## 0. 结论与边界

- `71-R01-recheck.md` 的"候选 PASS"结论**作废**（该文件已加撤回声明）。第三方审核 + 实施者实证复现确认 P1-a 使账期**永久无法结账**，P1-b 使结账闸门**静默冻结陈旧归集**。
- 本轮按用户明确授权的 6 项返修，方案 A（写入方同事务 `markAllocationDirty`）。
- 未 push / 未 merge / 未 deploy；performance WIP 与 test-baseline-governance 分支未触碰；未运行容量/百万行测试。1M 行生产规模性能**仍未验收**。
- 实施者不得自审：本轮完成后交**新的独立评审上下文**做 R02（见 §6 必检清单）。

## 1. 逐项修复与证据（file:line）

### P1-a 幂等短路分支必撞唯一索引 → 账期永久无法结账

- **修复**：`packages/database/src/repositories/project-allocation-run-repository.ts:583-602` —— 命中已发布摘要时改为 **no-op 成功**：只前进 `status/finished_at/duration_ms/updated_at`，**不写 `input_digest`**、不置 `is_current`、不写份额行与余量；既有发布批次保持 current。
- **附带语义（超出字面指令，必须由 R02 复核）**：`:608-635` 事务尾消费脏代次。no-op 分支以"摘要相等"证明当前输入与已发布批次一致，故把该账期 `dirty.generation` 对齐到发布批次捕获的代次（**条件更新**：`WHERE generation = <读取值>`，期间若有并发标记则不改动、保留 `dirty=true` 让闸门继续拒绝），并清 `dirty=false`。不改闸门代码（`project-allocation-freeze.ts:60-68` 原样），使"dirty 清除 + close 放行"同时成立；不变量：`dirty=false` 只可能由某次成功执行（发布或 no-op）设置。
- **回归**：`packages/database/src/__tests-integration__/project-allocation-close.integration.test.ts`（describe「P1-a：digest 命中幂等再发布」）——启用→SUCCEEDED→新项目 STARTED（date-only，同事务推脏）→脏输入 close 被拒→再登记执行→run SUCCEEDED（无 duplicate key）→2 个 SUCCEEDED 中仅 1 个带 digest 且为 current→dirty=false 且代次等于发布批次捕获值→close 返回 CLOSED。
- **实证复现（修复前）**：临时用例输出 `duplicate key value violates unique constraint "project_allocation_run_published_idem_uq"`，一次 `runDueAllocationRuns` 内 attempt 1→3 转终态 FAILED，dirty.generation=2 未消费（临时脚本已删除，工作树干净）。

### 退避符号写反（失败批次被立即重认领）

- **修复**：`project-allocation-run-repository.ts:661` `lease_expires_at: new Date(Date.now() + backoffMs)`；认领条件 `:309` 为 `lease_expires_at < now()`，过去时刻会被立刻回收并烧光尝试额度。
- **回归**：`project-allocation-compute.integration.test.ts`（describe「R02 返修回归」R02-1）——确定性失败后断言 `status=RUNNING`、`attempt=1`、`last_error` 非空、`lease_expires_at > now()`，且紧接的 `runDueAllocationRuns` 返回长度 0（退避窗口内不被重认领）。
- **R02 注意**：该用例的失败注入是**合成**的——直接插入一条把请求指向非 PROJECT 主体的 `operating_bill_request_project_assignment`，使发布期契约触发器必然拒绝。该状态经正常写路径不可达（`assignRequestToProject` 校验 PROJECT），仅用于强制走"可重试失败"路径；最初设计的 `numeric(24,4)` 溢出注入经实测不可行（bigint 最大 9.22e18 → 份额 19 位整数，仍在精度内）。

### P1-b 人工指定/回填不在变更识别内（闸门静默冻结陈旧归集）

- **方案 A（写入方同事务推脏）**，新增共享账期推导 `project-allocation-common.ts:129-152`（与 `accountMonthLineCtes`/scan 同口径：finance 严格写开启用 `settled_at`，否则 `created_at`，北京自然月；批量去重）：
  - `operating-bill-project-attribution.ts:71-75`（覆盖 `assignRequestToProject`，与业务写同事务）；
  - `principal-attribution-backfill.ts:174-179`（按批聚合后一次标记，禁止逐行）；
  - `provider-finance-usage-backfill.ts:155-171`（按"实际变更行"取请求集后标记；原地 UPDATE 不前进 `created_at`，水位扫描天然失明）。
- **回归**：close 用例「P1-b：人工指定同事务推脏」——指定前 MEMBERSHIP_RULE→指定后 dirty 前进、close 被拒→tick 自动登记并重算（`runsExecuted ≥ 1`，无需人工点重建）→来源变 MANUAL_ASSIGNMENT 且目标为指定项目→close 放行；`principal-attribution-backfill.integration.test.ts` 断言回填后 2026-09 脏行存在且 `dirty=true`；compute 用例 R02-2 断言 finance 原地回填后脏行存在。
- **观察（R02 可判）**：`provider-finance-usage-backfill` 是"可同事务挂钩"的，故未触发"停下来报回"的条件；本轮未扩展到其它 finance 写路径（如 `provider-finance-legacy-resolution`），列问题蓄水池。

### HISTORICAL_UNKNOWN 缺"无参与证据"前提

- **修复**：`packages/domain/src/project-allocation/allocation.ts:222-241` 抽出 `unallocatedReasonFor`：`RULE_PENDING_REPAIR` > （**无参与证据** 且早于 cutoff）`HISTORICAL_UNKNOWN` > `NO_EFFECTIVE_RULE` > `NO_MEMBERSHIP`，与 `:90` 契约注释一致。
- **回归**：`packages/domain/src/__tests__/project-allocation.test.ts` 新增两条——cutoff 之前**有参与证据**且无有效规则 → `NO_EFFECTIVE_RULE`（份额仍全额未分配）；cutoff 之前有参与但规则待修复 → `RULE_PENDING_REPAIR` 优先于历史未知。

### 并行门禁非确定性 flake

- **根因**：测试用宿主 JS 时钟写 `ledger_line.created_at`，tick 用 DB `now()` 写 `last_marked_at`；本机实测容器时钟比宿主快 1.2–6.0s，偏斜反向即让 `HAVING MAX(created_at) > last_marked_at`（`project-allocation-scan.ts:63-64`）重复标记同一月份。
- **修复**：`project-allocation-scan.ts:34-37` tick 内 `now` 改从数据库取（`SELECT now()`）；close 用例的种子行改用 DB 时钟并把断言月份改为从 DB 时钟推导（`project-allocation-close.integration.test.ts`「补偿扫描 tick」用例）。
- **证据**：`receipts/r02/gate-parallel-3x.txt` —— 文档原命令（4 文件并行）**连跑三遍 36/36 全绿**，无 unhandled error。

### 顺手项 1–6 的其余部分

- **P2-b 余量减数重复计数**：`project-allocation-run-repository.ts:517-530` 改为按 `ledger_line_id` `DISTINCT ON` 去重后再求和（每 share 行都带整行源套餐成本，多目标拆分时减数会被放大）。
- **P2-c 纯规则变更脏月份不登记**：`project-allocation-scan.ts:83-96` 增加"已脏且当前批次未消费该代次"的补登记，结果新增 `monthsEnqueued` 字段（worker 日志随之扩展）；回归见 close 用例「P2-c：纯规则变更（无新 ledger 行）」。
- **F-1 项目明细混入企业级未分配**：`project-allocation-read-repository.ts:290` 收紧为 `target_type='PROJECT' AND target_project_principal_id=:projectId`；回归：close「P2-c」用例断言重构前后 `total` 为 0/1。
- **F-2 明细主体类型合同**：`apps/control-api/src/operating-bills/project-allocation-routes.ts:94-101` 统一 `resolveAllocationPrincipal(..., 'PROJECT')`，不存在/跨企业/类型不符 → 404 `not_found`；回归：route 用例「F-2」三条负例。
- **F-3 未分配缺明细**：新增 `listUnallocatedLines`（`project-allocation-read-repository.ts:305-366`，支持 reason/employee/resource 过滤）+ 路由透出 `detail`（`project-allocation-routes.ts:120-150`，员工筛选走 EMPLOYEE 解析、非法 UUID 400）；Web 端把明细呈现在未分配卡片（`apps/web/src/pages/OperatingBillProjectAllocation.tsx`），因为项目明细已不再含未分配行。
- **Web `expectedVersion: 0`**：新增 `getProjectAccountingProfile`（`project-accounting-lifecycle-repository.ts:54-81`），成员接口透出 `accountingProfile`（`apps/control-api/src/principals/project-allocation-routes.ts:146-149`），页面提交前读取（`apps/web/src/pages/ProjectMembers.tsx:342`）。
- **diag 脚本**：`packages/database/diag-*.ts` 7 个文件已从候选移除。
- **attribution_watermark 死列**：0077 建表语句、`kysely-allocation-tables.ts` 类型、scan 写入与头注一并移除；`10-WP01-contract.md`、`50-WP06-implementation.md` 措辞同步修订。

## 2. 门禁回执

| 门禁 | 结果 | 回执 |
| --- | --- | --- |
| 根 `pnpm run typecheck` | exit 0（11 包） | `receipts/r02/gates-typecheck-lint-build.txt` |
| 根 `pnpm run lint` | exit 0 | 同上 |
| 根 `pnpm run build` | exit 0 | 同上 |
| close 8 / compute 8 | 全绿（含 5 条新增回归） | `receipts/r02/tests-database.txt` |
| foundation 19 + invariance 1 + migration 7 | 全绿 | 同上 |
| principal-attribution-backfill 4 | 全绿 | 同上 |
| domain 205 / control-api routes 13 / web 476 | 全绿 | `receipts/r02/tests-domain-api-web.txt` |
| 文档原命令 4 文件并行 ×3 | 36/36 ×3 全绿 | `receipts/r02/gate-parallel-3x.txt` |

未运行：e2e（Playwright，需起完整栈）、容量/百万行测试（明确禁跑）。

## 3. 遗留与问题蓄水池（不在本轮授权范围）

1. **`packages/database/tsconfig.json` 排除 `src/**/__tests-integration__/**`**：集成测试完全不在 typecheck 覆盖内。本轮顺手修正了其中一处真实类型错误（compute 用例的 `seedLedgerLine` 4 参调用 → 显式传 `null`，语义为"币种未知"，UNKNOWN_COST 形态要求 `api_cost_currency IS NULL`）。是否把集成测试纳入 typecheck 属独立议题（全仓历史红灯风险）。
2. P3 展示口径：residual `note` 按企业级 `financeEnabled` 打标（`run-repository.ts`），角落场景标签可能与实际来源不符，不影响金额/守恒/幂等。
3. 其它 finance 原地写路径（legacy resolution 等）未纳入同事务推脏；tick 会对"已脏且无法成功消费"的账期在退避到期后反复登记（可见的失败而非静默陈旧），是否需要退避上限属运营议题。
4. 未实现的非阻断项（沿用 R01 列表）：发布缺租约属主校验、preview 类型边界 400/404、30s 冷却、审计 `change_summary` 缺幂等键/原因/账期、扫描可能为早于 startMonth 的账期建冗余批次。

## 4. 交付物清单（本轮 diff 面）

23 个文件：数据库仓储 8（含 3 条写入路径钩子）、迁移 1、domain 1、control-api 3、web 3、集成测试 4、领域测试 1、证据文档 2，另有 7 个 diag 脚本删除。核心代码未触碰 Gateway/结算热路径。

## 5. 状态声明

核心功能工程候选：**返修完成，待独立 R02 复核**（不自评 PASS）；百万行生产规模性能：**未验收**；未 push、未合并、未部署。

## 6. 建议 R02 必检清单

1. digest 命中方向用例是否真正覆盖"no-op 成功 + dirty 清除 + close 放行"，且不依赖被改写的断言；
2. 幂等短路分支是否完全不触碰幂等键与 `is_current`（含 DB 触发器语义）；
3. 代次对齐（`:608-635`）的条件更新在并发标记下是否安全，且未放宽 `project-allocation-freeze.ts` 闸门；
4. 方案 A 三条写入路径是否**同事务**、是否按批聚合、账期口径是否与 scan/`account_at` 一致；
5. 退避符号与"退避窗口内不被重认领"断言是否成立（含合成失败注入的可接受性判断）；
6. `HISTORICAL_UNKNOWN` 判定次序与金标用例；
7. `attribution_watermark` 移除是否彻底（迁移/类型/写入/文档四面向）；
8. F-1/F-2/F-3、Web `expectedVersion`、diag 脚本移除是否到位；
9. 4 文件并行三连跑回执是否可复现（含时钟源修复的必要性）。
