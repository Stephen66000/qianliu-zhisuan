# 机械门禁全部复跑记录 — 新 HEAD `94482f0`

> 触发：F-P1-7 处置（rebase 到 kimi 修复 tip `5160002`）改写候选历史，旧 HEAD 上的门禁证据一律作废。
> 本记录是 `94482f0` 这一新 HEAD 上**重新独立复跑**的全部门禁原始结果。
> 运行日期：2026-09-22。worktree：`/Users/mac/Projects/仟流智算-provider-finance-init-20260921`。
> 候选 HEAD：`94482f06e5ac69a80357b6e17b9786f7690265c4`。

## 0. 结果总表

| 门禁 | 命令 | 结果 | 判定 |
|---|---|---|---|
| typecheck（全 workspace） | `pnpm -r run typecheck` | exit 0，11 个工程全过 | **PASS** |
| lint（全 workspace） | `pnpm -r run lint` | exit 0，12 个工程全过 | **PASS** |
| 单测（非 web，10 包） | `node scripts/run-bounded-vitest.mjs`（命令 01） | **2 fails / 8 passes** | **FAIL**（22 项既有失败，A/B 证明非本轮引入，见 `regression-triage-baseline-diff.md`） |
| 单测（web） | `vitest run --config vitest.config.ts`（apps/web） | **518 / 518 通过**（82 文件） | **PASS** |
| 体量门禁 | `node scripts/check-source-size.mjs` | **581 文件，0 违例** | **PASS** |
| 架构门禁 | `node scripts/check-architecture.mjs` | **581 生产文件，无运行时循环** | **PASS** |
| 重复率门禁 | `jscpd --min-lines 20 --min-tokens 100 --threshold 5` | 26 clones；lines **0.74%** / tokens **0.60%** ≤ 5% | **PASS** |
| 许可证门禁 | `pnpm licenses list --prod --json \| check-licenses.mjs` | `生产依赖出现未批准许可证: MPL-2.0` | **FAIL（基线既有、非本候选引入）** |
| domain 覆盖率 ratchet | `pnpm --filter @qianliu/domain run test:coverage` | lines **98.59** / statements **98.59** / branches **92.42** / functions **98.4** | **PASS**（基线 97.37 / 97.37 / 89.63 / 95.83） |
| 覆盖率 ratchet（13 scope） | `node scripts/check-coverage-ratchet.mjs` | 10 PASS / 3 FAIL（6 项指标） | **FAIL（3 个失败 scope 与本次改动文件集零重叠，属既有基线失配）** |
| 变异测试 | `quality:mutation*` | 未执行 | **未覆盖**（见 §4） |

## 1. typecheck（全 workspace）— PASS

`pnpm -r run typecheck` exit 0；11 个工程逐个通过：`config`、`contracts`、`domain`、`testing`、`web`、
`provider-adapters`、`observability`、`database`、`control-api`、`gateway`、`worker`。

> 该门禁同时是 **F-P1-5 barrel 拆分零导出丢失** 的类型级证据：`packages/database/src/index.ts`
> 拆成 4 个 `exports/*` 子模块后，全部消费方的类型解析仍然通过。

## 2. lint（全 workspace）— PASS

`pnpm -r run lint` exit 0；12 个工程全过（含拆分后的 `domain` 6 文件与 `database` 4 个 `exports/*` 子模块，
均为 `eslint --max-warnings=0`）。

## 3. 单测 — web PASS；非 web 22 项既有失败

- **web：518 / 518 通过（82 文件）**。I1 报告记载为 513/513；本轮新增的向导/预检回归用例使其增至 518，
  全部通过 —— 即 F-P1-1 的 UI 回归用例确实在跑且为绿。
- **非 web：2 fails / 8 passes**，失败包 `packages/database`（20 项）与 `apps/gateway`（2 项）。
- 已用 baseline diff 证明 **0 项为本次整改引入**；三类成因（迁移头数字断言链 / 迁移台账列表深比较 /
  数据性能口径）与逐项清单见 `regression-triage-baseline-diff.md`。

## 4. 体量与架构 — PASS

```
source-size gate passed: 581 files, default <= 400 logical lines
architecture gate passed: 581 production source files, no runtime cycles
```

对照 I1 报告 F-P1-5 的 11 处违例：

| 原违例 | 处置 | 现状 |
|---|---|---|
| `domain/provider-finance-activation-projection.ts` 894 | 按 输入契约/草稿规范化/守恒检查/余额投影 拆为 5 模块 | 354（+ 188/164/192/100 四个新模块） |
| `domain/provider-finance-activation.ts` 538 | 按 契约面/实现面 拆为 2 模块 | 249（+ 304 契约模块） |
| `database/src/index.ts` 471 | 按域拆出 4 个 `exports/*` 子导出 | 12（+ 186/93/36/156） |
| `database/...coordinator.ts` 569、`-repository.ts` 501、`-facts.ts` 442 | 按 `exception_policy` 登记防增长基线 | 已登记（owner/reason/reviewed_on/review_due/exit 五要素齐备） |
| `web/ActivationDraftEditor.tsx` 492、`activation-draft-model.ts` 418 | 同上登记 | 已登记 |
| kimi 侧 3 处（`model-discovery-routes.ts` 602、`ResourceModelDiscovery.tsx` 768、`model-discovery.ts` 506） | rebase 到 `5160002` 后由其修复覆盖 | 392 / 687（≤723 基线）/ 408（≤484 基线），已合规 |

## 5. 覆盖率 ratchet — domain PASS，3 个 scope 为既有失配

