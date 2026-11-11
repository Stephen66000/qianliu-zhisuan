# R1 返修矩阵（matrix-r1）：四阻断与负向修复回归终态候选

- 日期：2026-11-05；装配：glm-flash 子 Agent（R6/F6 合同）；审定：验收人 R2 终审已完成——50 条功能矩阵全部 PASS，整体有条件通过。
- 基线：worktree `/Users/mac/Projects/仟流智算-api-decouple`（R1 装配时 HEAD `686100f`＋未提交改动；R2 终审候选 `b511ad9`）。输入＝development-summary.md §6 验收意见 1-6＋remediation-r1/plan.md §2（F1-F7）＋inv-r1.md。
- **状态口径**：主表 A-G 的 PASS 指对应负向／修复回归已执行；原五项验收条目 ACE-02、ACE-04、OAB-01、OAB-04、AFR-01 在 R1 复审终判 **PASS**；X02 在 R2 终审判 **PASS**，最新总矩阵为 **50 PASS／0 FAIL**。整体为**有条件通过**，发布条件见 development-summary.md §6.2；R1 的 49/1 与整体退回为历史结论。R2/R3 两阶段无独立回执文件，其证据以 logs/01-14 与测试文件内 F1/F3/F4 注释用例名为准（R4 有 r4-f2-receipt.md，R5 有 logs/27-ab-summary.json 汇总）。
- 图例：`logs/NN`＝本目录 `logs/`；`WP5 matrix.md`＝`../WP5-20261104/matrix.md`；X06 基准＝`../WP5-20261104/x06-amount-reconciliation.md`，复跑＝本目录 `x06-amount-reconciliation-f2-rerun.md`。

## 1. 主矩阵（行＝阻断/缺陷）

