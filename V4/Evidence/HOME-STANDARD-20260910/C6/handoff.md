# C6 交接（首页看板精简 + 费用同期口径修正候选）

日期：2026-09-10。实施：ZCode；状态：**待 Codex 复核**。历史证据（C1–C5/R01–R05/V14-C2/V14-C4/V14-C5）原样保留。

## 1. 候选标识与冻结

- 候选：`HOME-STANDARD-C6-20260910`
- 基线：分支 `codex/quota-pricing-review-20260905`，HEAD `934b372ea50dc11de0cd2f2fe9ae362532e1c398`（C5 已并入此提交；本候选未提交、未推送、未合并、未部署）
- C6 tracked patch：`candidate-tracked.patch`，SHA256 `9ce21040b133f52e4ac360366d19be79514b7f62791d48b46604761d295dc34f`
- 9 个改动文件逐文件 SHA256：`candidate-files.sha256`
- 起止锁：`candidate-lock.txt`（起止 patch hash 漂移 = +`dashboard-home-costs.test.ts` 两处断言更新，测试文件、无生产代码变更；其余 8 文件起止一致）

### 审核事件披露（沙箱工具限制）

- 变异测试临时配置（`apps/web/stryker.home-model.config.json`、`apps/web/vitest.home-model-mutation.config.ts`）跑完后按惯例应删除，但沙箱文件系统拒绝删除（Operation not permitted），当前为 untracked 残留。**不得提交这两个文件**；其副本已归档至 `C6/mutation/`。
- 工作树另有非本任务改动 `V4/仟流智算-2.0-问题蓄水池.md`（POOL 台账 2026-09-07 补记）及 `V4/Evidence/POOL-*` 等历史证据目录，均不在本候选 patch 范围，未触碰。

## 2. 本轮差异（C5 → C6）

| 文件 | 变化 | 性质 |
| --- | --- | --- |
| `apps/web/src/pages/Dashboard.tsx` | 删概览 Zone `description`；删四卡 `hint` 传参 | 展示层（删文案） |
| `apps/web/src/components/dashboard/OverviewMetricCard.tsx` | 移除 `hint` prop 与渲染块 | 展示层（删 prop） |
| `apps/web/src/components/dashboard/standard-home-model.ts` | 删 `token.hint`/`cost.hints` 字段与 `costHints` 构建；`costPreviousText` 对有金额+缺口场景改渲染"（已知部分；缺口：…）" | 展示模型 |
| `packages/database/src/repositories/dashboard-home-costs.ts` | 新增 `bridgeKnownSpends()`；`bridgeIncompleteReason` 改三分支（总额空且无已知→原因；否则 null） | **业务口径修正** |
| `packages/database/src/repositories/dashboard-home.ts` | 组合器：总额空时回退透出 `bridgeKnownSpends`（已知部分保留） | **业务口径修正** |
| 测试 ×3（model/page/costs 单测 + 集成断言） | 同步更新断言：解释行删除断言为 not.toContain；costs 单测两分支改断 null（透出已知部分）；集成用例改断套餐 200 透出 | 测试 |

**业务口径修正动因**：用户指出"上月有 Kimi 订阅费用，不应显示不可完整计算"。根因=`bridgeIncompleteReason` 旧实现在总额不完整（如 API 资源缺期末快照→ENDING_BALANCE_MISSING）时把 `totalSpends` 全清空，连坐丢弃已知套餐费用。修复后：已知部分（已计价 API 花费 + 套餐费用）保留透出，`incompleteReason` 仅在**无任何已知金额**时给出（与"遗漏金额只能标记为缺口、不得视为已知 0"互补——已知部分不是 0）。

## 3. 门禁（C6 回执）

