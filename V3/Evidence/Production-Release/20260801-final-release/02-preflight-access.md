# Mac Mini 发布前连通性核对

- 检查时间：2026-08-01 15:00～15:47 CST
- 检查性质：先只读核对准确目标，再完成迁移前备份；此文件不记录 Secret 值

## 结果

- 公网 `https://gw.qianliuai.com/health`：HTTP 200，`service=gateway`。
- Tailscale `100.91.119.91:22`：当前本机 Tailscale 服务未运行，不可达。
- UU 历史 SSH 映射 `47.111.66.55:6022/16022`：已删除，当前不可达。
- 局域网地址 `192.168.1.40`：当前客户端不在同一网段，不可达。
- Owner 明确授权临时 SSH 映射；通过 UU 建立本机 `127.0.0.1:26024` →
  Mac Mini 局域网 `192.168.1.40:22` 的临时映射，SSH 主机密钥严格校验通过。
- 主机：`stephendeMac-mini.local` / `arm64`；磁盘 `460Gi`，可用约 `297Gi`。
- 发布前 Release：`/Users/stephen/releases/qianliu-zhisuan-pool013-20260731-222133`。
- 发布前数据库版本：`0029_provider_quota_auto_calculation`，前序为 `0028`、`0027`。
- 发布前容器：Web、Gateway、Control API、PostgreSQL、Caddy、Redis 均运行，
  `RestartCount=0`；Worker 尚未部署。
- 本机 Web、Gateway、Control API 和公网 Gateway 健康检查均为 HTTP 200。
- `.env` 及 PostgreSQL、Gateway、会话、凭证加密、Cookie 必需变量均存在；
  只核对存在性，没有输出值。

## 迁移前备份与回滚点

- 备份：`/Users/stephen/仟流智算-backups/final-pre-dd80e975-20260801-154700.sql.gz`
- 大小：`85339` bytes；SHA-256：
  `922c7ea57808d5fe01cbd788d5e8baa639f10763a3c86cd4a6ccafba01051c52`
- 验证：文件存在、非空、可读，`gzip -t` 通过；备份发生在任何迁移之前。
- 回滚点：上述数据库备份 + 旧 Release 路径 + 已冻结的旧应用镜像
  `qianliu-rollback-dd80e975-{control-api,gateway,web}:pool013`。
- 恢复必须先停 Gateway、Control API、Worker 与 Caddy 写入口，在明确回滚决定后重建
  目标数据库，再执行：

```bash
gzip -dc /Users/stephen/仟流智算-backups/final-pre-dd80e975-20260801-154700.sql.gz \
  | docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"
```

恢复命令中的环境变量只在 Mac Mini 现有 `.env` 内解析，不在 Evidence 中保存值。
