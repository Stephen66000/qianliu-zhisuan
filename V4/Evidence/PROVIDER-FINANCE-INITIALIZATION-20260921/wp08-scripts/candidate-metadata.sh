#!/bin/sh
# WP08 7.1 候选元数据采集（只读）
set -u
cd /Users/mac/Projects/仟流智算-provider-finance-init-20260921 || exit 1
H256() { shasum -a 256 "$@"; }

echo "# WP08 7.1 本地不可变候选元数据（deployment candidate receipt）"
echo "# 生成时刻(UTC): $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "# 生成主机: $(uname -srm)"
echo "# docker: $(docker version --format '{{.Server.Version}}' 2>/dev/null)"
echo
echo "## 候选 commit（工作树 HEAD）"
echo "HEAD_FULL=$(git rev-parse HEAD)"
echo "HEAD_SHORT=$(git rev-parse --short=12 HEAD)"
echo "BRANCH=$(git rev-parse --abbrev-ref HEAD)"
echo "TREE=$(git rev-parse 'HEAD^{tree}')"
echo "SUBJECT=$(git log -1 --pretty=%s)"
echo
echo "## worktree 干净性（候选有效性前提）"
STATUS="$(git status --porcelain)"
if [ -z "$STATUS" ]; then echo "WORKTREE=clean"; else echo "WORKTREE=dirty"; echo "$STATUS"; fi
echo
echo "## VERSION"
echo "VERSION=$(cat VERSION)"
echo
echo "## 构建输入哈希（sha256）"
H256 package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json VERSION .dockerignore deploy/compose.yaml deploy/compose.target.yaml
echo
echo "## 四个 Dockerfile 哈希"
H256 apps/control-api/Dockerfile apps/gateway/Dockerfile apps/worker/Dockerfile apps/web/Dockerfile
echo
echo "## 迁移头（最近 4 个）"
ls packages/database/migrations/ | tail -4
echo
echo "## 候选源码树内容指纹（git 索引：mode+oid+path 全量摘要）"
git ls-files -s | LC_ALL=C sort | shasum -a 256
echo "TRACKED_FILES=$(git ls-files | wc -l | tr -d ' ')"
echo
echo "## 受版本控制的构建输入（进镜像的路径集合）"
echo "PACKAGES_TRACKED=$(git ls-files packages | wc -l | tr -d ' ')"
echo "APPS_CONTROL_API_TRACKED=$(git ls-files apps/control-api | wc -l | tr -d ' ')"
echo "APPS_GATEWAY_TRACKED=$(git ls-files apps/gateway | wc -l | tr -d ' ')"
echo "APPS_WORKER_TRACKED=$(git ls-files apps/worker | wc -l | tr -d ' ')"
echo "APPS_WEB_TRACKED=$(git ls-files apps/web | wc -l | tr -d ' ')"
echo
echo "## 构建上下文大小（.dockerignore 生效后的实际上下文，由 docker build 报告）"
echo "（见 8.1-build-<svc>.log 的 'transferring context' 行）"
