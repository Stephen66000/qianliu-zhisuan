# WP5 S1 只读调查笔记（50 条覆盖映射＋R1-R3 实施点＋X01-08 可执行性＋命令清单）

日期：2026-11-04；基线：worktree `/Users/mac/Projects/仟流智算-api-decouple`，分支 `codex/simplify-api-cost-and-official-balance`，HEAD `d6550c9`（开工复核一致，工作树仅 WP5 plan.md 未跟踪）。
方法：全部锚点逐一打开文件核实（grep/read），未照抄任何 report 文字；未运行任何测试；未修改业务代码。主仓未进入。

## 0. 环境与测试基建事实（S3 命令清单依据）

- 包管理：`corepack pnpm@11.11.0`；单测 `--filter <pkg> run test`，集成 `--filter <pkg> run test:integration`（`packages/database/package.json:12-13`、`apps/control-api/package.json:12-13` 同款）。
- DB 集成测试（database/control-api/gateway）**不需要 DATABASE_URL**：每文件经 `@qianliu/testing` 的 `startPostgresContainer`（PG17 testcontainer，digest 锁定，`/Users/mac/Projects/仟流智算-api-decouple/packages/testing/src/postgres-container.ts:13-32`）自起自停，需 Docker/colima 运行（WP4 用 colima＋`qianliu-pg` @55432）。
- E2E **需要 DATABASE_URL 指向专用 `_e2e` 库**：`apps/control-api/src/cli/seed-e2e.ts:18-24` 安全门（仅 127.0.0.1/localhost＋库名 `_e2e` 后缀，否则抛错）；`apps/web/e2e/global-setup.ts:8-15` 经 tsx 执行 seed（先 migrateToLatest＋TRUNCATE 清库再播种）。WP4 环境先例：`qianliu_e2e` 库。Playwright webServer 自动拉起 control-api＋web（`apps/web/playwright.config.ts:26,33`）。
- 已知 flake：`packages/database/src/__tests-integration__/w20-standard-capacity.integration.test.ts` 的 W20-10 P95 计时（WP1/WP2/WP3/WP4 四包同记录：本机负载相关，隔离复绿，CI 自裁）。
- 迁移水位：0000…0096（`packages/database/migrations/`；0092 员工月度额度、0093 source_status、0094 退役准入、0095/0096 WP3）。
- e2e 已知基线缺陷：`apps/web/e2e/wt-web.spec.ts` 引用 5 个未提交 helper（WP4 §4.2，用户裁定项）→ S3 必须用**指定文件运行**绕开。

## 1. T1：50 条覆盖映射表

统计：**直接覆盖 27 / 部分覆盖 23 / 无覆盖 0；缺口断言点合计 26**（下方逐条"缺口"栏，编号 G1-G26）。
层缩写：DB=database 集成；CA=control-api HTTP 集成；GW=gateway 集成；WK=worker；AD=provider-adapters；WEB=web 组件单测；E2E=Playwright 浏览器（`/Users/mac/Projects/仟流智算-api-decouple/apps/web/e2e/wp4-cost-official-balance.spec.ts`，下称 e2e spec，7 个 test）。
夹具：seed＝`/Users/mac/Projects/仟流智算-api-decouple/apps/control-api/src/cli/seed-e2e-wp4.ts`（下称 seed）；e2e 基础目录 seed＝`apps/control-api/src/cli/seed-e2e-catalog.ts`（含 CODING_PLAN 资源 :25、quota_value 100000＋allow_overage=true :49）。

### 1.1 API 费用估算（AT-ACE-01～14）

