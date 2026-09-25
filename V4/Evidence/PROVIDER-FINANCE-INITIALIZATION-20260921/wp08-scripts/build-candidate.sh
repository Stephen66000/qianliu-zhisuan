#!/bin/sh
# WP08 7.1 本地不可变候选镜像构建（仅本机，不推送）
set -u
REPO=/Users/mac/Projects/仟流智算-provider-finance-init-20260921
cd "$REPO" || exit 1

HEAD_FULL=$(git rev-parse HEAD)
HEAD_SHORT=$(git rev-parse --short=12 HEAD)
TREE=$(git rev-parse 'HEAD^{tree}')
INDEX_DIGEST=$(git ls-files -s | LC_ALL=C sort | shasum -a 256 | awk '{print $1}')
VERSION=$(cat VERSION)
TAGBASE="qianliu-candidate"
TAG="${TAGBASE}/PLACEHOLDER:${HEAD_SHORT}"

echo "# WP08 7.1 候选镜像构建（本地，不推送、不登录任何 registry）"
echo "# 构建时刻(UTC): $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "# 构建上下文: $REPO （deploy/compose.yaml 声明的 context=.. 即仓库根）"
echo "# 候选 commit: $HEAD_FULL"
echo "# 候选 tree:   $TREE"
echo "# 索引摘要:    $INDEX_DIGEST"
echo "# VERSION:     $VERSION"
echo "# 平台:        $(docker version --format '{{.Server.Os}}/{{.Server.Arch}}')"
echo

LABELS="--label org.opencontainers.image.revision=$HEAD_FULL \
--label org.opencontainers.image.version=$VERSION \
--label org.opencontainers.image.title=qianliu-zhisuan \
--label qianliu.candidate.change=provider-finance-initialization \
--label qianliu.candidate.workpackage=WP08 \
--label qianliu.candidate.source-tree=$TREE \
--label qianliu.candidate.index-sha256=$INDEX_DIGEST"

for SVC in control-api gateway worker web; do
  IMG="${TAGBASE}/${SVC}:${HEAD_SHORT}"
  DF="apps/${SVC}/Dockerfile"
  echo "=================================================================="
  echo "### 构建 $SVC"
  echo "### image: $IMG"
  echo "### dockerfile: $DF   context: ."
  echo "### 起始: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "=================================================================="
  # shellcheck disable=SC2086
  docker build --no-cache -f "$DF" -t "$IMG" $LABELS . 2>&1
  echo "BUILD_${SVC}_EXIT=$?"
  echo "### 结束: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo
done

echo "=================================================================="
echo "### 全部构建完成: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
docker images --format '{{.Repository}}:{{.Tag}}  ID={{.ID}}  Created={{.CreatedSince}}  Size={{.Size}}' | grep "qianliu-candidate" | sort
