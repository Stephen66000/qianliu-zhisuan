# 标准版首页 C1 独立审核 R01

日期：2026-09-10；审核者：Codex。结论：**FAIL，退回修复后提交 C2**。仅审核标准版首页变更，不评价其他任务或整个系统历史封板。

## 候选同一性

HEAD `4898df546fbcbc9ca292ee892cd7ae412766185a`。13 个 tracked 文件当前 diff 与 C1 patch 字节一致，SHA256 `0d1897cac230b5cb082d253ecf1dd72c2c761252b16875cbfa8e68f5aee6adc0`。11 个新增文件 SHA256 全部核验通过。原有蓄水池等改动不属于本审核，不覆盖。

## Findings

### F01 [P1] 有已知费用时丢弃缺口提示，并对不完整费用计算增长率

位置：`apps/web/src/pages/Dashboard.tsx:68-75`。
只要 totalSpends 非空，本期/同期 incompleteReason 就不展示；moneyChangePercent 只收到金额，无法禁止不完整数据比较。可复现：12800 对 11851.85，任一期设置 API_COST_UNKNOWN / API_USAGE_COST_UNKNOWN:1，卡片仍显示 +8.0%，且未告知金额不完整。老板会把已知部分理解为完整费用。违反 AC01/AC02。
证据：`web-regression.log` 的前两项新增回归失败（原 13 项通过）。
修复：金额可保留已知部分，但明确提示缺口；任一期不完整禁止正常百分比。同步复核 `dashboard-home-costs.ts` 完整性来源：其仅查询 UNKNOWN_COST，遗漏权威资金汇总里的币种缺失/冲突、套餐现金未登记等缺口，不能将遗漏金额视为已知零。应复用区间化权威规则并为这些缺口增加回归。

### F02 [P1] 上月 Token 质量信息被丢弃，不完整同期仍参与增长比较

位置：`packages/database/src/repositories/dashboard-home.ts:117`；`apps/web/src/pages/Dashboard.tsx:64-66`；对应前后端契约。
tokenTotalsForRange 已返回 usageQuality/unknownCount，但 previous 仅序列化 totalTokens。上月包含 UNKNOWN 记录且仍有已知 Token 时，本月 EXACT 会正常输出增长率；页面无法知道分母不完整。修复：本期、同期都携带质量/完整性并据此禁止误导比较，保留已知量及说明。
证据：源代码数据流确认。补充防御测试 current unknownCount=1、quality=EXACT 时也会出现“合计不完整”与 +20.0% 并存（web-regression.log 第三项）；该组合是审查夹具，不宣称当前 SQL 必然生成它。主要问题是同期质量在实际序列化中丢失。

### F03 [P2] 一个新鲜资源掩盖同厂商其他资源的同步过期或缺失

位置：`packages/database/src/repositories/dashboard-home-providers.ts:128-144`。
先过滤掉没有同步记录的资源，再取厂商所有资源 last_success_data_at 的最大值，最后统一判断 STALE；因此任意一项同步成功就可覆盖其他项过期。复现两项 ACTIVE 资源，一项 9 月 10 日同步、另一项 9 月 1 日同步，输出 syncStale=false、attention=null。缺失同步记录同理。违反 AC04 的范围精度。
证据：`provider-stale-repro.json`，脚本直接执行当前私有聚合函数的转译代码；仅外部 worstResourceStatus 对本例全部 ACTIVE 的输入提供固定返回，未模拟数据库完整链路。
修复：逐资源计算同步事实，再聚合任一失败/缺失/过期及范围，不能用最大时间判断全体新鲜度；不把同步异常改写为调用失败。

### F04 [P2] 多币种金额穿出卡片，覆盖相邻指标

位置：`apps/web/src/components/dashboard/OverviewMetricCard.tsx:47-56`；`apps/web/src/pages/Dashboard.tsx:68-69`。
currencyFacts 把金额拼成一行，容器 whitespace-nowrap。真实前端 1440px 下费用卡宽 259.5px，`¥12,800.00 / USD 5,000.00` 数字宽 404.75px，覆盖活跃员工卡；根节点没有横向滚动仍不能证明卡片未溢出。违反 AC07。
证据：`multicurrency-1440.png` 与 `browser-results.json`。本次使用真实 Vite 前端、受控 API 夹具，未连接生产或声称后端验收。
修复：多币种分行/独立金额条目，自适应字重和字号，保留所有值；同时验证较大单币金额及 1024/1440 视口的元素边界。

### F05 [P2] 深色状态背景未使用 soft 透明度，对比度不足

位置：`apps/web/src/components/dashboard/ProviderResourcesPanel.tsx:33-37` 和关注数量标签。
直接 bg-ql-success-soft / warning-soft / danger-soft，深色令牌是需配合透明度使用的原始 RGB，因此变成饱和实色底。浏览器取得正常标签前景约 rgb(86,193,111)、背景 rgb(52,168,83)，文字难辨；C1 自有深色截图也出现该问题。不能把“使用令牌”当成自动满足对比度。违反 AC07、设计规范 §3.3/§10.5/§12。
修复：复用有正确深色透明度的状态组件或统一语义样式，检查正常/警示/异常全部标签及关注数量；提供修复后浅深截图。

## 已核实的通过项

- 两分区、四指标及唯一 Token 焦点方向符合已确认范围，无新增排行榜或 AI 对话功能。
- 五个 Link 的路径与当前路由解析器一致；原组件测试中的五目标断言通过。C1 提供目标页面截图；本次未独立重跑完整后端登录后的五跳转，不以夹具浏览器检查替代它。
- 针对本次新增数据库测试独立复跑：同期窗口 6 项 + 真实 PG 集成 2 项，8/8 通过（database-tests-corrected.log）。首轮在根目录执行未发现测试，已保留 database-tests.log，不算通过证据。
- Web 独立复跑原 13 项通过；追加 3 项验收回归全部失败，明确暴露覆盖盲区。
- 没有数据库迁移，路由新端点包含 requireAuth 和 enterpriseId 参数；未发现此次变更中的租户条件遗漏。

## 证据边界及建议补充

- 2 项现有数据库集成测试不足以覆盖金融模式同期费用、缺口、非上海员工时区、资源混合新鲜度及后端权限拒绝。C2 补影响范围测试，不要求重开全仓库审计。
- C1 报告 database/control-api 历史失败，本次没有对基线复跑验证其所有归因，因此保留为“实施者报告的既有失败”，不宣称独立证明无关。
- 25—30 条查询相较旧首页增多；仅固定查询数不是性能证据。交付代表性数据量下耗时/查询执行记录；避免重复构建整份经营草稿与员工趋势排名。
- FEATURE_USAGE_OVERVIEW_V2 关闭时首页仍展示概览跳转，但目的页落请求明细；C2 核对开关/权限状态的可见性，确保不误导。不授权开启全局开关。
- 原型以短文案为主；当前页面“余额桥接口径”“排他边界”等工程术语建议移入说明提示，非本轮阻断项。

## 下一步

ZCode 按 F01—F05 修复并补回归，提交新候选 C2（新 hash、改动及验证回执），Codex 复核。不得覆盖 C1/R01 证据，不得提交、推送、合并或部署。当前只完成审核，不改写业务实现。
