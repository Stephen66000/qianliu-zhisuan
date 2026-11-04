#!/usr/bin/env bash
# =============================================================================
# X08 切换半段演练编排（WP6 S4，一次性演练证据脚本，非测试套件成员）。
#
# 五段时序：T0 旧栈(0092)运行与夹具 → T1 停旧写/在途收尾/停旧栈 → T2 迁移
# 0093-0096 → T3 候选栈就绪 → T4 候选栈验证（断言 A-E）。
# 时序日志：logs/wp6-x08-switch-drill.log；断言终判：logs/x08-result.json。
#
# 端口纪律：5173/8788 被走查遗留进程占用（不杀，全程避开）；8787/9191 虽空闲
# 亦按合同改用空闲段：mock=19191；旧栈 CA=18788/GW=18787/WK健康=19190；
# 新栈 CA=28788/GW=28787/WK健康=29190；Postgres 容器=55434。
# =============================================================================
set -uo pipefail

BASE=/Users/mac/Projects/仟流智算-api-decouple
LEG=/Users/mac/Projects/仟流智算-wp6-legacy-ae506fe
EV=$BASE/V4/Evidence/API-COST-OFFICIAL-BALANCE/WP6-20261104
SCRIPTS=$EV/scripts
LOGS=$EV/logs
PG_IMG=postgres:17-alpine@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193
PG_CONTAINER=wp6-x08-pg
PG_PORT=55434
DBNAME=wp6_x08_drill
DBURL="postgres://postgres:qianliu@127.0.0.1:${PG_PORT}/${DBNAME}"
MOCK_PORT=19191
OLD_CA_PORT=18788; OLD_GW_PORT=18787; OLD_WK_PORT=19190
NEW_CA_PORT=28788; NEW_GW_PORT=28787; NEW_WK_PORT=29190
KEK="ZGV2LW9ubHkta2VrLXJlcGxhY2UtaW4tcGlsb3QAAAA="
PEPPER=""
COOKIE_SECRET="x08-drill-cookie-secret-at-least-32-bytes!"
KEY=""
FIXTURE=$SCRIPTS/x08-fixture.json
DRILL_LOG=$LOGS/wp6-x08-switch-drill.log
GUARD_LOG=$LOGS/x08-fetch-guard.jsonl
GUARD_LOADER=$SCRIPTS/x08-fetch-guard.mjs
MOCK_SCRIPT=$SCRIPTS/x08-mock-upstream.mjs
export DOCKER_HOST=unix:///Users/mac/.colima/default/docker.sock
export TESTCONTAINERS_RYUK_DISABLED=true
T0_TS=0; T1_TS=0; T2_TS=0; T3_TS=0; T4_TS=0; DRILL_TS=0

OLD_CA_PID=""; OLD_GW_PID=""; OLD_WK_PID=""
NEW_CA_PID=""; NEW_GW_PID=""; NEW_WK_PID=""
MOCK_PID=""
NEW_COOKIE_JAR=$LOGS/x08-new-cookie.txt
OLD_COOKIE_JAR=$LOGS/x08-old-cookie.txt

die() { echo "X08_DRILL_FATAL: $*" | tee -a "$DRILL_LOG" >&2; exit 1; }
now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
epoch() { python3 -c "import time; print(time.time())"; }
elapsed_ms() { python3 -c "import sys; print(int((float(sys.argv[2])-float(sys.argv[1]))*1000))" "$1" "$2"; }
log_event() { printf '%s %s\n' "$(now)" "$*" | tee -a "$DRILL_LOG"; }
wait_http() {
  local i=0
  while [ "$i" -lt "$3" ]; do
    if curl -sf -o /dev/null "$1"; then return 0; fi
    i=$((i+1)); sleep 1
  done
  die "等待 $2 超时（${3}s）：$1"
}
wait_pid_gone() {
  local i=0
  while kill -0 "$1" 2>/dev/null && [ "$i" -lt 10 ]; do i=$((i+1)); sleep 0.5; done
  kill -0 "$1" 2>/dev/null && kill -9 "$1" 2>/dev/null
  return 0
}
jf() { node -e '
const fs=require("fs");const d=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
const path=process.argv[2].split(".").filter(Boolean);
let cur=d;for(const p of path){cur=cur?.[p];}
console.log(typeof cur==="object"&&cur!==null?JSON.stringify(cur):String(cur));
' "$1" "$2"; }
mock_chat_count() {
  curl -sf "http://127.0.0.1:${MOCK_PORT}/__x08/stats" 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{try{console.log(String(JSON.parse(s).chat))}catch{console.log("?")}})'
}
extract_usage_row() { # $1 usage.json  $2 request-id  $3 out（归一化 snake_case 摘要）
  node -e '
const fs=require("fs");
const usage=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
const rows=usage.records??usage.items??usage.rows??usage.data??usage;
const raw=(Array.isArray(rows)?rows:[]).find(r=>(r.request_id??r.requestId)===process.argv[2]);
const row=raw?{request_id:raw.request_id??raw.requestId,total_api_cost:raw.total_api_cost??raw.totalApiCost,cost_status:raw.cost_status??raw.costStatus,status:raw.status,usage_quality:raw.usageQuality??raw.usage_quality}:null;
fs.writeFileSync(process.argv[3], JSON.stringify(row));
' "$1" "$2" "$3"
}

