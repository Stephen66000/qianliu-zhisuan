# WP4 S6 回执：浏览器证据＋AT-AFR-03 修复＋全量复跑

实施：glm-flash 子 Agent（WP4-S6 合同）；日期：2026-11-04；分支 `codex/simplify-api-cost-and-official-balance`（不 commit，改动留工作树）。
开工基线：`git status --short | grep -v "^??" | wc -l` ＝ **59**（含 2 个 D；合同预期"约 61 含 2 D"，以实测为准，与 S4 回执收尾态一致）。收尾 ＝ **63**（59＋本阶段 4 个 M）；新增未跟踪 2 文件（seed 子文件＋新 e2e spec）。全程只在 `/Users/mac/Projects/仟流智算-api-decouple/` 写文件，主仓 `/Users/mac/Projects/仟流智算` 零触碰。

## 1. AT-AFR-03 时间敏感缺陷最小修复（交付 1）

文件：`apps/control-api/src/__tests-integration__/provider-finance-activation.http.test.ts`（:550 一行＋注释，diff +7/−1）。

```diff
-    const today = new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10);
+    // AT-AFR-03 修复（WP4-S6，总指挥授权）：业务时间改取北京昨天 T02:00（恒为过去时刻）。
+    // 原夹具取北京"今天"后拼 T02:00:00Z（=北京今天 10:00），在北京 00:00–10:00 窗口
+    // 位于未来，被 validateOrdinaryOccurredAt 拒绝（400"业务时间不能晚于当前时间"）；
+    // occurred_at 与 service_period_start 受 assertSameShanghaiDay 约束须同上海日，故同改。
+    // 用例语义（业务时间合法的纯套餐草稿）与断言/流程零变化。
+    const today = new Date(Date.now() + 8 * 3_600_000 - 24 * 3_600_000).toISOString().slice(0, 10);
```

- 修复机制核实：`provider-finance-core.ts:31-33`（occurred_at > now → 400）；`provider-finance-activation-writes.ts:278` `assertSameShanghaiDay(occurred_at, period_start)` ⇒ 两个同源变量必须同改；`PROVIDER_FINANCE_CUTOVER = 2026-08-31T16:00Z`（北京昨天在切换点之后，下界安全）。
- **前后对比（缺陷窗口内实测，北京 01:23–01:24）**：
  - 修复前：`Tests 1 failed | 14 passed (15)`，失败点 ：559 `expect(subscription.statusCode).toBe(201)` 得 400（日志 `logs/at-afr-03-before-fix.log`）；
  - 修复后：`Tests 15 passed (15)`（日志 `logs/at-afr-03-after-fix.log`）。
- 只动夹具时间取值；断言、流程、其余 14 用例零变化。

## 2. canonicalProviderCode 核实结论（交付 2 前置）

`packages/provider-adapters/src/provider-code.ts:18-21`：仅 `trim().toLowerCase()`，**不剥离前缀** ⇒ seed 的 `pool043-deepseek`/`pool042-deepseek` **不会**归一为 `deepseek`（`official-balance-states.ts:126` supported 判定落 UNSUPPORTED）。因此 WP4 夹具新增 provider `code="DeepSeek"`：
- `canonicalProviderCode("DeepSeek") === "deepseek"` ⇒ supported 成立；
- `provider_enterprise_code_idx`（0005:29-33）为 `(enterprise_id, code)` 精确字符串唯一索引 ⇒ 与 `provider-review.spec.ts` beforeAll 自建的 `code="deepseek"` provider **不冲突**（实测同库共存，7/7 spec 通过）。

## 3. seed 夹具清单（交付 2）

新文件 `apps/control-api/src/cli/seed-e2e-wp4.ts`（`seedWp4CostOfficialBalance`，由 `seed-e2e.ts` 在 pool042 后调用）；`seed-e2e.ts` 另加 3 行 ledger_line `settled_at`＋TRUNCATE 显式补 `provider_resource_operating_sync_attempt`/`operating_bill_period`/`provider_finance_event`/`provider_finance_runtime_state`；pool043/pool042 各 2 行 ledger_line 补 `settled_at`（＝created_at， Aug 历史月）。E2E_IDS 固定 UUID 未动；4 个既有可运行 spec 依赖零破坏（`provider-review` beforeAll 在同库实测通过）。

