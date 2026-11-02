# 月度分流新增的三个精确等价变体

本记录仅适用于最终 integration 原生完整 490 报告中的三个新增月度分支，不接受同文件任意新增存活变体，不新增 TEST_DEBT。

- **186**：未提供 quota_settlements 时，默认空数组被变为仅含字符串的数组。随后 filter 仅保留具有 period_id/usage_id 的普通结算对象，字符串不具有这两个属性，因此两者均得到空 monthly 数组；后面的 legacy 循环使用独立原始输入，不受此数组变体影响。非空输入不使用默认值。
- **196**：legacy 循环里的 `period_id || usage_id` 改为 `&&`。循环前 settleMonthlyQuotaItems 已接收任意一项月度引用的记录，并拒绝不完整引用；成功返回后只剩完整月度引用或完全 legacy 两类，因此两种判断相同。该 helper 不修改输入引用。
- **235**：`used > quota` 改为 `>=`。仅相等时判断不同，但 bigint 精确减法与原 false 分支都为 0n，没有舍入或分支副作用。

原有两个等价分支仍为 request 行锁下的重复 Attempt 行锁移除，以及 0044 的 usage_event_id 唯一索引下不可达的重复 ledger line 防御。额外强制加锁的 **66 不归为等价**：新增真实 PostgreSQL 幂等重放用例已将其杀死。

因此原2个加新增3个为5 Survived；唯一索引保护下的错误文字仍为1 NoCoverage。采用当前完整原生报告的精确变体指纹和源码/前置 helper/唯一索引迁移哈希绑定，禁止任意存活数量增长。分数门槛及其他既有处置不变，原始完整报告和原生增量统计均保留。