| # | 阻断/缺陷 | 对应验收条目与 spec 条款 | 修复内容（R2-R4） | 回归用例名（可执行证据） | 结果 | 证据指针 |
|---|---|---|---|---|---|---|
| A | 写旁路（客户端自报官方来源；验收意见 1 前半） | OAB-01（official-account-balance：官方余额采集与来源）、AFR-01（api-funding-retirement：资金字段退役，冒充来源可绕过资金字段守卫） | `ClientOperatingSnapshotSchema` source 收紧为字面 `ADMIN`（创建/编辑/onboarding 三入口），提交 PROVIDER_SYNC/BILL_RECONCILIATION→400；O1a 服务端注入路径保留全枚举（operating-bills/routes.ts:131 不受影响）；web `api/types.ts:289` 同步收紧 | 「拒绝客户端自报官方来源（PROVIDER_SYNC/BILL_RECONCILIATION），ADMIN 与缺省放行」「服务端内部合同（OperatingSnapshotSchema）保留全枚举，O1a 注入路径行为不变」（routes.test 5/5，logs/01）；w04「F1 负向：编辑入口提交非 ADMIN 来源（BILL_RECONCILIATION）被 400 拒绝且零落库」「F1 负向：创建入口提交 PROVIDER_SYNC 来源＋余额金额被 400 拒绝且零落库」「F1 负向：onboarding 入口提交 PROVIDER_SYNC 来源＋余额金额被 400 拒绝且零落库」（17/17，logs/02；PATCH/POST/onboard 400 服务端实录 6 笔，logs/02b） | PASS（回归已执行） | inv-r1.md §A1-A3；`apps/control-api/src/providers/contracts.ts`；WP5 matrix.md OAB-01/AFR-01 行【R1】标注 |
| B | 读侧单滤（仅筛 source，未双滤 balance_source；验收意见 1 后半"已冒充行不显示为官方"） | OAB-01＋预测链（design.md D2：读取时明确筛选 PROVIDER_SYNC 与 PROVIDER_API） | `official-balance-states.ts:98`、`provider-operating-repository.ts:75`、worker `runner.ts:71` 三处补 `balance_source='PROVIDER_API'` 双滤（冒充行 balance_source 恒 NULL，被排除出官方域/预测/恢复链） | states「F1 冒充行免疫：source=PROVIDER_SYNC 且 balance_source=NULL 的行不进入官方余额域」＋forecast「e) F1 冒充行免疫：source=PROVIDER_SYNC 且 balance_source=NULL 的行不作为预测官方来源」（states 9/9＋forecast 5/5，logs/04）；runner「F1 冒充行免疫：balance_source=NULL 的 PROVIDER_SYNC 冒充行不触发耗尽资源恢复」（4/4，logs/06） | PASS（回归已执行） | inv-r1.md §A4-A5；WP5 matrix.md OAB-01 行【R1】标注 |
| C | 缺价补零（ABSOLUTE 适用分项缺价 `?? "0"`；验收意见 2） | ACE-04（api-cost-estimation：费用完整性，未知不补零；design D1） | `computeApiCostFromRule` 返回 `string\|null`：适用分项（对应用量>0）缺价→null 不补零；MULTIPLIER 抛 `incomplete_multiplier_price` 保留；结算链 null→UNKNOWN_COST（api_cost/currency NULL、billing_rule_id/rule_version/快照含缺失价 null 仍冻结）；反事实 saving→NOT_CALCULABLE/baseline_not_comparable | domain「F2 验收场景：三项价齐 → 0.00104000；缺 hitPrice（cache>0）→ null 不补零」「F2 适用分项：缺 missPrice（miss>0）或 outputPrice（output>0）→ null」＋api-multiplier :46-51 两处补零预期重写为 null 断言（domain 413/413＝基线 411＋新增 2，r4-f2-receipt §2）；gateway「规则缺适用分项价时结算 UNKNOWN_COST，费用与币种为 NULL 但规则与快照仍冻结」＋billing-evidence it.each 新增 `baseline_not_comparable` 条目（19/19＝10+9，logs/15）；DB「c2/F2 缺适用分项价行（UNKNOWN_COST＋快照冻结缺失价）→ PRICE_MISSING、金额不含该行、不进 priceBasis」（DB 下游 97/97，logs/17） | PASS（回归已执行） | `packages/domain/src/billing-rule.ts`；r4-f2-receipt.md §1/§2/§4a/c/f；WP5 matrix.md ACE-04 行【R1】标注 |
| D | 历史依据读现值（聚合 JOIN 当前 billing_rule.source_status；验收意见 3） | ACE-02（api-cost-estimation：价格版本与依据、历史追溯） | `estimationLinesSql` 移除 LEFT JOIN billing_rule，改读 `ledger_line.billing_rule_snapshot->>'sourceStatus'`（请求时冻结值），缺键 coalesce `'UNVERIFIED'`（不引用现值冒充当时）；usage-overview 的 0091 列存在性门保留（旧水位报表合同不变） | estimation「i-a/F3 历史追溯：改 billing_rule.source_status 后重查，依据仍按快照 VERIFIED、金额逐字不变」「i-b/F3 旧行回退：快照无 sourceStatus 键 → 依据归 UNVERIFIED（不读当前规则 VERIFIED 值）」（13/13，logs/07）；DB 下游 83/83（logs/08；1 个 unhandled error＝teardown 期 postgres 断连，环境噪声，用例全绿）；pool010/经营分析 24/24（logs/05）；CA 下游 4/4（logs/10）；worker report-facts 11/11（logs/11）；GW 7/7（logs/12）；typecheck 全 0（logs/13）；0091 水位探针：0091 水位 priceBasis 缺键行归 UNVERIFIED 且 metrics.priceBasisUnverified 不出现，升 0096 后显式 true（exit 0，logs/14） | PASS（回归已执行） | `packages/database/src/repositories/api-cost-estimation.ts`；inv-r1.md §C；`scripts/f3-legacy-watermark-probe.ts`；WP5 matrix.md ACE-02 行【R1】标注 |
| E | 租约过期不收敛（RUNNING 恒判 SYNCING，未排除 expires_at≤now；验收意见 4） | OAB-04（official-account-balance：失败/过期状态与保鲜） | `SYNCING` 判定加租约未过期条件（`expires_at > now`）；过期 RUNNING 回落快照/失败/NEVER_SYNCED 正常判定；`next_refresh_at = max(attempt+P3, 租约到期)` 语义保留 | states「F4 租约过期：expires_at 已过的 RUNNING 刷新收敛为非 SYNCING；未过期仍 SYNCING」（states 9/9，logs/04；含「RUNNING refresh 行 → SYNCING；next_refresh_at = max(attempt+P3, 租约到期)」既有断言）；runner 4/4（logs/06） | PASS（回归已执行） | `packages/database/src/repositories/official-balance-states.ts`；inv-r1.md（F4 实施点）；WP5 matrix.md OAB-04 行【R1】标注 |
| F | CONFIRMED_ZERO 口径统一（R3→R4 总指挥裁定 (b)，F2 连带项，非验收意见独立条目） | ACE-04 场景 2（确认零不冒充缺口/不冒充计价） | `basis_unverified_rows` FILTER 补 `coalesce(lines.api_cost_status,'') <> 'CONFIRMED_ZERO_NO_UPSTREAM'`（零确认行恒快照 NULL、无价格依据语义），与 priced_rows 口径对齐 | estimation「d) 仅 CONFIRMED_ZERO_NO_UPSTREAM → ZERO_CONFIRMED、无缺口（ACE-04 场景 2）」＝gaps []；attempts §1.5 零费用与未知并存＝[USAGE_UNKNOWN:1]（DB 下游 97/97，logs/17；两处 R3 预期回改确认见 r4-f2-receipt §3） | PASS（回归已执行） | `packages/database/src/repositories/api-cost-estimation.ts`；r4-f2-receipt.md §3 |
| G | X06 基准差异（F2 复跑口径，R6 统一） | X06（全页和导出同源；金额链） | 无代码改动；**预期内口径变化记录**：R4 隔离栈复跑 26 行/15 端点、待裁定 0，**12 个含金额行逐字一致**（金额值出现次数亦一致：3.00104000×20、0.50000000×22、96.00000000×10、137.00104000×2、137.50104000×2、126.00000000×5、8.00000000×9）；资源分解 3 行集合相等（仅组遍历顺序不同）；唯一实质差异＝基准 gaps **PRICE_BASIS_UNVERIFIED 4→9**，归因＝D 行 F3 语义（seed 直插行/旧行快照无 sourceStatus 键→归 UNVERIFIED），即 inv-r1 风险 4 明示的"上线当期计数跳增（诚实但显著）"；与 C 行 F2 及 F 行过滤器无关（seed 无 CONFIRMED_ZERO 行，grep 实证）；priceBasis 数组（2 条 UNVERIFIED）与 completeness/amounts 不变 | X06 脚本 exit 0（seed exit 0→control-api /health 200→脚本 26 行/15 端点/待裁定 0；logs/18、19、20） | PASS（金额链不变；计数口径变化已记录并归因） | `x06-amount-reconciliation-f2-rerun.md`（对照 `../WP5-20261104/x06-amount-reconciliation.md`）；r4-f2-receipt.md §4e；WP5 matrix.md §5 X06 行【R1 F2 复跑】注 |
| H | W20-10 归因（验收意见 5；矩阵外单列，非 50 条之一） | release-candidate.md §7.3（发布阻断条件） | 三处文档归因改"尚未闭合"：撤销"纯环境/路径零触碰"定性（diff 证实 query.ts 逐资源估算调用为本变更新增）；R5 同机 ae506fe vs 候选 A/B 四样本交替（cand-s1→legacy-s1→cand-s2→legacy-s2，同底噪） | A/B 实测：resourceUtilizationP95 候选 1133.066/1185.735ms（2/2 FAIL）vs 旧基线 877.201/747.113ms（2/2 PASS，legacy-s2 全文件四项过），候选均值 +42.8%、区间无重叠→**本变更为贡献因素（非纯环境）已证实**；departmentBillP95 混合（legacy-s1 1800.78 全场最差）同机不可归因；subjectUsageP95 候选稳定 +430ms 量级（两侧均未超阈值 800）；commonAdmin 两侧同量级 | 部分闭合：**归因尚未闭合（四项完整归因待 CI/标定环境复验）；发布阻断维持**，解除条件＝CI/标定环境四项 P95 全过 | logs/23~26（四样本）＋logs/27-ab-summary.json；release-candidate.md §7.3；development-summary.md §4.5 |

