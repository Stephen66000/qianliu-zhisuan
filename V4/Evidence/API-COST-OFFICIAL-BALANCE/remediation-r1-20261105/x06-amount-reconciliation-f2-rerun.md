# AT-X06 金额核对表（WP5 S3b · 一次性只读脚本产出）

- 生成时间：2026-11-05T06:03:19.193Z（本地运行，零消息发送）
- 基准：`loadApiCostEstimation`（WP1 合同 §5 唯一基准），全企业（仟流 M5 E2E 企业 / `00000000-0000-4000-8000-000000000001`）
- 期间：当月 DRAFT 上海月界 `2026-11`＝[2026-10-31T16:00:00.000Z, 2026-11-30T16:00:00.000Z)
- 库：`qianliu_e2e`（127.0.0.1:55432，seed 安全门校验通过）；HTTP 基址：`http://127.0.0.1:8899`（control-api，指向同一 `qianliu_e2e` 库）
- 端点清单：GET /dashboard；GET /dashboard/home；GET /usage/overview?subject_type=EMPLOYEE&period=MONTH；GET /usage?limit=500；GET /usage/export；GET /operating-bills；GET /operating-bills/<month>；GET /operating-bills/2026-10；GET /operating-bills/<month>/analysis；GET /operating-bills/<month>/department-accounts；GET /operating-bills/<month>/departments；GET /operating-bills/<month>/project-allocation-status；GET /operating-bills/<month>/project-unallocated；GET /operating-bills/<month>/projects/00000000-0000-4000-8000-000000000140/allocation-lines；GET /provider-resources/usage-overview（另 POST /auth/login 取会话）
- 只读核对查询：无币种已计价账本行：有事务行＝窗口内 126.00000000（3 行）／窗口外 8.00000000（2 行）；无事务行（请求级读取方经空金额行呈现）＝8.00000000（2 行）（窗口内）＋0.00000000（0 行）（窗口外）（SELECT-only 构成核对）

## 1. 核对表

判定口径：**一致**＝金额逐字相等或差异恰可归因 WP1 §5 白名单 (a) 筛选范围/期间、(b) 缺口与完整性说明双权威、(c) 桥接字段历史值；「核对行」＝非金额域或构成差异已逐行解释；不能归因的金额差异列入 §2 待裁定差异。

