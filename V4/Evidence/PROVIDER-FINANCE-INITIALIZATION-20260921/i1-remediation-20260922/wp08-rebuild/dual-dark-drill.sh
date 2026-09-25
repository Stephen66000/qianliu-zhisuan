#!/bin/bash
# WP08 7.2 双端停写演练（PFA-08）：Control API 与 Worker 同时 DARK
#
# 断言口径：
#   * 写入口（充值/开账/套餐/自动续订取消/冲销/激活/静默租约）在 DARK 下必须被门禁拦下，
#     且响应体为门禁口径「资金写入口尚未启用」（404）——不能仅凭状态码判定，
#     因为资源不存在等业务分支同样返回 404。
#   * 读接口按合同保留（不返回门禁体，返回业务结果或鉴权/参数错误）。
#   * strict_writes_enabled 与既有资金事实在切换前后逐字节不变。
#   * 恢复 ACTIVE 前必须重新预检。
# 会话 Cookie 只从 /tmp/wp08/secrets.json 读取，不写入任何日志。
set -u
REPO=/Users/mac/Projects/仟流智算-provider-finance-init-20260921
cd "$REPO" || exit 1
export CANDIDATE_TAG=94482f06e5ac
export QIANLIU_ENV_FILE=/tmp/wp08/local.env
COMPOSE="docker compose -f deploy/compose.yaml -f /tmp/wp08/compose.wp08-local.yaml"
NODE=/Users/mac/.workbuddy/binaries/node/versions/22.22.2-3/bin/node
COOKIE=$("$NODE" -e 'console.log(require("/tmp/wp08/secrets.json").cookie)')
ENT=11111111-1111-4111-8111-111111111111
API_RES=66666666-6666-4666-8666-666666666666
GATE=资金写入口尚未启用