## 2. 统计

- 主矩阵 **8 行**（A 写旁路、B 读侧双滤、C 缺价补零、D 历史依据、E 租约、F CONFIRMED_ZERO 口径、G X06 基准差异、H W20-10 归因）。
- 结果：**PASS（回归已执行）7 行**（A-G）；**部分闭合 1 行**（H，发布阻断维持）。
- 用例级回归累计（R2-R5）：control-api routes 5＋w04 17＋refresh/discovery/pool025 32＋CA 下游 4×2＋worker runner 4×2＋worker report-facts 11；database states 9＋forecast 5＋estimation 13＋DB 下游 83＋97＋pool010/经营分析 24；gateway 单测 19＋集成 7×2；domain 413；另有 X06 脚本复跑、0091 水位探针、A/B 四样本。合计定向回归 **约 870 用例次全绿**（精确数以各 log 为准；logs/08 有 1 个非用例性 teardown 断连 error，logs/15/16 初次误跑全套已如实留痕后定向复跑）。
- **全量 build/回归终态复跑未在本轮执行**——验收意见 6 要求的"最终全量 build/回归证据"归 R8 总指挥复核后归档，本表不冒充。

## 2b. R2 闭合记录（2026-11-05，R1 复审三类条件）

| 条件 | 闭合证据 |
|---|---|
| C1 AT-X02 | **R2 终审 PASS**：根治＝convergeExpiredLeases 判定与留痕改单条 UPDATE 内 DB `now()`；探针实测 skew +1.2~1.3s 且捕获宿主时钟阶跃；目标文件三连 8/8＋全量上下文批 44/44＋db 批 12/12，验收人另独立复跑 AT-X02 4/4、HTTP 8/8、DB 7/7。新增 2 秒用例在当前约 1.27s 偏移下旧实现也会通过，不能称为独立负向证据；发布前须改为受控偏移、可证明旧实现失败的回归（development-summary.md §6.2）。 |
| C2 干净复跑 | database 单测 245/245＋集成 a1-a7 610/610 全批 exit 0（4 文件 afterAll 排空加固，WP5 先例；a1/a2 首跑 57P01 记录于复跑日志头）；容量 2 文件：W20-10 红（resourceUtilization 1540.44>1000，指标轮换震荡如实）、usage-aggregate-capacity 同一容量批 368.96s 通过（边界状态）；gateway 31 文件全量一次 250/250 exit 0（r2-20，拼接证据替换）；根 build exit 0（r2-23，Node 引擎警告归档） |
| C3 证据绑定 | .gitignore 加 `!V4/Evidence/**/*.log` 例外；R1 全部 31 份＋R2 全部日志随候选 SHA 入库；R1 report 提交链更正（7ceb97e 系 amend 被替换，实际链 686100f→ea45c4f→0899f04→b56c31a→R2 提交）；过时表述清理＝usage-overview-repository 两处"规则现值"注释按 F3 语义更正、WP1 合同 §1 priceBasis 行更新 |

