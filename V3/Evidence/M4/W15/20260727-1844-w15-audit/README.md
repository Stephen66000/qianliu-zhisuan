# W15 Evidence：供给预测

| 项目 | 内容 |
| --- | --- |
| 工作包 | W15（1h／24h／7d 速度、耗尽／恢复／覆盖、可信度与不可计算原因） |
| 里程碑 | M4（额度／预测／调度／账本，W13～W17） |
| Stage | Stage 03 / D2 |
| 日期 | 2026-07-27 |
| pnpm-lock.yaml sha256 | 无外部新依赖 |
| 迁移文件 | 新增 `0013_supply_forecast.js`（供给预测快照表） |
| 结论 | **PASS** —— W15 DoD 达成（多窗口速度、耗尽/恢复/覆盖、可信度、数据不足不伪精确） |

## 1. W15 DoD 达成情况

| DoD 项（详细计划行 291） | 结果 | Evidence |
| --- | --- | --- |
| 1h／24h／7d 速度 | ✅ | `computeForecast` 多窗口 token/小时；覆盖不足窗口 null |
| 耗尽／恢复／覆盖 | ✅ | forecastExhaustAt（余额/综合速度，不晚于失效时间）+ nextRecoverAt（周期配置）+ coverageHours |
| 可信度与不可计算原因 | ✅ | HIGH/MEDIUM/LOW/NOT_CALCULABLE 分级 + notCalculableReason |
| 数据不足不伪精确 | ✅ | 数据点<10 → LOW；余额未知 → NOT_CALCULABLE 不生成耗尽日期；无消耗速度 → no_consumption_rate |
| WT-15 | ✅ | `w15-supply-forecast.test.ts` 3 集成（真实 usage_event 聚合 → 全要素 + 落库） |

## 2. 关键决策

1. **综合速度在场窗口加权**（1h 0.5/24h 0.3/7d 0.2），覆盖不足 1/4 窗口视为数据不足不计入。
2. **耗尽预测不晚于资源失效时间**（TRD §9.2 行 637）；余额未知/无消耗速度不给日期（不伪精确）。
3. **next_recover_at 只来自厂商周期配置**，不从历史规律无标记猜测（行 638）。
4. **算法版本 `w15-v1` 冻结**（自然月偏差反向校准底座，行 640）。
5. **关键修正**：forecastExhaustAt 浮点小数 → 取整毫秒（时间戳整数，加 Number.isInteger 断言防回归）。

## 3. 正式工程命令实测（W15 Audit，2026-07-27 18:44 于佳哥 Mac 执行）

| 命令 | 结果 |
| --- | --- |
| typecheck | ✅ 11 包全 Done |
| lint | ✅ 11 包全 Done（--max-warnings=0） |
| test | ✅ domain **72**（supply-forecast 14 + quota-gate 11 + billing 14 + routing 10 + lifecycle 19 + 原 4）、provider-adapters 35、gateway **54**（**w15-supply-forecast 3** + w05~w14 回归 51）、control-api 23、database 4、config 4、contracts 2、observability 4 |
| build | ✅ 11 包全 Done |
| evidence:canary | ✅ postgres/redis/logs/traces 全 0 |

## 4. 边界确认（W15 不做项）

- 每日快照定时任务执行器：W25 worker（当前 computeForecast + 落库接口就绪，测试内直接驱动）。
- 耗尽提前告警（alert_event）：W16 经营调度/W25 告警。
- 预测偏差反向校准：自然月（W28 真实数据）;algorithm_version 已留校准点。
- 经营调度策略：W16。

## 5. 残余风险与后续

- **余额来源**：remainingQuota 需资源余额同步（真实厂商 API 或管理员录入）;DEP-PROVIDER-CREDENTIALS 解锁前测试用注入值。
- **窗口覆盖判定**：coveredHours 由最早 usage_event 推算；冷启动资源首小时数据稀疏 → LOW（符合不伪精确）。

## 6. 为 W16/W17 预留的集成点

- **W16 经营调度**：supply_forecast 的 forecastExhaustAt/nextRecoverAt/coverageHours/confidence 是 dispatch_policy「预计耗尽风险」匹配条件的输入（TRD §5.6 行 317）。
- **W17 对账**：每日预测快照与实际耗尽/恢复时间的偏差计算（自然月校准）。