| # | 读取方 | 端点 | 期间/范围 | 币种/维度 | 读取值 | 基准参照 | 与基准一致性 | 归因 |
|---|---|---|---|---|---|---|---|---|
| 1 | 首页 dashboard 汇总 | GET /dashboard | 当月（上海）2026-11 全企业 | 多币种分列 | CNY 3.00104000 ＋ USD 0.50000000 | 基准 amounts＝CNY 3.00104000 ＋ USD 0.50000000 | 一致 | 同源（loadApiCostEstimation，首页 S3a 改造） |
| 2 | 首页 dashboard 汇总 | GET /dashboard | 同上 | 完整性说明 | monthlyApiSpendReason＝"币种不一致：CNY、USD" | 基准 completeness＝KNOWN_PARTIAL，gaps＝PRICE_MISSING:1、CURRENCY_MISSING:5、PRICE_BASIS_UNVERIFIED:9 | 一致（说明形态不同属白名单(b) 双权威） | 白名单(b)：首页以 reason 文案透出缺口（apiEstimationGapText 剔除 PRICE_BASIS_UNVERIFIED 信息项；混币月份标量 monthlyApiCost=null） |
| 3 | 标准版首页（dashboard/home） | GET /dashboard/home | 当月 2026-11 全企业（账单快照） | 多币种分列 | apiSpends＝CNY 3.00104000 ＋ USD 0.50000000；totalSpends＝CNY 3.00104000 ＋ USD 0.50000000 | 基准 amounts＝CNY 3.00104000 ＋ USD 0.50000000 | 一致 | 同源（账单 getBill → loadApiCostEstimation）＋套餐 0 合成 totalSpends |
| 4 | 用量总览 v2 | GET /usage/overview?subject_type=EMPLOYEE&period=MONTH | 2026-10-31T16:00:00.000Z ~ 2026-11-30T16:00:00.000Z（企业时区=Asia/Shanghai）全主体 | 单一标量 | apiCost＝null；apiCostStatus＝UNKNOWN_COST | 基准 amounts＝CNY 3.00104000 ＋ USD 0.50000000（CNY＋USD 分列）、completeness＝KNOWN_PARTIAL | 差异 | 白名单(b)＋(a)：窗口含 UNKNOWN 事务行 → 聚合拒绝出数（不把已计价部分冒充完整总额）；聚合域为 ledger_transaction（请求级、created_at 窗口），与账本行级 settled_at 窗口基准不直接可比 |
| 5 | 用量总览 v2（角标） | GET /usage/overview | 同上 | 信息项 | priceBasisUnverified＝true | 基准 gaps 含 PRICE_BASIS_UNVERIFIED:9 | 一致 | 判定源同源（loadApiCostEstimation().priceBasis 任一 UNVERIFIED，S2B R7） |
| 6 | 用量明细列表（行级求和·CNY 标签） | GET /usage?limit=500 | 同上 | CNY | 137.00104000（7 行） | 基准 CNY 3.00104000＋无币种缺口行 126.00000000（3 行）（窗口内）＋8.00000000（2 行）（窗口外） | 差异 | 白名单(b)＋(a)：无币种已计价行在读取方缺省显示 CNY（usage-repository.ts:339 展示语义），合计与基准＋有事务行缺口行（请求级读取方可承载的账本行）逐字对平；请求级 ledger_transaction 汇总（请求 030 的 45＋80 两行合并为 125.00000000）、默认全量期间（窗口外 pool043 8 月行 3.2＋4.8 计入）、无事务行缺口行（pool042 8.00）经空金额行呈现而非金额——可逐行核对，非异源算法差异 |
| 7 | 用量明细列表（行级求和·USD） | GET /usage?limit=500 | 默认全量期间（无窗口过滤），8 个带金额请求行 | USD | 0.50000000（1 行：0.5） | 基准 USD 0.50000000 | 一致 | USD 已计价行金额与基准逐字相等 |
| 8 | 用量明细列表（空金额行） | GET /usage?limit=500 | 同上 | — | 空金额请求行＝3（…0352＝（空）/（无标签）；…0215＝（空）/（无标签）；…0214＝（空）/（无标签）；带金额行：…0050＝1.00000000/CNY/FAILED；…0030＝125.00000000/CNY；…0347＝2/CNY；…0342＝1/CNY；…0323＝0.5/USD；…0318＝0.00104/CNY；…0151＝4.8/CNY；…0150＝3.2/CNY） | 基准 gaps：PRICE_MISSING:1（账本行级 UNKNOWN）；pool042 两请求仅有账本行、无 ledger_transaction（请求级读取方不含其行级金额） | 核对行（构成差异可解释） | 白名单(a)＋(b)：请求级读取方与账本行级基准的域/期间口径差异＋完整性说明（请求域金额不可见≠账本行金额丢失，账单/基准仍承载缺口计数） |
| 9 | 用量 CSV 导出（行级求和·CNY 列） | GET /usage/export | 同上 | CNY | 137.00104000（…0050＝1.00000000；…0030＝125.00000000；…0347＝2；…0342＝1；…0318＝0.00104；…0151＝4.8；…0150＝3.2） | 基准 CNY 3.00104000＋无币种缺口行 126.00000000（3 行）＋8.00000000（2 行） | 差异 | 白名单(b)＋(a)：CSV 币种列对无币种已计价行缺省显示 CNY（usage/routes.ts export `costCurrency ?? "CNY"` 展示语义），列合计与基准＋有事务行缺口行逐字对平；导出无窗口过滤（含窗口外 pool043 8 月行 3.2＋4.8）、无事务行缺口行（pool042 8.00）留空呈现——可逐行核对，非异源算法差异 |
| 10 | 用量 CSV 导出（行级求和·USD） | GET /usage/export | 导出时点全量（limit=5000，11 数据行） | USD | 0.50000000（…0323＝0.5） | 基准 USD 0.50000000 | 一致 | USD 行金额与基准逐字相等 |
| 11 | 用量 CSV 导出（表头/空金额行） | GET /usage/export | CSV 文本 | — | 表头含「API费用估算」＝true；空金额行＝3（…0352、…0215、…0214） | 基准 gaps：PRICE_MISSING:1（行级 UNKNOWN）；pool042 两请求请求级无 transaction | 核对行（构成差异可解释） | 白名单(a)＋(b)：缺口行留空不冒充 0；其余空行同为请求级域口径差异（见 /usage 空金额行） |
| 12 | 经营账单（DRAFT 当月） | GET /operating-bills/2026-11 | 2026-11 上海月界 全企业 | 多币种分列 | apiSpends＝CNY 3.00104000 ＋ USD 0.50000000；totalSpends＝CNY 3.00104000 ＋ USD 0.50000000；apiCost＝null | 基准 amounts＝CNY 3.00104000 ＋ USD 0.50000000 | 一致 | 同源（operating-bill-draft → loadApiCostEstimation）；apiCost=null＝混币不合并（ACE-07） |
| 13 | 经营账单（完整性说明） | GET /operating-bills/2026-11 | 同上 | 完整性说明 | apiSpendStatus＝INCOMPLETE；apiSpendReason＝"PRICE_MISSING:1、CURRENCY_MISSING:5" | 基准 completeness＝KNOWN_PARTIAL，gaps＝PRICE_MISSING:1、CURRENCY_MISSING:5、PRICE_BASIS_UNVERIFIED:9 | 一致（口径换算：PRICE_MISSING:1＋CURRENCY_MISSING:5，信息项 PRICE_BASIS_UNVERIFIED 不入 reason） | 白名单(b)：双权威文案映射 |
| 14 | 经营账单（CLOSED 上月·历史） | GET /operating-bills/2026-10 | 2026-10 冻结版本 v1 | 多币种分列 | apiSpends＝CNY 96.00000000；apiCost＝"96.00000000"；桥接 opening/recharge/ending＝1000.00000000/100.00000000/1004.00000000 | seed 冻结快照常量：apiSpends=[CNY 96.00000000]、apiCost=96.00000000、1000/100/1004（桥接历史值） | 一致（历史快照零改动） | 白名单(c)：桥接字段历史值＋AFR-11 冻结快照；旧口径 96 是余额桥接历史金额，不得改写也不得填入当期估算 |
| 15 | 年度统计（DeepSeek×CNY） | GET /operating-bills/2026-11/analysis | 列 2026-11 | CNY | apiSpend＝null；apiSpendComplete＝false；recharge＝100.00、paidCny＝100.00 | 该厂商域（DeepSeek WP4 资源）基准＝CNY 3.00104000＋USD 0.50000000（多币种） | 差异 | 白名单(b)：WP1 合同 §6 已知边界——多币种月份所有 (provider,币种) 行 apiSpend 保守置 null＋false（不按行拆币种金额、不混加），按币种金额由账单 apiSpends 承载（本表第 12 行一致）；recharge/paidCny 为白名单(c) 资金域轨迹字段原样透出 |
| 16 | 年度统计（DeepSeek×USD） | GET /operating-bills/2026-11/analysis | 列 2026-11 | USD | apiSpend＝null；apiSpendComplete＝false；recharge＝0.00、paidCny＝0.00 | 该厂商域（DeepSeek WP4 资源）基准＝CNY 3.00104000＋USD 0.50000000（多币种） | 差异 | 白名单(b)：WP1 合同 §6 已知边界——多币种月份所有 (provider,币种) 行 apiSpend 保守置 null＋false（不按行拆币种金额、不混加），按币种金额由账单 apiSpends 承载（本表第 12 行一致）；recharge/paidCny 为白名单(c) 资金域轨迹字段原样透出 |
| 17 | 年度统计（覆盖范围） | GET /operating-bills/2026-11/analysis | apiAccounts 覆盖＝DeepSeek/CNY、DeepSeek/USD | — | — | 基准为全企业（含 zhipu 45/1/80、pool042 3.2/4.8 无币种行） | 核对行（范围差异） | 白名单(a)：年度页 apiAccounts 仅覆盖资金域 views 内资源（观察：本期仅 DeepSeek WP4 E2E 出现行；zhipu/pool042 资源的当月账本行不在 apiAccounts 任何行中——S3c 注释的 views 覆盖保证对这些资源未生效，机制未逐行核实，已列入回执未决问题） |
| 18 | 部门账户汇总 | GET /operating-bills/2026-11/department-accounts | 2026-11 全部门（line_facts 聚合） | 标量 | apiCost＝null；knownApiCost＝"137.50104000"；DeepSeek＝knownApiCost 3.50104000；pool042-deepseek＝knownApiCost 8.00000000；zhipu＝knownApiCost 126.00000000 | 基准 amounts＝CNY 3.00104000 ＋ USD 0.50000000＋窗口内无币种缺口行 126.00000000（3 行）＋8.00000000（2 行）＝137.50104000 | 差异 | 白名单(b)＋(a)：聚合含 api_cost IS NULL 行 → apiCost 拒绝出数（不冒充完整总额）；knownApiCost＝已知部分直加（跨币种直加为投影层既有口径，S2B §3 残留观察；仅计窗口内行 3.00104＋0.5＋134＝137.50104，与基准＋窗口内全部缺口行（含无事务行）逐字对平） |
| 19 | 部门账单（draft） | GET /operating-bills/2026-11/departments | 2026-11 全部门 | 行级/汇总 | rows＝2；totals＝{"inputTokens":"3970","outputTokens":"835","actualTokens":"4805","apiCost":null,"packageCost":"0.00000000","totalCost":null,"requestCount":7}；待归属行 apiCost＝null、reasonCodes＝["ATTRIBUTION_SNAPSHOT_MISSING","DEPARTMENT_UNASSIGNED","API_COST_UNKNOWN"] | 部门域为分摊域读取方：本期行均无归属快照（attributionSnapshotMissingCount=7）→ 金额落待归属行且 apiCost=null（含 UNKNOWN 行拒绝出数） | 核对行（完整性说明） | 白名单(b)：DEPARTMENT_UNASSIGNED/ATTRIBUTION_SNAPSHOT_MISSING/API_COST_UNKNOWN 以缺口码说明而非金额冒充 |
| 20 | 项目分摊状态 | GET /operating-bills/2026-11/project-allocation-status | 2026-11 | — | {"month":"2026-11","enabled":false,"currentRun":null,"lastError":null,"latestRun":null} | — | 核对行 | 项目域读取方（当月夹具无分摊批次，enabled=false 属预期） |
| 21 | 项目未分摊 | GET /operating-bills/2026-11/project-unallocated | 2026-11 | — | tokens＝"0"；apiCostByCurrency＝{}；lineCount＝0 | — | 核对行 | 分摊域（当月未启用分摊 → 空集；apiCostByCurrency 按币种分列的键结构本身即不混加口径） |
| 22 | 项目明细（…0140 星河） | GET /operating-bills/2026-11/projects/00000000-0000-4000-8000-000000000140/allocation-lines | 2026-11 该项目 | — | lines＝0 | — | 核对行 | pool043 项目当月无分摊行（夹具用量在 2026-08），空集属预期 |
| 23 | 资源分解（DeepSeek API 组） | GET /provider-resources/usage-overview | 当月（上海）该组资源 | 组级标量 | monthlyCost＝null；reason＝"币种不一致：CNY、USD"；priceBasisUnverified＝true | 组域＝该 (provider,mode) 组内资源的同源估算（小于全企业） | 差异 | 白名单(a)＋(b)：组范围小于全企业（筛选范围不同）＋缺口/混币以 reason 说明（币种不一致：CNY、USD ／ CURRENCY_MISSING:n），priceBasisUnverified 判定源同源；组内金额可由账单 apiSpends（第 12 行）与组域行级数值核对 |
| 24 | 资源分解（pool042-deepseek API 组） | GET /provider-resources/usage-overview | 当月（上海）该组资源 | 组级标量 | monthlyCost＝null；reason＝"CURRENCY_MISSING:2"；priceBasisUnverified＝false | 组域＝该 (provider,mode) 组内资源的同源估算（小于全企业） | 差异 | 白名单(a)＋(b)：组范围小于全企业（筛选范围不同）＋缺口/混币以 reason 说明（币种不一致：CNY、USD ／ CURRENCY_MISSING:n），priceBasisUnverified 判定源同源；组内金额可由账单 apiSpends（第 12 行）与组域行级数值核对 |
| 25 | 资源分解（pool043-deepseek API 组） | GET /provider-resources/usage-overview | 当月（上海）该组资源 | 组级标量 | monthlyCost＝"0.00000000"；reason＝null；priceBasisUnverified＝false | 组域＝该 (provider,mode) 组内资源的同源估算（小于全企业） | 核对行 | 组域当月窗口外（pool043 8 月行）→ 月窗金额为精确 0，期间差异属白名单(a) |
| 26 | 资源分解（zhipu API 组） | GET /provider-resources/usage-overview | 当月（上海）该组资源 | 组级标量 | monthlyCost＝null；reason＝"CURRENCY_MISSING:3"；priceBasisUnverified＝true | 组域＝该 (provider,mode) 组内资源的同源估算（小于全企业） | 差异 | 白名单(a)＋(b)：组范围小于全企业（筛选范围不同）＋缺口/混币以 reason 说明（币种不一致：CNY、USD ／ CURRENCY_MISSING:n），priceBasisUnverified 判定源同源；组内金额可由账单 apiSpends（第 12 行）与组域行级数值核对 |

