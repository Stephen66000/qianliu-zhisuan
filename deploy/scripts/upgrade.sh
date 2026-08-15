#!/usr/bin/env bash
# 仟流智算 2.0 目标环境升级脚本
#
# 用途：在标准目标环境执行从当前 1.0 起点 (迁移头 0045) 到 2.0 (迁移头 0049) 的升级。
# 前提：deploy/.env 已配好真实 Secret（无 PLACEHOLDER），Docker Engine 已运行。
#
# 安全等级：SERVICE + DATA_MUTATION
# 授权要求：运维 Owner 独立授权
#
# 使用方法：
#   cd 仟流智算/deploy
#   bash scripts/upgrade.sh
#
# 退出码：
#   0 = 全部成功
#   1 = 前置检查失败
#   2 = 构建失败
#   3 = 迁移失败
#   4 = 健康检查失败

set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(dirname "$SCRIPT_DIR")"
REPO_DIR="$(dirname "$DEPLOY_DIR")"
COMPOSE_ARGS=(--env-file "$DEPLOY_DIR/.env" -f "$DEPLOY_DIR/compose.yaml" -f "$DEPLOY_DIR/compose.target.yaml")

compose() {
  docker compose "${COMPOSE_ARGS[@]}" "$@"
}

BASE_CANDIDATE_COMMIT="c1e780686518841f31737001c4521e2e9c813867"
RELEASE_FILES=(
  "deploy/caddy/Caddyfile.target"
  "deploy/compose.target.yaml"
  "deploy/scripts/rollback.sh"
  "deploy/scripts/upgrade.sh"
  "deploy/scripts/verify-target.sh"
  "deploy/target.env.example"
)

echo "=========================================="
echo "  仟流智算 2.0 目标环境升级"
echo "  基础候选: ${BASE_CANDIDATE_COMMIT:0:8}"
echo "=========================================="
echo ""

# ---- Step 0: 前置检查 ----
echo "[Step 0] 前置检查..."

for command_name in docker git curl gzip; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "ERROR: 缺少必需命令: $command_name"
    exit 1
  fi
done

RELEASE_COMMIT=$(git -C "$REPO_DIR" rev-parse HEAD)
if ! git -C "$REPO_DIR" merge-base --is-ancestor "$BASE_CANDIDATE_COMMIT" "$RELEASE_COMMIT"; then
  echo "ERROR: 当前发布版本不包含冻结的 W20-10 基础候选。"
  echo "  required base: $BASE_CANDIDATE_COMMIT"
  echo "  actual HEAD:   $RELEASE_COMMIT"
  exit 1
fi
RELEASE_COMMIT_COUNT=$(git -C "$REPO_DIR" rev-list --count "${BASE_CANDIDATE_COMMIT}..${RELEASE_COMMIT}")
if [ "$RELEASE_COMMIT_COUNT" -ne 1 ]; then
  echo "ERROR: W20-11 必须是基础候选之上的唯一一个发布叠加提交。"
  echo "  actual release commits: $RELEASE_COMMIT_COUNT"
  exit 1
fi

EXPECTED_RELEASE_CHANGES=$(printf 'A\t%s\n' "${RELEASE_FILES[@]}" | LC_ALL=C sort)
ACTUAL_RELEASE_CHANGES=$(git -C "$REPO_DIR" diff --name-status "$BASE_CANDIDATE_COMMIT" "$RELEASE_COMMIT" -- | LC_ALL=C sort)
if [ "$ACTUAL_RELEASE_CHANGES" != "$EXPECTED_RELEASE_CHANGES" ]; then
  echo "ERROR: 发布叠加提交不只包含冻结的 6 个 W20-11 部署文件。"
  echo "  actual changes:"
  printf '%s\n' "$ACTUAL_RELEASE_CHANGES"
  exit 1
fi
echo "  ✓ 发布 commit: $RELEASE_COMMIT"

# 构建使用 worktree 内容；除 HEAD/Tree 外，还要拒绝会进入镜像或基础编排的本地代码漂移。
CANDIDATE_PATHS=(
  ".dockerignore"
  ".npmrc"
  "package.json"
  "pnpm-lock.yaml"
  "pnpm-workspace.yaml"
  "tsconfig.base.json"
  "apps"
  "packages"
  "deploy/compose.yaml"
  "deploy/caddy/Caddyfile"
  "deploy/postgres-init"
)
if ! git -C "$REPO_DIR" diff --quiet HEAD -- "${CANDIDATE_PATHS[@]}"; then
  echo "ERROR: 候选构建路径存在未提交的已跟踪改动。"
  git -C "$REPO_DIR" status --short -- "${CANDIDATE_PATHS[@]}"
  exit 1
