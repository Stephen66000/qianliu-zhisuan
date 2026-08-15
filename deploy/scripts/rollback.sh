#!/usr/bin/env bash
# 仟流智算 2.0 回退脚本
#
# 用途：从 2.0 (迁移头 0049) 回退到升级前状态。
# 安全等级：DESTRUCTIVE（会重置数据库到备份点）
# 授权要求：运维 Owner 独立授权
#
# 使用方法：
#   bash scripts/rollback.sh <backup-file>
#   bash scripts/rollback.sh backups/pre-upgrade-20260813-120000.sql.gz
#
# 注意：
#   - 回退会丢失从备份点到回退执行之间的所有数据变更
#   - 回退前请先通知所有用户停止操作
#   - 回退后需重新构建旧版本镜像

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(dirname "$SCRIPT_DIR")"
COMPOSE_ARGS=(--env-file "$DEPLOY_DIR/.env" -f "$DEPLOY_DIR/compose.yaml" -f "$DEPLOY_DIR/compose.target.yaml")

compose() {
  docker compose "${COMPOSE_ARGS[@]}" "$@"
}

BACKUP_FILE="${1:-}"

if [ -z "$BACKUP_FILE" ]; then
  echo "ERROR: 请指定备份文件路径。"
  echo "  用法: bash scripts/rollback.sh <backup-file>"
  echo ""
  echo "  可用备份:"
  ls -lh "$DEPLOY_DIR"/backups/*.sql.gz 2>/dev/null || echo "  (无备份文件)"
  exit 1
fi

if [ ! -f "$BACKUP_FILE" ]; then
  echo "ERROR: 备份文件不存在: $BACKUP_FILE"
  exit 1
fi

if ! gzip -t "$BACKUP_FILE"; then
  echo "ERROR: 备份文件 gzip 校验失败: $BACKUP_FILE"
  exit 1
fi

BACKUP_DIR=$(cd "$(dirname "$BACKUP_FILE")" && pwd)
BACKUP_FILE="$BACKUP_DIR/$(basename "$BACKUP_FILE")"

echo "=========================================="
echo "  仟流智算 2.0 回退"
echo "  备份文件: $BACKUP_FILE"
echo "=========================================="
echo ""

# 确认
echo "⚠️  此操作将重置数据库到备份点，之后的全部数据变更将丢失。"
read -p "确认回退？输入 YES 继续: " CONFIRM
if [ "$CONFIRM" != "YES" ]; then
  echo "已取消。"
  exit 0
fi
echo ""

cd "$DEPLOY_DIR"

# ---- Step 1: 停止业务服务（保留 postgres） ----
echo "[Step 1] 停止业务服务..."
compose stop control-api gateway worker web caddy 2>/dev/null || true
echo "  ✓ 业务服务已停止"
echo ""

# ---- Step 2: 恢复数据库 ----
echo "[Step 2] 恢复数据库到备份点..."

# 检查 postgres 是否运行
POSTGRES_CONTAINER=$(compose ps -q postgres)
if [ -z "$POSTGRES_CONTAINER" ] || [ "$(docker inspect --format='{{.State.Running}}' "$POSTGRES_CONTAINER" 2>/dev/null || echo false)" != "true" ]; then
  echo "  启动 postgres..."
  compose up -d postgres
  sleep 5
fi

# 等待 postgres 就绪
POSTGRES_READY=0
for i in $(seq 1 30); do
  if compose exec -T postgres sh -ceu 'pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"' 2>/dev/null; then
    POSTGRES_READY=1
    break
  fi
  echo "  等待 PostgreSQL 就绪... ($i/30)"
  sleep 2
done
if [ "$POSTGRES_READY" -ne 1 ]; then
  echo "ERROR: PostgreSQL 未在等待窗口内就绪。"
  exit 2
fi

# 备份是完整逻辑库快照；先重建目标库，避免把 SQL 叠加到 2.0 库后仍残留新增表。
echo "  正在重建并恢复数据库..."
compose exec -T postgres sh -ceu '
  case "$POSTGRES_DB" in postgres|template0|template1) echo "拒绝恢复到系统数据库: $POSTGRES_DB" >&2; exit 1;; esac
  dropdb --if-exists --force -U "$POSTGRES_USER" "$POSTGRES_DB"
  createdb -U "$POSTGRES_USER" -O "$POSTGRES_USER" "$POSTGRES_DB"
'
gunzip -c "$BACKUP_FILE" | compose exec -T postgres \
  sh -ceu 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'

echo "  ✓ 数据库已恢复"
echo ""

# 完整备份已把 schema、迁移表和数据一起恢复到升级前状态；禁止再叠加 down。
echo "[Step 3] 验证恢复后的迁移头..."
RESTORED_HEAD=$(compose exec -T postgres sh -ceu \
  'psql -At -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "select name from kysely_migration order by timestamp desc limit 1"')
if [ "$RESTORED_HEAD" != "0045_zhipu_weekday_window_alias" ]; then
  echo "ERROR: 恢复后的迁移头不是当前 1.0 起点 0045: $RESTORED_HEAD"
  exit 3
fi
echo "  ✓ 迁移头已恢复到 $RESTORED_HEAD"

echo ""
echo "=========================================="
echo "  回退完成"
echo "  当前数据库状态: 已恢复到 $BACKUP_FILE"
echo "  如需重新升级: bash scripts/upgrade.sh"
echo "=========================================="
echo "migration_head_after_restore=$RESTORED_HEAD"
echo "result=PASS"