## 2. 待裁定差异清单（金额不一致且不能归因白名单）

（无——全部读取方的金额差异均归因白名单 (a)/(b)/(c)，或在表中标注为同源一致/核对行。）

## 3. 基准 JSON 全文（loadApiCostEstimation 输出）

```json
{
  "scope": {
    "enterpriseId": "00000000-0000-4000-8000-000000000001",
    "resourceIds": null
  },
  "period": {
    "start": "2026-10-31T16:00:00.000Z",
    "end": "2026-11-30T16:00:00.000Z"
  },
  "amounts": [
    {
      "currency": "CNY",
      "amount": "3.00104000"
    },
    {
      "currency": "USD",
      "amount": "0.50000000"
    }
  ],
  "completeness": "KNOWN_PARTIAL",
  "gaps": [
    {
      "reason": "PRICE_MISSING",
      "count": 1
    },
    {
      "reason": "CURRENCY_MISSING",
      "count": 5
    },
    {
      "reason": "PRICE_BASIS_UNVERIFIED",
      "count": 9
    }
  ],
  "priceBasis": [
    {
      "ruleId": "00000000-0000-4000-8000-000000000037",
      "ruleVersion": "e2e-v1",
      "sourceStatus": "UNVERIFIED"
    },
    {
      "ruleId": "00000000-0000-4000-8000-000000000317",
      "ruleVersion": "wp4-e2e-f01",
      "sourceStatus": "UNVERIFIED"
    }
  ],
  "excludedNoRecordedCost": 0
}
```

