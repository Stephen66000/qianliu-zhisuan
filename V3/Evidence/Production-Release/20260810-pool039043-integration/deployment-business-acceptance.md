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

## POOL-040／041 Mac Mini 部署镜像确定性业务验收：PASS

为证明严格的“reserve 后、上游前”时序，同时避免锁表、安装临时触发器或修改正式员工和厂商资源，
本轮直接使用 Mac Mini 当前生产镜像，在 Testcontainers 隔离 PostgreSQL 和 Stub 上游中执行真实 HTTP
pipeline。隔离数据库随测试容器退出，不接触生产数据库。

### POOL-040：PASS，关闭

- 镜像：`qianliu-zhisuan-gateway:latest`
  (`sha256:7a55bd754bb629070c1aaa7f18e499ac3cf20931942f6b2ecad5b65f34b07c44`)。
- `w18-quota-pipeline.test.ts -t POOL-040`：9 passed、14 skipped，Test Files 1 passed。
- 覆盖 reserve 后停用 Route、Resource、Provider；精确 route 撤权、同资源／不同资源 failover、
  备用候选 Grant 撤权、API 零成本 Attempt 和池禁用型号。
- 每个拒绝场景均断言 Stub 上游调用数为 0、quota／lease 完整释放、请求 FAILED、
  Attempt／ledger／transaction 一致；`/v1/models` 与调用门禁同步。

### POOL-041：PASS，关闭

- 镜像：`qianliu-zhisuan-control-api:latest`
  (`sha256:386030fcb2da75121a9e73bc98818b7c81728db12f0efbee249b0eb24b85fc6a`)。
- 首次启动沿用镜像 `NODE_ENV=production`，因隔离测试没有配置 `WEB_ORIGIN`，在测试收集前 fail-closed；
  随后仅对一次性测试容器设置 `NODE_ENV=test`，未修改生产容器或 `.env`。
- `pool033-access-config-regression.test.ts -t POOL-041`：2 passed、13 skipped，Test Files 1 passed。
- 重复 `provider_code`、同厂商重复 `enabled_model_ids` 均稳定返回 HTTP 400；规则版本、Grant、
  Key 白名单、额度计数器、禁用型号、状态和操作日志前后完全一致。

### 验收后生产状态

- Testcontainers 和两个一次性 runner 均已退出，`docker ps` 仅保留正式服务。
- Control API、Gateway、Web、Worker、Caddy 均继续运行；五个服务 restart count 仍为 0。
- 本验收未写入生产数据库、未调用真实厂商、未读取或输出 Key／凭据／请求正文。

## 封板边界

- `POOL-039`、`POOL-040`、`POOL-041`、`POOL-043` 已关闭。
- `POOL-042` 仍为 P2 待修复；本候选没有实现资源 Token 摘要与余额可承载 Token 估算。
- 因此当前不能宣称 v1.0 全部问题关闭。