| 夹具 | 内容 | 实测验证 |
|---|---|---|
| OK 官方余额资源 `…0311` | provider `DeepSeek WP4 E2E`(code `DeepSeek`)＋API 资源（无凭证）＋快照 `source='PROVIDER_SYNC'＋balance_source='PROVIDER_API'` 110 CNY（赠送 10＋充值 100，available=true，collected_at now−60s）＋attempt SUCCESS（next_sync_at 未来） | `listOfficialBalanceStates` 实测：status=OK，total=110.00000000，composition{10,100}，available=true |
| FAILED 保鲜值资源 `…0312` | 曾成功快照 50（now−120s，P2 内 ⇒ expired=false）＋最新 attempt FAILED（UPSTREAM_UNAVAILABLE） | status=FAILED，total=50.00000000（保鲜不显 0），last_attempt_failed=true |
| UNSUPPORTED | 复用既有 zhipu 资源（E2E 智谱主资源）＋pool043/pool042/isolated 均 UNSUPPORTED，不新增 | 实测 4 资源 status=UNSUPPORTED 全 null |
| F01 估算半开窗 `…0318-0322` | 输入 600＋缓存 400＋输出 200，规则 1/0.1/2 元每百万，settled_at 当月；api_cost="0.00104" CNY | `loadApiCostEstimation` 当月实测：CNY **0.00104000**；规则缺省 UNVERIFIED ⇒ gaps 含 PRICE_BASIS_UNVERIFIED=4（"价格依据待核实"夹具） |
| 混币 | 同资源 USD 行 api_cost=0.5 settled 当月 | estimation amounts：CNY 0.00104＋USD 0.5 两桶 |
| CLOSED 历史月 | `operating_bill_period` status=CLOSED（上海上一月，动态计算）＋`operating_bill_version` 冻结快照（期初 1000/充值 100/期末 1004/API 花费 96 旧资金轨迹＋原标签）＋CLOSED 事件 | getBill 走冻结版本；页面横幅＋三卡实测可见 |
| 历史资金记录 | `provider_finance_runtime_state` strict_writes_enabled=true＋`provider_finance_event` API_OPENING_BALANCE(1000)＋API_RECHARGE(100) 均 source=ADMIN（触发器链：0083 要求 PENDING 资源状态行＋同币种期先于充值 ⇒ 按事实链顺序补 `provider_resource_finance_state` PENDING 行；资源 created_at 显式提前 30 天满足"期初不早于创建"） | 页面"历史资金记录（旧口径，只读）"实测渲染 2 行＋来源"管理员登记" |

安全门：全部写入经 seed-e2e.ts 既有 127.0.0.1/`_e2e` 断言；运行验证 `seed-e2e.ts` 整体 exit=0（`{"status":"ok",…}`）。

## 4. e2e spec 用例清单与逐条结果（交付 3）

文件：`apps/web/e2e/wp4-cost-official-balance.spec.ts`（7 用例，真实 API 联调、零页面 mock；最终一轮 **7 passed (12.4s)**，日志 `logs/e2e-run5.log`；指定文件运行，未触碰 wt-web.spec.ts）。