`node scripts/check-coverage-ratchet.mjs` 退出码 **1**，逐 scope 实测（本机产出 `coverage-summary.json` 后对照 `V3/仟流智算-质量门禁-v1.0.json`）：

| scope | statements | branches | functions | lines | 判定 |
|---|---|---|---|---|---|
| **domain** | 98.59 | 92.42 | 98.4 | 98.59 | **PASS** |
| control-api-security | 100 | 94.44 | 100 | 100 | PASS |
| observability-remediation | 100 | 88.88 | 100 | 100 | PASS |
| provider-secret | 100 | 87.5 | 100 | 100 | PASS |
| worker-scheduler | 100 | 100 | 100 | 100 | PASS |
| pool029-node-authorization | 96.2 | 90.5 | 93.18 | 96.2 | PASS |
| pool029-web-authorization | 97.47 | 89.95 | 97.95 | 97.47 | **FAIL**（stmt/lines < 99.65） |
| pool030-gateway-timeout | 98.5 | 96.29 | 100 | 98.5 | **FAIL**（stmt/br/lines < 100） |
| pool030-provider-timeout | 100 | 100 | 100 | 100 | PASS |
| pool043-node-operating-bill-accounts | 95.45 | 89.3 | 94.67 | 95.45 | PASS |
| pool043-gateway-model-identity | 97.84 | 90.73 | 100 | 97.84 | PASS |
| pool043-web-operating-bill-accounts | 96.74 | 85.91 | 89.33 | 96.74 | **FAIL**（fn < 90） |
| pool040-gateway-revoked-settlement | 100 | 100 | 100 | 100 | PASS |

### 5.1 3 个失败 scope 的归属：与本次改动**零重叠**，属既有基线失配

三个失败 scope 的 `coverage.include` 都是**显式文件清单**（非 glob），因此覆盖集合不会被新文件撑大：

| scope | 覆盖的源文件 | 是否在本次改动文件集内 |
|---|---|---|
| pool029-web-authorization | `pages/EmployeeModelRules.tsx`、`api/employee-model-rules.ts`、`components/layout/Sidebar.tsx` | **否** |
| pool030-gateway-timeout | `upstream-timeout-policy.ts`、`upstream-caller-factory.ts`、`upstream-failover-policy.ts` | **否** |
| pool043-web-operating-bill-accounts | `App.tsx`、`api/operating-bill(s).ts`、`layout/*`、`operating-bill/*`、`pages/OperatingBill*` | **否** |

- 本次整改提交 `94482f0` 的 28 个改动文件，与上表**无一交集**（`git diff --name-only 7c2e5ca 94482f0` 比对）；
- rebase 引入的 kimi 修复 15 个文件（`git diff --name-only ca533e3d 5160002`）同样与上表**零交集**；
- 故这 3 个 scope 的覆盖率**在数学上不因本次改动而改变**，其低于配置基线属**既有失配**
  （配置内基线取自更早时点的实测值，与本候选无关）。**不擅自下调配置基线以求绿**，登记为独立事项。

### 5.2 F-P1-6 关闭证据（domain scope）

I1 报告 F-P1-6 记录的是 domain scope 四项全线跌破（lines/statements 91.19、functions 94.40、branches 85.79）。
本轮实测：**lines/statements 98.59、branches 92.42、functions 98.4**，全部高于防下降基线
（97.37 / 89.63 / 95.83），超出量 1.22 / 2.79 / 2.57 个百分点。**F-P1-6 关闭。**

### 5.3 覆盖率运行的环境适配（如实记录）

本机 safe-delete 批量删除守卫（阈值 50 文件/轮）会拦下 vitest v8 coverage 在 `reportCoverage()`
之后对 `<reportsDirectory>/.tmp`（400+ 文件）的清理动作，导致命令以非 0 退出。
**报告在清理之前即已写出**（已在 `packages/domain/coverage/coverage-summary.json` 验证）。因此本轮：

1. 每次运行前把该 scope 的旧输出目录**移出**（`mv`，非删除），避免守卫影响与结果串味；
2. 运行后以 `coverage-summary.json` 是否存在判定本次是否真正产出；
3. 对因**测试失败**而跳过报告写出的两个 scope（`pool043-node`、`pool043-gateway`，
   失败即 §3 的既有失败），追加 `--coverage.reportOnFailure=true` 后补齐产物。

> 结论：13 个 scope 的 `coverage-summary.json` **全部为本机在 `94482f0` 上实测产出**，
> I1 报告 §3「其余 13 个覆盖率 scope 缺报告未复跑」与 §6 Evidence Gap 第 4 项 **就此补齐**。
> 未对本机安全守卫做任何修改或绕过。

## 6. 许可证门禁 — 基线既有失败

`生产依赖出现未批准许可证: MPL-2.0`（`@resvg/resvg-js`）。与 I1 报告 §3
「许可证门禁 exit 1：MPL-2.0（@resvg/resvg-js）」一致，且 I1 已明确登记为**基线既有、非本候选引入**。
本轮维持登记，不处置。

## 7. 未覆盖项（诚实登记）

| 项 | 状态 | 说明 |
|---|---|---|
| 增量变异测试 `quality:mutation*`（R3 核心变更原则要求） | **未执行** | Stryker 全量变异耗时极大，本轮未启动；I1 报告 §6 第 3 项 Evidence Gap 仍然存在，需单独授权执行或按有依据的例外登记 |
| 仓库既有 22 项集成失败（database 20 + gateway 2） | **未修复** | 属既有失败，按规范不擅自改断言；需单独立项裁决 |
| 3 个覆盖率 scope 的基线失配 | **未处置** | 同上，需单独立项 |
