# POOL-015～028 Mac Mini 发布证据

## 结论

- 发布结果：`SUCCEEDED`
- 服务器：`stephen@192.168.1.40`
- 发布时间：2026-08-03 18:52～18:55（Asia/Shanghai）
- 当前 release：`/Users/stephen/releases/qianliu-zhisuan-pool015028-1cd8157b-20260803`
- 上一 release：`/Users/stephen/releases/qianliu-zhisuan-pool015017-43d4bdc4-20260802`
- 未执行：Git commit、push、PR；真实厂商扣费调用与三端业务验收仍保留到独立验收步骤。

## 审计与制品

- v1.4 代码质量审计：`PASS`，R3 / I2，P0=0、P1=0。
- 候选对象锁：145/145 OK，manifest SHA-256 `1cd8157b0fc943f146ae683802d2094d5b638225b52ccb83d37619967dfc7be8`。
- 发布包：`qianliu-zhisuan-pool015028-1cd8157b-20260803.tar.gz`
- 发布包 SHA-256：`73f2947e8edcbb0332a05a0be66564d2859e8394b3ad5f8cd254d3db694c2693`
- 服务器复算发布包 SHA-256：一致。
- 发布包排除：`.git`、`.env*`、`node_modules`、coverage、mutation reports、test reports、知识库、V3 审计资料和本机设计目录。

## 备份与回滚

- 发布前数据库迁移：`0032_admin_lifecycle`
- 备份：`/Users/stephen/backups/qianliu-zhisuan/pre-pool015028-20260803-185239.dump`
- 备份格式：PostgreSQL custom format
- 备份大小：353,673 bytes
- 备份 SHA-256：`466a85e6ffd7f105d92a90271aee82fe72859919e732b5f511ca358725a0be35`
- 回滚目标：上一 release 目录和上述数据库备份。
- 回滚顺序：停新业务容器 → 恢复数据库备份（若涉及迁移回滚）→ 使用上一 release 的 compose 与 `.env` 启动 → 健康检查 → 原子恢复 current release 指针。

## 发布步骤

1. 旧服务在线期间上传并校验发布包，复制旧 release 的 `deploy/.env`，权限保持 `600`。
2. 旧服务在线期间构建 migrate、Control API、Gateway、Worker、Web 镜像；全部构建成功。
3. 停止 Caddy、Web、Gateway、Control API、Worker；PostgreSQL/Redis 数据卷保留。
4. 新 compose 启动迁移容器并成功执行 `0033`～`0037`。
5. 同批启动 Control API、Gateway、Worker、Web、Caddy；无新旧 Gateway 混跑。
6. 健康与冒烟通过后，原子切换 `/Users/stephen/qianliu-current-release.txt`。
7. 通过 POOL-026 导入升级 Manifest，记录 ID：`347446ab-b238-44eb-a8a0-c84218f4b4c5`。

## 迁移结果

顺序确认：

- `0031_gateway_stream_resilience`
- `0032_admin_lifecycle`
- `0033_operating_bill`
- `0034_supply_forecast_production`
- `0035_deployment_log`
- `0036_provider_model_discovery`
- `0037_client_identity`

当前最新迁移：`0037_client_identity`。

## 健康与冒烟

| 检查 | 结果 |
|---|---|
| Control API `127.0.0.1:8788/health` | 200 / `status=ok` |
| Gateway `127.0.0.1:8787/health` | 200 / `status=ok` |
| Caddy `/health` | 200 / 转发到 Control API |
| Web `127.0.0.1:8080/` | 200 / 标题“仟流智算” |
| 未登录 `/auth/me` | 401 / 可解释未登录响应 |
| PostgreSQL | running / healthy |
| Redis | running / healthy |
| Worker | running / healthy |
| Caddy / Control API / Gateway / Web | running |
| 启动后十分钟严重日志 | 0 |
| POOL-026 升级记录 | `SUCCEEDED` / migration `0037_client_identity` / artifact SHA 一致 |

## 保留验收项

- POOL-002：CC Switch + 仟流 Key 的独立 Codex 实际使用端 E2E 最后验收。
- POOL-027：使用真实 DeepSeek/智谱/Kimi 厂商凭证验证模型发现、选择、同步和异常分类；避免无必要调用造成费用。
- POOL-028：WorkBuddy、Codex、Z Code 三端真实请求，核对 Agent 家族、版本、来源、可信度、用量筛选和账本归因。
- 正式厂商计费对账、真实公网故障和生产规模观察不在本次部署冒烟中伪装为已完成。