| # | 用例 | 对应 case | 结果 | 关键断言 |
|---|---|---|---|---|
| 1 | 资源列表官方余额三态 | ACE-01＋OAB-01/04/02＋C2 API 事实 | PASS | 列头"官方余额 / 订阅"；OK 行 `官方余额 ¥110.00`＋`最近成功`＋组成不相加（行内无"220"）；FAILED 行 `¥50.00`＋`同步失败`(exact)；zhipu 行 `暂不支持官方余额同步`＋无刷新按钮；`GET /provider-resources` official_balance 三态结构逐资源对账 |
| 2 | 手动刷新无凭证 | OAB-03 手动 | PASS | 点"刷新余额"→路由响应 **409 `credential_missing`**（零真实上游）＋行内红字"资源没有可用凭证，无法刷新官方余额" |
| 3 | 套餐与订阅面板 | AFR-01 场景1（AT-AFR-01） | PASS | Tab"套餐与订阅"；`充值与订阅`/`充值金额`/`充值时间`/`当前 API 余额`/`API 经营成本` 全部 0 命中；"历史资金记录（旧口径，只读）"＋来源列"管理员登记"＋区块零按钮（只读） |
| 4 | 用量页估算命名＋F01 | ACE-01＋F01 半开窗 | PASS | 概览"API费用估算"＋明细 `th`"API费用估算"；`GET /usage` F01 记录 totalApiCost **"0.00104"** 精确断言；页面行渲染 ¥0.00（formatMoney 两位小数取整，精确值以 API 事实钉死） |
| 5 | DRAFT 现行月 | AFR-07 | PASS | "综合费用（含 API 估算）"可见；`期初余额未登记`/`本月总花费`/期初/充值/期末卡/关账横幅 全部 0 命中 |
| 6 | CLOSED 历史月 | AFR-07/AFR-06 | PASS | `role=status`"已关账版本（历史口径，只读）· v1"；期初 ¥1,000.00/充值 ¥100.00/期末 ¥1,004.00 三卡＋"本月总花费"＋厂商表 `th`"API 花费"；"综合费用（含 API 估算）" 0 命中 |
| 7 | 用量导出 CSV | AT-ACE-14 | PASS | content-type text/csv＋attachment；表头含"API费用估算"且无旧名 `API费用,`；F01 金额 0.00104 落列；响应头证据归档 |

实现注记：资源表/账单表的 `<th>` 无 `scope="col"`，Chromium 无障碍角色为 `cell` 而非 `columnheader`（利用表用 `scope="col"` 故有 columnheader）——断言按 `thead th` 文本过滤，未改任何业务组件。

## 5. 全量复跑矩阵（交付 4，真实数据）

| 套件 | 命令（worktree 根） | 结果 | 日志 |
|---|---|---|---|
| web test | `corepack pnpm@11.11.0 --filter @qianliu/web run test` | **94 文件 / 754 用例全绿** | logs/web-test.log |
| web lint | `… run lint` | exit=0（--max-warnings=0） | logs/web-lint.log |
| web typecheck | `… run typecheck` | **仅 6 个已知基线错误**（global-setup/wt-web 缺 5 helper，TS2307）；新 spec **零新增错误** | typecheck 输出（本回执 §4） |
| control-api test | `… run test` | **66 文件 / 482 用例全绿**（含 AT-AFR-03 修复） | logs/control-api-test.log |
| control-api typecheck / lint | 同上 | 均 exit=0 | logs/control-api-{typecheck,lint}.log |
| domain | test ＋ test:integration(无集成用例，echo 0) ＋ typecheck ＋ lint | **22 文件 / 411 用例全绿**；其余 exit=0 | logs/domain-*.log |
| provider-adapters | test ＋ test:integration ＋ typecheck ＋ lint | **test 22/398 全绿；integration 3 文件 / 8 用例全绿**；typecheck/lint exit=0 | logs/provider-adapters-*.log |
| database test | `… run test` | 113/114 文件、**835/836**：唯一失败＝`w20-standard-capacity.integration.test.ts` P95 性能基准（resourceUtilizationP95 1277ms>1000ms 预算；同套件内 335s 百万行迁移用例刚跑完、4 worker 并发预热）。**单文件复跑 2/2 通过（34.7s）**⇒ 时序抖动，非功能回归；本包 packages/database **零 diff**（git status 证实） | logs/database-test.log、logs/database-w20-standard-capacity-rerun.log |
| database test:integration | `… run test:integration`（testcontainers 自动起容器） | 80/81 文件、**590/591**：唯一失败＝同上同文件（该轮 3700ms，紧随 412s 百万迁移用例）；隔离复跑证据见上行 | logs/database-test-integration.log |
| database typecheck / lint | 同上 | 均 exit=0 | logs/database-{typecheck,lint}.log |
| gateway | test ＋ typecheck ＋ lint | **51 文件 / 411 用例全绿**；exit=0 | logs/gateway-*.log |
| worker | test ＋ typecheck ＋ lint | **36 文件 / 200 用例全绿**；exit=0 | logs/worker-*.log |
| openspec | `OPENSPEC_TELEMETRY=0 openspec validate simplify-api-cost-and-official-balance --strict --no-interactive` | **valid**（exit=0） | logs/openspec-validate.log |
| e2e（本 spec） | 合同指定命令＋指定文件 | **7/7 通过**（run2 起历经 4 轮定位：chromium 未装→th 角色断言→strict 冲突→ID 笔误） | logs/e2e-run{1-5}.log |

