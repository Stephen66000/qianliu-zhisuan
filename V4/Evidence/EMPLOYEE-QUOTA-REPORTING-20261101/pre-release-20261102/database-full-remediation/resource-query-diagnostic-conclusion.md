# 当前候选性能诊断（不是容量验收）

第三 lock / Node 22.23.4 的原容量测试 resource P95 为 1141.722ms，超过原 1000ms 门槛，结果 FAIL；其他三个端点 P95 为 8.902 / 12.624 / 752.395ms。保留全部原种子、查询日期、2 次预热和 20 次采样。

相同隔离种子、enterprise、2026-08 bounds/asOf、原索引和 PG17.10 下，官方 Kysely log 捕获实际 endpoint SQL；v4 的 EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) 对照：

| 方案 | 实际执行 ms | 结果逐行一致 | 主要代价 |
|---|---:|---|---|
| 原 SQL | 898.252 | 基准 | 百万行 width77 外部排序，76408KB 磁盘 |
| 事务局部 enable_presorted_aggregate=off | 1014.217 | 是 | 仍宽排序，临时读取从28633增至31082块 |
| 请求去重窄CTE + numeric sums CTE | 1805.569 | 是 | 两次百万行扫描；窄排序降至45088KB，但共享读取约翻倍，新增111个JIT函数 |

两种候选均不具实测收益，均未落入生产源、未修改PG配置/索引/work_mem。一次 EXPLAIN 执行时间不能替代原20次P95容量验收。token history 实际约0.28ms，无可归因瓶颈，不做历史谓词改动。下一步应另取有证据的最小查询方案，再由 root 审阅是否实施；不得以旧锁环境的通过覆盖第三锁失败。

原计划和精确SQL/parameters/rows等价/索引/数据分布：resource-query-explain-v4.json。初次错误 logger 捕获0查询的诊断保留为 INVALID，不作结论依据。
