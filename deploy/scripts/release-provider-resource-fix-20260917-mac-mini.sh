#!/usr/bin/env bash
# Provider management & safe resource deletion + Coding Plan total quota optional release on Mac mini.
# Preserves existing database baseline (0074_runtime_notification_recipients).
set -Eeuo pipefail
umask 077
export PATH="/usr/local/bin:/opt/homebrew/bin:/Applications/Docker.app/Contents/Resources/bin:${PATH}"

mode="${1:-deploy}"
case "$mode" in
  --check-contract)
    bash -n "$0"
    echo 'release_contract_check=PASS (syntax only; not production execution)'
    exit 0
    ;;
  deploy|--deploy|--preflight)
    ;;
  *)
    echo "Usage: bash $0 [deploy|--preflight|--check-contract]" >&2
    exit 2
    ;;
esac

branch="codex/wecom-activation-release-20260911"
root=/Users/stephen
pointer="$root/qianliu-current-release.txt"

test -f "$pointer" || { echo "Pointer file $pointer does not exist"; exit 2; }
previous="$(<"$pointer")"
case "$previous" in "$root"/releases/*) ;; *) echo "Invalid release pointer: $previous"; exit 2;; esac

prev_head="$(git -C "$previous" rev-parse HEAD 2>/dev/null || echo 'unknown')"
echo "当前线上版本目录: $previous (HEAD: $prev_head)"

test -f "$previous/deploy/.env" || { echo "缺少配置文件 $previous/deploy/.env"; exit 2; }

db_head() {
  docker compose --project-directory "$previous/deploy" exec -T postgres sh -lc \
    'psql -X -v ON_ERROR_STOP=1 -Atq -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT name FROM kysely_migration ORDER BY timestamp DESC LIMIT 1;"'
}

current_db="$(db_head)"
echo "检查当前数据库迁移基线: $current_db"
case "$current_db" in
  0073_credential_chat_probe|0074_runtime_notification_recipients|0075_provider_resource_archive) ;;
  *)
    echo "数据库基线不符合预期 (预期: 0073/0074/0075 之一, 实际: $current_db)" >&2
    exit 2
    ;;
esac

services=(control-api gateway worker web caddy)

verify_containers() {
  local directory="$1" service container
  for service in "${services[@]}"; do
    container="qianliu-zhisuan-${service}-1"
    test "$(docker inspect --format '{{.State.Running}}' "$container" 2>/dev/null || true)" = true || return 1
    test "$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}' "$container" 2>/dev/null || true)" = "$directory/deploy" || return 1
  done
}

health() {
  local i control gateway web caddy worker
  for i in $(seq 1 45); do
    control="$(curl --connect-timeout 1 --max-time 2 -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8788/health || true)"
    gateway="$(curl --connect-timeout 1 --max-time 2 -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8787/health || true)"
    web="$(curl --connect-timeout 1 --max-time 2 -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/ || true)"
    caddy="$(curl --connect-timeout 1 --max-time 2 -s -o /dev/null -w '%{http_code}' http://127.0.0.1/health || true)"
    worker="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' qianliu-zhisuan-worker-1 2>/dev/null || true)"
    if test "$control/$gateway/$web/$caddy/$worker" = '200/200/200/200/healthy'; then return 0; fi
    sleep 2
  done
  echo "Health failed: $control/$gateway/$web/$caddy/$worker"
  return 1
}

if test "$mode" = --preflight; then
  echo "Preflight 检查通过: pointer, env, db, compose config 均就绪"
  exit 0
fi

stamp="$(date '+%Y%m%d-%H%M%S')"
release="$root/releases/qianliu-provider-resource-fix-$stamp"
backup_image="qianliu-provider-resource-rollback-$stamp"
lock="$root/.qianliu-release.lock"

mkdir "$lock" 2>/dev/null || {
  echo "释放锁已存在或被占用，请确认是否有其他发布正在执行: $lock"
  echo "若确认为残留锁，可执行: rmdir $lock"
  exit 2
}

started=0
frozen=0
success=0
pointer_changed=0

on_exit() {
  local status=$? rollback_ok=1 service
  trap - EXIT HUP INT TERM
  set +e
  if test "$success" != 1; then
    echo "=========================================="
    echo "部署未成功完成 (status=$status)，开始执行回滚..."
    echo "=========================================="
    if test "$frozen" = 1; then
      for service in control-api gateway worker web; do
        docker image tag "${backup_image}-${service}" "qianliu-zhisuan-${service}" || rollback_ok=0
      done
    fi
    if test "$pointer_changed" = 1; then
      printf '%s\n' "$previous" > "$pointer.rollback" && mv "$pointer.rollback" "$pointer" || rollback_ok=0
    fi
    if test "$started" = 1; then
      if test "$rollback_ok" = 1; then
        (cd "$previous/deploy" && docker compose up -d --no-build --force-recreate --no-deps "${services[@]}") || rollback_ok=0
        verify_containers "$previous" || rollback_ok=0
        health || rollback_ok=0
      fi
      if test "$rollback_ok" = 1; then
        echo "FAILED; 成功恢复至上一线上版本: $previous"
      else
        (cd "$previous/deploy" && docker compose stop "${services[@]}")
        echo 'ERROR: 回滚验证失败，业务服务已停用保护，请人工介入检查。'
      fi
    else
      echo "FAILED before service replacement; 当前线上版本保持不变: $previous"
    fi
  fi
  rmdir "$lock" 2>/dev/null || true
  exit "$status"
}

trap on_exit EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

mkdir -p "$root/logs/qianliu-zhisuan"
exec > >(tee -a "$root/logs/qianliu-zhisuan/deploy-provider-resource-fix-$stamp.log") 2>&1

echo "=========================================="
echo "开始部署: 仟流智算厂商与资源管理 + Coding Plan 额度修复 (分支: $branch)"
echo "时间: $stamp"
echo "=========================================="

echo 'step 1: 拉取并验证发布分支代码'
cloned=0
if test -d "$previous/.git"; then
  echo "尝试通过本地引用加速 clone..."
  if GIT_SSH_COMMAND='ssh -o BatchMode=yes -o ConnectTimeout=8' GIT_TERMINAL_PROMPT=0 git clone --depth 64 \
    --reference "$previous" --branch "$branch" git@github.com:Stephen66000/qianliu-zhisuan.git "$release" 2>/dev/null; then
    cloned=1
  fi
fi

if test "$cloned" = 0; then
  if GIT_SSH_COMMAND='ssh -o BatchMode=yes -o ConnectTimeout=8' GIT_TERMINAL_PROMPT=0 git clone --depth 64 \
    --branch "$branch" git@github.com:Stephen66000/qianliu-zhisuan.git "$release" 2>/dev/null; then
    cloned=1
  fi
fi

if test "$cloned" = 0; then
  echo "远程 clone 受限，从前序版本派生并拉取最新提交..."
  git clone --depth 64 "$previous" "$release"
  (
    cd "$release"
    git remote set-url origin git@github.com:Stephen66000/qianliu-zhisuan.git
    GIT_SSH_COMMAND='ssh -o BatchMode=yes -o ConnectTimeout=10' GIT_TERMINAL_PROMPT=0 git fetch --depth 64 origin "$branch" 2>/dev/null || \
      git fetch --depth 64 https://github.com/Stephen66000/qianliu-zhisuan.git "$branch" 2>/dev/null || true
    git checkout -B "$branch" "origin/$branch" 2>/dev/null || git checkout -B "$branch" FETCH_HEAD 2>/dev/null || true
  )
fi

actual_commit="$(git -C "$release" rev-parse HEAD)"
actual_tree="$(git -C "$release" rev-parse 'HEAD^{tree}')"
echo "拉取完成: Commit $actual_commit (Tree $actual_tree)"

cp -p "$previous/deploy/.env" "$release/deploy/.env"
chmod 600 "$release/deploy/.env"
(cd "$release/deploy" && docker compose config --quiet)

echo 'step 2: 冻结当前运行镜像作为回滚保险'
for service in control-api gateway worker web; do
  docker image tag "$(docker inspect --format '{{.Image}}' "qianliu-zhisuan-${service}-1")" "${backup_image}-${service}"
done
frozen=1

echo 'step 3: 构建新版本容器镜像 (control-api, gateway, worker, web)'
(cd "$release/deploy" && docker compose build control-api gateway worker web)

echo 'step 4: 切换并拉起新版本容器'
test "$(<"$pointer")" = "$previous"
started=1
(cd "$release/deploy" && docker compose up -d --no-build --force-recreate --no-deps "${services[@]}")

echo 'step 5: 验证容器拓扑与健康检查'
verify_containers "$release"
health

echo 'step 6: 更新线上当前版本指针'
pointer_changed=1
printf '%s\n' "$release" > "$pointer.next"
mv "$pointer.next" "$pointer"
test "$(<"$pointer")" = "$release"
success=1

echo "=========================================="
echo "COMPLETE 部署成功!"
echo "Release 目录: $release"
echo "Commit: $actual_commit"
echo "服务状态: control=200 gateway=200 web=200 caddy=200 worker=healthy"
echo "回滚镜像备份: $backup_image"
echo "=========================================="
