# WP5 50 条验收矩阵（WP5 结包存档＋R1 返修标注；原「终稿」口径经 R1 验收退回撤销，2026-11-05 统一见 §5 与 matrix-r1.md）

日期：2026-11-04；基线：worktree `/Users/mac/Projects/仟流智算-api-decouple`，HEAD `d6550c9`＋未提交 S2A/S2B/S3a-1/S3a-2/S3b/S5 改动（结包提交前状态）。
**状态口径（R2 终审后，2026-11-05；本文件为 WP5 存档＋验收终判标注）**：原重开的 ACE-02、ACE-04、OAB-01、OAB-04、AFR-01 均已在 R1 复审改判 **PASS**；X02 经 R2 DB 侧 `now()` 根治、时钟探针及独立复跑，终审改判 **PASS**。**当前唯一统计：50 PASS／0 FAIL；整体结论为有条件通过，功能验收不等于发布批准。** W20-10 矩阵外单列，CI／标定环境四项 P95 全过及 development-summary.md §6.2 其余条件未闭合前不得发布。
**沿革（唯一沿革注记；旧「48＋2」与「50/50」均为历史口径，不再作为当前结论）**：WP5 原判 48 PASS＋2 半段 BLOCKED → WP6 演练补齐至 50/50 → R1 验收退回四阻断（ACE-02/04、OAB-01/04 等受影响条目重开）→ R2-R4 修复＋负向回归补齐 → 终态见 ../remediation-r1-20261105/matrix-r1.md；W20-10 矩阵外单列（归因未闭合）。业务复核层（§7 人工路线＋§8 业务签收）见 WP5/report.md 用户签认清单，不在本矩阵内冒充完成。

## 0. 证据指针图例（绝对路径前缀省写）

| 缩写 | 全路径 |
|---|---|
| `E2E` | `apps/web/e2e/wp4-cost-official-balance.spec.ts`（test 编号 1-16；行号见各指针） |
| `E2E-LOG` | `V4/Evidence/API-COST-OFFICIAL-BALANCE/WP5-20261104/logs/e2e-wp4-spec-commander-rerun.log`（16 passed / 36.3s，总指挥复跑档） |
| `SHOTS` | `V4/Evidence/API-COST-OFFICIAL-BALANCE/WP5-20261104/screenshots/`（R6 盘点后：在用 wp5-*.png 共 3 张；修复前/空白/重复 8 张移入同级 `superseded/`，清单与替代证据见 ../remediation-r1-20261105/matrix-r1.md 附注二；WP4 既有 wp4-*.png 10 件为 2026-11-05 01:07 走查修复 D-1~D-4 之后重摄版，复用） |
| `X06` | `V4/Evidence/API-COST-OFFICIAL-BALANCE/WP5-20261104/x06-amount-reconciliation.md` §1 行 1-26（脚本 `x06-amount-reconciliation.ts`，0 待裁定差异） |
| `S2A/S2B/S3A1/S3A2` | `openspec/changes/simplify-api-cost-and-official-balance/handoff/work-packages/WP5/receipts/` 下 `s2a-receipt.md`/`s2b-receipt.md`/`s3a1-receipt.md`/`s3a2-receipt.md`（§号见各指针） |
| `INV` | 同上目录 `notes/inv-wp5.md` §1 映射表锚点（file:line 均开工时逐一核实） |
| `DB`/`CA`/`GW`/`WK`/`AD`/`WEB` | 集成层：`packages/database/src/__tests-integration__/`、`apps/control-api/src/__tests-integration__/`、`packages/gateway`（同构）、`packages/worker`、`packages/provider-adapters`、`apps/web/src`（各 file:line 见指针） |

## 0b. 执行命令图例（S5 全量清单＝INV §4 T4 原样＋全量兜底）

| 编号 | 命令（corepack pnpm@11.11.0，worktree 根；E2E 需 4 环境变量＋`DATABASE_URL=qianliu_e2e`） |
|---|---|
| CMD-DB | `--filter @qianliu/database run test:integration -- <INV §4 DB 文件清单＋wp5-upgrade-immutability.integration.test.ts>` |
| CMD-GW | `--filter @qianliu/gateway run test:integration -- <INV §4 GW 文件清单>` |
| CMD-CA | `--filter @qianliu/control-api run test:integration -- <INV §4 CA 文件清单>` |
| CMD-WK | `--filter @qianliu/worker run test -- src/provider-operating-sync/runner.test.ts src/subscription-renewal/runner.test.ts` |
| CMD-AD | `--filter @qianliu/provider-adapters run test -- src/__tests__/provider-operating-facts.test.ts` |
| CMD-WEB | `--filter @qianliu/web run test -- <INV §4 web 文件清单>` |
| CMD-E2E | `--filter @qianliu/web exec playwright test --config playwright.config.ts e2e/wp4-cost-official-balance.spec.ts` |
| CMD-FULL | 各包 `test:integration` 不带文件参数（全量兜底；注意 w20-standard-capacity P95 与 usage-aggregate-migration-capacity 为本机容量敏感项（隔离可复绿）。[R1 更正 2026-11-05：W20-10「已知本机容量 flake」归因已撤销、改为归因未闭合，见 §5 与 remediation-r1-20261105/matrix-r1.md H 行]） |