# ---------------------------------------------------------------- 预检
mkdir -p "$LOGS"
: > "$DRILL_LOG"
: > "$GUARD_LOG"
DRILL_TS=$(epoch)
log_event "X08-DRILL-START 候选=59f7367 旧栈=ae506fe 库=${DBNAME}@127.0.0.1:${PG_PORT} mock=127.0.0.1:${MOCK_PORT}"
docker rm -f "$PG_CONTAINER" >/dev/null 2>&1 || true   # 仅清理本演练自己的容器
# 定向清理本演练遗留（上一轮失败运行残留）：只处理演练专用端口上、命令行匹配
# 本演练脚本/服务的进程；绝不触碰 5173/8788 等外部进程。
for p in $MOCK_PORT $OLD_CA_PORT $OLD_GW_PORT $OLD_WK_PORT $NEW_CA_PORT $NEW_GW_PORT $NEW_WK_PORT; do
  pid=$(lsof -nP -iTCP:"$p" -sTCP:LISTEN -t 2>/dev/null | head -1)
  if [ -n "$pid" ]; then
    cmd=$(ps -p "$pid" -o command= 2>/dev/null || true)
    cwd=$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | grep "^n" | cut -c2-)
    case "$cwd" in
      "${LEG}"/apps/*|"${BASE}"/apps/*|"$SCRIPTS"*)
        kill "$pid" 2>/dev/null || true; sleep 0.5
        kill -9 "$pid" 2>/dev/null || true
        log_event "PREFLIGHT-CLEANUP 清理本演练遗留进程 PID=$pid（端口 $p cwd=$cwd）" ;;
      *)
        die "端口 $p 被非演练进程占用（不杀，请人工处理）：$cmd" ;;
    esac
  fi
done
if lsof -nP -iTCP:"$PG_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  die "端口 $PG_PORT 已被占用（不杀既有进程，请人工处理）"
fi
log_event "PORTS-OK 演练端口全空闲（5173/8788 走查遗留占用已避开，未触碰）"
docker run -d --name "$PG_CONTAINER" -e POSTGRES_PASSWORD=qianliu -e POSTGRES_DB="$DBNAME" \
  -p "127.0.0.1:${PG_PORT}:5432" "$PG_IMG" >/dev/null || die "Postgres 容器启动失败"
i=0; until docker exec "$PG_CONTAINER" pg_isready -U postgres -d "$DBNAME" >/dev/null 2>&1; do
  i=$((i+1)); [ "$i" -gt 30 ] && die "Postgres 未就绪"; sleep 1
done
log_event "PG-READY 容器=$PG_CONTAINER 镜像=${PG_IMG%%@*}(digest pinned) 端口=${PG_PORT}（保留待复核）"

# ---------------------------------------------------------------- T0 旧栈
T0_TS=$(epoch)
log_event "T0-START 旧栈(ae506fe)@0092"
X08_MOCK_PORT=$MOCK_PORT X08_MOCK_STATS_PATH="$LOGS/x08-mock-stats.json" \
  node "$MOCK_SCRIPT" > "$LOGS/x08-mock-upstream.log" 2>&1 &
MOCK_PID=$!
wait_http "http://127.0.0.1:${MOCK_PORT}/__x08/stats" mock-upstream 15
log_event "T0-MOCK-UP 模拟上游就绪 :${MOCK_PORT}（chat/balance/调用计数）"

(cd "$LEG" && DATABASE_URL="$DBURL" \
  X08_FIXTURE_OUTPUT="$FIXTURE" X08_MOCK_ORIGIN="http://127.0.0.1:${MOCK_PORT}" \
  corepack pnpm@11.11.0 exec tsx "$SCRIPTS/x08-prepare.ts") \
  > "$LOGS/x08-prepare.log" 2>&1 || { tail -5 "$LOGS/x08-prepare.log" | tee -a "$DRILL_LOG"; die "T0 准备段失败"; }
PEPPER=$(jf "$FIXTURE" gatewayKeyPepper); KEY=$(jf "$FIXTURE" apiKey)
log_event "T0-SEEDED legacy-migrator→0092 resourceA=$(jf "$FIXTURE" resourceA) resourceB=$(jf "$FIXTURE" resourceB) resourceP=$(jf "$FIXTURE" resourceP)（全程零期初资金）"

start_service() { # $1 worktree-root  $2 app-dir  $3 logfile  $4 label  $5 envfile  $6 args
  local envfile; envfile=$(mktemp)
  cat > "$envfile" <<EOF
NODE_OPTIONS="--import ${GUARD_LOADER}"
X08_FETCH_GUARD_LOG=${GUARD_LOG}
X08_MOCK_ORIGIN=http://127.0.0.1:${MOCK_PORT}
X08_SERVICE=$4
EOF
  cat "$5" >> "$envfile"
  ( cd "$1/$2" && set -a && source "$envfile" && set +a \
    && exec ./node_modules/.bin/tsx src/main.ts $6 ) >> "$3" 2>&1 &
  rm -f "$envfile"
}
cat > "$LOGS/x08-env-old-ca.txt" <<EOF
DATABASE_URL=$DBURL
CONTROL_API_PORT=$OLD_CA_PORT
CONTROL_API_HOST=127.0.0.1
GATEWAY_KEY_PEPPER=$PEPPER
CREDENTIAL_KEK=$KEK
COOKIE_SECRET=$COOKIE_SECRET
PROVIDER_FINANCE_MODE=ACTIVE
EOF
cat > "$LOGS/x08-env-old-gw.txt" <<EOF
DATABASE_URL=$DBURL
GATEWAY_PORT=$OLD_GW_PORT
GATEWAY_HOST=127.0.0.1
GATEWAY_KEY_PEPPER=$PEPPER
CREDENTIAL_KEK=$KEK
RUNTIME_ASSURANCE_MODE=OFF
EOF
cat > "$LOGS/x08-env-old-wk.txt" <<EOF
DATABASE_URL=$DBURL
WORKER_HEALTH_PORT=$OLD_WK_PORT
RUNTIME_ASSURANCE_INTERVAL_MS=3000
CREDENTIAL_KEK=$KEK
PROVIDER_FINANCE_MODE=ACTIVE
RUNTIME_ASSURANCE_WECOM_NOTIFY=false
EOF
start_service "$LEG" "apps/control-api" "$LOGS/x08-old-control-api.log" old-control-api "$LOGS/x08-env-old-ca.txt" ""
OLD_CA_PID=$!
start_service "$LEG" "apps/gateway" "$LOGS/x08-old-gateway.log" old-gateway "$LOGS/x08-env-old-gw.txt" ""
OLD_GW_PID=$!
start_service "$LEG" "apps/worker" "$LOGS/x08-old-worker.log" old-worker "$LOGS/x08-env-old-wk.txt" "runtime-assurance-scheduler"
OLD_WK_PID=$!
printf 'old_ca=%s old_gw=%s old_wk=%s\n' "$OLD_CA_PID" "$OLD_GW_PID" "$OLD_WK_PID" > "$LOGS/x08-pids.txt"
wait_http "http://127.0.0.1:${OLD_CA_PORT}/health" old-control-api 40
wait_http "http://127.0.0.1:${OLD_GW_PORT}/health" old-gateway 40
log_event "T0-OLD-STACK-UP control-api=:${OLD_CA_PORT} gateway=:${OLD_GW_PORT} worker健康=:${OLD_WK_PORT} PID wk=${OLD_WK_PID}（调度循环首轮 tick 立即执行）"

curl -sf -c "$OLD_COOKIE_JAR" -X POST "http://127.0.0.1:${OLD_CA_PORT}/auth/login" \
  -H "content-type: application/json" \
  --data "{\"username\":\"$(jf "$FIXTURE" adminUsername)\",\"password\":\"$(jf "$FIXTURE" adminPassword)\"}" \
  > "$LOGS/x08-old-login.json" || die "旧栈登录失败"
log_event "T0-LOGIN 旧栈 control-api 会话就绪"

RP=$(jf "$FIXTURE" resourceP)
SUB_HTTP=$(curl -sS -o "$LOGS/x08-subscription-create.json" -w "%{http_code}" \
  -b "$OLD_COOKIE_JAR" -X POST "http://127.0.0.1:${OLD_CA_PORT}/provider-resources/${RP}/finance/subscriptions" \
  -H "content-type: application/json" \
  --data '{"kind":"PURCHASE","product_name":"X08 套餐","account_amount":"268.00","account_currency":"CNY","cash_paid_cny":"268.00","auto_renew":true,"service_period_start":"2026-11-01","service_period_end":"2026-12-31","occurred_at":"2026-11-01T00:00:00+08:00","description":"X08 切换演练：旧栈登记在用套餐（演练专用库合成数据）","evidence_ref":"V4/Evidence/API-COST-OFFICIAL-BALANCE/WP6-20261104 X08 演练证据","idempotency_key":"x08-subscription-20261104-001"}')
{ [ "$SUB_HTTP" = "201" ] || [ "$SUB_HTTP" = "200" ]; } || die "旧栈订阅登记失败 HTTP=$SUB_HTTP"
log_event "T0-SUBSCRIPTION 旧栈 HTTP 登记 CODING_PLAN 订阅（auto_renew=true，周期 2026-11-01~2026-12-31 未到期） HTTP=$SUB_HTTP"

curl -sf -b "$OLD_COOKIE_JAR" "http://127.0.0.1:${OLD_CA_PORT}/provider-resources/${RP}/finance/auto-renewal" > "$LOGS/x08-auto-renewal-old.json" || die "读自动续订开关失败"
curl -sf -b "$OLD_COOKIE_JAR" "http://127.0.0.1:${OLD_CA_PORT}/provider-resources/${RP}/subscription-periods" > "$LOGS/x08-periods-old.json" || die "读订阅周期失败"
log_event "T0-BASELINE-D 开关=$(jf "$LOGS/x08-auto-renewal-old.json" enabled) 周期数=$(jf "$LOGS/x08-periods-old.json" periods.length)"

(cd "$BASE" && DATABASE_URL="$DBURL" corepack pnpm@11.11.0 exec tsx \
  "$SCRIPTS/x08-checks.ts" counts) > "$LOGS/x08-counts-c0.json" 2>"$LOGS/x08-counts-c0.err" \
  || die "C0 计数失败：$(tail -2 "$LOGS/x08-counts-c0.err")"
PFE_C0=$(jf "$LOGS/x08-counts-c0.json" provider_finance_event)
[ "$(jf "$LOGS/x08-counts-c0.json" provider_subscription_period)" = "1" ] || die "C0 订阅周期行数异常"
log_event "T0-C0-COUNTS 资金四表：finance_event=${PFE_C0}（T0 订阅登记 1 行） period=1 activation_attempt=$(jf "$LOGS/x08-counts-c0.json" provider_finance_activation_attempt) ledger_line=$(jf "$LOGS/x08-counts-c0.json" ledger_line)"

CHAT_HTTP=$(curl -sS -o "$LOGS/x08-chat-t0.json" -D "$LOGS/x08-chat-t0.headers" -w "%{http_code}" \
  -X POST "http://127.0.0.1:${OLD_GW_PORT}/v1/chat/completions" \
  -H "Authorization: Bearer $KEY" -H "content-type: application/json" \
  --data '{"model":"qianliu-x08-deepseek","messages":[{"role":"user","content":"X08-T0-NORMAL"}],"stream":false}')
[ "$CHAT_HTTP" = "200" ] || die "T0 正常消费失败 HTTP=$CHAT_HTTP $(cat "$LOGS/x08-chat-t0.json")"
T0_REQ=$(grep -i '^x-ai-request-id:' "$LOGS/x08-chat-t0.headers" | tr -d '\r' | awk '{print $2}')
[ -n "$T0_REQ" ] || die "T0 请求缺少 x-ai-request-id"
sleep 1
log_event "T0-CONSUMPTION 正常消费完成 request=$T0_REQ HTTP=${CHAT_HTTP}（期望金额 0.00100000）"

curl -sf -b "$OLD_COOKIE_JAR" "http://127.0.0.1:${OLD_CA_PORT}/usage?limit=50" > "$LOGS/x08-usage-old.json" || die "旧栈 /usage 读取失败"
extract_usage_row "$LOGS/x08-usage-old.json" "$T0_REQ" "$LOGS/x08-t0-usage-row-old.json"
[ "$(jf "$LOGS/x08-t0-usage-row-old.json" total_api_cost)" = "0.00100000" ] \
  || die "T0 旧栈可读金额异常：$(cat "$LOGS/x08-t0-usage-row-old.json")"
log_event "T0-READ 旧栈 /usage 可读金额=$(jf "$LOGS/x08-t0-usage-row-old.json" total_api_cost)（新栈可比对基线）"

curl -sS "http://127.0.0.1:${MOCK_PORT}/__x08/stats" > "$LOGS/x08-mock-stats-t0.json"
log_event "T0-MOCK-STATS chat=$(jf "$LOGS/x08-mock-stats-t0.json" chat) balance=$(jf "$LOGS/x08-mock-stats-t0.json" balance)（旧 worker 首轮已同步资源A/B 各一次）"

curl -sS -o "$LOGS/x08-chat-inflight.json" -D "$LOGS/x08-chat-inflight.headers" \
  -X POST "http://127.0.0.1:${OLD_GW_PORT}/v1/chat/completions" \
  -H "Authorization: Bearer $KEY" -H "content-type: application/json" \
  --data '{"model":"qianliu-x08-deepseek","messages":[{"role":"user","content":"X08-T1-INFLIGHT"}],"stream":false}' &
INFLIGHT_CURL_PID=$!
INFLIGHT_REQ=$(DATABASE_URL="$DBURL" X08_ENTERPRISE_ID="$(jf "$FIXTURE" enterpriseId)" \
  node "$SCRIPTS/x08-poll.mjs" 10 | tail -1)
[ -n "$INFLIGHT_REQ" ] || die "在途请求未在 10s 内进入 IN_PROGRESS"
(cd "$BASE" && DATABASE_URL="$DBURL" corepack pnpm@11.11.0 exec tsx \
  "$SCRIPTS/x08-checks.ts" counts) > "$LOGS/x08-counts-inflight.json" 2>/dev/null || true
log_event "T0-INFLIGHT 在途请求已 admitted 未结算 request=${INFLIGHT_REQ}（mock 延迟 8s，切换窗口开始前挂起）"
T0_END=$(epoch)
log_event "T0-END 耗时=$(elapsed_ms "$T0_TS" "$T0_END")ms"

# ---------------------------------------------------------------- T1 停旧写+在途收尾
T1_TS=$(epoch)
log_event "T1-START 停旧 API 写（静默租约）→在途消费收尾→停旧栈"
QS_HTTP=$(curl -sS -o "$LOGS/x08-lease-start.json" -w "%{http_code}" \
  -b "$OLD_COOKIE_JAR" -X POST "http://127.0.0.1:${OLD_CA_PORT}/provider-finance/activation-quiescence" \
  -H "content-type: application/json" --data '{"duration_seconds":600}')
[ "$QS_HTTP" = "201" ] || die "静默租约启动失败 HTTP=$QS_HTTP $(cat "$LOGS/x08-lease-start.json")"
log_event "T1-LEASE-START 静默租约 ACTIVE duration=600s HTTP=$QS_HTTP"

GATE_HTTP=$(curl -sS -o "$LOGS/x08-gate-503.json" -w "%{http_code}" \
  -X POST "http://127.0.0.1:${OLD_GW_PORT}/v1/chat/completions" \
  -H "Authorization: Bearer $KEY" -H "content-type: application/json" \
  --data '{"model":"qianliu-x08-deepseek","messages":[{"role":"user","content":"租约内新请求"}],"stream":false}')
GATE_CODE=$(jf "$LOGS/x08-gate-503.json" error.code)
[ "$GATE_HTTP" = "503" ] && [ "$GATE_CODE" = "enterprise_maintenance" ] \
  || die "租约门禁未按合同 503：HTTP=$GATE_HTTP body=$(cat "$LOGS/x08-gate-503.json")"
MOCK_CHAT_AT_GATE=$(mock_chat_count)
log_event "T1-GATE-503 租约内新请求被静默门禁拒绝（零上游零账本事实） code=$GATE_CODE mock_chat=$MOCK_CHAT_AT_GATE"

DRAINED="false"; i=0
while [ "$i" -lt 40 ]; do
  curl -sf -b "$OLD_COOKIE_JAR" "http://127.0.0.1:${OLD_CA_PORT}/provider-finance/activation-quiescence" \
    > "$LOGS/x08-drain-report.json" 2>/dev/null || true
  D=$(jf "$LOGS/x08-drain-report.json" quiescence.drain.drained)
  if [ "$D" = "true" ]; then DRAINED="true"; break; fi
  i=$((i+1)); sleep 0.5
done
[ "$DRAINED" = "true" ] || die "在途收尾报告 20s 内未 drained"
MOCK_CHAT_AT_DRAIN=$(mock_chat_count)
wait "$INFLIGHT_CURL_PID" 2>/dev/null || true
log_event "T1-DRAIN 收尾报告 drained=true（IN_PROGRESS=0 openAttempts=0 pendingTx=0）：在途请求已在旧 gateway 完成结算；mock chat 计数 ${MOCK_CHAT_AT_GATE}→${MOCK_CHAT_AT_DRAIN}（门禁请求未触达上游）"

REL_HTTP=$(curl -sS -o "$LOGS/x08-lease-release.json" -w "%{http_code}" \
  -b "$OLD_COOKIE_JAR" -X POST "http://127.0.0.1:${OLD_CA_PORT}/provider-finance/activation-quiescence/release" \
  -H "content-type: application/json" --data '{"reason":"X08 切换演练：在途收尾完成，停旧栈"}')
[ "$REL_HTTP" = "200" ] || die "租约解除失败 HTTP=$REL_HTTP"
log_event "T1-LEASE-RELEASE 租约 RELEASED HTTP=$REL_HTTP"

kill "$OLD_WK_PID" 2>/dev/null; wait_pid_gone "$OLD_WK_PID"
log_event "T1-OLD-WORKER-STOPPED 旧 worker 停止（PID=${OLD_WK_PID}）"
kill "$OLD_GW_PID" 2>/dev/null; wait_pid_gone "$OLD_GW_PID"
log_event "T1-OLD-GATEWAY-STOPPED 旧 gateway 停止（PID=${OLD_GW_PID}）"
kill "$OLD_CA_PID" 2>/dev/null; wait_pid_gone "$OLD_CA_PID"
log_event "T1-OLD-CA-STOPPED 旧 control-api 停止（PID=${OLD_CA_PID}）——旧后台全部下线，此后不可能再新增 API 资金写入"

(cd "$BASE" && DATABASE_URL="$DBURL" corepack pnpm@11.11.0 exec tsx \
  "$SCRIPTS/x08-checks.ts" counts) > "$LOGS/x08-counts-c1.json" 2>"$LOGS/x08-counts-c1.err" \
  || die "C1 计数失败"
[ "$(jf "$LOGS/x08-counts-c1.json" ledger_line)" = "2" ] || die "C1 账本行数异常（应为 2=T0+在途收尾）：$(jf "$LOGS/x08-counts-c1.json" ledger_line)"
[ "$(jf "$LOGS/x08-counts-c1.json" provider_finance_event)" = "$PFE_C0" ] || die "C1 资金事件出现增量"
[ "$(jf "$LOGS/x08-counts-c1.json" provider_finance_activation_attempt)" = "0" ] || die "C1 激活尝试行非零"
[ "$(jf "$LOGS/x08-counts-c1.json" ai_request_in_progress)" = "0" ] || die "C1 仍有在途请求"
T1_END=$(epoch)
log_event "T1-C1-COUNTS 切换窗口起点快照：ledger_line=2 finance_event=$PFE_C0 period=1 attempt=0 in_progress=0；T1-END 耗时=$(elapsed_ms "$T1_TS" "$T1_END")ms"

# ---------------------------------------------------------------- T2 迁移
T2_TS=$(epoch)
log_event "T2-START 候选 migrator up 0093-0096"
(cd "$BASE" && DATABASE_URL="$DBURL" corepack pnpm@11.11.0 exec tsx \
  "$SCRIPTS/x08-checks.ts" migrate) > "$LOGS/x08-migration.json" 2>"$LOGS/x08-migration.err" \
  || die "T2 迁移失败：$(tail -3 "$LOGS/x08-migration.err")"
MIGR_LIST=$(node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(d.executed.join(","))' "$LOGS/x08-migration.json")
MIGR_MS=$(jf "$LOGS/x08-migration.json" durationMs)
MIGR_REPLAY=$(jf "$LOGS/x08-migration.json" idempotentReplayError)
log_event "T2-MIGRATED executed=[$MIGR_LIST] duration=${MIGR_MS}ms idempotent_replay_error=${MIGR_REPLAY:-null}"
T2_END=$(epoch)
log_event "T2-END 耗时=$(elapsed_ms "$T2_TS" "$T2_END")ms"

# ---------------------------------------------------------------- T3 新栈就绪
T3_TS=$(epoch)
log_event "T3-START 候选栈(59f7367)@0096 就绪"
cat > "$LOGS/x08-env-new-ca.txt" <<EOF
DATABASE_URL=$DBURL
CONTROL_API_PORT=$NEW_CA_PORT
CONTROL_API_HOST=127.0.0.1
GATEWAY_KEY_PEPPER=$PEPPER
CREDENTIAL_KEK=$KEK
COOKIE_SECRET=$COOKIE_SECRET
PROVIDER_FINANCE_MODE=ACTIVE
PROVIDER_OPERATING_BALANCE_REFRESH_COOLDOWN_MS=1000
EOF
cat > "$LOGS/x08-env-new-gw.txt" <<EOF
DATABASE_URL=$DBURL
GATEWAY_PORT=$NEW_GW_PORT
GATEWAY_HOST=127.0.0.1
GATEWAY_KEY_PEPPER=$PEPPER
CREDENTIAL_KEK=$KEK
RUNTIME_ASSURANCE_MODE=OFF
EOF
cat > "$LOGS/x08-env-new-wk.txt" <<EOF
DATABASE_URL=$DBURL
WORKER_HEALTH_PORT=$NEW_WK_PORT
RUNTIME_ASSURANCE_INTERVAL_MS=3000
CREDENTIAL_KEK=$KEK
PROVIDER_FINANCE_MODE=ACTIVE
RUNTIME_ASSURANCE_WECOM_NOTIFY=false
EOF
start_service "$BASE" "apps/control-api" "$LOGS/x08-new-control-api.log" new-control-api "$LOGS/x08-env-new-ca.txt" ""
NEW_CA_PID=$!
start_service "$BASE" "apps/gateway" "$LOGS/x08-new-gateway.log" new-gateway "$LOGS/x08-env-new-gw.txt" ""
NEW_GW_PID=$!
start_service "$BASE" "apps/worker" "$LOGS/x08-new-worker.log" new-worker "$LOGS/x08-env-new-wk.txt" "runtime-assurance-scheduler"
NEW_WK_PID=$!
printf 'new_ca=%s new_gw=%s new_wk=%s\n' "$NEW_CA_PID" "$NEW_GW_PID" "$NEW_WK_PID" >> "$LOGS/x08-pids.txt"
wait_http "http://127.0.0.1:${NEW_CA_PORT}/health" new-control-api 40
wait_http "http://127.0.0.1:${NEW_GW_PORT}/health" new-gateway 40
log_event "T3-NEW-STACK-UP control-api=:${NEW_CA_PORT} gateway=:${NEW_GW_PORT} worker健康=:${NEW_WK_PORT} PID wk=${NEW_WK_PID}（官方余额同步 tick＋套餐续订 tick 同进程共存）"

curl -sf -c "$NEW_COOKIE_JAR" -X POST "http://127.0.0.1:${NEW_CA_PORT}/auth/login" \
  -H "content-type: application/json" \
  --data "{\"username\":\"$(jf "$FIXTURE" adminUsername)\",\"password\":\"$(jf "$FIXTURE" adminPassword)\"}" \
  > "$LOGS/x08-new-login.json" || die "新栈登录失败"
log_event "T3-LOGIN 候选栈 control-api 会话就绪"

# 切换窗口新登记 API 资源 C（旧栈“每日一次”门禁已覆盖 A/B 的同步节奏；C 零同步尝试
# → T4 新 worker runner 路径可对 C 执行成功）。演练夹具操作（非业务端点）：pg 直插。
(cd "$BASE" && DATABASE_URL="$DBURL" X08_FIXTURE="$FIXTURE" \
  corepack pnpm@11.11.0 exec tsx "$SCRIPTS/x08-add-resource.ts") \
  > "$LOGS/x08-resource-c.json" 2>"$LOGS/x08-resource-c.err" || die "资源 C 登记失败：$(tail -3 "$LOGS/x08-resource-c.err")"
RESOURCE_C=$(jf "$LOGS/x08-resource-c.json" resourceC)
node -e '
const fs=require("fs");const p=process.argv[1];
const f=JSON.parse(fs.readFileSync(p,"utf8"));f.resourceC=process.argv[2];
fs.writeFileSync(p, JSON.stringify(f,null,2)+"\n");
' "$FIXTURE" "$RESOURCE_C"
log_event "T3-RESOURCE-C 切换窗口新登记 API 资源C=${RESOURCE_C}（零同步尝试，T4 runner 路径目标；夹具直插，非业务端点）"
T3_END=$(epoch)
log_event "T3-END 耗时=$(elapsed_ms "$T3_TS" "$T3_END")ms"

# ---------------------------------------------------------------- T4 候选栈验证
T4_TS=$(epoch)
log_event "T4-START 候选栈验证（断言 A-E）"
RA=$(jf "$FIXTURE" resourceA)

# 断言 A 前半：七退役端点 410
RET410_OK="true"
RET_RESULTS="["
first="true"
for spec in \
  "/provider-resources/${RA}/finance/opening-balances" \
  "/provider-resources/${RA}/finance/readiness" \
  "/provider-resources/${RA}/finance/opening-balance-corrections" \
  "/provider-resources/${RA}/finance/recharges" \
  "/provider-resources/${RA}/finance/reconciliation-cases" \
  "/provider-finance-reconciliation-cases/00000000-0000-0000-0000-000000000000/confirm" \
  "/provider-finance-reconciliation-cases/00000000-0000-0000-0000-000000000000/reject"; do
  code=$(curl -sS -o "$LOGS/x08-retired-last.json" -w "%{http_code}" -b "$NEW_COOKIE_JAR" \
    -X POST "http://127.0.0.1:${NEW_CA_PORT}${spec}" -H "content-type: application/json" --data "{}")
  errcode=$(jf "$LOGS/x08-retired-last.json" error)
  { [ "$code" = "410" ] && [ "$errcode" = "api_funding_management_retired" ]; } || RET410_OK="false"
  [ "$first" = "true" ] && first="false" || RET_RESULTS="$RET_RESULTS,"
  RET_RESULTS="${RET_RESULTS}{\"endpoint\":\"${spec}\",\"status\":${code},\"error\":\"${errcode}\"}"
done
RET_RESULTS="$RET_RESULTS]"
printf '{"retired410": %s, "results": %s}\n' "$RET410_OK" "$RET_RESULTS" > "$LOGS/x08-retired-410.json"
log_event "T4-A-410 七退役端点全部 410+api_funding_management_retired=$RET410_OK"

NEW_CHAT_HTTP=$(curl -sS -o "$LOGS/x08-chat-t4.json" -D "$LOGS/x08-chat-t4.headers" -w "%{http_code}" \
  -X POST "http://127.0.0.1:${NEW_GW_PORT}/v1/chat/completions" \
  -H "Authorization: Bearer $KEY" -H "content-type: application/json" \
  --data '{"model":"qianliu-x08-deepseek","messages":[{"role":"user","content":"X08-T4-NEW"}],"stream":false}')
[ "$NEW_CHAT_HTTP" = "200" ] || die "T4 新消费失败 HTTP=$NEW_CHAT_HTTP $(cat "$LOGS/x08-chat-t4.json")"
T4_REQ=$(grep -i '^x-ai-request-id:' "$LOGS/x08-chat-t4.headers" | tr -d '\r' | awk '{print $2}')
[ -n "$T4_REQ" ] || die "T4 请求缺少 x-ai-request-id"
sleep 1
log_event "T4-NEW-CONSUMPTION 无期初资源A 新消费（候选栈 gateway）request=$T4_REQ HTTP=${NEW_CHAT_HTTP}（期望金额 0.00060000）"

curl -sf -b "$NEW_COOKIE_JAR" "http://127.0.0.1:${NEW_CA_PORT}/usage?limit=50" > "$LOGS/x08-usage-new.json" || die "新栈 /usage 读取失败"
extract_usage_row "$LOGS/x08-usage-new.json" "$T0_REQ" "$LOGS/x08-t0-usage-row-new.json"
log_event "T4-READ-T0 新栈 /usage 读 T0 消费金额=$(jf "$LOGS/x08-t0-usage-row-new.json" total_api_cost)（旧栈基线=$(jf "$LOGS/x08-t0-usage-row-old.json" total_api_cost)）"

# 新 worker 双 tick 证据（官方余额同步 runner 路径＋套餐续订 tick）
i=0; WK_OP_LINE=""; WK_RN_LINE=""
while [ "$i" -lt 30 ]; do
  # runner 路径证据：取 snapshotsCreated>=1（camelCase，candidate main.ts 日志键）的那一轮
  WK_OP_LINE=$(grep -o '{"event":"provider_operating_sync_tick_completed".*' "$LOGS/x08-new-worker.log" 2>/dev/null \
    | grep -v '"snapshotsCreated":0' | tail -1 || true)
  WK_RN_LINE=$(grep -o '{"event":"subscription_auto_renewal_tick".*' "$LOGS/x08-new-worker.log" 2>/dev/null | tail -1 || true)
  if [ -n "$WK_OP_LINE" ] && [ -n "$WK_RN_LINE" ]; then
    SNAP=$(node -e 'try{const d=JSON.parse(process.argv[1]);console.log(String(d.snapshotsCreated??d.snapshots_created??0))}catch{console.log("0")}' "$WK_OP_LINE")
    [ "$SNAP" -ge 1 ] && break
  fi
  i=$((i+1)); sleep 1
done
[ -n "$WK_OP_LINE" ] && [ -n "$WK_RN_LINE" ] || die "新 worker tick 证据缺失 op=${WK_OP_LINE:-无} renewal=${WK_RN_LINE:-无}"
OLD_RN_LINE=$(grep -o '{"event":"subscription_auto_renewal_tick".*' "$LOGS/x08-old-worker.log" 2>/dev/null | tail -1 || true)
[ -n "$OLD_RN_LINE" ] || die "旧 worker 续订 tick 日志缺失"
OLD_OP_LINE=$(grep -o '{"event":"provider_operating_sync_tick_completed".*' "$LOGS/x08-old-worker.log" 2>/dev/null | tail -1 || true)
log_event "T4-C-WORKER-TICKS 旧worker续订tick=${OLD_RN_LINE}"
log_event "T4-C-WORKER-TICKS 旧worker余额同步tick=${OLD_OP_LINE:-无（旧栈为每日一次门禁）}"
log_event "T4-C-WORKER-TICKS 新worker续订tick=${WK_RN_LINE}"
log_event "T4-C-WORKER-TICKS 新worker余额同步tick=${WK_OP_LINE}"
printf '%s' "$OLD_RN_LINE" > "$LOGS/x08-renewal-old-line.txt"
printf '%s' "$WK_RN_LINE" > "$LOGS/x08-renewal-new-line.txt"
printf '%s' "$WK_OP_LINE" > "$LOGS/x08-operating-new-line.txt"

MR_HTTP=$(curl -sS -o "$LOGS/x08-manual-refresh.json" -w "%{http_code}" \
  -b "$NEW_COOKIE_JAR" -X POST "http://127.0.0.1:${NEW_CA_PORT}/provider-resources/${RA}/official-balance/refresh" \
  -H "content-type: application/json" --data '{}')
MR_OUTCOME=$(jf "$LOGS/x08-manual-refresh.json" result.outcome)
MR_BALANCE=$(jf "$LOGS/x08-manual-refresh.json" result.balance.total_balance)
[ "$MR_HTTP" = "200" ] && [ "$MR_OUTCOME" = "SUCCEEDED" ] && [ "$MR_BALANCE" = "110.50" ] \
  || die "手动官方余额刷新失败 HTTP=$MR_HTTP body=$(cat "$LOGS/x08-manual-refresh.json")"
log_event "T4-C-MANUAL-REFRESH 手动官方余额刷新成功 outcome=$MR_OUTCOME balance=$MR_BALANCE CNY（模拟上游返回）"

curl -sf -b "$NEW_COOKIE_JAR" "http://127.0.0.1:${NEW_CA_PORT}/provider-resources/${RP}/finance/auto-renewal" > "$LOGS/x08-auto-renewal-new.json" || die "新栈读开关失败"
curl -sf -b "$NEW_COOKIE_JAR" "http://127.0.0.1:${NEW_CA_PORT}/provider-resources/${RP}/subscription-periods" > "$LOGS/x08-periods-new.json" || die "新栈读周期失败"
SAME_RN=$(node -e '
const fs=require("fs");
const a=fs.readFileSync(process.argv[1],"utf8"), b=fs.readFileSync(process.argv[2],"utf8");
console.log(JSON.stringify(JSON.parse(a))===JSON.stringify(JSON.parse(b)));
' "$LOGS/x08-auto-renewal-old.json" "$LOGS/x08-auto-renewal-new.json")
SAME_PD=$(node -e '
const fs=require("fs");
const a=fs.readFileSync(process.argv[1],"utf8"), b=fs.readFileSync(process.argv[2],"utf8");
console.log(JSON.stringify(JSON.parse(a))===JSON.stringify(JSON.parse(b)));
' "$LOGS/x08-periods-old.json" "$LOGS/x08-periods-new.json")
log_event "T4-D-COMPARE auto-renewal HTTP 新旧一致=$SAME_RN subscription-periods HTTP 新旧一致=$SAME_PD"

curl -sS "http://127.0.0.1:${MOCK_PORT}/__x08/stats" > "$LOGS/x08-mock-stats-t4.json"
log_event "T4-E-MOCK-STATS chat=$(jf "$LOGS/x08-mock-stats-t4.json" chat) balance=$(jf "$LOGS/x08-mock-stats-t4.json" balance) other=$(jf "$LOGS/x08-mock-stats-t4.json" other) total=$(jf "$LOGS/x08-mock-stats-t4.json" total)"

(cd "$BASE" && DATABASE_URL="$DBURL" corepack pnpm@11.11.0 exec tsx \
  "$SCRIPTS/x08-checks.ts" counts) > "$LOGS/x08-counts-c4.json" 2>"$LOGS/x08-counts-c4.err" \
  || die "C4 计数失败"

# ---------------------------------------------------------------- 基线装配＋终判
node -e '
const fs=require("fs");
const S=process.argv[2], out=process.argv[3];
const read=p=>JSON.parse(fs.readFileSync(p,"utf8"));
const readText=p=>fs.readFileSync(p,"utf8");
const parseLine=p=>{const t=readText(p).trim();return t?JSON.parse(t):null;};
const t0RowOld=read(S+"/x08-t0-usage-row-old.json");
const c1=read(S+"/x08-counts-c1.json");
const inflightInterim=read(S+"/x08-counts-inflight.json");
const inflightRow=inflightInterim.perRequest.find(r=>r.status==="IN_PROGRESS")
  ?? inflightInterim.perRequest.find(r=>r.requestId!==t0RowOld?.request_id)
  ?? null;
const h4=fs.readFileSync(S+"/x08-chat-t4.headers","utf8");
const m4=h4.match(/^x-ai-request-id:\s*(\S+)/im);
const baseline={
  t0RequestId: t0RowOld?.request_id ?? null,
  t0UsageRowOld: t0RowOld,
  t0UsageRowNew: read(S+"/x08-t0-usage-row-new.json"),
  t4RequestId: m4?m4[1]:null,
  inflightRequestId: inflightRow?inflightRow.requestId:null,
  inflightAdmitted: true,
  leaseStart: read(S+"/x08-lease-start.json"),
  gate503: true,
  gate503Detail: read(S+"/x08-gate-503.json"),
  drained: read(S+"/x08-drain-report.json")?.quiescence?.drain?.drained ?? false,
  drainReport: read(S+"/x08-drain-report.json"),
  oldWorkerPid: (readText(S+"/x08-pids.txt").match(/old_wk=(\d+)/)||[])[1] ?? null,
  newWorkerPid: (readText(S+"/x08-pids.txt").match(/new_wk=(\d+)/)||[])[1] ?? null,
  oldWorkerStopped: true,
  newWorkerStarted: true,
  retired410: read(S+"/x08-retired-410.json").retired410,
  retired410Detail: read(S+"/x08-retired-410.json").results,
  manualRefresh: read(S+"/x08-manual-refresh.json")?.result?.outcome==="SUCCEEDED",
  manualRefreshDetail: read(S+"/x08-manual-refresh.json")?.result ?? null,
  autoRenewalOld: read(S+"/x08-auto-renewal-old.json"),
  autoRenewalNew: read(S+"/x08-auto-renewal-new.json"),
  periodsOld: read(S+"/x08-periods-old.json"),
  periodsNew: read(S+"/x08-periods-new.json"),
  periodsDbT0: read(S+"/x08-counts-c0.json").subscriptionPeriods,
  providerFinanceEventAtC0: read(S+"/x08-counts-c0.json").provider_finance_event,
  renewalTickOld: parseLine(S+"/x08-renewal-old-line.txt"),
  renewalTickNew: parseLine(S+"/x08-renewal-new-line.txt"),
  newWorkerOperatingTick: parseLine(S+"/x08-operating-new-line.txt"),
};
fs.writeFileSync(out, JSON.stringify(baseline,null,2)+"\n");
console.log("baseline assembled -> "+out);
' x08 "$LOGS" "$LOGS/x08-baseline-t0.json" >> "$DRILL_LOG" 2>&1 || die "基线装配失败：$(tail -3 "$DRILL_LOG")"
log_event "T4-BASELINE 基线装配完成 logs/x08-baseline-t0.json"

(cd "$BASE" && DATABASE_URL="$DBURL" corepack pnpm@11.11.0 exec tsx \
  "$SCRIPTS/x08-checks.ts" final) > "$LOGS/x08-result.json" 2>"$LOGS/x08-result.err" \
  || die "终判失败：$(tail -3 "$LOGS/x08-result.err")"
ALLPASS=$(jf "$LOGS/x08-result.json" allPass)
T4_END=$(epoch)
log_event "T4-END 断言终判 allPass=${ALLPASS}（logs/x08-result.json）；T4 耗时=$(elapsed_ms "$T4_TS" "$T4_END")ms"

# ---------------------------------------------------------------- 收尾（容器保留待复核）
kill "$NEW_WK_PID" 2>/dev/null; wait_pid_gone "$NEW_WK_PID"
kill "$NEW_GW_PID" 2>/dev/null; wait_pid_gone "$NEW_GW_PID"
kill "$NEW_CA_PID" 2>/dev/null; wait_pid_gone "$NEW_CA_PID"
kill "$MOCK_PID" 2>/dev/null; wait_pid_gone "$MOCK_PID"
log_event "SERVICES-STOPPED 演练服务进程全部停止；容器 ${PG_CONTAINER}（:${PG_PORT}）保留待复核"
log_event "X08-DRILL-END 总耗时=$(elapsed_ms "$DRILL_TS" "$(epoch)")ms allPass=$ALLPASS"
[ "$ALLPASS" = "true" ] || exit 2
exit 0
