#!/bin/sh
# WP08 7.1 候选镜像摘要采集（只读）— I1 整改后新 HEAD 重建版
# 与冻结原件 wp08-scripts/image-digests.sh 的差异：仅候选 commit/tree/索引摘要与镜像标签改为
# 新 HEAD（94482f06e5ac69a80357b6e17b9786f7690265c4）。参数含义与采集项逐项保持一致。
set -u
echo "# WP08 7.1 候选镜像摘要（本地构建，未推送任何 registry）— I1 整改后重建"
echo "# 采集时刻(UTC): $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "# 候选 commit: 94482f06e5ac69a80357b6e17b9786f7690265c4"
echo "# 候选 tree:   fb1212dba13963014cef18da4ed6fd7457c51b48"
echo "# 索引摘要:    4f14d9dde58ef0157c8ba34b2b80333f289b922e392870ee6358ab7c78c41d15"
echo "# VERSION:     2.5.8"
echo "# 宿主平台:    $(docker version --format '{{.Server.Os}}/{{.Server.Arch}}')"
echo
echo "## docker images（候选仓库:标签 / ID / 大小）"
docker images --format '{{.Repository}}:{{.Tag}}  ID={{.ID}}  Size={{.Size}}' | grep '^qianliu-candidate/' | sort
echo
for SVC in control-api gateway worker web; do
  IMG="qianliu-candidate/${SVC}:94482f06e5ac"
  echo "=================================================================="
  echo "### $SVC"
  echo "------------------------------------------------------------------"
  echo "-- image ID / Created / Size / Platform"
  docker image inspect "$IMG" --format 'ID={{.Id}}
Created={{.Created}}
Size={{.Size}}
Architecture={{.Architecture}}
Os={{.Os}}'
  echo "-- RepoDigests（本地构建应为 []，证明未推送 registry）"
  docker image inspect "$IMG" --format '{{json .RepoDigests}}'
  echo "-- 候选回执标签（revision / version / source-tree / index-sha256）"
  docker image inspect "$IMG" --format '{{json .Config.Labels}}'
  echo "-- 层 diffID（构建产物逐层指纹，可比对复现）"
  docker image inspect "$IMG" --format '{{json .RootFS.Layers}}'
  echo "-- 入口 / 暴露端口 / 工作目录"
  docker image inspect "$IMG" --format 'Entrypoint={{json .Config.Entrypoint}}
Cmd={{json .Config.Cmd}}
ExposedPorts={{json .Config.ExposedPorts}}
WorkDir={{.Config.WorkingDir}}'
  echo
done
echo "=================================================================="
echo "## 基础镜像 digest（与 deploy/compose.yaml 的锁定值比对）"
for REF in "postgres:17-alpine@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193" \
           "redis:8-alpine@sha256:8096655e437712b07503796fb64d81359256cfcff0ab29d95a7da72863786efb" \
           "node:22.17.1-alpine" "nginx:1.27-alpine" "caddy:2.9-alpine"; do
  printf '%s\n' "$REF"
  docker image inspect "$REF" --format '  ID={{.Id}}  Created={{.Created}}' 2>&1 | head -2
done