| ID | 现有覆盖（已核实 file:line） | 夹具就绪 | 缺口 |
|---|---|---|---|
| ACE-01 | e2e spec test1 :45（资源页官方余额列）＋test4 :144-146（用量页两处"API费用估算"表头）＋test7 :209（CSV 表头）；E2E/HTTP | seed 资源 :78-133＋F01 :136-180 | **G1** 请求详情页（RequestDrilldown）命名与"说明可查看且不宣称包含平台外调用"无浏览器断言（e2e 只覆盖 /usage 与 CSV）；扩 e2e test4 加详情页步骤 |
| ACE-02 | DB `api-cost-estimation.integration.test.ts:160-171`（a：0.00104000 字面值，:167 注释即规范公式）；GW `w13-billing.test.ts:128`（API_PRICE 缓存分项 decimal）；E2E test4 :150-156＋test7 :210；HTTP/DB/E2E | estimation 夹具 seedRule :77-88；seed F01 :136-180（600/400/200 @1/0.1/2） | **G2** 同一响应内"输入+输出仍 1200 Token"无显式断言（e2e 只断金额）；扩 e2e test4 断言 token 字段 |
| ACE-03 | GW `w13-billing.test.ts:145`（规则版本冻结：改规则后历史 attempt 命中版本不变）；GW/单元 | w13 夹具 v1[0,T1)/v2[T1,∞) :146-160 即 F11 价格 A/B 雏形 | **G3** F11 企业时区生效点前后各消费一次＋"旧记录刷新不重算"端到端断言无；建议 DB 层新用例（A/B 两规则＋前后两行 settled→刷新后各保留版本） |
| ACE-04 | DB estimation f) :258（PRICE_BASIS_UNVERIFIED 信息项）＋:302（0093 迁移）；CA `w19-billing-rules.test.ts:195`（source_status 读写/缺省 UNVERIFIED/非法拒绝）；WEB `RequestDrilldown.test.tsx:104,112`（UNVERIFIED 角标/VERIFIED 无角标）；WEB `usage-cost.test.ts:16`；DB/CA/WEB | seed F01 规则未设 source_status → 0093 默认 UNVERIFIED（seed :19-20 注释） | **G4a** 聚合级角标不可达（R2，见 §2）；**G4b** e2e 无角标断言（页面 F01 行有 UNVERIFIED 规则可断） |
| ACE-05 | DB estimation a) :160＋readers-alignment :157（无任何资金表产出同源估算）；DB | estimation 夹具每场景独立企业、零资金表（:46 注释） | 无 |
| ACE-06 | DB `wp2-finance-mode-parity.integration.test.ts:102`（strict 关/开两路金额同源）＋WK runner :131（同步零资金事实写入）＋GW gates :320（快照正余额不改额度域判定）；DB/WK/GW | parity 夹具 :39-97 | **G5** 无"只改官方余额→重读估算金额逐字不变"直接断言；建议扩 parity 或 estimation 加一对前后读数断言（低成本） |
| ACE-07 | DB estimation c) :218（3 元+KNOWN_PARTIAL+PRICE_MISSING）＋:382（§1.5 零与未知并存）＋readers-alignment :182；WEB UsageRow.tsx:28-40＋Usage.test.tsx:99-100；DB/WEB | estimation 夹具 seedLine :108-127 | **G6** 浏览器"已计价 3 元＋待计价说明"展示断言无；扩 e2e 或组件测试 |
| ACE-08 | GW `attempt-usage-settlement.test.ts:168`（上游前拒绝冻结无币种确认零费用）＋:310（definite zero＋默认 overage/classification）；DB estimation d) :233（ZERO_CONFIRMED 无缺口）；GW/DB | gateway 夹具内建（dispatch guard） | 无 |
| ACE-09 | DB `api-cost-estimation-attempts.integration.test.ts:237`（§1.1：0.01+0.02=0.03、两 attempt 事实保留）；DB | attempts 夹具（同文件 :51 起） | **G7**（小）HTTP 侧"成功请求次数按请求口径"（attempt_count≠请求计数）无显式断言；可并入 G1 的详情页步骤 |
| ACE-10 | DB attempts §1.3 :319（处置不变＋原始行不改写）＋CA `usage-cost-disposition.http.test.ts:62`（list/settlement/metering 三处投影一致）；DB/CA | 两夹具均直插合法历史处置 | 无 |
| ACE-11 | DB readers-alignment :115（首页/用量/同期/统一入口四读取方字面值相等）；DB | 夹具内建 | **G8** 浏览器/联调"按同期间逐笔核对资源明细、首页与账单"证据（并入 X06） |
| ACE-12 | DB `wp2-cross-month-attribution.integration.test.ts:132`（11-30 23:59/12-01 00:02 结算分列 11/12 月）＋:162（额度预占月）；GW employee-monthly-quota :81；DB/GW | cross-month 夹具（同文件 :47 起，固定时钟） | 无 |
| ACE-13 | CA `dashboard-finance-estimation.test.ts:99`（总额=套餐 199+估算 42.5=241.5，同机制）＋e2e test5 :163（"综合费用（含 API 估算）"标签）；CA/E2E | e2e CLOSED/DRAFT 月＋catalog 套餐资源 | **G9** F11 原文数值（API 10+套餐 100=110）的页面数值断言无（机制等价但数值不同）；扩 e2e test5 断言综合费用数值=当月估算+套餐 |
| ACE-14 | DB estimation b) :182（1 CNY+2 USD 分列不混加）＋attempts §1.4 :355（请求内混币）＋readers-alignment :182（总览币种不一致 reason）；seed 混币 USD 行 :182-218；DB/E2E | seed usdRequest/usdLine :183-218 | **G10** 浏览器 2 USD 分列展示断言无（e2e 只断 CSV 含 0.00104）；扩 e2e 断言 USD 行显示"USD" |

### 1.2 官方账户余额（AT-OAB-01～14）

WP3 核心测试文件：DB `wp3-official-balance-states.integration.test.ts`（下称 states）、DB `wp3-supply-forecast-official-source.integration.test.ts`（下称 forecast）、DB `wp3-official-balance-refresh.integration.test.ts`、CA `official-balance-refresh.http.test.ts`（下称 refresh.http）、WK `provider-operating-sync/runner.test.ts`（下称 runner）。