## 4. 各端点原始响应摘要

### 200 /dashboard

```
{
 "resourceAccountCount": 10,
 "activeEmployeeCount": 1,
 "currentInUseCount": 1,
 "monthlyPackagePayment": null,
 "monthlyPackagePayments": [],
 "monthlyApiCost": null,
 "monthlyApiCosts": [
  {
   "currency": "CNY",
   "amount": "3.00104000"
  },
  {
   "currency": "USD",
   "amount": "0.50000000"
  }
 ],
 "monthlyApiSpendReason": "币种不一致：CNY、USD",
 "monthlyTotalSpend": null,
 "monthlyTotalSpends": [],
 "monthlyRechargeAmount": null,
 "monthlyRechargeAmounts": [
  {
   "currency": "CNY",
   "amount": "100.00000000"
  }
 ],
 "earliestExhaustion": {
  "resourceId": "00000000-0000-4000-8000-000000000011",
  "resourceName": "E2E 智谱主资源",
  "providerCode": "zhipu",
  "forecastExhaustAt": "2026-11-05T18:02:47.247Z",
  "nextRecoverAt": "2026-11-08T06:02:47.247Z",
  "confidence": "HIGH",
  "notCalculableReason": null
 },
 "monthlyDispatchSaving": "0",
 "dispatchSavingBreakdown": {
  "realizedAmount": "0.00000000",
  "realizedSwitchCount": 0,
  "actualSwitchCount": 0,
  "realizedReason": "本月无可计算的实际切换",
  "potentialPeakSavingAmount": null,
  "potentialReason": "缺少同一任务的峰值/低谷等价执行关联，暂不估算金额",
  "avoidedPeakDeduction": "0",
  "avoidedDeductionCount": 0,
  "avoidedReason": "本月无具备双端倍率快照的已执行切换",
  "rejectedRequestCount": 0
 },
 "resourceStatus": {
  "total": 10,
  "status": "CREDENTIAL_INVALID",
  "statusCounts": {
   "ACTIVE": 9,
   "CREDENTIAL_INVALID": 1
  },
  "abnormalResources": [
   {
    "resourceId": "00000000-0000-4000-8000-000000000012",
    "resourceName": "E2E 待恢复资源",
    "provid
…（截断，共 18257 字符）
```