已执行记录：S2A（CMD-CA 并集 360/360＋typecheck 0）、S2B（DB 591/593、CA 361/361、WEB 758/758、typecheck/lint 0）、S3A1（5 文件 29/29＋typecheck/lint 0）、S3A2（E2E 16/16＝E2E-LOG、WEB 759/759＋lint/typecheck 0）、S3B（X06 脚本 exit 0，15 端点/26 行/0 待裁定）。

## 1. API 费用估算（AT-ACE-01～14）

| ID | 夹具 | 证据层与证据指针 | 执行命令 | 状态草案 | 备注 |
|---|---|---|---|---|---|
| ACE-01 | F01（seed-e2e-wp4 :288-333） | E2E test4 :161-178（用量页两处“API费用估算”表头）＋E2E test8 :245-283（详情页结算汇总命名，G1 补）＋E2E test7 :214-241（CSV 表头）＋E2E-LOG ✓1/✓4/✓7/✓8＋SHOTS superseded/wp5-drilldown-f01.png（R1 盘点移入：修复前 D-1 旧渲染；表头命名证据以 E2E test4/7/8＋E2E-LOG 为准）；DB readers-alignment :115（4 读取方命名同源） | CMD-E2E（已跑 16/16）＋CMD-DB | PASS | G1 已补；“说明可查看且不宣称包含平台外调用”以详情页文案＋截图承载 |
| ACE-02 | F01 同上 | DB api-cost-estimation.integration.test.ts :160-171（**0.00104000 字面值**，:167 注释即规范公式）＋GW w13-billing.test.ts :128（分项 decimal）＋E2E test4 :171-174（HTTP 0.00104）＋E2E test8 :245-283（0.00104＋600/400/200 三字段，G2 补）＋X06 行 1/3/6/9/12（0.00104 求和成分） | CMD-DB＋CMD-GW＋CMD-E2E | PASS | 金额链→0.00104000 字面值用例＋X06 表；G2（1200 Token）已由 test8 断言；【R1 退回→修复→复核】阻断＝聚合 JOIN 当前 billing_rule.source_status（改规则翻转历史依据）→ F3 修复（estimationLinesSql 改读请求时快照键＋缺键 coalesce UNVERIFIED、移除该 JOIN）→ 回归已执行：「i-a/F3 历史追溯：改 billing_rule.source_status 后重查，依据仍按快照 VERIFIED、金额逐字不变」「i-b/F3 旧行回退：快照无 sourceStatus 键 → 依据归 UNVERIFIED」（estimation 13/13，remediation logs/07）＋0091 水位探针 exit 0（logs/14）；R1 复审 PASS（2026-11-05）（matrix-r1.md D 行） |
| ACE-03 | F11 雏形（w13 夹具 v1/v2）＋G3 夹具（S3A1 §2） | DB estimation “h)”（S3A1 §2-G3：生效点分窗 1.00000000/0.50000000＋重读 toEqual＋旧行保留版本 A）＋GW w13 :145（版本冻结） | CMD-DB（5 文件 29/29 已跑）＋CMD-GW | PASS | S3A1 §2-G3 全绿 |
| ACE-04 | seed F01 规则 0093 默认 UNVERIFIED | DB :258（PRICE_BASIS_UNVERIFIED）＋:302（0093）＋CA w19 :195＋WEB RequestDrilldown.test.tsx :104,112＋S2B §1.1/1.3（聚合级角标 R2/R7：UsageOverviewPanel/ResourceBreakdown/databreakdown）＋E2E test9 :285-313（指标卡角标）＋test15 :439-451（分解行角标）＋test8 :271（行级“估算 ¥0.00（价格依据待核实）”）＋SHOTS superseded/wp5-breakdown-price-basis-badge.png（R1 盘点移入：修复前 D-4 旧面板渲染；角标证据以 E2E test9/test15＋E2E-LOG＋X06 §3 为准） | CMD-DB＋CMD-CA＋CMD-WEB＋CMD-E2E | PASS | G4a（R2）与 G4b（e2e 角标）均已补；基准 gaps PRICE_BASIS_UNVERIFIED:4＝X06 §3；【R1 退回→修复→复核】阻断＝ABSOLUTE 适用分项缺价按 0 补零（验收复现 0.00044000 反例）→ F2 修复（computeApiCostFromRule 缺适用分项价返回 null 不补零→结算 UNKNOWN_COST、聚合 PRICE_MISSING）→ 回归已执行：domain「F2 验收场景：三项价齐 → 0.00104000；缺 hitPrice（cache>0）→ null 不补零」「F2 适用分项：缺 missPrice（miss>0）或 outputPrice（output>0）→ null」＋gateway「规则缺适用分项价时结算 UNKNOWN_COST，费用与币种为 NULL 但规则与快照仍冻结」＋DB「c2/F2 缺适用分项价行 → PRICE_MISSING、金额不含该行、不进 priceBasis」（remediation logs/15、17）；R4 复跑基准 gaps PRICE_BASIS_UNVERIFIED 4→9（F3 语义：seed 直插行无快照键归 UNVERIFIED，预期内口径变化、金额逐字不变，matrix-r1.md X06 行）；R1 复审 PASS（2026-11-05）（matrix-r1.md C 行） |
| ACE-05 | estimation 夹具（零资金表企业） | DB estimation a) :160＋readers-alignment :157＋E2E test8（无资金账户结算读数） | CMD-DB＋CMD-E2E | PASS | — |
| ACE-06 | parity 夹具 :39-97 | DB wp2-finance-mode-parity.integration.test.ts :102（strict 两路同源）＋S3A1 §2-G5 新用例（仅插更小官方快照→重读 toEqual＋amounts/completeness/gaps 逐字一致）＋GW gates :320 | CMD-DB（已跑）＋CMD-GW | PASS | G5 已补（“只改余额→重读逐字不变”） |
| ACE-07 | seed F02 三行（S3A2 §2：1 CNY/2 CNY/UNKNOWN） | DB estimation c) :218＋:382＋readers-alignment :182＋WEB UsageRow :28-40＋Usage.test :99-100＋E2E test9 :285-313（行级 ¥1/¥2/未知）＋E2E test10 :315-356（账单警示＋HTTP apiSpends=[CNY 3.00104000, USD 0.50000000]）＋X06 行 12/13（apiSpends 逐字一致＋缺口说明）＋SHOTS superseded/wp5-usage-unknown-cost-rows.png（R1 盘点移入：三文件 md5 相同的重复归档；行级金额证据以 X06 行 12＋E2E test10＋E2E-LOG 为准）、wp5-bill-draft-partial-pricing.png | CMD-DB＋CMD-WEB＋CMD-E2E | PASS | 金额链→X06 表行 12；G6 已补 |
| ACE-08 | gateway 夹具（dispatch guard） | GW attempt-usage-settlement.test.ts :168（上游前拒绝零费用）＋:310（definite zero＋overage/classification） | CMD-GW | PASS | — |
| ACE-09 | attempts 夹具（0.01+0.02） | DB api-cost-estimation-attempts.integration.test.ts :237（§1.1 合计 **0.03**）＋S3A1 §2-G26（§1.2b 回滚→重放仍 0.03000000）＋E2E test8（Attempt 数＝1，G7 补） | CMD-DB＋CMD-E2E | PASS | 金额链→0.03000000 字面值用例（attempts §1.1/§1.2/§1.2b） |
| ACE-10 | 直插合法历史处置 | DB attempts §1.3 :319（处置不变）＋CA usage-cost-disposition.http.test.ts :62（三投影一致） | CMD-DB＋CMD-CA | PASS | — |
| ACE-11 | 夹具内建 | DB readers-alignment :115（首页/用量/同期/统一入口字面值相等）＋**X06 §1 全表 26 行**（首页/资源分解/用量/账单/年度/部门/项目/CSV 同期同范围对照，0 待裁定） | CMD-DB＋X06 脚本（已跑 exit 0） | PASS | G8 已由 X06 补齐；跨读取方差异全部归因白名单 (a)/(b)/(c) |
| ACE-12 | cross-month 固定时钟 | DB wp2-cross-month-attribution :132/:162（11/12 月分列＋额度预占月）＋:233（新月续订）＋GW employee-monthly-quota :81 | CMD-DB＋CMD-GW | PASS | — |
| ACE-13 | e2e CLOSED/DRAFT＋catalog 套餐 | CA dashboard-finance-estimation.test.ts :99（总额=套餐+估算）＋E2E test5 :181-194（“综合费用（含 API 估算）”标签）＋E2E test10 :315-356（数值 ¥3.00 / USD 0.50＝seed 常量计算，G9 补）＋X06 行 3/12/14 | CMD-CA＋CMD-E2E | PASS | G9 已补（页面数值断言）；X06 行 14 另证 CLOSED 月历史口径不套用 |
| ACE-14 | seed usdRequest/usdLine :356-364 | DB estimation b) :182＋attempts §1.4 :355＋readers-alignment :182＋E2E test10（USD 0.50 独立标识、无 ¥3.50 合并）＋E2E test7（CSV 无跨币种合计列）＋X06 行 12（USD 0.50000000 分列、apiCost=null）＋行 10（CSV USD 列） | CMD-DB＋CMD-E2E | PASS | G10 已补；混币不合并由 apiCost=null 断言承载 |