## 6. 偏离与移交

1. **database W20-10 P95 基准**（全量 test 与 test:integration 各 1 例红）：性能包络测试对同套件并发预热敏感（两轮失败值 1277/3700ms 均紧随百万行迁移用例；隔离复跑 34.7s 全绿且四项 P95 达标）。零 database diff，非本包回归。移交：建议该文件纳入"可单独重跑"豁免清单或调 budget，由总指挥裁定。
2. **worker test 套件再生 V4 证据副作用（观察项）**：`apps/worker/src/reporting/__tests__/report-layout-preview.test.ts:39` 等用例在运行时直接写 `V4/Evidence/EMPLOYEE-QUOTA-REPORTING-20261101/reporting/`（含随机 UUID，内容必然漂移）。本阶段执行合同要求的 worker 全量测试触发再生 8 文件；已 `git checkout --` 恢复至 HEAD 保持工作树干净（63＝59＋4M）。任何人在本仓重跑 worker test 都会复现该漂移，移交总指挥知悉（该证据目录是否应改为输出目录由 WP-EMP 任务域裁定）。
3. **strict_writes_enabled=true 超出合同 seed 点名清单（主动报告）**：合同交付 2 未点名 `provider_finance_runtime_state`，但交付 3 断言 5"历史资金记录只读区含来源标签"只有在 strict_writes 开启（ProviderFinancePanel 渲染分支）时可达——按"夹具服务于断言"补种，并在 S4 语义上无害（DRAFT 账单经实测仍为 BRIDGE_UNAVAILABLE 中性格＋估算命名，断言 5 通过）。现有 4 spec 零依赖该状态。
4. **UNSUPPORTED 资源"其余用量/估算列正常"**：断言 4 以可见性断言为主（暂不支持文案、无刷新按钮）；其估算列正常性经页面快照佐证（智谱主资源行 CNY 5,200.00 正常渲染），未单独写自动断言。
5. **e2e trace 日志**：最终轮 7/7 全绿，Playwright `trace: retain-on-failure` ⇒ 无 trace 产物；控制台/过程日志＝logs/e2e-run{1-5}.log（含 4 轮失败定位全记录）。
6. S4 移交项维持：`POST /provider-resources/:id/purchases` 后端仍可写；wt-web.spec.ts 基线缺陷未触碰（本包 e2e 以指定文件运行，不受其影响）。

## 7. 证据路径清单

- 根：`/Users/mac/Projects/仟流智算-api-decouple/V4/Evidence/API-COST-OFFICIAL-BALANCE/WP4-20261104/`
- 截图（9）：`screenshots/wp4-official-balance-{ok,failed,unsupported}.png`（三态行特写）、`wp4-resources-official-balance-full.png`、`wp4-refresh-credential-missing.png`（409 红字整页）、`wp4-plan-subscription-panel.png`（套餐与订阅＋历史资金记录来源列）、`wp4-bill-closed-banner.png`（横幅＋三卡）、`wp4-bill-draft-current-month.png`、`wp4-usage-estimation-column.png`
- CSV 响应头：`screenshots/wp4-usage-export-csv-headers.txt`
- 日志（32）：`logs/at-afr-03-{before-fix,after-fix}.log`、`logs/e2e-run{1-5}.log`、`logs/{web,control-api,domain,provider-adapters,database,gateway,worker}-*-{test,test:integration,typecheck,lint}.log`＋`logs/openspec-validate.log`＋`logs/database-w20-standard-capacity-rerun.log`（web typecheck 未落文件，结果见 §5 表行）
- 代码：`apps/control-api/src/__tests-integration__/provider-finance-activation.http.test.ts`（修复）、`apps/control-api/src/cli/seed-e2e{,-pool042,-pool043,-wp4}.ts`（夹具）、`apps/web/e2e/wp4-cost-official-balance.spec.ts`（spec）