数字对照（验收人 611/613、1029.86ms）：R2-2 实测全库集成 612/613（usage-aggregate-capacity 本轮通过故较 R1 +1）；W20-10 R1 轮 subjectUsage 1029.86、R2 轮 resourceUtilization 1540.44——同用例不同指标轮换触发，两轮数值均如实入档。

## 3. 附注一：受影响验收条目处置表（四阻断映射）

| 条目 | 退回依据（验收意见） | 修复 | 负向/修复回归是否实际执行 | 处置 |
|---|---|---|---|---|
| ACE-02（价格调整历史依据） | 意见 3（D 行） | F3（R3） | 是：i-a/i-b＋0091 探针（logs/07、14） | 修复回归已执行；**R1 复审 PASS（2026-11-05）** |
| ACE-04（部分缺价） | 意见 2（C 行） | F2（R4） | 是：domain F2 两例＋gateway 结算例＋DB c2 例（logs/15、17） | 修复回归已执行；**R1 复审 PASS（2026-11-05）** |
| OAB-01（官方来源） | 意见 1（A/B 行） | F1（R2） | 是：w04 F1 负向×3（logs/02、02b）＋states 冒充行免疫（logs/04） | 修复回归已执行；**R1 复审 PASS（2026-11-05）** |
| OAB-04（失败保鲜/租约） | 意见 4（E 行） | F4（R2） | 是：states F4 租约过期例（logs/04） | 修复回归已执行；**R1 复审 PASS（2026-11-05）** |
| AFR-01（资金退役写入面） | 意见 1（A 行加重情节：冒充来源绕过资金字段守卫） | F1（R2） | 是：同 OAB-01 的 w04 F1 负向三条（提交来源＋余额金额→400 零落库） | 修复回归已执行；**R1 复审 PASS（2026-11-05）** |