## 2. 官方账户余额（AT-OAB-01～14）

| ID | 夹具 | 证据层与证据指针 | 执行命令 | 状态草案 | 备注 |
|---|---|---|---|---|---|
| OAB-01 | seed OK 资源（110=赠10+充100） | E2E test1 :62-114（110＋最近成功时间＋无 220）＋:99-113（C2 composition 逐字段）＋AD provider-operating-facts.test.ts :9＋SHOTS wp4-official-balance-ok.png（2026-11-05 修复后重摄） | CMD-AD＋CMD-E2E | PASS | 【R1 退回→修复→复核】阻断＝客户端可自报 PROVIDER_SYNC 来源冒充官方余额＋读侧仅筛 source 未双滤 → F1 修复（客户端合同 source 收紧字面 ADMIN＋读侧 states/repository/runner 三处补 balance_source='PROVIDER_API' 双滤）→ 回归已执行：w04「F1 负向：创建入口提交 PROVIDER_SYNC 来源＋余额金额被 400 拒绝且零落库」（17/17，logs/02）＋states「F1 冒充行免疫：source=PROVIDER_SYNC 且 balance_source=NULL 的行不进入官方余额域」（9/9，logs/04）；R1 复审 PASS（2026-11-05）（matrix-r1.md A/B 行） |
| OAB-02 | states 夹具直插 ADMIN 快照 | DB states :151（官方 null、手工不混入）＋forecast :56（official_source_missing） | CMD-DB | PASS | 浏览器侧无 ADMIN 快照夹具（不需浏览器） |
| OAB-03 | catalog zhipu 资源 | DB states :162（UNSUPPORTED 全 null）＋WK runner :131（DARK/OFF 仍同步）＋E2E test1 :86-89（暂不支持）＋E2E test11 :358-371（Token 与估算照常统计，G11 补）＋SHOTS superseded/wp5-usage-unsupported-tokens.png（R1 盘点移入：重复归档；Token 与估算统计证据以 E2E test11＋E2E-LOG 为准） | CMD-DB＋CMD-WK＋CMD-E2E | PASS | G11 已补 |
| OAB-04 | seed failedResource＋expiredResource | WK runner :131（资金 DARK/OFF 仍执行同步写快照）＋E2E test1 :79-83（FAILED 保鲜）＋E2E test12 :373-392（过期标记＋保鲜值 40，G14 补）＋SHOTS superseded/wp5-official-balance-expired.png（空白 769B）＋superseded/wp5-resources-expired-full.png（修复前）→ 替代＝WP4 SHOTS wp4-resources-official-balance-full.png（2026-11-05 重摄：'数据过期'行 ¥40.00 保鲜标记） | CMD-WK＋CMD-E2E | PASS | G12 备注：“推进至下一同步时点”为 runner 级 mock tick（非真实调度循环）；验收按 runner 证据＋说明执行，或 WP6 补 WK 集成；【R1 退回→修复→复核】阻断＝RUNNING 刷新行未排除 expires_at≤now（进程崩溃后无限 SYNCING）→ F4 修复（SYNCING 判定加租约未过期条件，过期回落快照/失败/NEVER_SYNCED）→ 回归已执行：states「F4 租约过期：expires_at 已过的 RUNNING 刷新收敛为非 SYNCING；未过期仍 SYNCING」（states 9/9，logs/04）；R1 复审 PASS（2026-11-05）（matrix-r1.md E 行） |
| OAB-05 | refresh.http 夹具注入成功响应 | CA official-balance-refresh.http.test.ts :164（成功刷新 ACCEPTED＋快照/attempt 落库＋审计无凭证明文）＋E2E test2 :116-132（409 credential_missing 分支） | CMD-CA＋CMD-E2E | PASS | G13 备注：浏览器“刷新后变 160”无 e2e（无真实上游）；以 HTTP 层成功路径＋页面 409 分支合成，如需真实演练归 WP6 |
| OAB-06 | refresh.http 夹具 | CA refresh.http :268（view-only 403＋GET 可读＋422/409/404）＋:365/:417（C2 结构＋请求体校验）；凭证不下发断言 :164/:268 | CMD-CA | PASS | — |
| OAB-07 | states 可控时钟（vi.setSystemTime） | DB states :86（T0 成功 50 保鲜＋P2 过期叠加）＋:223（P2 可配置）＋WK runner :192（失败保鲜）＋E2E test12（浏览器过期标记，G14 补） | CMD-DB＋CMD-WK＋CMD-E2E | PASS | G14 已补（S3A2 seed 过期资源） |
| OAB-08 | states 夹具＋seed neverResource | DB states :125（NEVER_SYNCED 不显 0）＋CA refresh.http :307（失败留痕/旧快照保留）＋E2E test13 :394-414（暂无官方数据＋401 原因，G15 补）＋SHOTS superseded/wp5-official-balance-never-success.png（修复前裁切；替代＝WP4 SHOTS wp4-resources-official-balance-full.png '从未成功'行暂无官方数据） | CMD-DB＋CMD-CA＋CMD-E2E | PASS | G15 已补 |
| OAB-09 | states 两资源＋seed 同账户 A/B | DB states :173（各 100 独立无合计）＋E2E test14 :416-437（两行各 ¥100.00、全页无 ¥200.00，G16 补）＋C2 两资源 OK 100 断言＋SHOTS superseded/wp5-official-balance-same-account-pair.png（修复前；替代＝WP4 SHOTS wp4-resources-official-balance-full.png 同账户 A/B 两行各 ¥100.00、全页无 ¥200 合计） | CMD-DB＋CMD-E2E | PASS | G16 已补（S3A2 §2-G16 落地说明：以 A/B 两资源对达成“无 200 合计”可证断言） |
| OAB-10 | 同上 | DB states :173（不凭金额自动合并——产品无账户识别逻辑即天然满足）＋资源列表页截图（同账户两行独立） | CMD-DB＋CMD-E2E | PASS | G17 以 states :173＋SHOTS superseded/wp5-official-balance-same-account-pair.png（修复前，替代见 OAB-09）记录 |
| OAB-11 | —（机制层） | WP3-S5 grep 证伪 gateway 准入零余额读取＋GW gates :320（正余额不进额度判定）＋WK runner :192（同步失败零资金写入） | CMD-GW＋CMD-WK | PASS | G18 备注：端到端“失败后模拟请求成功＋上游计数”联调步骤缺；以 GW 电池＋runner 证据合成，浏览器演练可归 WP6 |
| OAB-12 | runner/w11 夹具 | WK runner :192（恢复链：新证据解除/证据不足不解除/保鲜）＋GW w11-resource-pool.test.ts :146,282,315＋gates :497（EXHAUSTED 恢复原合同→DEGRADED） | CMD-WK＋CMD-GW | PASS | 隔离前/后证据两条时序已由 :192 覆盖 |
| OAB-13 | forecast 夹具＋seed expiredForecast | DB forecast :105（官方新鲜值不被 ADMIN 覆盖）＋:56（official_source_missing）＋domain supply-forecast.test.ts＋E2E test16 :453-476（可信度 HIGH＋覆盖 12h＋“不可计算”文案＋“○ 供给预测（算法估算）”图例）＋SHOTS wp5-supply-forecast-not-calculable.png、wp5-quota-window-forecast-legend.png | CMD-DB＋CMD-E2E | PASS | **浏览器层现有文案断言（可信度/覆盖/不可计算/算法估算）；“仅按已观察速率”专项句子缺位待用户裁定**（S3A2 §8-1，未改组件） |
| OAB-14 | forecast 可控时钟＋expiredForecast | DB forecast :76（official_balance_expired 不可计算）＋:122（P2 内正常）＋E2E test16（过期资源行 not_calculable_reason 断言，G20 补） | CMD-DB＋CMD-E2E | PASS | G20 已补 |

