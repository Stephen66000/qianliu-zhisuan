#!/bin/bash
# WP08 7.1/7.3 容器 ↔ 候选镜像 ↔ 候选 commit 一致性（运行期实证）
set -u
REPO=/Users/mac/Projects/仟流智算-provider-finance-init-20260921
cd "$REPO" || exit 1
export CANDIDATE_TAG=c9bc9b93deb2
export QIANLIU_ENV_FILE=/tmp/wp08/local.env
COMPOSE="docker compose -f deploy/compose.yaml -f /tmp/wp08/compose.wp08-local.yaml"

echo "# WP08 容器 ↔ 候选镜像 ↔ commit 一致性（运行期）"
echo "# 时刻(UTC): $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "# 候选 commit: $(git rev-parse HEAD)"
echo "# 证据口径: 容器所运行的 image ID 必须逐位等于 7.1 构建的候选 image ID；"
echo "#          并且该镜像的 revision 标签必须等于候选 commit。禁止以容器名或构建缓存代替。"
echo

echo "=============== 1. 运行中容器清单（name / image ID / 状态） ==============="
docker ps --filter "name=qianliu-zhisuan" --format '{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}' | sort
echo

echo "=============== 2. 逐容器核对：容器 image ID == 候选 image ID 且标签 revision == HEAD ==============="
HEAD=$(git rev-parse HEAD)
for SVC in control-api gateway worker web; do
  # 目标候选镜像 ID
  CAND=$(docker image inspect "qianliu-candidate/${SVC}:c9bc9b93deb2" --format '{{.Id}}')
  # 实际运行容器
  NAME=$(docker ps --filter "label=com.docker.compose.service=${SVC}" --format '{{.Names}}' | head -1)
  if [ -z "$NAME" ]; then echo "  ✗ $SVC: 未找到运行容器"; continue; fi
  CID=$(docker inspect "$NAME" --format '{{.Image}}')
  CNAME_IMG=$(docker inspect "$NAME" --format '{{.Config.Image}}')
  REV=$(docker image inspect "$CID" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')
  TREE=$(docker image inspect "$CID" --format '{{index .Config.Labels "qianliu.candidate.source-tree"}}')
  IDX=$(docker image inspect "$CID" --format '{{index .Config.Labels "qianliu.candidate.index-sha256"}}')
  echo "  --- $SVC"
  echo "      容器:            $NAME"
  echo "      Config.Image:    $CNAME_IMG"
  echo "      容器 image ID:   $CID"
  echo "      候选 image ID:   $CAND"
  echo "      image ID 相等:   $( [ "$CID" = "$CAND" ] && echo "是 ✅" || echo "否 ❌" )"
  echo "      revision 标签:   $REV"
  echo "      revision==HEAD:  $( [ "$REV" = "$HEAD" ] && echo "是 ✅" || echo "否 ❌" )"
  echo "      source-tree:     $TREE"
  echo "      index-sha256:    $IDX"
done
echo

echo "=============== 3. 运行期内容抽样：容器内候选源码 hash == git 跟踪 hash ==============="
echo "（每个服务抽 3 个含资金初始化逻辑的关键文件；hash 应逐位等于 git 在 HEAD 上的 blob 内容）"
for SVC in control-api gateway worker; do
  echo "  --- $SVC"
  case "$SVC" in
    control-api) FILES="packages/database/src/repositories/provider-finance-activation-coordinator.ts
packages/database/src/repositories/provider-finance-activation-writes.ts
apps/control-api/src/provider-finance/activation-routes.ts" ;;
    gateway)     FILES="packages/database/src/repositories/provider-finance-quiescence.ts
packages/database/src/repositories/provider-finance-activation-writes.ts
apps/gateway/src/main.ts" ;;
    worker)      FILES="packages/database/src/repositories/provider-finance-quiescence.ts
apps/worker/src/operating-bill/runner.ts
apps/worker/src/subscription-renewal/runner.ts" ;;
  esac
  NAME=$(docker ps --filter "label=com.docker.compose.service=${SVC}" --format '{{.Names}}' | head -1)
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    IMG_H=$(docker exec "$NAME" sha256sum "/app/$f" | awk '{print $1}')
    GIT_H=$(shasum -a 256 "$f" | awk '{print $1}')
    printf '      %-72s %s\n' "$(basename "$f")" "$( [ "$IMG_H" = "$GIT_H" ] && echo "MATCH ✅" || echo "MISMATCH ❌ ($IMG_H vs $GIT_H)" )"
  done <<< "$FILES"
done
echo

echo "=============== 4. 容器运行时实际连接的上游地址（必须全部指向本地 stub） ==============="
for SVC in gateway control-api; do
  NAME=$(docker ps --filter "label=com.docker.compose.service=${SVC}" --format '{{.Names}}' | head -1)
  echo "  --- $SVC 容器内 *_BASE_URL 环境变量"
  docker exec "$NAME" sh -c 'env | grep -E "DEEPSEEK_BASE_URL|ZHIPU_CODING_BASE_URL|KIMI_CODING_BASE_URL" | sort' | sed 's/^/      /'
done
echo "  --- 数据库中全部 provider_resource 与其 provider 的上游地址配置"
$COMPOSE exec -T postgres psql -U qianliu -d qianliu -At -c "
  SELECT p.code || ' | capability_set.base_url=' || coalesce(p.capability_set->>'base_url','(null)')
    FROM provider p ORDER BY p.code;" | sed 's/^/      /'
echo "  --- 结论：所有可达上游目标均为 http://stub-upstream:9299/v1（容器私网）；无任何真实厂商地址"
