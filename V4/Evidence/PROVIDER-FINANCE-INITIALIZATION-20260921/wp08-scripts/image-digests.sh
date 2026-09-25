#!/bin/sh
# WP08 7.1 候选镜像摘要采集（只读）
set -u
echo "# WP08 7.1 候选镜像摘要（本地构建，未推送任何 registry）"
echo "# 采集时刻(UTC): $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "# 候选 commit: c9bc9b93deb2c535d95346f7da4a9b141604441f"
echo "# 候选 tree:   f9bc02baf7f3260cce3f0edb706fa7e5287b1aef"
echo "# 索引摘要:    30da0d46dc216bf54bda50cd7c6ff0e306498cb692678343b3f2e532104f262c"
echo "# 宿主平台:    $(docker version --format '{{.Server.Os}}/{{.Server.Arch}}')"
echo
echo "## docker images（候选仓库:标签 / ID / 大小）"
docker images --format '{{.Repository}}:{{.Tag}}  ID={{.ID}}  Size={{.Size}}' | grep '^qianliu-candidate/' | sort
echo
for SVC in control-api gateway worker web; do
  IMG="qianliu-candidate/${SVC}:c9bc9b93deb2"
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
  echo "-- 候选回执标签（revision / source-tree / index-sha256）"
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