psqlq() { $COMPOSE exec -T postgres psql -U qianliu -d qianliu -At -v ON_ERROR_STOP=1 -c "$1"; }
classify() {
  if printf '%s' "$2" | grep -q "${GATE}"; then echo "BLOCKED(暗门禁)"; else echo "PASSED(未拦)"; fi
}
# 就绪等待：容器 Started ≠ 应用已监听端口。--force-recreate 后固定 sleep 会撞上
# 「Docker 端口代理已指向新容器、应用尚未 listen」的窗口，探针会得到 curl 000（连接失败），
# 被 classify 误判为 PASSED(未拦) —— 属**假绿**。故改为轮询读接口，并要求响应体的 mode
# 字段等于期望值（既证端口可达，又证是**新模式的新容器**在服务，而非旧容器残留）。
wait_mode() { # expected_mode
  local want=$1 i code got
  for i in $(seq 1 120); do
    code=$(curl -s -o /tmp/wp08/.ready -w '%{http_code}' \
      "http://127.0.0.1:8788/provider-finance/activation-state" -H "cookie: ${COOKIE}" 2>/dev/null)
    if [ "$code" = "200" ]; then
      got=$(grep -o '"mode":"[A-Za-z]*"' /tmp/wp08/.ready | head -1 | sed 's/.*:"//;s/"//')
      if [ "$got" = "$want" ]; then echo "  就绪：mode=${got}（HTTP 200，等待 ${i}s）"; return 0; fi
    fi
    sleep 1
  done
  echo "  ✗ 等待 mode=${want} 就绪超时（120s）——后续探针结果不可信 ❌"; return 1
}
facts() {
  psqlq "SELECT 'runtime_state=' || count(*)::text || ' | strict_true=' ||
           count(*) FILTER (WHERE strict_writes_enabled)::text
         FROM provider_finance_runtime_state;"
  psqlq "SELECT 'events=' || (SELECT count(*) FROM provider_finance_event)::text ||
         ' ledger=' || (SELECT count(*) FROM ledger_line)::text ||
         ' ai_request=' || (SELECT count(*) FROM ai_request)::text ||
         ' attempts=' || (SELECT count(*) FROM provider_finance_activation_attempt)::text ||
         ' quiescence=' || (SELECT count(*) FROM provider_finance_activation_quiescence)::text;"
  psqlq "SELECT 'fact_fingerprint=' || md5(string_agg(x, '' ORDER BY x)) FROM (
            SELECT md5(coalesce(ent.id::text,'')||coalesce(ent.name,''))  AS x FROM enterprise ent
            UNION ALL SELECT md5(coalesce(p.id::text,'')||coalesce(p.name,'')) FROM provider p
            UNION ALL SELECT md5(coalesce(r.id::text,'')||coalesce(r.name,'')) FROM provider_resource r
            UNION ALL SELECT md5(coalesce(l.id::text,'')||coalesce(l.amount::text,'')) FROM resource_purchase_record l
            UNION ALL SELECT md5(coalesce(s.enterprise_id::text,'')||s.strict_writes_enabled::text||coalesce(s.activated_at::text,''))
                       FROM provider_finance_runtime_state s) t;"
}
worker_tick() {
  # 在 worker 容器内以其**自身候选源码**执行续订 tick：cwd 设为该应用目录，
  # 使 @qianliu/* 走该应用自己的 node_modules 解析（与容器 CMD 同一解析面）。
  $COMPOSE exec -T -w /app/apps/worker worker node --import tsx -e '
    const rec = async () => {
      const { createKysely } = await import("@qianliu/database");
      const m = await import("./src/subscription-renewal/runner.js");
      const db = createKysely(process.env.DATABASE_URL);
      try {
        const r = await m.runSubscriptionRenewalTick({ db, env: process.env });
        console.log("MODE=" + process.env.PROVIDER_FINANCE_MODE + " RESULT=" + JSON.stringify(r));
      } finally { await db.destroy(); }
    };
    rec().catch((e) => { console.log("ERR=" + e.message); process.exit(1); });
  ' 2>&1 | tail -3
}
write_routes() {
  printf '  %-58s %s\n' "POST /provider-resources/:id/finance/opening-balances" "$(probe_capture POST "/provider-resources/${API_RES}/finance/opening-balances")"
  printf '  %-58s %s\n' "POST /provider-resources/:id/finance/recharges" "$(probe_capture POST "/provider-resources/${API_RES}/finance/recharges")"
  printf '  %-58s %s\n' "POST /provider-resources/:id/finance/subscriptions" "$(probe_capture POST "/provider-resources/${API_RES}/finance/subscriptions")"
  printf '  %-58s %s\n' "POST /provider-resources/:id/finance/auto-renewal/cancel" "$(probe_capture POST "/provider-resources/${API_RES}/finance/auto-renewal/cancel")"
  printf '  %-58s %s\n' "POST /provider-finance-events/:id/reversal" "$(probe_capture POST "/provider-finance-events/00000000-0000-4000-8000-000000000000/reversal")"
  printf '  %-58s %s\n' "POST /provider-finance/activation-preview" "$(probe_capture POST "/provider-finance/activation-preview")"
  printf '  %-58s %s\n' "POST /provider-finance/activation-quiescence" "$(probe_capture POST "/provider-finance/activation-quiescence")"
  printf '  %-58s %s\n' "POST /provider-finance/activation-quiescence/release" "$(probe_capture POST "/provider-finance/activation-quiescence/release")"
}
probe_capture() { # method path  -> "码 体分类"
  local M=$1 P=$2
  local CODE BODY
  CODE=$(curl -s -o /tmp/wp08/.p -w '%{http_code}' -X "$M" "http://127.0.0.1:8788$P" \
    -H "cookie: ${COOKIE}" -H 'content-type: application/json' -d '{}')
  BODY=$(cat /tmp/wp08/.p)
  printf '%s %s' "$CODE" "$(classify "$CODE" "$BODY")"
}
read_routes() {
  # 读接口按合同保留：带齐必填查询参数，避免把参数校验错误误当成"被门禁拦下"。
  for P in "/provider-finance/activation-state" "/provider-finance/summary?month=2026-09" \
           "/provider-finance/resources?month=2026-09" \
           "/provider-resources/${API_RES}/finance/balance?currency=CNY" \
           "/provider-resources/${API_RES}/finance/events" \
           "/provider-resources/${API_RES}/finance/auto-renewal" \
           "/provider-resources/${API_RES}/subscription-periods" \
           "/provider-finance/reconciliation-cases"; do
    local CODE BODY
    CODE=$(curl -s -o /tmp/wp08/.p -w '%{http_code}' "http://127.0.0.1:8788$P" -H "cookie: ${COOKIE}")
    BODY=$(cat /tmp/wp08/.p)
    printf '  %-64s %s  %s\n' "GET $P" "$CODE" "$(printf '%s' "$BODY" | grep -q "${GATE}" && echo "被门禁误拦 ❌" || echo "保留 ✅ $(printf '%s' "$BODY" | head -c 66)")"
  done
}

echo "# WP08 7.2 双端停写演练（PFA-08）"
echo "# 开始(UTC): $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "# 企业: WP08-SYNTHETIC 既有企业（本地一次性合成数据，非真实业务）"
echo "# 服务: qianliu-candidate/control-api 与 .../worker，同一候选 commit 94482f06e5ac"
echo

echo "=============== 0. 前置：把基线强制置为 ACTIVE ==============="
PROVIDER_FINANCE_MODE=ACTIVE $COMPOSE up -d --force-recreate control-api worker 2>&1 | grep -E "Recreat|Started|Error" | sed 's/^/  /'
wait_mode ACTIVE || true
echo