## 3. API 资金管理退出（AT-AFR-01～14）

| ID | 夹具 | 证据层与证据指针 | 执行命令 | 状态草案 | 备注 |
|---|---|---|---|---|---|
| AFR-01 | seed 历史事件 :586-620 | E2E test3 :134-159（无充值表单/历史只读含来源/退役说明）＋WEB resource-page-display（S3A2 §5 G24 组合断言）＋SHOTS wp4-plan-subscription-panel.png | CMD-WEB＋CMD-E2E | PASS | G21 备注：“逐项遍历所有操作菜单”未做，以 e2e test3＋组件测试合成；【R1 退回→修复→复核】阻断＝提交非 ADMIN 来源可同时绕过资金字段守卫携 API 资金字段落库 → F1 修复（客户端合同收紧字面 ADMIN 后守卫绕过路径闭合；O1a 保留服务端注入路径）→ 回归已执行：w04 F1 负向三条（创建/编辑/onboarding 提交 PROVIDER_SYNC/BILL_RECONCILIATION＋余额金额→400 且零落库；400 服务端实录 logs/02b，共 6 笔）；R1 复审 PASS（2026-11-05）（matrix-r1.md A 行） |
| AFR-02 | pf 夹具＋w20 plan/api 资源 | CA pf :896 it.each（W1-W4/W9-W11 七端点 410）＋:707/:726（W8/W7）＋S2A §1（R1：purchases API_RECHARGE 一律 410 新用例 w20 :999-1073＋既有用例迁移说明）＋WP2/retired-api-funding-contract.md §2 W12 | CMD-CA（43 文件 360/360 已跑） | PASS | G22=R1 已落地；S2A §4-2 备注 410 优先于 closed 为隐式覆盖（如需显式断言可后续补） |
| AFR-03 | activ 夹具 | CA activ :371（preview 拒绝含 API 资金草稿 400）＋:584（直插旧候选→409 candidate_contains_retired_api_facts 零写入）＋:538（纯套餐草稿 GO→W5/W6 可用） | CMD-CA | PASS | — |
| AFR-04 | pending (a) 夹具 | GW wp2-pending-admission.test.ts :135（新建无资金账户→立即可服务＋用量与估算） | CMD-GW | PASS | — |
| AFR-05 | pending＋直插 PENDING | GW pending (b) :163＋DB activ-migration :257/:423（0094 后门禁退役/存量语义不变） | CMD-GW＋CMD-DB | PASS | — |
| AFR-06 | pending (c) | GW pending (c) :175（CREDENTIAL_INVALID 仍拒绝零上游）＋gates :470（凭证隔离不被额度同步解除） | CMD-GW | PASS | — |
| AFR-07 | cross-month 固定时钟 | DB cross-month :132/:162/:233＋GW employee-monthly-quota :81＋E2E test1 :72（最近成功时间保留） | CMD-DB＋CMD-GW＋CMD-E2E | PASS | — |
| AFR-08 | 各夹具内建＋catalog CP 资源 | DB cross-month :233＋DB subscription-auto-renewal.integration（10 例）＋CA subscription-renewal-flow :15＋WK subscription-renewal/runner :8-19（OFF/DARK 不写/ACTIVE 调用） | CMD-DB＋CMD-CA＋CMD-WK | PASS | — |
| AFR-09 | gates 夹具（快照 88.88） | GW gates :320（AT-AFR-09 正余额仍 429 provider_quota_exhausted 零上游）＋GW employee-monthly-quota :45 系＋GW w18 :285（F-01-2） | CMD-GW | PASS | — |
| AFR-10 | gates 夹具 | GW gates :360（200+overage=true+授权四字段前后相等）＋GW w18 :812（F-01-4） | CMD-GW | PASS | — |
| AFR-11 | seed CLOSED 冻结月 :475-585 | CA pool025 :551（冻结不可变版本）＋:201（确认不改写快照/账本）＋DB parity :139＋DB draft-model-alignment :294（逐字节）＋E2E test6 :196-212（CLOSED 横幅·v1＋三卡）＋X06 行 14（CLOSED apiSpends=CNY 96.00000000 零改动）＋SHOTS wp4-bill-closed-banner.png | CMD-CA＋CMD-DB＋CMD-E2E | PASS | 金额链→X06 表行 14（白名单(c) 桥接历史值） |
| AFR-12 | draft-model-alignment 夹具＋S3A1 G23 夹具 | DB draft-model-alignment :236（draft 桥接字段照常产出）＋S3A1 §2-G23 新用例（仅余额桥接月份：桥接 30 保留在 sourceFacts、估算域精确 0、全树扫描无 30 误填）＋CA pool025 :151＋CA w20-resource-insights :646（旧 CLOSED JSON 安全投影） | CMD-DB＋CMD-CA | PASS | G23 已补（S3A1 §2-G23）；导出层不填桥接值由 G23 全树扫描承载 |
| AFR-13 | e2e DRAFT 现行月 | CA standard-home.integration :434-485（V14 缺口码迁移）＋WEB OperatingBill.test.tsx :178（无“待补期初余额”）＋standard-home-model.test.ts :208-211（死映射删除）＋E2E test5 :181-194（DRAFT 无待补/期初/充值/期末卡） | CMD-CA＋CMD-WEB＋CMD-E2E | PASS | — |
| AFR-14 | seed＋catalog | E2E test1（API 官方余额列）＋test3（套餐与订阅保留）＋WEB ResourceBreakdown.pool042.test.tsx（同面板两 mode）＋S3A2 §5 G24 同渲染输出组合断言（API 无资金栏目＋CP 费用/额度保留） | CMD-WEB＋CMD-E2E | PASS | G24 已补 |