| ID | 现有覆盖 | 夹具就绪 | 缺口 |
|---|---|---|---|
| OAB-01 | E2E test1 :48-52（110 元+最近成功时间+组成不相加/无 220）＋:88-89（C2 API composition 逐字段）；AD `provider-operating-facts.test.ts:9`（DeepSeek 字段解析，不从余额推导费用）；E2E/HTTP/AD | seed :78-133（OK 110=赠10+充100，PROVIDER_SYNC） | 无 |
| OAB-02 | DB states :151（仅 ADMIN 手工快照→官方 null，手工金额不混入）＋forecast :56（official_source_missing）；DB | states 夹具直插 ADMIN 快照；e2e 侧无 ADMIN 手工快照夹具（不需浏览器） | 无 |
| OAB-03 | DB states :162（UNSUPPORTED 余额全 null）；WK runner :131（DARK/OFF 仍同步）；E2E test1 :64-68（暂不支持+无刷新按钮）；DB/WK/E2E | seed 复用 catalog zhipu 资源（IDS.resource，非 DeepSeek） | **G11**（小）unsupported 资源"Token 和费用估算仍正常统计"浏览器侧断言无；catalog zhipu 资源有用量可在 e2e 用量页断言一行 |
| OAB-04 | WK runner :131（资金 DARK/OFF 仍执行同步写快照＋零资金事实）；E2E test1 :57-62（FAILED 保鲜） | seed failedResource :90-95 | **G12**（小）"Worker 集成推进至下一同步时点"现为 runner 级 mock tick（非真实调度循环）；验收可按 runner 证据＋说明执行，或补 WK 集成（worker integration 目录现有 directory/quiescence/runtime-assurance 三件，无 operating-sync 集成） |
| OAB-05 | CA refresh.http :164（AT-OAB-05 成功刷新 ACCEPTED＋快照/attempt 落库＋审计无凭证明文）；CA | refresh.http 夹具内建注入成功响应 | **G13** 浏览器"刷新后变 160"路径无 e2e（e2e 仅测 409 无凭证分支，test2 :95-111）；e2e 环境无真实上游，需可控 mock 上游或保持 HTTP 层证据＋页面读数断言 |
| OAB-06 | CA refresh.http :268（view-only 403＋GET 可读＋422/409/404 分态）＋:365/:417（C2 结构＋请求体校验）；凭证不下发断言在 :164/:268 | refresh.http 夹具（同文件 beforeAll） | 无 |
| OAB-07 | DB states :86（AT-OAB-07：T0 成功 50 保鲜＋P2 过期 FAILED+expired 叠加）＋:223（P2 可配置）；WK runner :192（失败保鲜 last_success_data_at）；DB/WK | states 夹具可控时钟（vi.setSystemTime） | **G14** 浏览器过期标记展示断言无（e2e FAILED 行无时钟推进）；扩 e2e 或以 states 字段＋WP4 渲染组件测试合成证据 |
| OAB-08 | DB states :125（AT-OAB-08：从未成功+401→FAILED null 不显 0；NEVER_SYNCED）；CA refresh.http :307（失败 attempt 留痕/旧快照保留/失败态返回）；DB/CA | states 夹具 | **G15** 浏览器"从未成功资源显示暂无余额+失败原因、不显示 0"行断言无（e2e failedRow 是曾成功资源）；seed 加一个从未成功资源行或扩 e2e |
| OAB-09 | DB states :173（AT-OAB-09/10：同账户两资源各 100→两行独立、无任何合计字段）；E2E test1 :52（okRow 无 220）；DB/E2E | states 夹具两资源；seed 单资源（无同账户第二资源） | **G16** e2e 侧无"两个同账户 Key 同屏"夹具（WP4 裁定以资源列表页为浏览器证据）；seed 加第二资源＋states 已证无合计字段 |
| OAB-10 | DB states :173（同上：不凭金额自动合并——产品无账户识别逻辑，DB 层证"独立展示无合计"）；DB | 同上 | **G17** "无法证明账户关系时不按相同金额识别/求和"无专门断言（机制不存在即天然满足）；验收以 states :173＋资源列表页截图记录 |
| OAB-11 | 机制层：WP3-S5 grep 证伪 gateway 准入零余额读取（WP3 report §3）；GW gates :320（快照正余额不进额度判定）＋runner :192（同步失败零资金写入）；GW/WK | — | **G18** 联调"余额查询失败后对可用资源模拟请求成功＋上游计数"端到端步骤无；扩 e2e（failed 资源发起用量）或以 GW 电池证据 |
| OAB-12 | WK runner :192（恢复链回归：新隔离被更新官方证据解除/证据不足不恢复/保鲜）；GW `w11-resource-pool.test.ts:146,282,315`＋gates :497（EXHAUSTED 恢复原合同→DEGRADED）；WK/GW | runner/w11 夹具 | 无（"隔离前/后证据"两条时序已由 :192 覆盖：更新证据解除、旧/不足证据不解除） |
| OAB-13 | DB forecast :105（来源优先级：官方新鲜值不被 ADMIN 覆盖）＋:56（official_source_missing 不可计算）；domain `supply-forecast.test.ts`；DB/domain | forecast 夹具 | **G19** 浏览器"预测说明仅按已观察速率"展示断言无；扩 e2e 或组件测试 |
| OAB-14 | DB forecast :76（official_balance_expired 不可计算/无确定 exhaust）＋:122（P2 内正常）；DB | forecast 夹具可控时钟 | **G20**（小）浏览器"数据待更新/不可计算"展示断言无；同 G14 处理 |

### 1.3 API 资金管理退出（AT-AFR-01～14）

WP2 核心文件：CA `provider-finance.test.ts`（下称 pf）、CA `provider-finance-activation.http.test.ts`（下称 activ）、GW `wp2-pending-admission.test.ts`（下称 pending）、GW `wp2-admission-gates.test.ts`（下称 gates）、DB `wp2-cross-month-attribution.integration.test.ts`（下称 cross-month）、DB `wp2-finance-mode-parity.integration.test.ts`（下称 parity）。