### 200 /dashboard/home

```
{
 "asOf": "2026-11-05T06:03:19.647Z",
 "month": "2026-11",
 "tokenUsage": {
  "rangeStart": "2026-10-31T16:00:00.000Z",
  "rangeEndExclusive": "2026-11-30T16:00:00.000Z",
  "current": {
   "totalTokens": "4780",
   "inputTokens": "3950",
   "outputTokens": "830",
   "usageQuality": "EXACT",
   "unknownCount": 0
  },
  "previous": {
   "totalTokens": "0",
   "usageQuality": "EXACT",
   "unknownCount": 0,
   "window": {
    "rangeStart": "2026-09-30T16:00:00.000Z",
    "rangeEndExclusive": "2026-10-05T06:03:19.647Z",
    "truncated": false
   }
  }
 },
 "monthlyCost": {
  "month": "2026-11",
  "billStatus": "DRAFT",
  "mtdComparison": {
   "basis": "FINANCE_READ_MODEL",
   "current": {
    "totalSpends": [
     {
      "currency": "CNY",
      "amount": "3.00104000"
     },
     {
      "currency": "USD",
      "amount": "0.50000000"
     }
    ],
    "incompleteReason": "API_USAGE_COST_UNKNOWN:6、API_COST_CURRENCY_MISSING:5",
    "window": {
     "rangeStart": "2026-10-31T16:00:00.000Z",
     "rangeEndExclusive": "2026-11-05T06:03:19.647Z",
     "truncated": false
    }
   },
   "previous": {
    "totalSpends": [],
    "incompleteReason": null,
    "window": {
     "rangeStart": "2026-09-30T16:00:00.000Z",
     "rangeEndExclusive": "2026-10-05T06:03:19.647Z",
     "truncated": false
    }
   }
  },
  "current": {
   "totalSpends": [
    {
     "currency": "CNY",
     "amount": "3.00104000"
    },
    {
     "currency": "USD",
     "amount": "0.50000000"
    }
   ],
   "apiSpen
…（截断，共 4653 字符）
```

### 200 /usage/overview?subject_type=EMPLOYEE&period=MONTH

```
{
 "subjectType": "EMPLOYEE",
 "subjectId": null,
 "period": "MONTH",
 "anchor": "2026-11-05T06:03:20.172Z",
 "timezone": "Asia/Shanghai",
 "range": {
  "from": "2026-10-31T16:00:00.000Z",
  "to": "2026-11-30T16:00:00.000Z"
 },
 "metrics": {
  "activeSubjects": 1,
  "requestCount": "6",
  "inputTokens": "3600",
  "outputTokens": "750",
  "cacheTokens": "420",
  "reasoningTokens": "0",
  "realTokens": "4350",
  "apiCost": null,
  "apiCostStatus": "UNKNOWN_COST",
  "deductedQuota": "320",
  "usageQuality": "PROVIDER_REPORTED",
  "providerReportedCount": 6,
  "estimatedCount": 0,
  "accountAggregatedCount": 0,
  "mixedCount": 0,
  "unknownCount": 0,
  "priceBasisUnverified": true
 },
 "trend": [
  {
   "bucketStart": "2026-10-31T16:00:00.000Z",
   "bucketEnd": "2026-11-01T16:00:00.000Z",
   "label": "11-01",
   "collectionStatus": "MISSING",
   "requestCount": "0",
   "inputTokens": "0",
   "outputTokens": "0",
   "cacheTokens": "0",
   "reasoningTokens": "0",
   "realTokens": "0",
   "apiCost": "0",
   "apiCostStatus": "CONFIRMED_ZERO_NO_UPSTREAM",
   "deductedQuota": "0",
   "usageQuality": "NO_DATA",
   "providerReportedCount": 0,
   "estimatedCount": 0,
   "accountAggregatedCount": 0,
   "mixedCount": 0,
   "unknownCount": 0
  },
  {
   "bucketStart": "2026-11-01T16:00:00.000Z",
   "bucketEnd": "2026-11-02T16:00:00.000Z",
   "label": "11-02",
   "collectionStatus": "MISSING",
   "requestCount": "0",
   "inputTokens": "0",
   "outputTokens": "0",
   "cacheTokens": "0",
   "re
…（截断，共 18156 字符）
```

### 200 /usage?limit=500