## 4. 八项集成回归（AT-X01～08）

| ID | 夹具 | 证据层与证据指针 | 执行命令 | 状态草案 | 备注 |
|---|---|---|---|---|---|
| X01 资金模式矩阵 | parity 夹具＋pending 夹具＋runner/w04 夹具 | **组合现有五套件**：DB parity :102（strict 关/开两路同源＝OFF/ACTIVE 机制）＋WK subscription-renewal/runner :8-19（OFF/DARK 续订门禁）＋WK provider-operating-sync/runner :131（DARK/OFF 仍同步）＋CA w04-provider-route.test.ts :41-47（OFF 路由不注册 404）＋CA activ :891（DARK 停写 404，INV §3-X01 补充）＋GW pending (a)(b)（无账户/PENDING） | CMD-DB＋CMD-WK＋CMD-CA＋CMD-GW（同批执行） | PASS（S5 五套件全绿确认）| **组合矩阵＝分域参数化证据合成，无单一矩阵用例**（INV G25 建议已被总指挥接受）；组合覆盖＝OFF/DARK/ACTIVE×strict 关/开×无账户/旧账户×无状态/PENDING（各分域参数化点见前述指针）；“估算恒 0.00104000”字面值在分域各自断言（estimation a/:160、GW w13 :128、E2E test4/test8、X06 行 1-12），parity 本身用 12.34 |
| X02 同日多次与冷却 | refresh.http/DB refresh/0095/runner 夹具 | CA refresh.http 7 例（:164 成功/:207 冷却/:227 在途租约/:268 权限/:307 失败后再刷/:365 C2/:417 校验）＋DB wp3-official-balance-refresh 8 例（:73 并发/:104 幂等/:118 冷却/:165 租约/:185 同日多行/:230 down）＋DB wp3-operating-sync-decouple :74,82,113（0095 同日多行＋down 守卫）＋WK runner :54（P1 周期门禁）＋R2 DB 侧 `now()` 根治、时钟探针及三连 8/8（remediation-r2 logs/r2-01~03） | CMD-CA＋CMD-DB＋CMD-WK | **PASS（R2 终审改判）** | `convergeExpiredLeases` 的过期判定与留痕已统一为单条 UPDATE 内 DB `now()`；验收人独立复跑 AT-X02 4/4、HTTP 文件 8/8、DB refresh 7/7 全绿。新增 2 秒 skew 用例不具独立杀死旧实现的判别力，发布前须改为受控偏移负向回归；该测试条件不否定已验证的产品修复，详见 development-summary.md §6.2。 |
| X03 重复终态 | attempts 夹具 | DB attempts §1.2 :276（dedup 重放不落新行、聚合仍 **0.03**）＋S3A1 §2-G26 §1.2b（事务回滚→重放→仍只计一次、计数 ["2","2","2"]、9.99 幽灵行不存在）＋GW employee-monthly-quota :110（原子月度记账失败零残留）＋GW attempt-usage-settlement :101/:189（单一原子入口/failover 不重复结算） | CMD-DB＋CMD-GW | PASS | 金额链→0.03000000 字面值用例；G26 两步断言已由 S3A1 §1.2b 补齐 |
| X04 其他门禁 | gates/w11/cpqw 夹具 | GW gates 9 例 :319-534（禁超额/允许超额/Key 限制/项目限制/CPQW 窗口/人工停用/凭证无效/真实 EXHAUSTED/纯 PENDING 对照）＋GW w11 :74-330＋GW cpqw-quota-window :205-475 | CMD-GW | PASS | — |
| X05 升级与历史不变 | S3A1 X05 夹具（0091 水位 F08/F09） | DB wp5-upgrade-immutability.integration.test.ts（新文件 3 用例：6.2a 迁移不变性＋sha256 摘要对比/0093 白名单正向断言；6.2b 退役写入口升级后仍拒绝零写入；6.2c 新库对照）——S3A1 §3 全绿（3/3） | CMD-DB | PASS | 允许差异白名单（0092 新表/0093 新列默认值）已逐条列明；HTTP 层 410/409 退役合同由 AFR-02 覆盖；“迁移前旧数据摘要保存”以用例内现场基线实现（INV §5-6） |
| X06 全页和导出同源 | e2e seed 当月 DRAFT＋CLOSED 月 | **X06 §1 核对表 26 行**（脚本 x06-amount-reconciliation.ts exit 0：15 端点/基准 loadApiCostEstimation CNY 3.00104000＋USD 0.50000000 KNOWN_PARTIAL/**0 待裁定差异**；基准 JSON 全文＋15 端点原始响应摘要见 X06 §3/§4）＋DB readers-alignment :115＋draft-model-alignment :142/:159/:184＋operating-analysis.integration（9 例）＋pool043-operating-bill-accounts＋project-allocation-*＋E2E test4/5/6/7 | X06 脚本（已跑）＋CMD-DB＋CMD-E2E | PASS | 金额链→X06 全表；差异归因：一致 10 行、白名单(b) 双权威 6 行、白名单(a) 范围/期间 7 行、(a)+(b) 组合 4 行、(c) 桥接历史 1 行、核对行（项目/部门分摊域）若干部；CSV 币种缺省标签（costCurrency??"CNY"）与年度页 apiAccounts 覆盖范围两处观察列入回执未决问题 |
| X07 无账户新消费与回退 | estimation/pending/gates/冻结系夹具 | **可执行半段**：DB estimation a) :160（可读）＋GW pending (a) :135（可结算全链路）＋GW gates :320（受额度约束）＋AFR-11 系（冻结/逐字节，数据保留）＋DB migration-rollback 系（provider-finance-activation-migration :359、wp3-operating-sync-decouple :82/:113、wp5-upgrade-immutability 6.2b）＋WK runner/CA refresh.http :307（官方刷新恢复）＋X06 行 1-26（无期初消费金额可读可核对）＋**WP6 回退半段（2026-11-05 补齐）**：DB wp6-rollback-drill.integration.test.ts 7/7（down 链 0096→0092 八行集 sha256 逐字不变/0092 幂等重放/0095 守卫两态/0094 down 边界/回退后重升零丢失）＋旧代码（ae506fe）读回退库实证三行式 PASS（准入含边界/可读/可结算，legacy-ae506fe-read-check.output.md）＋回退操作单＝WP6/release-candidate.md §6 | CMD-DB＋CMD-GW＋CMD-CA＋CMD-WK | **PASS（全条；WP6 回退半段 2026-11-05 补齐）** | WP6 演练证据根＝`V4/Evidence/API-COST-OFFICIAL-BALANCE/WP6-20261104/`（logs/wp6-rollback-drill.log 7/7，总指挥复跑同绿；旧代码行为边界如实登记于回退单 §6.4：回退后新建资源重新 PENDING 且旧代码不服务，不补期初） |
| X08 切换时任务共存 | pf/activ/quiescence/runner 夹具 | **机制证据（可执行半段）**：CA pf :896（停旧写七端点 410＋四表零增量）＋CA activ :458（未排空拒绝且不落候选）＋GW provider-finance-quiescence-gate :126/:171（租约内 503 零事实/到期自动恢复）＋WK runner gate＋renewal tick＋provider-operating-sync runner（零资金依赖）＋CA refresh.http :307（官方刷新恢复）＋X01 组合套件（OFF/DARK/ACTIVE 各服务共存读数）＋**WP6 切换半段（2026-11-05 补齐）**：X08 五段时序编排演练 23 断言 allPass（T0 旧栈 ae506fe@0092→T1 停旧写+在途收尾 drained+停旧栈→T2 迁移 0093-0096→T3 候选栈→T4 验证 A-E：七端点 410/资金窗口零增量/官方刷新 runner+手动成功/套餐开关周期新旧一致/mock 计数 chat=3 balance=4 零外呼）；logs/wp6-x08-switch-drill.log＋x08-result.json | CMD-CA＋CMD-GW＋CMD-WK | **PASS（全条；WP6 切换半段 2026-11-05 补齐）** | 演练 31.8s 为隔离环境参考值；T0 订阅登记 1 行为计划内基线增量（总指挥裁定口径，release-candidate.md §7.2）；无真实付款（fetch 守卫 fail-closed 零 BLOCKED） |

## 5. 统计与装配说明（R2 终审后统一口径，2026-11-05）

- **单一最新统计（R2 终审后，2026-11-05）**：**50 PASS／0 FAIL。** 原五条在 R1 复审改判 PASS；X02 在 R2 终审改判 PASS。整体结论为**有条件通过**，功能矩阵全绿不代表发布批准；W20-10、X02 受控偏移负向回归修正及既有发布前置按 development-summary.md §6.2 执行。
- **沿革（一次性注记，历史口径不再作为「当前」）**：WP5 原判 48 PASS＋2 半段 BLOCKED → WP6 演练补齐 X07/X08 至 50/50（证据根 `../WP6-20261104/`，操作单＝WP6/release-candidate.md）→ R1 验收退回四阻断（ACE-02/04、OAB-01/04 等受影响条目重开，验收意见见 development-summary.md §6）→ R2-R4 修复＋负向回归补齐 → 终态见 ../remediation-r1-20261105/matrix-r1.md。
- **W20-10（矩阵外单列，归因未闭合）**：原「已知本机容量 flake」归因（含 §0b CMD-FULL 备注）经验收复核撤销——query.ts 逐资源估算调用为本变更新增；同机 ae506fe vs 候选 A/B：resourceUtilizationP95 候选 1133.07/1185.74ms（2/2 FAIL）vs 旧基线 877.20/747.11ms（2/2 PASS），证实本变更为贡献因素、非纯环境；发布阻断维持，解除条件＝CI/标定环境四项 P95 全过；详见 release-candidate.md §7.3＋../remediation-r1-20261105/logs/27-ab-summary.json

- 金额类 case 逐条链接：ACE-02（0.00104000 字面值＋X06 行 1/3/6/9/12）、ACE-07（X06 行 12/13）、ACE-09（0.03000000 attempts §1.1/§1.2b）、ACE-13（X06 行 3/12/14）、ACE-14（X06 行 12/10）、X03（0.03000000 字面值用例）、X06（全表）。
- X06 表（§1 26 行）一致性分布：同源/口径换算一致 9 行（含 CLOSED 冻结月白名单(c) 零改动）；差异全部可归因——白名单(b) 双权威 2 行（overview/年度页多币种保守置 null）、(a)+(b) 组合 7 行（其中 4 行为请求级域＋缺省币种标签、金额可逐行对平；3 行为资源分解组域收敛）；非金额域核对行 8 行。待裁定差异 0。 **[R1 F2 复跑 2026-11-05]**：隔离栈复跑 26 行/15 端点、待裁定 0——12 个含金额行逐字一致（金额值出现次数亦一致）；唯一实质差异＝基准 gaps PRICE_BASIS_UNVERIFIED 4→9（F3 语义：快照无 sourceStatus 键的行归 UNVERIFIED，预期内口径变化；金额/priceBasis 数组/completeness 不变）；详见 ../remediation-r1-20261105/x06-amount-reconciliation-f2-rerun.md
- 集中备注（口径说明，不降状态）：G12（runner 级 mock tick＝AT-OAB-04 "推进至下一同步时点"的执行载体口径）、G13（AT-OAB-05 矩阵层＝HTTP＋Worker，浏览器刷新 160 无真实上游，按矩阵层执行）、G17（账户识别机制不存在即天然满足 OAB-10）、G18（OAB-11 以 GW 电池＋runner 证据合成）、G21（菜单遍历以 e2e test3＋组件测试合成）、OAB-13（现有文案断言通过；"仅按已观察速率"专项句缺位列 WP5/report.md 用户签认清单）、S2A（410 优先于 closed 隐式覆盖）。

## 6. S5 全量档案（终稿依据，logs/ 均在本目录）

| 检查 | 结果 | 日志 |
|---|---|---|
| openspec strict | valid | logs/openspec-strict.log |
| domain 单测 | 411/411 | logs/domain-test.log |
| provider-adapters 单测 | 398/398 | logs/adapters-test.log |
| database 单测 | 843/845：唯二红＝W20-10 resourceUtilizationP95（四数据点 986/1018/1094/1187ms 贴阈值线震荡，路径零触碰证据见 WP5/report.md §4；WP6 发布候选复验）＋迁移容量超时（隔离复跑 1/1 过 404.9s） | logs/database-test.log＋两份 isolated-rerun 日志 |
| database 集成（最终态＝S3a-1 后零改动） | 82 文件并集 598/600（同上两容量 flake）＋定向 5 文件 29/29＋X05/estimation 总指挥复跑 14/14 | s3a1-receipt＋logs/database-w20-capacity-isolated-rerun.log 等 |
| control-api 集成（最终态） | **361/361，exit 0**（teardown 57P01 修复后；修复前 361/361 但 exit 1×15 errors） | logs/control-api-integration.log＋control-api-integration-final.log |
| gateway 集成 | **250/250，exit 0** | logs/gateway-integration.log |
| worker | **200/200，exit 0**（legacy-schema 回归修复后；修复前 199/200） | logs/worker-test.log＋worker-legacy-schema-fix-commander-rerun.log |
| web 单测（最终态） | 759/759 | s3a2-receipt |
| web e2e 矩阵 spec | **16/16**（总指挥两次复跑） | logs/e2e-wp4-spec-commander-rerun.log |
| 全量 e2e（5 spec） | 三轮 20 passed／1 failed／29 串行中止（wt-web WT-01:91＝合成上游基建缺位，环境型非产品回归，归因链见 s5-e2e-fixture-fix-receipt 第三轮）；三轮修复全部归因本 change 夹具波及（provider code 冲突/strict_writes/文案改名） | logs/e2e-full-suite{,-round2,-round3}.log |
| typecheck | database/control-api/web 全 0（web 含 R11 补提交 helper 后归零） | 各回执 |
| lint | database/control-api/web 全 exit 0（web e2e 目录 6 个 HEAD 基线 unused-var 不在 lint 脚本范围） | logs/web-lint.log、control-api-lint.log |


**R1 返修回归补充（2026-11-05，logs 均在 `../remediation-r1-20261105/logs/`；用例名级映射见 matrix-r1.md）**：R2（F1/F4）routes.test 5/5（01）＋w04 17/17（02）＋states/forecast 14/14（04）＋refresh/discovery/pool025 32/32（03）＋runner 4/4（06）；R3（F3）estimation 13/13（07）＋DB 下游 83/83（08，1 个 teardown 断连 error 为环境噪声、用例全绿）＋pool010/经营分析 24/24（05）＋CA 4/4（10）＋worker report-facts 11/11（11）＋GW 7/7（12）＋typecheck 全 0（13）＋0091 水位探针 exit 0（14）；R4（F2）domain 413/413＋GW 单测 19/19（15）＋GW 集成 7/7（16）＋DB 下游 97/97（17）＋CA 4/4（21）＋worker 4/4（22）＋lint 全 0＋X06 复跑 exit 0（18~20）；R5（W20-10 A/B）四样本（23~27）。**全量 build/回归终态复跑未在本轮执行，归 R8 总指挥复核后归档**（验收意见 6 要求的最终全量证据不在本表冒充）。