| ID | 现有覆盖 | 夹具就绪 | 缺口 |
|---|---|---|---|
| AFR-01 | E2E test3 :113-138（无充值表单/历史只读含来源/退役说明）；WEB resource-page-display 等；E2E/WEB | seed 历史事件 :332-365 | **G21**（小）"打开所有操作菜单逐项检查"未遍历；以 e2e test3＋组件测试合成 |
| AFR-02 | CA pf :896 it.each（W1-W4/W9-W11 七端点：401 未认证→410+固定错误码+四表零增量）＋:707/:726（W8 API 候选/W7 按事实拆分）＋pf :76（激活态无关 410）＋CA wp07 :493/:673；CA | pf 夹具（apiResourceId/planResourceId） | **G22**＝R1：`POST /provider-resources/:id/purchases` API_RECHARGE 仍可写（见 §2-R1）；补 410 分支＋参数化负向；其余七端点已完整 |
| AFR-03 | CA activ :371（preview 拒绝含 API 资金草稿 400）＋:584（直插旧候选→activate 409 candidate_contains_retired_api_facts 零写入）＋:538（AT-AFR-03 纯套餐草稿 GO→activate→W5/W6 可用）；CA | activ 夹具 | 无 |
| AFR-04 | GW pending (a) :135（新建无资金账户→立即可服务＋用量与费用估算）；GW | pending 夹具 | 无 |
| AFR-05 | GW pending (b) :163（仅 PENDING 存量可服务）＋DB activ-migration :257/:423（0094 后门禁退役/存量 READY 语义不变）；GW/DB | pending＋直插 PENDING 夹具 | 无 |
| AFR-06 | GW pending (c) :175（CREDENTIAL_INVALID 仍拒绝、零上游）＋gates :470（凭证隔离不被额度同步解除）；GW | pending (c) | 无 |
| AFR-07 | DB cross-month :132/:162（费用归月/额度预占月）＋:233（新月续订）；GW employee-monthly-quota :81；E2E test1 :51（最近成功时间保留）；DB/GW/E2E | cross-month 固定时钟夹具 | 无 |
| AFR-08 | DB cross-month :233（API 无期初已激活企业→续订成功、开关周期不变、重复 tick 幂等）＋DB `subscription-auto-renewal.integration.test.ts`（10 例）＋CA `subscription-renewal-flow.test.ts:15`（HTTP 购买→续订→取消）＋WK `subscription-renewal/runner.test.ts:8-19`（OFF/DARK 不写/ACTIVE 调用）；DB/CA/WK | 各夹具内建；e2e catalog 有 CP 资源+开关 | 无 |
| AFR-09 | GW gates :320（AT-AFR-09：快照正余额 88.88 仍 429 provider_quota_exhausted、原因在额度域、零上游）＋GW employee-monthly-quota.test.ts:45 系＋GW w18 :285（F-01-2）；GW | gates 夹具 | 无 |
| AFR-10 | GW gates :360（AT-AFR-10：200+overage=true+授权四字段前后相等）＋GW w18 :812（F-01-4）；GW | gates 夹具 | 无 |
| AFR-11 | CA `pool025-operating-bill.test.ts:551`（冻结不可变版本）＋:201（确认不改写原始快照和账本）；DB parity :139（冻结后改账本/切模式仍返回冻结版本）；DB draft-model-alignment :294（关账版本快照逐字节不变）；E2E test6 :175-190（CLOSED 横幅·v1+三卡+旧列名）；CA/DB/E2E | seed CLOSED 冻结月 :220-329 | 无 |
| AFR-12 | DB draft-model-alignment :236（draft 桥接字段 opening/ending/recharge 照常产出＋apiCost=估算）＋CA pool025 :151（POOL20-043 最近有效快照/拒绝跨币种相加）＋CA w20-resource-insights :646（旧 CLOSED JSON 安全投影不改写）；DB/CA | seed 冻结月含旧轨迹值 | **G23** "仅有余额桥接、无请求计价的月份"精确夹具（apiSpendStatus=BRIDGE/UNAVAILABLE 场景）＋导出层"不把桥接值填成 API费用估算已确认值"断言无；建议 DB 层新用例（只有 opening/recharge 无 ledger 行的月份） |
| AFR-13 | CA standard-home.integration :434-485（V14 缺口码迁移后口径）；WEB OperatingBill.test.tsx:178（无"待补期初余额"）＋standard-home-model.test.ts:208-211（死映射删除）；E2E test5 :160-173（DRAFT 无待补/期初/充值/期末卡）；CA/WEB/E2E | e2e DRAFT 现行月 | 无 |
| AFR-14 | E2E test1（API 官方余额列）＋test3（套餐与订阅保留）；WEB ResourceBreakdown.pool042.test.tsx（同面板两种 mode）；E2E/WEB | seed＋catalog | **G24**（小）"API 资源详情页不再显示内部资金栏目＋套餐页保留费用/额度"同页断言散在组件层；可扩 resource-page-display.test.tsx 一条组合断言 |

### 1.4 八项集成回归（AT-X01～08）

| ID | 现有覆盖（已核实） | 缺口 |
|---|---|---|
| X01 资金模式矩阵 | parity :102（strict 关/开两路金额同源——OFF/ACTIVE 等价机制）；WK runner :8-19（OFF/DARK 续订门禁）＋:131（DARK/OFF 同步）；CA `w04-provider-route.test.ts:41-47`（PROVIDER_FINANCE_MODE=OFF 路由不注册）；GW pending (a)(b)（无账户/PENDING） | **G25** 无单一"OFF/DARK/ACTIVE × strict × 无账户/旧账户 × 无状态/PENDING"组合矩阵测试（现有为分域参数化）；S3 可组合现有 5 套件出证据，或新增 1 个参数化矩阵用例（建议放 DB 层仿 parity）。"估算恒 0.00104000"字面值组合断言无（parity 用 12.34） |
| X02 同日多次与冷却 | CA refresh.http 7 例（:164 成功/:207 冷却 COOLDOWN/:227 在途 IN_PROGRESS+租约收敛/:268 权限/:307 失败后再刷/:365 C2/:417 校验）；DB refresh 集成 8 例（:73 begin/finish 并发、:104 幂等重放、:118 冷却、:165 租约、:185 同日多次各留一行、:230 down）；DB `wp3-operating-sync-decouple.integration.test.ts:74,82,113`（0095 daily_uq 删除＋同日多行＋down 守卫）；WK runner :54（P1 周期门禁） | 无实质缺口（手动+定期同时发起＝:227 在途租约＋runner P1 计入节奏） |
| X03 重复终态 | DB attempts §1.2 :276（相同 dedup 证据重放不落新行、聚合仍 0.03）；GW employee-monthly-quota :110（原子月度记账失败零残留）＋attempt-usage-settlement :101/:189（单一原子入口/failover 不重复结算） | **G26** "事务回滚→重放→仍只计一次"两步显式断言无（现有为幂等重放与失败零残留分立）；扩 attempts §1.2 加故障注入轮 |
| X04 其他门禁 | GW gates 9 例 :319-534（禁超额/允许超额/Key 限制/项目限制/CPQW 窗口/人工停用/凭证无效/真实 EXHAUSTED/纯 PENDING 对照）＋GW w11 :74-330＋GW cpqw-quota-window :205-475 | 无 |
| X05 升级与历史不变 | DB parity :139（冻结内容不变）＋CA pool025 :551/:201＋DB draft-model-alignment :294（逐字节）＋DB activ-migration :359（0094 down 触发器恢复+存量行原样）＋DB wp3-operating-sync-decouple :82/:113（0095 down 守卫/单行 down） | **G27** "新库＋带 F08/F09 旧数据的升级库迁移→受保护记录摘要对比"完整演练无（见 §3-T3/X05 做法） |
| X06 全页和导出同源 | DB readers-alignment :115（首页/用量/同期/统一入口）；DB draft-model-alignment :142/:159/:184（模型行/账单 draft）；DB operating-analysis.integration.test.ts（9 例，年度）；DB pool043-operating-bill-accounts.integration.test.ts（部门）；DB project-allocation-*（项目）；E2E test4/test5/test6/test7（用量页/账单 DRAFT/CLOSED/CSV） | **G28** 金额核对表生成物（同期间同范围跨 7 页面/导出的数值对照文件）无——建议 S3 以脚本（对同一 `_e2e` 库调 `loadApiCostEstimation`＋各 HTTP 读端点输出 markdown/CSV 对照表）或扩 e2e 汇总输出；年度页/部门项目页浏览器断言缺 |
| X07 无账户新消费与回退 | 可读：DB estimation a) :160；可结算：GW pending (a) :135（gateway 全链路用量+估算）；受额度约束：GW gates :320；数据保留：AFR-11 系（冻结/逐字节）；回退机制半段：DB migration-rollback 系（provider-finance-activation-migration :359、wp3 :113、`migration-pre-monthly-fixture.ts:5-11` 0072 水位回滚演练基建） | **G29** 候选版本回退演练（停新版本→回旧版本→数据保留断言）归 WP6；本包可做 DB 水位回退（migrateDown 至 0096 前→旧服务可读性断言不可行——旧服务无测试环境，标注为 WP6 演练项） |
| X08 切换时任务共存 | 停旧写：pf :896 七端点 410；在途收尾：CA activ :458（未排空拒绝且不落候选）＋GW provider-finance-quiescence-gate :126/:171（租约内 503 零事实/到期自动恢复）；Worker：runner gate + renewal tick + provider-operating-sync runner（零资金依赖）；官方刷新恢复：refresh.http :307；资金事件零增量：pf it.each 四表计数＋WK runner :131 | **G30** 实际候选版本切换时序演练归 WP6；本包 S3 以现有机制套件组合出"共存"证据 |