fi
UNTRACKED_CODE=$(git -C "$REPO_DIR" ls-files --others --exclude-standard -- apps packages)
if [ -n "$UNTRACKED_CODE" ]; then
  echo "ERROR: apps/packages 中存在未绑定到候选的未跟踪文件。"
  printf '%s\n' "$UNTRACKED_CODE"
  exit 1
fi

if [ ! -f "$DEPLOY_DIR/.env" ]; then
  echo "ERROR: deploy/.env 不存在。请先配置 Secret。"
  exit 1
fi

# 检查 .env 中是否有 PLACEHOLDER
if grep -q 'PLACEHOLDER' "$DEPLOY_DIR/.env"; then
  echo "ERROR: deploy/.env 中仍有 PLACEHOLDER 值。请替换为真实 Secret。"
  exit 1
fi

# 检查必填变量
REQUIRED_VARS=(
  "DEEPSEEK_API_KEY"
  "ZHIPU_CODING_TOKEN"
  "KIMI_CODING_TOKEN"
  "GATEWAY_KEY_PEPPER"
  "SESSION_AFFINITY_HMAC_KEY"
  "CREDENTIAL_KEK"
  "COOKIE_SECRET"
  "POSTGRES_DB"
  "POSTGRES_USER"
  "POSTGRES_PASSWORD"
  "WEB_ORIGIN"
  "QIANLIU_PUBLIC_HOST"
)
for var in "${REQUIRED_VARS[@]}"; do
  if ! grep -q "^${var}=" "$DEPLOY_DIR/.env" || grep -q "^${var}= *$" "$DEPLOY_DIR/.env"; then
    echo "ERROR: 必填变量 $var 未设置或为空。"
    exit 1
  fi
done

REQUIRED_EXACT=(
  "NODE_ENV=production"
  "CONTENT_RETENTION_MODE=METADATA_ONLY"
  "FEATURE_DIRECTORY_IMPORT=true"
  "FEATURE_USAGE_OVERVIEW_V2=true"
  "FEATURE_DEPARTMENT_COST=true"
  "FEATURE_RESOURCE_UTILIZATION_V2=true"
  "FEATURE_PROCUREMENT_REVIEW=true"
)
for assignment in "${REQUIRED_EXACT[@]}"; do
  if ! grep -qx "$assignment" "$DEPLOY_DIR/.env"; then
    echo "ERROR: 目标环境必须显式配置 $assignment"
    exit 1
  fi
done

if ! grep -Eq '^WEB_ORIGIN=https://' "$DEPLOY_DIR/.env"; then
  echo "ERROR: 标准目标环境 WEB_ORIGIN 必须使用 HTTPS。"
  exit 1
fi

PUBLIC_HOST=$(awk -F= '$1 == "QIANLIU_PUBLIC_HOST" {sub(/^[^=]*=/, ""); print; exit}' "$DEPLOY_DIR/.env")
if [[ ! "$PUBLIC_HOST" =~ ^[A-Za-z0-9.-]+$ ]] || [ "$PUBLIC_HOST" = "localhost" ]; then
  echo "ERROR: QIANLIU_PUBLIC_HOST 必须是标准目标环境域名（不含 scheme/path）。"
  exit 1
fi
if ! grep -qx "WEB_ORIGIN=https://${PUBLIC_HOST}" "$DEPLOY_DIR/.env"; then
  echo "ERROR: WEB_ORIGIN 必须与 QIANLIU_PUBLIC_HOST 对应。"
  exit 1
fi

if ! compose config --quiet; then
  echo "ERROR: Compose 目标环境配置解析失败。"
  exit 1
fi

echo "  ✓ .env 前置检查通过"
echo ""

# ---- Step 1: 数据库备份 ----
echo "[Step 1] 数据库备份（升级前快照）..."
BACKUP_TS=$(date +%Y%m%d-%H%M%S)
BACKUP_FILE="$DEPLOY_DIR/backups/pre-upgrade-$BACKUP_TS.sql.gz"
mkdir -p "$DEPLOY_DIR/backups"

# 目标环境升级必须基于正在运行的 1.0 数据库，禁止用空库替代升级验证。
if [ -z "$(compose ps -q postgres)" ]; then
  echo "ERROR: 未发现正在运行的 1.0 PostgreSQL；不能跳过升级前备份。"
  exit 1
fi

SOURCE_HEAD=$(compose exec -T postgres sh -ceu \
  'psql -At -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "select name from kysely_migration order by timestamp desc limit 1"')
if [ "$SOURCE_HEAD" != "0045_zhipu_weekday_window_alias" ]; then
  echo "ERROR: 当前数据库迁移头不是冻结的 1.0 升级起点: $SOURCE_HEAD"
  echo "  expected: 0045_zhipu_weekday_window_alias"
  exit 1