复审处置：以上五条已由验收人依据独立代码审查与负向回归复跑改判 **PASS**。读侧双滤连带惠及 OAB-02/13/14 相关路径（forecast 冒充行免疫例，logs/04），这些条目维持 WP5 matrix.md 原判。X02 为 R1 复审新重开项，不属上述五条，整体结论见 development-summary.md §6.1。

## 4. 附注二：截图盘点（R6，2026-11-05）

**盘点范围**：`../WP5-20261104/screenshots/`（11 png）＋`../WP4-20261104/screenshots/`（9 png＋1 txt）。

**判定规则**（按合同"空白（0 字节或 <5KB 占位）与修复前陈旧版本"）：(i) 空白＝图像文件 <5KB；(ii) 修复前＝所摄页面渲染后被走查修复 D-1（`715e5d0` 11-04 21:52：RequestDrilldown 精确金额＋单价）/D-2（`da36ac4` 22:31：资源表余额组成行）/D-3+D-4（`68d2227` 22:51：资金面板标签＋用量总览免责句）更改，而文件摄于 11-04 17:23（修复前统一时点，md5/mtime 实测）；(iii) 重复＝多文件 md5 相同但指称不同内容。

**WP5 在用保留 3 张**（页面未被上述修复更改，指称内容可见）：

| 文件 | 大小(B) | 理由 |
|---|---|---|
| wp5-bill-draft-partial-pricing.png | 283,097 | 经营账单 DRAFT 页：PRICE_MISSING:1/CURRENCY_MISSING＋警示横幅可见；该页未被 D-1~D-4 更改 |
| wp5-supply-forecast-not-calculable.png | 82,774 | 供给与健康 tab 供给预测表；D-4 免责句落在用量总览面板（ResourceUsageOverviewPanel），非此 tab |
| wp5-quota-window-forecast-legend.png | 232,224 | 额度窗口 tab＋图例；未被 D-1~D-4 更改 |

**移入 `../WP5-20261104/screenshots/superseded/` 8 张**（未删除；WP5 matrix.md 相应 SHOTS 指针已同步改为 superseded 路径＋替代证据）：