## 2. T2：三项已授权改动实施点（file:line）

### R1 purchases 补退役（AT-AFR-02 G22）

- 端点：`/Users/mac/Projects/仟流智算-api-decouple/apps/control-api/src/department-costs/routes.ts:219-247`（POST 注册 :219-220；zod 解析 :224-229；失败映射调用 :238；幂等重放 200/201 :239-243）。GET 同路径 :201-217（读，保留）。
- 实现：`createResourcePurchase`＝`/Users/mac/Projects/仟流智算-api-decouple/apps/control-api/src/department-costs/writes.ts:216-325`。要点：:262 模式/类型配对检查（API 资源 ⇄ API_RECHARGE）；:250-261 幂等回执查询（resource_purchase_idempotency）；:282-295 INSERT `resource_purchase_record`（只写采购实付表，**不写 provider_finance_event**——WP4 §4.2 描述已核实）；append-only 触发器保护（w20 测试 :983-985 验证 UPDATE 被拒 55000）。
- 错误映射：`purchaseFailure`＝routes.ts:71-88，现有 kind：`not_found`→404、`closed`→409 bill_closed、`mode_mismatch`→409 purchase_type_mismatch、默认→409 idempotency_conflict。
- Schema：`PurchasePostSchema`＝`/Users/mac/Projects/仟流智算-api-decouple/apps/control-api/src/department-costs/contracts.ts:21-39`；`purchase_type` 枚举 `["API_RECHARGE","PACKAGE_PURCHASE"]` 在 :22。Schema 单测 contracts.test.ts:31（服务周期校验）。
- 现有测试：`/Users/mac/Projects/仟流智算-api-decouple/apps/control-api/src/__tests-integration__/w20-department-costs.test.ts:932` `it("采购记录 append-only，幂等重放不重复现金支出")` ——含 201/重放 200/idempotency_conflict/mode_mismatch 409/跨企业 404/列表/审计 1 行/append-only 触发器/401。**该用例用 API_RECHARGE 走 410 后需迁移**（改为 PACKAGE_PURCHASE 于 CP 资源，或在 R1 分支前显式豁免说明）。
- 最小插入点建议：routes.ts:229 之后（zod 成功分支内）、:230 `createResourcePurchase` 调用之前，按 `body.data.purchase_type === "API_RECHARGE"` 返回 P4 合同响应：`reply.code(410).send({ error: "api_funding_management_retired", message: "API 内部资金管理已退出，请使用官方账户余额与 API费用估算" })`（与 pf :896 参数化断言逐字一致）。鉴权已在 preHandler requireAuth（:222）；410 应先于幂等/closed/mode_mismatch 全部分支（retired-api-funding-contract §1"410 优先于一切"）。PACKAGE_PURCHASE 分支原样保留。
- 应加参数化负向测试的文件：`w20-department-costs.test.ts`（同文件新增 it：API 资源+API_RECHARGE → 410＋`resource_purchase_record`/`resource_purchase_idempotency`/`operation_log` 三表零增量＋未认证 401＋同键已存在回执时也 410；对照 CP 资源+PACKAGE_PURCHASE 201 不受影响）。若追求与 AFR-02 七端点同型，可在 pf :896 的 it.each 追加第 8 行（该文件夹具已有 apiResourceId）——二选一，推荐前者（夹具与断言口径同文件）。

### R2 聚合级 PRICE_BASIS_UNVERIFIED（WP4 悬项③/G4a）