```
{
 "records": [
  {
   "requestId": "00000000-0000-4000-8000-000000000050",
   "principalId": "00000000-0000-4000-8000-000000000020",
   "principalName": "E2E 固定员工",
   "principalType": "EMPLOYEE",
   "clientId": "m5-playwright",
   "agentFamily": "UNKNOWN",
   "agentVersion": null,
   "agentIdentitySource": "NONE",
   "agentIdentityConfidence": "UNKNOWN",
   "clientIdentityRuleVersion": "legacy",
   "unifiedModel": "qianliu-glm",
   "status": "FAILED",
   "errorClassification": "STREAM_INTERRUPTED",
   "errorCode": "UPSTREAM_STREAM_CLOSED",
   "startedAt": "2026-11-05T06:02:52.247Z",
   "finishedAt": "2026-11-05T06:02:53.247Z",
   "durationMs": 1000,
   "finalProviderId": "00000000-0000-4000-8000-000000000010",
   "finalProviderCode": "zhipu",
   "finalProviderName": "智谱 E2E",
   "finalProviderResourceId": "00000000-0000-4000-8000-000000000011",
   "finalProviderResourceName": "E2E 智谱主资源",
   "costCurrency": "CNY",
   "overage": false,
   "totalInputTokens": "20",
   "totalOutputTokens": "5",
   "totalCacheTokens": "0",
   "totalReasoningTokens": "0",
   "totalDeductedQuota": "25",
   "totalApiCost": "1.00000000",
   "costStatus": "PRICED_USAGE",
   "costNotMigrated": false,
   "usageQuality": "PROVIDER_REPORTED",
   "attemptCount": 1,
   "hasSettlement": true
  },
  {
   "requestId": "00000000-0000-4000-8000-000000000030",
   "principalId": "00000000-0000-4000-8000-000000000020",
   "principalName": "E2E 固定员工",
   "principalType": "EMPLOYEE",
   "clientId": "m5-playwright",
…（截断，共 13837 字符）
```

### 200 /usage/export

```
{
 "_unparsed": "请求ID,发起主体,主体类型,Agent/工具,统一模型,最终厂商,最终资源,输入Token,输出Token,缓存Token,扣减额度,API费用估算,币种,状态,开始时间,耗时(毫秒)\r\n00000000-0000-4000-8000-000000000050,E2E 固定员工,EMPLOYEE,UNKNOWN,qianliu-glm,智谱 E2E,E2E 智谱主资源,20,5,0,25,1.00000000,CNY,FAILED,2026-11-05T06:02:52.247Z,1000\r\n00000000-0000-4000-8000-000000000030,E2E 固定员工,EMPLOYEE,UNKNOWN,qianliu-glm,智谱 E2E,E2E 智谱主资源,200,100,20,320,125.00000000,CNY,SUCCEEDED,2026-11-05T06:02"
}
```

### 200 /operating-bills

```
{
 "months": [
  {
   "month": "2026-11",
   "status": "DRAFT",
   "currentVersion": 0
  },
  {
   "month": "2026-10",
   "status": "CLOSED",
   "currentVersion": 1
  }
 ]
}
```

### 200 /operating-bills/2026-11

```
{
 "month": "2026-11",
 "timezone": "Asia/Shanghai",
 "periodStart": "2026-10-31T16:00:00.000Z",
 "periodEnd": "2026-11-30T16:00:00.000Z",
 "status": "DRAFT",
 "version": 0,
 "generatedAt": "2026-11-05T06:03:20.410Z",
 "closedAt": null,
 "closedBy": null,
 "closeNote": null,
 "summary": {
  "totalCost": null,
  "apiCost": null,
  "openingBalance": null,
  "monthlyRecharge": null,
  "apiSpendStatus": "INCOMPLETE",
  "apiSpendReason": "PRICE_MISSING:1、CURRENCY_MISSING:5",
  "packageCost": "0.00000000",
  "endingBalance": null,
  "endingBalanceCurrency": null,
  "openingBalances": [],
  "rechargeAmounts": [
   {
    "currency": "CNY",
    "amount": "100.00000000"
   },
   {
    "currency": "USD",
    "amount": "0.00000000"
   }
  ],
  "endingBalances": [],
  "apiSpends": [
   {
    "currency": "CNY",
    "amount": "3.00104000"
   },
   {
    "currency": "USD",
    "amount": "0.50000000"
   }
  ],
  "packageCosts": [],
  "totalSpends": [
   {
    "currency": "CNY",
    "amount": "3.00104000"
   },
   {
    "currency": "USD",
    "amount": "0.50000000"
   }
  ],
  "ledgerApiCost": null,
  "planUtilization": null,
  "activePrincipalCount": 1,
  "confirmedValueAmount": "0.00000000",
  "confirmedNonMonetaryCount": 0,
  "unallocatedCost": "0.00000000",
  "totalAllocatedQuota": "100000",
  "provisionalEndingBalances": []
 },
 "providers": [
  {
   "providerResourceId": "00000000-0000-4000-8000-000000000311",
   "providerCode": "DeepSeek",
   "providerName": "DeepSeek WP4 E2E",
   "reso
…（截断，共 33408 字符）
```

### 200 /operating-bills/2026-10

