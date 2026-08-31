# DeepSeek 余额与账单同步调研

- 收集时间：2026-08-02（Asia/Shanghai）
- 用途：核对仟流智算 API 资源的充值、余额、费用和账单数据来源

## 决策记录

- 决策时间：2026-08-02（Asia/Shanghai）
- 决策人：佳哥
- 决策结论：同意本文提出的产品口径和调整方向。
- 执行边界：当前只记录，不修改产品代码、PRD 或开发计划；待本轮 P0／P1 问题全部沟通完成后，再统一确定范围、优先级并集中调整。

## 一、官方接口结论

### 1. 当前余额可以通过官方 API 同步

DeepSeek 官方公开 `GET /user/balance`，使用 Bearer API Key 鉴权，可返回：

- `is_available`：账户是否还有可用于 API 调用的余额；
- `balance_infos[].currency`：`CNY` 或 `USD`；
- `total_balance`：当前总可用余额；
- `granted_balance`：当前未过期赠金余额；
- `topped_up_balance`：当前充值余额。

`total_balance` 是“赠金余额 + 充值余额”的当前值，不是累计充值金额。

### 2. 未发现公开的充值流水／账单明细 API

截至本次核对，DeepSeek 官方公开 API Reference 只列出模型调用、模型列表和余额查询，未公开充值记录、账单明细或按 Key 用量账单 API。

官方 FAQ 给出的账单方式是：

- 充值结果在平台 `Billing` 页面查看；
- 按 API Key 的月度用量在 `Usage` 页面选择月份后导出；
- 导出压缩包中的 `amount` CSV 包含按 Key 拆分的金额明细。

因此现阶段可自动拉取“当前余额”，但累计充值、充值流水和厂商账单需要人工录入、CSV 导入，或等待 DeepSeek 后续开放正式接口。

### 3. 官方没有公开价格查询 API

DeepSeek 官方价格位于 `Models & Pricing` 页面，按每 100 万 Token 公示缓存命中输入、缓存未命中输入和输出价格，并明确价格可能调整。当前未发现机器可用的正式价格 API。

价格适合作为仟流智算内部的版本化计价规则，由管理员维护或由受控模板更新；不应把网页抓取结果直接当成不可审计的正式计费规则。

## 二、现有仟流智算实现核对

### 1. API 价格实际已有配置入口

`apps/web/src/pages/QuotaRules.tsx` 的“计价规则模板”支持 `API_PRICE`，可以配置缓存命中输入、缓存未命中输入、输出单价、生效区间、多个时间窗和规则版本。

入口依赖顺序是：统一模型 → Model Route → 计价规则。未创建并启用 Model Route 时，“新建规则”按钮禁用，因此在厂商资源页面看不到 API 价格字段，容易被理解为“API 价格不能填”。

### 2. API 经营数据目前全部手填

`apps/web/src/pages/Resources.tsx` 当前允许分别填写：

- `recharge_amount`；
- `current_balance`；
- `current_period_cost`；
- `cumulative_cost`；
- 余额更新时间和费用周期。

这些字段保存为 `ADMIN` 来源的资源经营快照，彼此不做自动推导。

### 3. 自动计算目前只用于 Coding Plan

`packages/database/src/repositories/provider-operating.ts` 只有在资源模式为 `CODING_PLAN` 且 `usage_calculation=SYSTEM_LEDGER` 时，才根据当前周期 `ledger_line.deducted_quota` 自动计算已用、剩余和下一重置时间。

API 资源不会根据“充值金额 - 本地账本费用”自动生成厂商当前余额。

这个边界是合理的：厂商余额还可能受到赠金、Gateway 外调用、额外充值、退款、厂商舍入和价格变化影响，本地推导值不能冒充厂商余额事实。

### 4. “本月充值”当前口径存在问题

`DashboardRepository.sumLatestSnapshotAmount` 汇总的是每个 API 资源最新经营快照中的 `recharge_amount`，没有按自然月筛选充值事件。因而首页“本月充值”实际上不是严格的本月充值流水。

根因是当前只有经营快照，没有独立的充值交易表；`recharge_amount` 的含义也没有明确为“本次充值”还是“累计充值”。

## 三、建议产品口径

### DeepSeek API 资源登记后自动处理

1. 保存凭证后调用 `/user/balance`；
2. 同步总余额、赠金余额、充值余额、币种、是否可用和采集时间；
3. 生成来源为 `PROVIDER_SYNC` 的不可变余额快照；
4. 后台定时同步，并提供“立即同步”；
5. 同步失败保留最后成功值，显示数据新鲜度和失败原因，不回退成伪造的 0。

### 系统自行计算

- 每次调用 Token；
- 按规则版本计算的内部 API 费用；
- 本期／累计内部费用；
- 当前余额下的预计可用时长；
- 本地账本与厂商账单的差异。

### 仍需人工或文件导入

- 充值交易；
- 退款；
- 发票；
- DeepSeek `Usage` 页面导出的 `amount` CSV；
- 无公开接口厂商的余额／账单。

### 数据模型调整建议

- 余额快照：保留现有 `provider_resource_operating_snapshot`，补 `total_balance`、`granted_balance`、`topped_up_balance` 和同步状态；
- 充值流水：新增独立 `provider_fund_transaction`，记录 `TOP_UP/REFUND/GRANT/ADJUSTMENT`，不要继续用快照字段代替交易；
- 账单对账：保留“内部计算费用”和“厂商确认费用”两个值，产生差异记录；
- 首页“本月充值”改为按充值交易发生时间聚合，不再读取最新快照。

## 四、来源

1. DeepSeek API Docs, Get User Balance：<https://api-docs.deepseek.com/api/get-user-balance/>，访问于 2026-08-02。
2. DeepSeek API Docs, DeepSeek API Reference：<https://api-docs.deepseek.com/api/deepseek-api/>，访问于 2026-08-02。
3. DeepSeek API Docs, Models & Pricing：<https://api-docs.deepseek.com/quick_start/pricing/>，访问于 2026-08-02。
4. DeepSeek API Docs, FAQ（Billing / Usage Export）：<https://api-docs.deepseek.com/faq>，访问于 2026-08-02。