- web 侧已就绪：`/Users/mac/Projects/仟流智算-api-decouple/apps/web/src/lib/usage-cost.ts:14`（`unavailableUsageCostLabel` 分支 `"PRICE_BASIS_UNVERIFIED"`→"价格依据待核实"）；聚合消费方 `apps/web/src/components/usage/UsageOverviewPanel.tsx:35`（指标卡）与 `:50`（排名行）均已把 `apiCostStatus` 传入该函数；类型 `apps/web/src/api/v2-types.ts:100/:105/:106` 为宽泛 `apiCostStatus?: string`（web 无需类型改动）。逐请求级角标已可用（RequestDrilldown.tsx:376-378 `priceBasisSuffix`，数据源 `billing_rule_snapshot.sourceStatus`）。
- 后端聚合读取链现状（costStatus 全部取自 DB 列，无 UNVERIFIED 产出口）：
  1. 请求列表：`packages/database/src/repositories/usage-repository.ts:74`（联合类型）＋:309-311（处置投影覆盖 `projection.apiCostStatus ?? row.api_cost_status`）；类型全集 `PRICED_USAGE|CONFIRMED_ZERO_NO_UPSTREAM|UNKNOWN_COST|NOT_APPLICABLE|NOT_MIGRATED|EXCLUDED_NO_RECORDED_COST|null`。
  2. usage 总览聚合：`packages/database/src/repositories/usage-overview-facts.ts:152`（live 路径 SELECT `lt.api_cost_status`）与 :213（bucket 路径 `usage_bucket_aggregate.api_cost_status`）→ `usage-overview-metrics.ts:13`（AggregateRow 联合类型）→ :61（`apiCostStatus: row.api_cost_status` 直通）→ `usage-overview-repository.ts:30`（`UsageOverviewMetrics.apiCostStatus` 联合类型，同样五值）。
  3. 首页资源分解行：`packages/database/src/repositories/dashboard-breakdown.ts:230-257` `apiCostFromEstimation`（返回 `{monthlyCost, monthlyCostReason, currency}` 三元组；`apiEstimationGapText` 按 WP1 合同 §1 剔除 PRICE_BASIS_UNVERIFIED，故该信息项现被丢弃）；估算对象本身带 `priceBasis[].sourceStatus`（`api-cost-estimation.ts`，WP1 合同 §1）。
- "仅字段透出"最小改动点（不动聚合语义、不改金额）：
  - 方案 A（usage 总览行，对应 WP4 悬项原文"聚合级角标"）：在 `usage-overview-metrics.ts:61` 映射处旁路新增兄弟字段（如 `priceBasisUnverified: boolean`），取值由 `usage-overview-repository.ts` 在组装结果时对该窗口调一次 `billing_rule.source_status` 存在性查询（或直接消费 `loadApiCostEstimation(estimation).priceBasis` 任一 `sourceStatus==='UNVERIFIED'`）；`usage-overview-repository.ts:30` 的接口加可选字段；web `UsageOverviewPanel.tsx:35/:50` 在 `costDisplay` 旁按布尔追加角标（复用 usage-cost.ts 文案）。**不改 apiCostStatus 五值枚举本身**（避免波及 strict_writes 聚合与既有钉死测试 w20-usage-overview）。
  - 方案 B（dashboard-breakdown API 汇总行）：`dashboard-breakdown.ts:230-257` 返回对象追加 `priceBasisUnverified: estimation.priceBasis.some(p => p.sourceStatus === 'UNVERIFIED')`，:328-331 调用处透传到 `ResourceBreakdownItem`；web `ResourceBreakdown.pool042` 组件消费。
  - 判定源建议统一复用 `loadApiCostEstimation().priceBasis`（WP1 已冻结语义：规则现值非冻结值），两链路都已在 API 模式调用它（breakdown :321 显式调用；usage-overview 需新增一次调用或独立小查询——注意 usage-overview 含 EMPLOYEE/PROJECT 主体维度，与估算的资源维度不同口径，方案 A 若要精确需按主体关联资源集合，若接受"企业级任一 UNVERIFIED 即角标"则一次查询即可——该取舍需总指挥裁定）。
- 相关测试锚点（改后需跑）：`w20-usage-overview.test.ts`（CA）、`usage-overview.integration.test.ts`/`usage-aggregate.integration.test.ts`（DB）、`pool042-dashboard-resource-usage.integration.test.ts`（DB 6 例）、web UsageOverviewPanel.test.tsx。

### R3 settlement 币种透出（WP4 悬项④/G3 关联）

- RequestDrilldown 数据源：`/Users/mac/Projects/仟流智算-api-decouple/apps/web/src/pages/RequestDrilldown.tsx:43`（`const { request, settlement } = detail.data`）← `GET /gateway-requests/:id`＝`/Users/mac/Projects/仟流智算-api-decouple/apps/control-api/src/gateway-requests/routes.ts:32-65`；settlement 对象 :48-63 现有字段 totalApiCost/apiCostStatus/usageQuality/attemptCount/status，**无币种字段**。
- 回退 ¥ 位置：`apps/web/src/lib/usage-cost.ts:24-27` `costMoneyText(value, currency?)`——currency 缺省/CNY 时返回 `¥`；settlement 级 Field（RequestDrilldown.tsx:74-80）调用 `costMoneyText(settlement.totalApiCost!)` 未传币种 → 恒 ¥；行级（:211、:264）已传 `billingRuleSnapshot.currency`（快照冻结币种，不等于结算币种）。
- 数据本体币种列：`ledger_line.api_cost_currency`（`/Users/mac/Projects/仟流智算-api-decouple/packages/database/src/kysely-ledger-tables.ts:52`，`"CNY"|"USD"|null`）；**`ledger_transaction` 无币种列**（同文件 :73-81，仅 total_api_cost/api_cost_status）。处置投影层已有币种：`packages/database/src/repositories/usage-cost-disposition-projection.ts:16-19`（`UsageCostDispositionProjection.costCurrency`，:72 由行聚合 currency 而来，混币行为未核实在该文件聚合 SQL 内——:76/:78/:81 混币时 costCurrency 取 `row.currency`，其聚合语义"多币种时取什么"未逐行核实，标注未核实）；请求列表读取方已消费该字段（usage-repository.ts:316 `costCurrency`）。
- 最小改动点（字段透出）：
  1. CA：`gateway-requests/routes.ts:56-63` settlement 对象加 `apiCostCurrency: cost ? cost.costCurrency : null`（cost 来自 `loadUsageCostDispositionProjections`，投影已含 costCurrency，零新 SQL；transaction-only 分支回退 null）。
  2. web：`apps/web/src/api/diagnostic-types.ts`（:27/:52/:117 附近已有 apiCostStatus 字段处）加 `apiCostCurrency?: string | null`；RequestDrilldown.tsx:74-80 改传 `costMoneyText(settlement.totalApiCost!, settlement.apiCostCurrency)`。
  3. 混币请求的展示语义：costCurrency 为 null/多币种时继续走"无币种回退 ¥"会重现原问题——建议 null 时不渲染 ¥ 而渲染分列或"—"（该分支语义需总指挥裁定；纯字段透出最小版可先透传，混币显示沿用现行）。