```
{
 "gaps": [],
 "month": "2026-10",
 "status": "CLOSED",
 "values": [],
 "summary": {
  "apiCost": "96.00000000",
  "apiSpends": [
   {
    "amount": "96.00000000",
    "currency": "CNY"
   }
  ],
  "totalCost": "396.00000000",
  "packageCost": "300.00000000",
  "totalSpends": [
   {
    "amount": "396.00000000",
    "currency": "CNY"
   }
  ],
  "packageCosts": [
   {
    "amount": "300.00000000",
    "currency": "CNY"
   }
  ],
  "endingBalance": "1004.00000000",
  "ledgerApiCost": "96.00000000",
  "apiSpendReason": null,
  "apiSpendStatus": "CALCULABLE",
  "endingBalances": [
   {
    "amount": "1004.00000000",
    "currency": "CNY"
   }
  ],
  "openingBalance": "1000.00000000",
  "monthlyRecharge": "100.00000000",
  "openingBalances": [
   {
    "amount": "1000.00000000",
    "currency": "CNY"
   }
  ],
  "planUtilization": "42.0",
  "rechargeAmounts": [
   {
    "amount": "100.00000000",
    "currency": "CNY"
   }
  ],
  "unallocatedCost": "0",
  "activePrincipalCount": 1,
  "confirmedValueAmount": "0",
  "endingBalanceCurrency": "CNY",
  "confirmedNonMonetaryCount": 0
 },
 "version": 1,
 "closedAt": "2026-11-05T06:02:47.247Z",
 "closedBy": "00000000-0000-4000-8000-000000000002",
 "subjects": [
  {
   "apiCost": "96.00000000",
   "providers": [
    "DeepSeek WP4 E2E",
    "智谱 E2E"
   ],
   "activeDays": 2,
   "cacheTokens": "400",
   "inputTokens": "1600",
   "principalId": "00000000-0000-4000-8000-000000000020",
   "totalTokens": "2300",
   "outputTokens": "300",
   "re
…（截断，共 4926 字符）
```

### 200 /operating-bills/2026-11/analysis

```
{
 "month": "2026-11",
 "currentMonth": "2026-11",
 "generatedAt": "2026-11-05T06:03:20.605Z",
 "months": [
  {
   "month": "2026-01",
   "totalTokens": "0",
   "usageIncomplete": false,
   "inputTokens": "0",
   "outputTokens": "0",
   "cacheTokens": "0",
   "employeeTokens": "0",
   "projectTokens": "0",
   "employeeCount": 0,
   "activeEmployees": 0,
   "perCapitaTokens": null
  },
  {
   "month": "2026-02",
   "totalTokens": "0",
   "usageIncomplete": false,
   "inputTokens": "0",
   "outputTokens": "0",
   "cacheTokens": "0",
   "employeeTokens": "0",
   "projectTokens": "0",
   "employeeCount": 0,
   "activeEmployees": 0,
   "perCapitaTokens": null
  },
  {
   "month": "2026-03",
   "totalTokens": "0",
   "usageIncomplete": false,
   "inputTokens": "0",
   "outputTokens": "0",
   "cacheTokens": "0",
   "employeeTokens": "0",
   "projectTokens": "0",
   "employeeCount": 0,
   "activeEmployees": 0,
   "perCapitaTokens": null
  },
  {
   "month": "2026-04",
   "totalTokens": "0",
   "usageIncomplete": false,
   "inputTokens": "0",
   "outputTokens": "0",
   "cacheTokens": "0",
   "employeeTokens": "0",
   "projectTokens": "0",
   "employeeCount": 0,
   "activeEmployees": 0,
   "perCapitaTokens": null
  },
  {
   "month": "2026-05",
   "totalTokens": "0",
   "usageIncomplete": false,
   "inputTokens": "0",
   "outputTokens": "0",
   "cacheTokens": "0",
   "employeeTokens": "0",
   "projectTokens": "0",
   "employeeCount": 0,
   "activeEmployees": 0,
   "perCapitaTokens": nu
…（截断，共 15126 字符）
```

### 200 /operating-bills/2026-11/department-accounts

```
{
 "month": "2026-11",
 "status": "DRAFT",
 "rows": [
  {
   "subjectId": null,
   "subjectName": "待归属",
   "isUnassigned": true,
   "allocatedQuota": "0",
   "projectOwner": null,
   "projectDepartments": [],
   "providers": [
    {
     "providerCode": "DeepSeek",
     "providerName": "DeepSeek WP4 E2E",
     "totals": {
      "inputTokens": "3400",
      "outputTokens": "650",
      "cacheTokens": "400",
      "reasoningTokens": "0",
      "totalTokens": "4050",
      "allocatedQuota": null,
      "deductedQuota": "0",
      "apiCost": null,
      "knownApiCost": "3.50104000",
      "packageAllocatedCost": "0.00000000",
      "totalAllocatedCost": null,
      "activeDays": 1,
      "requestCount": 5,
      "lastUsedAt": "2026-11-05T05:56:47.247Z",
      "usageQuality": "EXACT"
     }
    },
    {
     "providerCode": "pool042-deepseek",
     "providerName": "DeepSeek Token E2E",
     "totals": {
      "inputTokens": "350",
      "outputTokens": "80",
      "cacheTokens": "60",
      "reasoningTokens": "0",
      "totalTokens": "430",
      "allocatedQuota": null,
      "deductedQuota": "0",
      "apiCost": "8.00000000",
      "knownApiCost": "8.00000000",
      "packageAllocatedCost": "0.00000000",
      "totalAllocatedCost": "8.00000000",
      "activeDays": 1,
      "requestCount": 2,
      "lastUsedAt": "2026-11-05T05:32:47.247Z",
      "usageQuality": "EXACT"
     }
    },
    {
     "providerCode": "zhipu",
     "providerName": "智谱 E2E",
     "totals": {
      "input
…（截断，共 2886 字符）
```

### 200 /operating-bills/2026-11/departments