fi
echo "  ✓ 1.0 迁移头: $SOURCE_HEAD"

# 在容器内读取实际 POSTGRES_USER/POSTGRES_DB，避免脚本默认值与 Compose .env 分叉。
compose exec -T postgres \
  sh -ceu 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
  | gzip > "$BACKUP_FILE"

if [ ! -s "$BACKUP_FILE" ] || ! gzip -t "$BACKUP_FILE"; then
  echo "ERROR: 升级前备份为空或校验失败。"
  exit 1
fi

BACKUP_SIZE=$(du -h "$BACKUP_FILE" | cut -f1)
echo "  ✓ 备份完成: $BACKUP_FILE ($BACKUP_SIZE)"
echo ""

# ---- Step 2: 构建镜像 ----
echo "[Step 2] 构建业务镜像..."
cd "$DEPLOY_DIR"
if ! compose build; then
  echo "ERROR: 镜像构建失败。"
  exit 2
fi
echo "  ✓ 镜像构建完成"
echo ""

# ---- Step 3: 执行迁移 ----
echo "[Step 3] 执行数据库迁移 (→ 0049)..."

# 先启动 postgres
compose up -d postgres
sleep 3

# 等待 postgres 健康
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
  exit 3
fi

# 运行迁移
if ! compose run --rm migrate; then
  echo "ERROR: 数据库迁移失败。"
  echo "  可使用备份恢复: bash scripts/rollback.sh $BACKUP_FILE"
  exit 3
fi

UPGRADED_HEAD=$(compose exec -T postgres sh -ceu \
  'psql -At -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "select name from kysely_migration order by timestamp desc limit 1"')
if [ "$UPGRADED_HEAD" != "0049_resource_utilization_and_procurement_review" ]; then
  echo "ERROR: 升级后的迁移头不符合 Release Manifest: $UPGRADED_HEAD"
  echo "  可使用备份恢复: bash scripts/rollback.sh $BACKUP_FILE"
  exit 3
fi

echo "  ✓ 迁移完成 ($UPGRADED_HEAD)"
echo ""

# ---- Step 4: 启动全栈 ----
echo "[Step 4] 启动全部服务..."
compose up -d
sleep 10
echo "  ✓ 服务已启动"
echo ""

# ---- Step 5: 健康检查 ----
echo "[Step 5] 健康检查..."

HEALTH_FAIL=0

# 等待 Caddy 取得证书并验证公开 HTTPS 入口。
CONTROL_READY=0
GATEWAY_READY=0
for i in $(seq 1 60); do
  if curl -fsS --max-time 5 "https://${PUBLIC_HOST}/api/health" >/dev/null 2>&1; then CONTROL_READY=1; fi
  if curl -fsS --max-time 5 "https://${PUBLIC_HOST}/gateway-health" >/dev/null 2>&1; then GATEWAY_READY=1; fi
  if [ "$CONTROL_READY" -eq 1 ] && [ "$GATEWAY_READY" -eq 1 ]; then break; fi
  echo "  等待 HTTPS 健康入口... ($i/60)"
  sleep 2
done
if [ "$CONTROL_READY" -eq 1 ]; then echo "  ✓ control-api HTTPS /api/health"; else echo "  ✗ control-api HTTPS FAILED"; HEALTH_FAIL=1; fi
if [ "$GATEWAY_READY" -eq 1 ]; then echo "  ✓ gateway HTTPS /gateway-health"; else echo "  ✗ gateway HTTPS FAILED"; HEALTH_FAIL=1; fi

# worker (容器内部健康检查)
WORKER_CONTAINER=$(compose ps -q worker)
WORKER_HEALTH=$(docker inspect --format='{{.State.Health.Status}}' "$WORKER_CONTAINER" 2>/dev/null || echo "unknown")
if [ "$WORKER_HEALTH" = "healthy" ]; then
  echo "  ✓ worker health"
else
  echo "  ✗ worker health: $WORKER_HEALTH"
  HEALTH_FAIL=1
fi

if [ $HEALTH_FAIL -ne 0 ]; then
  echo ""
  echo "ERROR: 健康检查未全部通过。"
  echo "  排查: docker compose -f compose.yaml -f compose.target.yaml logs --tail=50"
  echo "  回退: bash scripts/rollback.sh $BACKUP_FILE"
  exit 4
fi

echo ""
echo "=========================================="
echo "  升级完成"
echo "  备份文件: $BACKUP_FILE"
echo "  如需回退: bash scripts/rollback.sh $BACKUP_FILE"
echo "=========================================="
echo "migration_head_after_upgrade=$UPGRADED_HEAD"
echo "result=PASS"