| gate | 命令/范围 | 结果 | 回执 |
| --- | --- | --- | --- |
| typecheck 全仓 | 9 包直调 `tsc -p tsconfig.json --noEmit`（沙箱 pnpm -r 因 store 在宿主挂载不可用，逐包直调等价） | **PASS（9/9 exit 0）** | gate-typecheck.log |
| lint 全仓 | 9 包 `eslint src --max-warnings=0` | **PASS（9/9 exit 0）** | gate-lint.log |
| size | `check-source-size.mjs` | **PASS（446 文件 ≤400 行）** | gate-size.log |
| architecture | `check-architecture.mjs` | **PASS（1074 文件无环）** | gate-architecture.log |
| duplication | `jscpd … --threshold 5` | **PASS（0.67%，17 clones）** | gate-duplication.log |
| web 全量单测 | vitest 全量 | **PASS（51 文件 / 305 用例，exit 0）** | gate-web-tests.log |
| web 覆盖率（3 改动文件） | `--coverage.include model+OverviewMetricCard+Dashboard` | stmts 98.62 / branch 93.05；model 98.26/95.28、OverviewMetricCard 96.36/81.25、Dashboard.tsx 100/90.9 | coverage-web.log |
| DB 候选纯单测 | `dashboard-home.test.ts` + `dashboard-home-costs.test.ts` | **PASS（12/12）** | gate-database-candidate-tests.log |
| DB PG 集成 | `standard-home.integration.test.ts`（13 用例） | **BLOCKED：沙箱无容器运行时**（testcontainers 起不了 Postgres）；13 用例 skipped | gate-database-candidate-tests.log（见 EG-C6-1） |
| 变异（standard-home-model.ts） | Stryker vitest-runner，coverageAnalysis=all，break=80 | **PASS（97.33%，exit 0，225 变异体：219 killed / 5 survived / 1 nocov）** | mutation-web.log、mutation/reports/home-model.json |

## 4. 变异存活逐项定性（225 = 219 killed + 4 等价 + 2 P3 文案欠缺）

| ID | 位置/替换 | 定性 | 处置 |
| --- | --- | --- | --- |
| #8 | L41 删 `previousScaled===null` 守卫 | **等价**（后续 `<=0n` 析支截获 null） | 接受（沿袭 R05） |
| #16 | L43 `delta<0n`→`<=0n` | **等价**（delta=0n 时 -0n===0n） | 接受（沿袭 R05） |
| #175 | L192 `?? []`→垃圾数组 | **等价**（不可达 fallback） | 接受（沿袭 R05） |
| #178 | L195 `?? []`→垃圾数组 | **等价**（同上） | 接受（沿袭 R05） |
| #86 | L74 质量守卫→false | **P3 文案欠缺**（`unknownCount>0` 且 quality 非 UNKNOWN 时丢脚注补充文字） | 沿袭 R05 定级；精确注入实测 35/35 通过（存活确认，非工具误报）；退出条件=后续补该组合断言 |
| #208 | L215 模板串→空（NoCoverage） | **P3 文案欠缺**（previous 金额空+有原因时脚注省"（原因）"） | 沿袭 R05 对 #207 的定级；V8 模板映射 NoCoverage |

净逻辑变异（数值/币种/守卫）全部 Killed；存活仅 4 等价 + 2 文案级 P3，与 R05 残余一致（本轮无新增逻辑存活）。**注意**：R05 的 2 项 P3 在本轮仍存活（未补断言），沿袭不阻断。

## 5. Evidence Gap 与残余

| ID | 内容 | 缓解 | 退出条件 |
| --- | --- | --- | --- |
| EG-C6-1 | `standard-home.integration.test.ts` 13 项 PG 集成用例在沙箱无法运行（无 Docker/testcontainers 容器运行时），含本轮改的"故障注入透出套餐 200"断言 | 纯单测 12/12 覆盖 `bridgeKnownSpends`/`bridgeIncompleteReason` 新逻辑；另以 /tmp 独立脚本核对 4 场景（完整/已知部分/全空/已计价+套餐）逻辑等价 | **宿主机/Mac Mini 复跑** `pnpm -F @qianliu/database test:integration -- standard-home` |
| 沿袭 | 生产量级性能未测、共享 StatusTag 深色、WCAG 定量、F-F 产品裁决 | R05 已登记 | 不变 |

`p0=0 p1=0`；阻断性 Evidence Gap=1（EG-C6-1，仅因环境限制，非代码缺陷）。

## 6. 复现

- 变异复跑：在 `apps/web` 放回 `C6/mutation/` 下两份配置副本（stryker.home-model.config.json / vitest.home-model-mutation.config.ts）后执行 `corepack pnpm@11.11.0 exec stryker run stryker.home-model.config.json`。
- 沙箱跑 web vitest 的坑：node_modules 缺 linux-arm64 原生包，用 `npm pack @rollup/rollup-linux-arm64-gnu@4.62.3`、`@esbuild/linux-arm64@0.25.12`、`jscpd-linux-arm64-gnu@5.0.14` 解包注入对应 `.pnpm/<pkg>/node_modules/…` 即可（不进 git）。
- DB PG 集成：需宿主机 Docker。

**结论**：C6 候选门禁除 EG-C6-1（环境限制，待宿主机复跑）外全部通过；业务口径修正（已知部分保留）逻辑经纯单测+独立脚本验证。效力=实施者自审 I1，提请 Codex 复核。
