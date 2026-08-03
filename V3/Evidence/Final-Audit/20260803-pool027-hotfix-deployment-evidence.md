# POOL-027 热修 Mac Mini 发布证据

- 结果：`SUCCEEDED`
- 服务器：`stephen@192.168.1.40`
- release：`/Users/stephen/releases/qianliu-zhisuan-pool027-a49ca355-20260803`
- 上一 release：`/Users/stephen/releases/qianliu-zhisuan-pool015028-1cd8157b-20260803`
- 发布方式：复制上一生产 release，仅覆盖候选锁中的 5 个文件；服务器逐项 SHA-256 与
  本地候选锁一致后构建全部业务镜像。
- 数据库备份：
  `/Users/stephen/backups/qianliu-zhisuan/pre-pool027-20260803-201040.dump`
- 备份 SHA-256：
  `766052f4cd095578745dc5ca0202c0b163a707ca574b59d4850a943c86d5b688`
- 迁移：0 项；最新仍为 `0037_client_identity`。
- 停流：Caddy、Web、Gateway、Control API、Worker 停止后同批重建启动；PostgreSQL 数据卷
  与 Redis 保留，未出现新旧 Gateway 混跑。
- 健康：Control API、Gateway、Worker、PostgreSQL、Redis、Web、Caddy 均在线；公网
  `https://ic.qianliuai.com` 正常；严重启动日志 0。
- 当前 release 指针已原子切换。
- 回滚：将指针和 compose 切回上一 release；本次无迁移，通常不需恢复数据库。若需恢复
  业务快照，可使用上述发布前 PostgreSQL custom-format 备份。
- 未执行：Git commit、push、PR。

生产 POOL-027 业务复验详见
`V3/Evidence/Final-Audit/20260803-pool027028-business-acceptance.md`。