```
{
 "month": "2026-11",
 "timezone": "Asia/Shanghai",
 "status": "DRAFT",
 "version": 0,
 "rows": [
  {
   "departmentId": "00000000-0000-4000-8000-000000000003",
   "departmentName": "E2E 研发部",
   "isUnassigned": false,
   "employeeDirectCost": "0.00000000",
   "projectCost": "0.00000000",
   "apiCost": "0.00000000",
   "packageAllocatedCost": "0.00000000",
   "totalCost": "0.00000000",
   "inputTokens": "0",
   "outputTokens": "0",
   "actualTokens": "0",
   "requestCount": 0,
   "attributionSnapshotMissingCount": 0,
   "budget": null,
   "budgetUsageRate": null,
   "budgetStatus": "NOT_SET",
   "reasonCodes": []
  },
  {
   "departmentId": null,
   "departmentName": "待归属",
   "isUnassigned": true,
   "employeeDirectCost": "0.00000000",
   "projectCost": "0.00000000",
   "apiCost": null,
   "packageAllocatedCost": "0.00000000",
   "totalCost": null,
   "inputTokens": "3970",
   "outputTokens": "835",
   "actualTokens": "4805",
   "requestCount": 7,
   "attributionSnapshotMissingCount": 7,
   "budget": null,
   "budgetUsageRate": null,
   "budgetStatus": "NOT_SET",
   "reasonCodes": [
    "ATTRIBUTION_SNAPSHOT_MISSING",
    "DEPARTMENT_UNASSIGNED",
    "API_COST_UNKNOWN"
   ]
  }
 ],
 "totals": {
  "inputTokens": "3970",
  "outputTokens": "835",
  "actualTokens": "4805",
  "apiCost": null,
  "packageCost": "0.00000000",
  "totalCost": null,
  "requestCount": 7
 },
 "conservation": {
  "status": "UNKNOWN",
  "tokenDifference": "0",
  "apiCostDifference": null,
  "packageCostDi
…（截断，共 1707 字符）
```

### 200 /operating-bills/2026-11/project-allocation-status

```
{
 "month": "2026-11",
 "enabled": false,
 "currentRun": null,
 "lastError": null,
 "latestRun": null
}
```

### 200 /operating-bills/2026-11/project-unallocated

```
{
 "month": "2026-11",
 "runId": null,
 "tokens": "0",
 "byReason": {},
 "apiCostByCurrency": {},
 "packageCostCny": "0",
 "lineCount": 0,
 "resourceResidual": [],
 "detail": {
  "runId": null,
  "lines": [],
  "total": 0,
  "limit": 25,
  "offset": 0
 }
}
```

### 200 /operating-bills/2026-11/projects/00000000-0000-4000-8000-000000000140/allocation-lines

```
{
 "month": "2026-11",
 "projectPrincipalId": "00000000-0000-4000-8000-000000000140",
 "runId": null,
 "lines": [],
 "total": 0,
 "limit": 25,
 "offset": 0
}
```

### 200 /provider-resources/usage-overview

```
{
 "generatedAt": "2026-11-05T06:03:20.965Z",
 "providerSummaries": [
  {
   "providerCode": "DeepSeek",
   "providerName": "DeepSeek WP4 E2E",
   "mode": "API",
   "accountCount": 6,
   "totalQuota": null,
   "usedQuota": null,
   "remainingQuota": null,
   "quotaUnit": null,
   "allocatedQuota": "0",
   "currency": null,
   "rechargeAmount": null,
   "currentBalance": null,
   "currentPeriodCost": null,
   "packageCost": null,
   "subscriptionPeriodStart": null,
   "subscriptionPeriodEnd": null,
   "snapshotAt": "2026-11-05T06:02:02.247Z",
   "monthlyCost": null,
   "monthlyCostReason": "币种不一致：CNY、USD",
   "priceBasisUnverified": true,
   "monthlyInputTokens": "3400",
   "monthlyOutputTokens": "650",
   "monthlyCacheTokens": "400",
   "monthlyReasoningTokens": "0",
   "monthlyTotalTokens": "4050",
   "monthlyUsageQuality": "EXACT",
   "monthlyUnknownCount": 0,
   "modelTokenBreakdown": [
    {
     "unifiedModelId": null,
     "modelAlias": "deepseek-v4-flash",
     "inputTokens": "3400",
     "outputTokens": "650",
     "cacheTokens": "400",
     "reasoningTokens": "0",
     "totalTokens": "4050",
     "usageQuality": "EXACT",
     "unknownCount": 0
    }
   ],
   "tokenRate24h": "168.75",
   "costRate24h": null,
   "estimatedBalanceTokens": null,
   "balanceTokenEstimateConfidence": null,
   "balanceTokenEstimateReason": "BALANCE_MISSING",
   "balanceTokenEstimateBasis": null,
   "currentRate24h": null,
   "currentRateUnit": null,
   "forecastConfidence": "LOW",
   "forec
…（截断，共 13175 字符）
```

## 5. 脚本说明

- 脚本：`V4/Evidence/API-COST-OFFICIAL-BALANCE/WP5-20261104/x06-amount-reconciliation.ts`（一次性只读；DB 仅 SELECT，HTTP 仅 GET＋登录）
- CSV 求和与全部金额运算使用 8 位定点 BigInt，无 float；金额一律保留端点原样字符串。
- 同步性说明：各端点在同一进程内先后抓取（秒级间隔），e2e 库为静态夹具（seed 后无写入），期间一致性成立。