- 相关测试锚点：`apps/control-api/src/__tests-integration__/w20-diagnostics-alerts.test.ts`（gateway-requests 路由）、web `RequestDrilldown.test.tsx:104`（币种展示已有行级断言，可仿写 settlement 级）。

## 3. T3：AT-X01～08 可执行性逐条核查

- **X01**：可执行。现有参数化分域证据：parity（strict 关/开，DB）、runner :8-19（OFF/DARK 续订门禁，WK 单元）、runner :131（DARK/OFF 同步）、w04 :41-47（OFF 路由 404，CA）、pending (a)(b)（无账户/PENDING，GW）。缺单一组合矩阵（G25）；S3 建议以这 5 套件同批执行＋在核对表记录组合覆盖，不强行新写矩阵（新写需 O1a/O2 守卫外的资源夹具，成本高收益低）。
- **X05**：可行，基建齐备。做法：(1) `startPostgresContainer("wp5_upgrade")`＋`createMigrator(db).migrateTo("0091_recorded_cost_accounting_policy")`（Kysely Migrator 原生支持水位迁移；既有先例 `wp3-operating-sync-decouple.integration.test.ts:88` migrateTo("0094")、`pool039-lock-order-migration.integration.test.ts:22`、`migration-pre-monthly-fixture.ts:8`）；(2) 在 0091 水位插 F08 旧数据（operating_bill_period/version 冻结快照＋provider_finance_event 期初/充值——表自 0026/0053/0081/0083 已存在）与 F09（CP 订阅事件/周期）；(3) `migrateToLatest()`（跨 0092-0096）；(4) 受保护记录摘要对比：迁移前后对固定行集做 `SELECT *`＋规范化 JSON 的 sha256 对比（无现成通用 helper，需在新测试内自写约 30 行；断言基线可仿 draft-model-alignment :294 的逐字节比对写法）。**注意**：0092（员工月度额度）与 0093（source_status DEFAULT）属"预先列明的合同/新增数据范围"——对比白名单需按迁移 down 注释列差异（0092 新表、0093 新列默认值），对照物为 F08/F09 行本身不变。建议落点：`packages/database/src/__tests-integration__/wp5-upgrade-immutability.integration.test.ts`（新文件）。
- **X07**：半段可执行。已证：无期初可读（estimation a）、可结算（pending (a) gateway 全链路）、受额度约束（gates :320）、数据不丢（AFR-11 冻结系）。**回退半段不可在本包执行**：回退到旧服务版本需 WP6 的候选镜像/回退方案；本包能做的最大半段＝DB 水位回退断言（migrateDown 0096→0095→0094 各 down 守卫已有测试 wp3 :113/:82、activ-migration :359），"旧服务读新数据"无旧服务测试环境，标 BLOCKED→WP6。
- **X08**：机制件全有（见 §1.4 表）；时序共存演练需多进程环境（control-api+gateway+worker+模拟上游），S3 建议按"组件证据＋核对表"执行，真实时序演练归 WP6（acceptance §1 已如此分工）。
- **X01 资金模式矩阵补充**：OFF 模式下 provider-finance 路由不注册＝404 已由 w04 覆盖；DARK 停写 404 由 activ :891 覆盖（"DARK 停写：只读与预检可用，不可逆激活与静默变更一律 404"）。
- **X06**：同源断言已存在面＝WP1 readers-alignment（服务层 4 读取方）＋draft-model-alignment（账单/模型行）＋operating-analysis（年度）＋pool043（部门）＋project-allocation（项目）＋e2e（资源/用量/账单/CSV）。金额核对表生成建议：S3 写一次性只读脚本（`DATABASE_URL=qianliu_e2e` 下调 `loadApiCostEstimation`＋`/dashboard`、`/usage`、`/operating-bills/:month`、`/operating-analysis`、部门/项目端点，输出同期间数值对照 markdown），脚本放 `V4/Evidence/.../WP5-<run-id>/`（证据目录由 WP5 创建，非业务代码）。
- **X02**：全可执行，无缺口（见 §1.4）。
- **X03**：可执行；G26 两步断言为增强项，非必需。

## 4. T4：S3 执行命令清单（corepack pnpm@11.11.0，全部在 worktree 根目录执行）

前提：Docker/colima 运行（DB 集成自起 PG17 容器）；E2E 需 `DATABASE_URL=postgres://…@127.0.0.1:55432/qianliu_e2e`（`_e2e` 后缀强制，seed 会 TRUNCATE 清库）。