| 文件 | 大小(B) | 异常类型 | 依据与替代证据 |
|---|---|---|---|
| wp5-official-balance-expired.png | **769** | 空白占位 | 目检为纯灰条；替代＝WP4 wp4-resources-official-balance-full.png（"数据过期"行 ¥40.00 保鲜标记）＋E2E test12 断言 |
| wp5-drilldown-f01.png | 312,498 | 修复前（D-1） | 展示 D-1 修复前"0.00＋单价——"旧渲染；替代＝D-1 修复后组件测试（RequestDrilldown.test.tsx，web 759/759 终态）＋E2E test8＋E2E-LOG |
| wp5-breakdown-price-basis-badge.png | 226,176 | 修复前（D-4 面板） | 所摄用量总览面板缺 D-4 免责句行；角标证据＝E2E test9/test15＋X06 §3 |
| wp5-official-balance-same-account-pair.png | 296,301 | 修复前（D-2） | 资源列表余额单元格无组成行；替代＝WP4 wp4-resources-official-balance-full.png（同账户 A/B 两行各 ¥100.00、无 ¥200 合计） |
| wp5-resources-expired-full.png | 413,496 | 修复前（D-2） | 同上页修复前版本；替代＝WP4 wp4-resources-official-balance-full.png |
| wp5-official-balance-never-success.png | 17,946 | 修复前（D-2 页面裁切） | 替代＝WP4 wp4-resources-official-balance-full.png（"从未成功"行 暂无官方数据） |
| wp5-usage-unknown-cost-rows.png | 246,377 | 重复（iii） | 与 wp4-usage-estimation-column.png、wp5-usage-unsupported-tokens.png 三文件 md5 相同（`da4720b52e18d7d8122902eb617a3989`，同一 11-04 17:23 捕获）；可见裁切未含金额列；行级金额证据＝X06 行 12＋E2E test10＋E2E-LOG |
| wp5-usage-unsupported-tokens.png | 246,377 | 重复（iii） | 同上；Token/估算统计证据＝E2E test11＋E2E-LOG |

**WP4 全部 10 件保留**（摄于 2026-11-05 01:07，晚于全部 D 修复）：bill-closed-banner 195,643／bill-draft-current-month 284,726／official-balance-failed 27,855／official-balance-ok 23,972／official-balance-unsupported 17,908／plan-subscription-panel 131,055／refresh-credential-missing 438,774／resources-official-balance-full 433,675／usage-estimation-column 246,377／usage-export-csv-headers.txt 874。其中 wp4-resources-official-balance-full.png 为 D-2 修复后全页（含"赠送＋充值"组成行），充当上表多张的替代证据；usage-export-csv-headers.txt 为 HTTP 200＋CSV 表头＋3 行正文抓取文本（非空白占位），保留；usage-estimation-column.png 为三重复文件中留档的一份，其可见裁切仅含请求列表左侧列，金额列证据以 CSV txt＋E2E test7/test10 为准（该口径已记入本附注，供验收人复核）。

**R1 返修后未重摄说明**：R2-R4 修复均无新增浏览器截图（证据为日志/断言），WP5 保留 3 张中不涉及受影响条目页面；如验收人需要修复后 UI 复核，属验收复审动作，不在本装配范围内伪造。

## 5. 附注三：既有演练证据的采信口径

按验收意见 6：X05、X06 已复跑（X06 复跑见本文件 G 行），X07/X08 隔离演练证据可采信，但**不能覆盖** A-H 所列旁路与口径缺陷；X07/X08 的 WP6 补齐判定在 WP5 matrix.md 中降为沿革口径，其"全条 PASS"终态同样待验收人复审确认。

## 6. 附注四：剩余问题（截至本装配时点）

1. 全量 build/回归终态复跑未执行（归 R8）。
2. R2/R3 无独立回执文件（证据以 logs＋测试文件用例注释承载，见本文件状态口径）。
3. W20-10 四项完整归因待 CI/标定环境复验；发布阻断维持。
4. F2 补零历史旧行仍为 PRICED_USAGE（AFR-06 不重算；读侧识别口径在 inv-r1 B5 记录、本轮不实施，r4-f2-receipt §5-2）。
5. development-summary.md 首部"状态总口径"行与 §1"50 条验收场景全部 PASS"为结包时点叙事，与 §4.1/§5.1 返修后口径的最终一致性由 R8 总指挥统一复核（本装配仅按合同改 §4.1/§4.2/§4.3/§5.1/§5.2）。
6. 整库备份恢复演练（F7/R7）证据尚未入档（development-summary §5.2 已列为发布前置第四项）。