echo "=============== A. 基线（PROVIDER_FINANCE_MODE=ACTIVE） ==============="
for SVC in control-api worker; do
  N=$(docker ps --filter "label=com.docker.compose.service=${SVC}" --format '{{.Names}}' | head -1)
  printf '  %-12s MODE=%s\n' "${SVC}" "$(docker exec "$N" sh -c 'echo $PROVIDER_FINANCE_MODE')"
done
echo "-- 写入口在 ACTIVE 下不得被暗门禁拦下（预期业务拒绝，而非「${GATE}」）"
write_routes
echo "-- ACTIVE 下业务拒绝体示例（证明"写入口可达、只是被业务前置条件挡住"）"
curl -s -X POST "http://127.0.0.1:8788/provider-resources/${API_RES}/finance/opening-balances" \
  -H "cookie: ${COOKIE}" -H 'content-type: application/json' -d '{}' | head -c 220 | sed 's/^/  /'
echo
echo "-- 既有资金事实基线"
facts | sed 's/^/  /'
echo "-- Worker 续订 tick（ACTIVE）"
worker_tick ACTIVE | sed 's/^/  /'
echo

echo "=============== B. 同时切 DARK（Control API + Worker） ==============="
PROVIDER_FINANCE_MODE=DARK $COMPOSE up -d --force-recreate control-api worker 2>&1 | grep -E "Recreat|Started|Error" | sed 's/^/  /'
wait_mode DARK || true
for SVC in control-api worker; do
  N=$(docker ps --filter "label=com.docker.compose.service=${SVC}" --format '{{.Names}}' | head -1)
  printf '  %-12s MODE=%s  运行中=%s\n' "${SVC}" "$(docker exec "$N" sh -c 'echo $PROVIDER_FINANCE_MODE')" "$(docker inspect -f '{{.State.Running}}' "$N")"
done
echo "-- 写入口必须被拦下（响应体 = 「${GATE}」）"
write_routes
echo "-- 读接口按合同保留"
read_routes
echo "-- Worker 续订 tick（DARK）"
worker_tick DARK | sed 's/^/  /'
echo "-- DARK 期间既有资金事实与 strict_writes_enabled 必须逐字节不变"
facts | sed 's/^/  /'
echo

echo "=============== C. 恢复 ACTIVE 前的重新预检（只读） ==============="
echo "-- 事实快照（预检前）"
facts | sed 's/^/  /' > /tmp/wp08/.facts_before_preflight
cat /tmp/wp08/.facts_before_preflight
echo "-- 以候选镜像执行 finance:preflight（只读，不带 --apply-usage-backfill）"
$COMPOSE run --rm -T --no-deps control-api node --import tsx \
  packages/database/src/cli/provider-finance-preflight.ts --enterprise "${ENT}" --month 2026-09 2>&1 \
  | tail -25 | sed 's/^/  /'
echo "PREFLIGHT_EXIT=${PIPESTATUS[0]}"
echo "-- 事实快照（预检后，应与前完全一致）"
facts | sed 's/^/  /' > /tmp/wp08/.facts_after_preflight
cat /tmp/wp08/.facts_after_preflight
if diff -q /tmp/wp08/.facts_before_preflight /tmp/wp08/.facts_after_preflight >/dev/null; then
  echo "  ★ 预检为只读：快照逐行一致 ✅"
else
  echo "  ✗ 预检改动了事实 ❌"; diff /tmp/wp08/.facts_before_preflight /tmp/wp08/.facts_after_preflight
fi
echo

echo "=============== D. 恢复 ACTIVE ==============="
PROVIDER_FINANCE_MODE=ACTIVE $COMPOSE up -d --force-recreate control-api worker 2>&1 | grep -E "Recreat|Started|Error" | sed 's/^/  /'
wait_mode ACTIVE || true
for SVC in control-api worker; do
  N=$(docker ps --filter "label=com.docker.compose.service=${SVC}" --format '{{.Names}}' | head -1)
  printf '  %-12s MODE=%s  运行中=%s\n' "${SVC}" "$(docker exec "$N" sh -c 'echo $PROVIDER_FINANCE_MODE')" "$(docker inspect -f '{{.State.Running}}' "$N")"
done
echo "-- 写入口恢复（不得再返回门禁体）"
write_routes
echo "-- Worker 续订 tick（恢复 ACTIVE）"
worker_tick ACTIVE | sed 's/^/  /'
echo "-- 既有资金事实与 strict_writes_enabled 全程不变"
facts | sed 's/^/  /'
echo
echo "# 结束(UTC): $(date -u +%Y-%m-%dT%H:%M:%SZ)"
