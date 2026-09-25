#!/bin/bash
# WP08 7.1 本地容器 / 路由 / 公开接口验证（仅回环；不开放公网端口）
set -u
REPO=/Users/mac/Projects/仟流智算-provider-finance-init-20260921
cd "$REPO" || exit 1
export CANDIDATE_TAG=c9bc9b93deb2
export QIANLIU_ENV_FILE=/tmp/wp08/local.env

req() { # method url [extra curl args...]
  local M=$1 U=$2; shift 2
  curl -s -o /tmp/wp08/.body -w '%{http_code}' -X "$M" "$U" "$@" || echo "000"
}

echo "# WP08 7.1 本地容器 / 路由 / 公开接口验证"
echo "# 时刻(UTC): $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "# 口径: 仅 127.0.0.1；不开放公网端口；上游仅 stub；所有业务调用均为未认证只读探测（不含任何会话凭证）"
echo

echo "=============== 1. 发布端口全部位于回环（无 0.0.0.0 / 无 ::: 绑定） ==============="
docker ps --filter "name=qianliu-zhisuan" --format '{{.Names}}\t{{.Ports}}' | sort | sed 's/^/  /'
echo
echo "-- 主机侧监听套接字（仅统计本项目端口；列出非回环绑定，应为空）"
for p in 5433 6380 8080 8081 8787 8788 9299; do
  L=$(lsof -nP -iTCP:"$p" -sTCP:LISTEN 2>/dev/null | awk 'NR>1{print $9}' | sort -u | tr '\n' ' ')
  printf '  :%-6s %s\n' "$p" "${L:-<无监听>}"
done
echo "  说明：以上地址集合若全部形如 127.0.0.1:*，即无公网暴露。80/443 未发布（caddy 已改为 127.0.0.1:8081->80）。"
echo

echo "=============== 2. 直连 control-api（127.0.0.1:8788） ==============="
C=$(req GET http://127.0.0.1:8788/health); echo "  GET /health            -> ${C}  $(cat /tmp/wp08/.body)"
C=$(req GET http://127.0.0.1:8788/provider-finance/summary); echo "  GET /provider-finance/summary -> ${C}（401=鉴权前缀生效，非 404）$(cat /tmp/wp08/.body)"
echo

echo "=============== 3. 直连 gateway（127.0.0.1:8787） ==============="
C=$(req GET http://127.0.0.1:8787/health); echo "  GET /health            -> ${C}  $(cat /tmp/wp08/.body)"
C=$(req GET http://127.0.0.1:8787/v1/models); echo "  GET /v1/models（无 Key）-> ${C}  $(head -c 200 /tmp/wp08/.body)"
echo

echo "=============== 4. 直连 web（127.0.0.1:8080）：SPA + /api 反代 ==============="
C=$(req GET http://127.0.0.1:8080/); echo "  GET /                  -> ${C}  content-type=$(curl -s -o /dev/null -w '%{content_type}' http://127.0.0.1:8080/) 首行=$(head -c 60 /tmp/wp08/.body | tr -d '\n')"
C=$(req GET http://127.0.0.1:8080/api/health); echo "  GET /api/health        -> ${C}  $(cat /tmp/wp08/.body)   （应为 control-api 的 health，证明 nginx 反代命中）"
C=$(req GET http://127.0.0.1:8080/some/spa/route); echo "  GET /some/spa/route    -> ${C}（SPA fallback 到 index.html）"
echo

echo "=============== 5. 经 caddy 统一入口（127.0.0.1:8081）分流验证 ==============="
C=$(req GET http://127.0.0.1:8081/health); echo "  GET /health（→ control-api）       -> ${C}  $(cat /tmp/wp08/.body)"
C=$(req GET http://127.0.0.1:8081/v1/models); echo "  GET /v1/models（→ gateway）        -> ${C}  $(head -c 160 /tmp/wp08/.body)"
C=$(req GET http://127.0.0.1:8081/provider-finance/summary); echo "  GET /provider-finance/summary（→ control-api）-> ${C}  $(head -c 160 /tmp/wp08/.body)"
echo

echo "=============== 6. worker 健康端点（容器私网，不发布端口） ==============="
W=$(docker ps --filter "label=com.docker.compose.service=worker" --format '{{.Names}}' | head -1)
echo "  docker exec $W wget -qO- http://127.0.0.1:9191/health"
docker exec "$W" sh -c 'wget -qO- http://127.0.0.1:9191/health' 2>&1 | sed 's/^/  /'
echo "  （worker 无 published 端口：见第 1 节 docker ps 输出）"
echo

echo "=============== 7. stub 上游可观测性（证明它是唯一上游且当前零命中） ==============="
echo "  GET http://127.0.0.1:9299/__stats"
curl -s http://127.0.0.1:9299/__stats | sed 's/^/  /'
echo
echo "  stub 容器日志（首 3 行）"
docker logs qianliu-zhisuan-stub-upstream-1 2>&1 | head -3 | sed 's/^/  /'
echo

echo "# 结束(UTC): $(date -u +%Y-%m-%dT%H:%M:%SZ)"