```bash
# T1/T3 主体——database 集成（估算/退役/跨月/官方余额/迁移；含 w20 flake 文件）
corepack pnpm@11.11.0 --filter @qianliu/database run test:integration -- src/__tests-integration__/api-cost-estimation.integration.test.ts src/__tests-integration__/api-cost-estimation-attempts.integration.test.ts src/__tests-integration__/api-cost-readers-alignment.integration.test.ts src/__tests-integration__/api-cost-draft-model-alignment.integration.test.ts src/__tests-integration__/wp2-finance-mode-parity.integration.test.ts src/__tests-integration__/wp2-cross-month-attribution.integration.test.ts src/__tests-integration__/wp3-official-balance-states.integration.test.ts src/__tests-integration__/wp3-supply-forecast-official-source.integration.test.ts src/__tests-integration__/wp3-official-balance-refresh.integration.test.ts src/__tests-integration__/wp3-operating-sync-decouple.integration.test.ts
# （R1-R3 落地后追加相关 DB 套件：usage-overview / pool042 / standard-home / w20-standard-capacity※flake）

# gateway 集成（准入电池/ pending/ 额度/ 计价/ 结算零费用）
corepack pnpm@11.11.0 --filter @qianliu/gateway run test:integration -- src/__tests-integration__/wp2-admission-gates.test.ts src/__tests-integration__/wp2-pending-admission.test.ts src/__tests-integration__/employee-monthly-quota.test.ts src/__tests-integration__/w11-resource-pool.test.ts src/__tests-integration__/w13-billing.test.ts src/__tests-integration__/w18-quota-pipeline.test.ts src/__tests-integration__/cpqw-quota-window.test.ts src/__tests-integration__/provider-finance-quiescence-gate.test.ts

# control-api 集成（退役 410/激活/刷新/账单/部门/账单口径/诊断）
corepack pnpm@11.11.0 --filter @qianliu/control-api run test:integration -- src/__tests-integration__/provider-finance.test.ts src/__tests-integration__/provider-finance-wp07-acceptance.http.test.ts src/__tests-integration__/provider-finance-activation.http.test.ts src/__tests-integration__/official-balance-refresh.http.test.ts src/__tests-integration__/pool025-operating-bill.test.ts src/__tests-integration__/pool043-operating-bill-accounts.test.ts src/__tests-integration__/w20-department-costs.test.ts src/__tests-integration__/w20-resource-insights.test.ts src/__tests-integration__/w20-usage-overview.test.ts src/__tests-integration__/dashboard-finance-estimation.test.ts src/__tests-integration__/usage-cost-disposition.http.test.ts src/__tests-integration__/subscription-renewal-flow.test.ts src/__tests-integration__/w19-billing-rules.test.ts src/__tests-integration__/standard-home-route.integration.test.ts

# worker（官方同步/续订门禁）
corepack pnpm@11.11.0 --filter @qianliu/worker run test -- src/provider-operating-sync/runner.test.ts src/subscription-renewal/runner.test.ts

# provider-adapters（DeepSeek 余额解析）
corepack pnpm@11.11.0 --filter @qianliu/provider-adapters run test -- src/__tests__/provider-operating-facts.test.ts

# web 组件单测（角标/币种/账单分流/官方余额列）
corepack pnpm@11.11.0 --filter @qianliu/web run test -- src/lib/usage-cost.test.ts src/pages/RequestDrilldown.test.tsx src/pages/Usage.test.tsx src/pages/OperatingBill.test.tsx src/components/usage/UsageOverviewPanel.test.tsx src/components/resources/resource-page-display.test.tsx src/components/dashboard/standard-home-model.test.tsx src/components/operating-bill/BillStat.test.tsx

# E2E（必须指定文件——wt-web.spec.ts 引用未提交 helper 会挂；需 DATABASE_URL 指向 qianliu_e2e）
corepack pnpm@11.11.0 --filter @qianliu/web exec playwright test --config playwright.config.ts e2e/wp4-cost-official-balance.spec.ts
```

注意：`--` 后传文件给 vitest 时路径相对各包目录（各包 test:integration 已含 `src/__tests-integration__` 前缀，指定文件时写相对包根路径）；database 集成并发默认 `--maxWorkers=4`（package.json 固化）；全量兜底命令＝各包 `test:integration` 不带文件参数（WP4 基线：database 835+590、control-api 482+359、gateway 411、worker 200、domain 411 全绿，唯 w20 P95 flake）。

## 5. 未解决问题清单

1. R2 方案取舍（主体维度 vs 企业级角标、apiCostStatus 枚举扩不扩）需总指挥裁定后才能定最小改动面（§2-R2 末）。
2. R3 混币请求 settlement 币种展示语义（costCurrency=null 时回退 ¥ 是否保留）需裁定；`usage-cost-disposition-projection.ts:72` 混币时 `row.currency` 聚合取值未逐行核实（未核实项）。
3. R1 落地后 w20-department-costs.test.ts:932 既有用例必然迁移（改 CP 资源），迁移说明需记录（AFR-01 断言迁移惯例）。
4. e2e wt-web.spec.ts 基线缺陷（5 个未提交 helper）＝用户裁定项，未解；S3 全量 e2e 不可运行，仅指定文件。
5. G12（operating-sync 无真实调度循环集成测试）、G29/X07/X08 回退与时序演练归 WP6，本包证据边界需在结果报告中如实标注。
6. acceptance §2-5 要求的"迁移前旧关账快照/资金事实摘要保存"在本仓内无现成产物（各包证据仅冻结快照断言）；X05 摘要对比基线需 S3 现场生成。
7. F07/F10/F11/F12 四个夹具在 e2e 侧不完整（无多 Key 资源对、无 900/1000 额度精确夹具、无价格 A/B 月界夹具、无 PENDING/人工停用独立资源行）；DB/GW 层各 case 已有等价夹具（见 §1 各行"夹具就绪"），浏览器证据按 WP4 先例以资源列表页＋既有行合成，或扩 seed（扩 seed 属 S3 改动，需授权）。
