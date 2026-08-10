# POOL-039／040／041／043 生产发布与业务验收证据

- 日期：2026-08-10（Asia/Shanghai）
- GitHub `main`／生产候选：`bdbdc01606fe40a763ad1939f6c249fa4b841e24`
- Mac Mini release：`/Users/stephen/releases/qianliu-zhisuan-pool039043-bdbdc01-20260810-124013`
- 上一 release：`/Users/stephen/releases/qianliu-zhisuan-pool040041-79ee912-20260808`
- 发布脚本 SHA-256：`b61e7f89803fa603320aa1722162f66e1920a5a0a41cc9b159f557c881c02d2e`
- 发布日志：`/Users/stephen/logs/qianliu-zhisuan/deploy-pool039043-bdbdc01-20260810-124013.log`

## 发布事实

1. 发布脚本先从 GitHub `main` 核验并拉取精确 SHA，没有从本地工作树复制候选。
2. 迁移前数据库严格为 `0042_alias_ql_format`，四类迁移阻断计数均为 0。
3. 停写后生成并校验备份：
   - 路径：`/Users/stephen/backups/qianliu-zhisuan/pre-pool039043-20260810-124013.dump`
   - SHA-256：`ef37b68d4774ff37ed7d2d6b80c75273c9c0b29cbdd182e9b4aeaadf1e9380fe`
4. 实际执行 `0042 → 0043_single_owner_rule_history → 0044_operating_bill_model_identity`；
   两个迁移约 3 秒完成，目标列、6 个索引、4 个唯一索引和模型外键均通过脚本核验。
5. current release 指针、release HEAD 均精确指向上述候选，release 工作树干净。
6. Control API、Gateway、Web、Caddy 均返回 HTTP 200；Worker、PostgreSQL、Redis healthy；
   应用及基础设施容器 restart count 均为 0。
7. 局域网实际 Bonjour 地址解析为 `192.168.1.40`，`http://192.168.1.40/health` 返回 200；
   用户最初提供的 `192.168.1.140` 不是本次发布时的实际地址。

## POOL-039 验收结论：PASS，关闭

- 单人 PUT、批量发布和停用已统一锁序；候选期真实 PostgreSQL 并发、失败回滚、全量门禁与双审通过。
- 迁移 `0043_single_owner_rule_history` 已在生产从严格 0042 基线成功执行，未发现重复 editable／published owner 阻断。
- 精确候选已进入 GitHub `main` 并在 Mac Mini 健康运行，满足本条原定“待主线落点与发布”门禁。

## POOL-043 生产业务验收：PASS，关闭

本轮仅使用生产管理页 GET 查询，没有点击“保存归属”，没有改写业务配置：

1. `/operating-bill/employees?month=2026-08` 与
   `/operating-bill/projects?month=2026-08` 为两个独立页面并真实可访问。
2. 员工账展示本月 Token、输入、输出、缓存、额度扣减、API 成本、套餐分摊、归集成本、
   活跃天数和请求次数；生产汇总为 `196,223,008 Token / 2,294 请求`。
3. “李佳 → deepseek”真实下钻同时展示：
   - `ql-deepseek-v4-flash`，历史 alias `qianliu-deepseek-deepseek-v4-flash`；
   - `ql-deepseek-v4-pro`，历史 alias `qianliu-deepseek-deepseek-v4-pro`。
4. “曹磊 → deepseek → ql-deepseek-v4-flash → 请求明细”真实可展开；模型层显示
   `1,693,765 Token / 26 请求 / API 成本 ¥0.19`，请求层展示输入、输出、缓存、状态、
   计量质量和北京时间。抽样 request ID：`1fa30843-46c6-4351-bb0e-f957ab57d81d`。
5. 项目账独立展示“未归属项目”、`compass` 和历史生产冒烟项目；三行 Token 求和严格等于
   项目账汇总 `196,826,230`，API 成本求和为 `¥6.34`，未发现重复归集。

## 仍未完成的生产业务验收

### POOL-040：保持待业务验收

- 已部署代码、真实 PostgreSQL 确定性测试和双审均通过。
- 生产代码没有 `afterReserve` 验收钩子；本轮没有用锁表、临时触发器或修改正式资源的方式
  强行制造“reserve 后、上游前撤权”，因此不能把生产业务场景写成 PASS。
- 最小后续动作：使用专用主体、专用 Key 和隔离厂商资源，在可控验收窗口制造撤权，证明上游调用数为 0，
  quota／lease 释放且账本终态完整。

### POOL-041：保持待业务验收

- 已部署代码、真实 Control API + PostgreSQL 零副作用测试和双审均通过。
- 生产当前没有可写的专用验收主体；归档验收主体的“保存并生效”已禁用。本轮未修改任何正式员工配置，
  因而没有把重复厂商／重复型号的生产负向请求伪装成已执行。
- 最小后续动作：创建或指定专用验收主体，分别提交重复厂商、重复型号输入，确认稳定 400，
  并对比前后规则版本、Grant、Key 白名单、计数器和操作日志完全不变。

## 封板边界

- `POOL-039`、`POOL-043` 已关闭。
- `POOL-040`、`POOL-041` 仍待真实生产业务验收。
- `POOL-042` 仍为 P2 待修复；本候选没有实现资源 Token 摘要与余额可承载 Token 估算。
- 因此当前不能宣称 v1.0 全部问题关闭。
