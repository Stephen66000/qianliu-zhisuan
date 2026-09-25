#!/bin/bash
# WP08 7.3 激活前静默演练（PFA-09）—— 仅本地合成企业与本地一次性容器库。
#
# 覆盖用户验收要求 5：
#   - Gateway admission 零上游（503 enterprise_maintenance，桩 0 命中、零账本事实）
#   - 在途请求继续排空（慢响应请求不被门禁中止；新请求被拦）
#   - 租约最长 60 分钟（3600 秒内接受、越界拒绝）
#   - 激活需剩余 ≥5 分钟（剩余不足返回 409 ACTIVATION_NOT_QUIESCENT）
#   - 候选 TTL 30 分钟（库层 CHECK 固定 1800 秒、不因读取/失败滑动）
#   - 租约到期自动恢复（数据面流量恢复、控制面租约转 EXPIRED）
#   - 旧候选不得继续激活（该租约下生成的候选在租约过期后拒绝激活）
#   - 正向路径（TTL 内、剩余 ≥5 分钟 → 激活成功 + 幂等重放）
#
# 企业分工（均为本地一次性合成企业，互不复用）：
#   A = 门禁 / 在途排空 / 到期恢复（不激活）
#   E = 失败关闭（租约过期后旧候选、剩余不足 5 分钟；全程不激活）
#   C = 候选 TTL 30 分钟（不激活）
#   F = 本地正向激活 + Worker 自动续订跳过 / 到期恢复
#
# 「本地时钟注入」仅作用于本地一次性合成行的 started_at / expires_at（候选预览事实受
# `provider_finance_protect_activation_attempt` 触发器保护，故以逐列等价的前移行替代），
# 语义等价于等待真实时间流逝；不改动任何候选哈希、事实水位或资金事实。
#
# 严禁：真实部署、生产库、真实厂商上游、任何公网端口。桩上游固定 127.0.0.1:9299。
set -u

CTRL=http://127.0.0.1:8788
GW=http://127.0.0.1:8787
STUB=http://127.0.0.1:9299
PG=qianliu-zhisuan-postgres-1
WORKER=qianliu-zhisuan-worker-1
EMPTY_DRAFT='{"schema_version":"1","api_opening_balances":[],"historical_api_recharges":[],"coding_plan_purchases":[],"coding_plan_carryovers":[],"legacy_purchase_resolutions":[]}'

ok=0; bad=0
chk() { # label expected actual
  if [ "$2" = "$3" ]; then ok=$((ok+1)); printf '  [PASS] %s = %s\n' "$1" "$3"
  else bad=$((bad+1)); printf '  [FAIL] %s 期望=%s 实际=%s\n' "$1" "$2" "$3"; fi
}
chkrange() { # label min max actual
  if [ "$4" -ge "$2" ] 2>/dev/null && [ "$4" -le "$3" ] 2>/dev/null; then
    ok=$((ok+1)); printf '  [PASS] %s = %s (∈[%s,%s])\n' "$1" "$4" "$2" "$3"
  else bad=$((bad+1)); printf '  [FAIL] %s 期望∈[%s,%s] 实际=%s\n' "$1" "$2" "$3" "$4"; fi
}
chkcontains() { # label needle haystack
  case "$3" in *"$2"*) ok=$((ok+1)); printf '  [PASS] %s 含 "%s"\n' "$1" "$2" ;;
    *) bad=$((bad+1)); printf '  [FAIL] %s 不含 "%s" 实际=%s\n' "$1" "$2" "$3" ;; esac
}
pg() { docker exec "$PG" psql -U qianliu -d qianliu -Atc "$1" 2>&1; }
pgi() { docker exec "$PG" psql -U qianliu -d qianliu -Atc "$1" 2>&1 | head -1; }
jsonq() { # dotted path from stdin JSON
  python3 -c 'import sys,json
d=json.load(sys.stdin)
for k in sys.argv[1].split("."):
    if k=="": continue
    if isinstance(d,list): d=d[int(k)]
    else: d=d.get(k) if isinstance(d,dict) else None
    if d is None: break
print("" if d is None else d)' "$1" 2>/dev/null
}
# 注意：请求体含 `"` 时**不得**把 curl 内联进 "$( ... )"（嵌套引用会破坏 JSON body），
# 因此统一用两段式：先 `C=$(code ...)`，再断言。
code() { curl -s -o /tmp/wp08/.rbody -w '%{http_code}' "$@"; }
secs() { python3 -c "import datetime,sys
s=datetime.datetime.fromisoformat(sys.argv[1].replace('Z','+00:00'))
e=datetime.datetime.fromisoformat(sys.argv[2].replace('Z','+00:00'))
print(int((e-s).total_seconds()))" "$1" "$2"; }
post_json() { # cookie path body -> code（body 存 .rbody）
  code -X POST -H "Cookie: $1" -H 'content-type: application/json' -d "$3" "$CTRL$2"
}
chat() { # model bodyextra -> code
  code -X POST -H "Authorization: Bearer $APIKEY" -H 'content-type: application/json' \
    -d "{\"model\":\"$1\",\"messages\":[{\"role\":\"user\",\"content\":\"wp08\"}]$2}" "$GW/v1/chat/completions"
}

SECRETS=/tmp/wp08/quiescence-secrets.json
CK_A=$(jsonq tenants.A.cookie < "$SECRETS"); ENT_A=$(jsonq tenants.A.enterpriseId < "$SECRETS")
CK_C=$(jsonq tenants.C.cookie < "$SECRETS"); ENT_C=$(jsonq tenants.C.enterpriseId < "$SECRETS")
CK_E=$(jsonq tenants.E.cookie < "$SECRETS"); ENT_E=$(jsonq tenants.E.enterpriseId < "$SECRETS")
CK_B=$(jsonq tenants.B.cookie < "$SECRETS")
CK_D=$(jsonq tenants.D.cookie < "$SECRETS")
APIKEY=$(jsonq apiKey < "$SECRETS"); MODEL=$(jsonq modelAlias < "$SECRETS")
ZERO64=$(python3 -c "print('0'*64)")

# 正向激活池：取"首个尚未激活"的一家，使演练可重复而回执仍为一次性（严格写激活不可逆）。
# I1 整改后扩展：原池 P1..P4 已在历次演练中用尽，且 P4 因一次无效运行留下 append-only 合成
# 资金事件（不可删除）。故由 seed-extra-pool.ts 追加 pristine 的 P5/P6，池位扩到 P6。
POOL_KEY=""; POOL_ENT=""
for K in P1 P2 P3 P4 P5 P6; do
  E=$(jsonq "tenants.$K.enterpriseId" < "$SECRETS")
  S=$(pg "select coalesce((select strict_writes_enabled::text from provider_finance_runtime_state
        where enterprise_id='$E'), 'false')")
  if [ "${S:-false}" != "true" ]; then POOL_KEY=$K; POOL_ENT=$E; break; fi
done
if [ -z "$POOL_KEY" ]; then echo "!! 激活池已耗尽（P1～P4 全部已激活）"; exit 1; fi
CK_F=$(jsonq "tenants.$POOL_KEY.cookie" < "$SECRETS"); ENT_F="$POOL_ENT"
read -r PROV_F RES_F <<EOF2
$(python3 -c "
import sys
p = sys.argv[1].split('-')[0]
print(f'{p}-2222-4222-8222-{p[:4]}0000aa01', f'{p}-3333-4333-8333-{p[:4]}0000aa02')" "$ENT_F")
EOF2
IDEM_F="wp08-sim-purchase:$ENT_F"

echo "# WP08 7.3 激活前静默演练（PFA-09）"
echo "# 时刻(UTC): $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "# 候选镜像: $(docker image ls --format '{{.Repository}}:{{.Tag}}' | grep 'qianliu-candidate' | sort | tr '\n' ' ')"
echo "# 上游: 仅本地桩 ${STUB}（记录每次入站调用）；无公网端口；无真实厂商请求"
echo

echo "=============== 0. 基线与清理：本机全部合成企业均无有效静默租约 ==============="
# B/D 是前几轮演练留下的历史企业（其静默租约仍是本地合成数据），一并归零，
# 使第 4 节的"静默企业集合"只包含本轮真正建立租约的 A。
for ck in "$CK_A" "$CK_B" "$CK_C" "$CK_D" "$CK_E" "$CK_F"; do
  curl -s -o /dev/null -X POST -H "Cookie: $ck" -H 'content-type: application/json' \
    -d '{"reason":"WP08 7.3 演练前基线归零"}' "$CTRL/provider-finance/activation-quiescence/release"
done
for pair in "A:$CK_A" "C:$CK_C" "E:$CK_E" "F:$CK_F"; do
  K=${pair%%:*}; CK=${pair#*:}
  Q=$(curl -s -H "Cookie: $CK" "$CTRL/provider-finance/activation-quiescence")
  printf '  %s: status=%s active=%s drained=%s\n' "$K" \
    "$(echo "$Q" | jsonq quiescence.status)" "$(echo "$Q" | jsonq quiescence.active)" \
    "$(echo "$Q" | jsonq quiescence.drain.drained)"
done
BASE_A_AI=$(pg "select count(*) from ai_request where enterprise_id='$ENT_A'")
BASE_E_EV=$(pg "select count(*) from provider_finance_event where enterprise_id='$ENT_E'")
BASE_E_LED=$(pg "select count(*) from ledger_line where enterprise_id='$ENT_E'")
printf '  基线：A ai_request=%s；E finance_event=%s ledger_line=%s\n' "$BASE_A_AI" "$BASE_E_EV" "$BASE_E_LED"
echo

echo "=============== 1. [A] 静默租约时长边界：上限 60 分钟 ==============="
for D in 3601 0 -5; do
  C=$(post_json "$CK_A" /provider-finance/activation-quiescence "{\"duration_seconds\":$D}")
  printf '  duration_seconds=%-5s -> %s  %s\n' "$D" "$C" "$(head -c 120 /tmp/wp08/.rbody)"
  chk "越界时长 $D 被拒" "400" "$C"
done
C=$(post_json "$CK_A" /provider-finance/activation-quiescence '{"duration_seconds":3600}')
cp /tmp/wp08/.rbody /tmp/wp08/.leaseA
chk "上限时长 3600 接受" "201" "$C"
L_START=$(jsonq lease.started_at < /tmp/wp08/.leaseA); L_END=$(jsonq lease.expires_at < /tmp/wp08/.leaseA)
chk "租约时长恰为 3600 秒" "3600" "$(secs "$L_START" "$L_END")"
printf '  lease started_at=%s expires_at=%s status=%s\n' "$L_START" "$L_END" "$(jsonq lease.status < /tmp/wp08/.leaseA)"
echo

echo "=============== 2. [A] 静默期内 Gateway admission 零上游 ==============="
curl -s -o /dev/null "$STUB/__reset"
H0=$(curl -s "$STUB/__stats" | jsonq totalHits)
AI0=$(pg "select count(*) from ai_request where enterprise_id='$ENT_A'")
UA0=$(pg "select count(*) from upstream_attempt where enterprise_id='$ENT_A'")
UE0=$(pg "select count(*) from usage_event where enterprise_id='$ENT_A'")
LL0=$(pg "select count(*) from ledger_line where enterprise_id='$ENT_A'")
C=$(chat "$MODEL" ',"stream":false')
chk "静默期内模型调用被拦" "503" "$C"
cp /tmp/wp08/.rbody /tmp/wp08/.gate503
chk "错误码为 enterprise_maintenance" "enterprise_maintenance" "$(jsonq error.code < /tmp/wp08/.gate503)"
chk "标注 retryable" "True" "$(jsonq error.retryable < /tmp/wp08/.gate503)"
chk "maintenance_until = 租约到期时间" "$L_END" "$(jsonq error.maintenance_until < /tmp/wp08/.gate503)"
RA=$(curl -s -o /dev/null -D - -X POST -H "Authorization: Bearer $APIKEY" \
  -H 'content-type: application/json' \
  -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"wp08\"}]}" \
  "$GW/v1/chat/completions" | tr -d '\r' | awk 'tolower($1)=="retry-after:"{print $2}')
chk "retry-after: 60" "60" "$RA"
chk "桩上游命中数（零上游）" "$H0" "$(curl -s "$STUB/__stats" | jsonq totalHits)"
chk "ai_request 无新增" "$AI0" "$(pg "select count(*) from ai_request where enterprise_id='$ENT_A'")"
chk "upstream_attempt 无新增" "$UA0" "$(pg "select count(*) from upstream_attempt where enterprise_id='$ENT_A'")"
chk "usage_event 无新增" "$UE0" "$(pg "select count(*) from usage_event where enterprise_id='$ENT_A'")"
chk "ledger_line 无新增" "$LL0" "$(pg "select count(*) from ledger_line where enterprise_id='$ENT_A'")"
C=$(code -H "Authorization: Bearer $APIKEY" "$GW/v1/models")
chk "只读元数据 /v1/models 不受门禁" "200" "$C"
echo "  503 响应体（脱敏，无凭证）：$(cat /tmp/wp08/.gate503)"
echo

echo "=============== 3. [A] 在途请求继续排空 ==============="
C=$(post_json "$CK_A" /provider-finance/activation-quiescence/release \
  '{"reason":"WP08 7.3 在途排空演练：解除后建立慢响应在途请求"}')
chk "解除租约（带原因）" "200" "$C"
curl -s -o /dev/null "$STUB/__reset"
( curl -s -o /tmp/wp08/.slow.body -w '%{http_code}' -X POST \
    -H "Authorization: Bearer $APIKEY" -H 'content-type: application/json' \
    -d '{"model":"wp08-synthetic-slow","messages":[{"role":"user","content":"wp08-inflight"}],"stream":false}' \
    "$GW/v1/chat/completions" > /tmp/wp08/.slow.code ) &
SLOW_PID=$!
sleep 1.5
C=$(post_json "$CK_A" /provider-finance/activation-quiescence '{"duration_seconds":600}')
chk "在途请求提交后建立 600 秒静默租约" "201" "$C"
Q=$(curl -s -H "Cookie: $CK_A" "$CTRL/provider-finance/activation-quiescence")
IPR=$(echo "$Q" | jsonq quiescence.drain.in_progress_requests)
printf '  租约生效瞬间：active=%s remaining=%ss in_progress_requests=%s\n' \
  "$(echo "$Q" | jsonq quiescence.active)" "$(echo "$Q" | jsonq quiescence.remaining_seconds)" "$IPR"
if [ "${IPR:-0}" -ge 1 ] 2>/dev/null; then ok=$((ok+1)); printf '  [PASS] 在途请求被观测到（in_progress_requests=%s ≥ 1）\n' "$IPR"
else bad=$((bad+1)); printf '  [FAIL] in_progress_requests 期望≥1 实际=%s\n' "$IPR"; fi
C=$(post_json "$CK_A" /provider-finance/activation-preview "$EMPTY_DRAFT")
cp /tmp/wp08/.rbody /tmp/wp08/.inflight
chk "在途未排空时预检失败关闭" "409" "$C"
chk "错误码 activation_not_quiescent" "activation_not_quiescent" "$(jsonq error < /tmp/wp08/.inflight)"
chkcontains "拒绝原因指向在途未排空" "在途" "$(jsonq message < /tmp/wp08/.inflight)"
C=$(chat "$MODEL" ',"stream":false')
chk "静默期内新请求仍被拦" "503" "$C"
wait "$SLOW_PID"
chk "在途慢响应正常完成（未被门禁中止）" "200" "$(cat /tmp/wp08/.slow.code)"
chkcontains "在途响应来自桩上游" "wp08-stub-ok" "$(cat /tmp/wp08/.slow.body)"
Q=$(curl -s -H "Cookie: $CK_A" "$CTRL/provider-finance/activation-quiescence")
chk "在途请求已完成（排空）" "0" "$(echo "$Q" | jsonq quiescence.drain.in_progress_requests)"
chk "未配对用量行=0" "0" "$(echo "$Q" | jsonq quiescence.drain.unpaired_usage_lines)"
chk "待结算交易=0" "0" "$(echo "$Q" | jsonq quiescence.drain.pending_ledger_transactions)"
chk "排空判定 drained" "True" "$(echo "$Q" | jsonq quiescence.drain.drained)"
chk "桩命中数=1（仅放行的在途请求；被拦请求零上游）" "1" "$(curl -s "$STUB/__stats" | jsonq totalHits)"
echo "  在途排空阻塞响应（脱敏）：$(cat /tmp/wp08/.inflight)"
echo

echo "=============== 4. [A] Worker 共享门禁：静默企业被跳过 ==============="
WOUT=$(docker exec -w /app/apps/worker "$WORKER" \
  node --import tsx -e '
import("@qianliu/database").then(async (m) => {
  const db = m.createKysely(process.env.DATABASE_URL);
  try {
    const ids = await m.listQuiescentEnterpriseIds(db, new Date());
    const tick = await m.runSubscriptionAutoRenewals(db, new Date());
    console.log(JSON.stringify({ quiescentIds: ids, tick }));
  } finally { await db.destroy(); }
}).catch((e) => { console.error("EVAL_FAIL", e && e.message); process.exit(1); });
' 2>&1)
echo "$WOUT" | python3 -m json.tool 2>/dev/null | sed 's/^/  /' || echo "$WOUT" | sed 's/^/  /'
chk "Worker 门禁（listQuiescentEnterpriseIds）恰好只列出本轮静默企业 A" "[\"$ENT_A\"]" \
  "$(echo "$WOUT" | python3 -c '
import sys,json
raw=sys.stdin.read().strip()
print(json.dumps(json.loads(raw)["quiescentIds"]) if raw else "ERR")')"
Q=$(curl -s -H "Cookie: $CK_A" "$CTRL/provider-finance/activation-quiescence")
chk "600 秒租约仍有充足剩余（insufficient=false）" "False" "$(echo "$Q" | jsonq quiescence.insufficient_for_activation)"
chkrange "剩余时间约 600 秒" 560 600 "$(echo "$Q" | jsonq quiescence.remaining_seconds)"
echo

echo "=============== 5. [A] 租约到期自动恢复 ==============="
# 本地时钟注入：仅把合成行的时间窗整体前移（保持库层 CHECK：expires_at>started_at 且 ≤ started_at+60min）。
pg "update provider_finance_activation_quiescence set started_at=started_at-interval '2 hours', expires_at=expires_at-interval '2 hours' where enterprise_id='$ENT_A'" >/dev/null
Q=$(curl -s -H "Cookie: $CK_A" "$CTRL/provider-finance/activation-quiescence")
chk "控制面租约自动转为 EXPIRED" "EXPIRED" "$(echo "$Q" | jsonq quiescence.status)"
chk "active=false" "False" "$(echo "$Q" | jsonq quiescence.active)"
Q=$(curl -s -H "Cookie: $CK_A" "$CTRL/provider-finance/activation-state")
chk "activation-state 亦显示 active=false" "False" "$(echo "$Q" | jsonq quiescence.active)"
chk "strict_writes_enabled 未被静默演练改变" "False" "$(echo "$Q" | jsonq strict_writes_enabled)"
curl -s -o /dev/null "$STUB/__reset"
C=$(chat "$MODEL" ',"stream":false')
chk "到期后数据面流量自动恢复（不再 503）" "200" "$C"
chk "到期后桩上游收到 1 次调用" "1" "$(curl -s "$STUB/__stats" | jsonq totalHits)"
WOUT=$(docker exec -w /app/apps/worker "$WORKER" \
  node --import tsx -e '
import("@qianliu/database").then(async (m) => {
  const db = m.createKysely(process.env.DATABASE_URL);
  try { console.log(JSON.stringify(await m.listQuiescentEnterpriseIds(db, new Date()))); }
  finally { await db.destroy(); }
}).catch((e) => { console.error("EVAL_FAIL", e && e.message); process.exit(1); });
' 2>&1)
echo "  Worker 门禁（到期后）: $WOUT"
if echo "$WOUT" | grep -q "$ENT_A"; then bad=$((bad+1)); printf '  [FAIL] 到期后企业 A 仍在 Worker 门禁列表中\n'
else ok=$((ok+1)); printf '  [PASS] 到期后企业 A 不再被 Worker 门禁跳过\n'; fi
echo

echo "=============== 6. [E] 该租约下生成的旧候选在租约过期后不得继续激活 ==============="
C=$(post_json "$CK_E" /provider-finance/activation-quiescence '{"duration_seconds":3600}')
chk "建立 3600 秒静默租约（E）" "201" "$C"
C=$(post_json "$CK_E" /provider-finance/activation-preview "$EMPTY_DRAFT")
cp /tmp/wp08/.rbody /tmp/wp08/.prevE1
chk "预检返回 200" "200" "$C"
chk "预检结论 GO_CANDIDATE" "GO_CANDIDATE" "$(jsonq decision < /tmp/wp08/.prevE1)"
CID1=$(jsonq candidate_id < /tmp/wp08/.prevE1); CH1=$(jsonq candidate_hash < /tmp/wp08/.prevE1)
PC1=$(jsonq preview_committed_at < /tmp/wp08/.prevE1); EX1=$(jsonq expires_at < /tmp/wp08/.prevE1)
printf '  candidate_id=%s\n  candidate_hash=%s\n  preview_committed_at=%s\n  expires_at=%s\n' "$CID1" "$CH1" "$PC1" "$EX1"
chk "候选 TTL 恰为 1800 秒（30 分钟）" "1800" "$(secs "$PC1" "$EX1")"
chk "库层 expires_at=created_at+30min（CHECK 强制）" "true" \
  "$(pg "select (expires_at = created_at + interval '30 minutes')::text from provider_finance_activation_attempt where id='$CID1'")"
S1=$(curl -s -H "Cookie: $CK_E" "$CTRL/provider-finance/activation-state" | jsonq latest_candidate.expires_at)
chk "连续读取不滑动 TTL" "$S1" "$(curl -s -H "Cookie: $CK_E" "$CTRL/provider-finance/activation-state" | jsonq latest_candidate.expires_at)"
C=$(post_json "$CK_E" /provider-finance/activate \
  '{"candidate_id":"'"$CID1"'","candidate_hash":"'"$ZERO64"'","idempotency_key":"wp08-fail-probe-key-0001","confirm_enterprise_id":"'"$ENT_E"'"}')
chk "失败探针（哈希不符）失败关闭" "409" "$C"
chk "失败探针错误码 candidate_stale" "candidate_stale" "$(jsonq error < /tmp/wp08/.rbody)"
chk "失败探针后 TTL 仍不滑动" "$S1" "$(curl -s -H "Cookie: $CK_E" "$CTRL/provider-finance/activation-state" | jsonq latest_candidate.expires_at)"
chk "TTL 由库层 CHECK 固定（读取/失败/重放均不能延长）" "true" \
  "$(pg "select (expires_at = created_at + interval '30 minutes')::text from provider_finance_activation_attempt where id='$CID1'")"
chk "候选当前仍在有效 TTL 内" "true" \
  "$(pg "select (expires_at > now())::text from provider_finance_activation_attempt where id='$CID1'")"
# 本地时钟注入：把租约时间窗整体前移，等价于等待 60 分钟租约自然到期。
pg "update provider_finance_activation_quiescence set started_at=started_at-interval '2 hours', expires_at=expires_at-interval '2 hours' where enterprise_id='$ENT_E'" >/dev/null
C=$(post_json "$CK_E" /provider-finance/activate \
  '{"candidate_id":"'"$CID1"'","candidate_hash":"'"$CH1"'","idempotency_key":"wp08-oldcand-key-00000001","confirm_enterprise_id":"'"$ENT_E"'"}')
cp /tmp/wp08/.rbody /tmp/wp08/.oldcand
chk "租约过期后旧候选激活被拒" "409" "$C"
chk "错误码 activation_not_quiescent" "activation_not_quiescent" "$(jsonq error < /tmp/wp08/.oldcand)"
chk "候选仍在有效 TTL 内（证明拒绝来自租约而非候选）" "true" \
  "$(pg "select (expires_at > now())::text from provider_finance_activation_attempt where id='$CID1'")"
chk "候选状态仍为 PREVIEWED" "PREVIEWED" "$(pg "select status from provider_finance_activation_attempt where id='$CID1'")"
chk "未发生任何资金写入（finance_event）" "$BASE_E_EV" "$(pg "select count(*) from provider_finance_event where enterprise_id='$ENT_E'")"
chk "未发生任何账本写入（ledger_line）" "$BASE_E_LED" "$(pg "select count(*) from ledger_line where enterprise_id='$ENT_E'")"
chk "strict_writes_enabled 仍未开启" "False" "$(curl -s -H "Cookie: $CK_E" "$CTRL/provider-finance/activation-state" | jsonq strict_writes_enabled)"
echo "  拒绝响应（脱敏）：$(cat /tmp/wp08/.oldcand)"
echo

echo "=============== 7. [E] 激活需剩余 ≥5 分钟 ==============="
C=$(post_json "$CK_E" /provider-finance/activation-quiescence '{"duration_seconds":3600}')
chk "重建 3600 秒租约" "201" "$C"
# 本地时钟注入：把窗口压到「距今约 120 秒」，同时保持 start/end 跨度 = 60 分钟（满足库层 CHECK）。
pg "update provider_finance_activation_quiescence set started_at=now()-interval '58 minutes', expires_at=now()+interval '2 minutes' where enterprise_id='$ENT_E'" >/dev/null
Q=$(curl -s -H "Cookie: $CK_E" "$CTRL/provider-finance/activation-quiescence")
chkrange "剩余时间约 120 秒" 100 140 "$(echo "$Q" | jsonq quiescence.remaining_seconds)"
chk "标记为不足以激活" "True" "$(echo "$Q" | jsonq quiescence.insufficient_for_activation)"
C=$(post_json "$CK_E" /provider-finance/activate \
  '{"candidate_id":"'"$CID1"'","candidate_hash":"'"$CH1"'","idempotency_key":"wp08-shortlease-key-00001","confirm_enterprise_id":"'"$ENT_E"'"}')
cp /tmp/wp08/.rbody /tmp/wp08/.shortlease
chk "剩余不足 5 分钟时激活被拒" "409" "$C"
chk "错误码 activation_not_quiescent" "activation_not_quiescent" "$(jsonq error < /tmp/wp08/.shortlease)"
chkcontains "提示重新建立静默期" "静默期" "$(jsonq message < /tmp/wp08/.shortlease)"
chkrange "返回剩余秒数约 120" 100 140 "$(jsonq detail.remainingSeconds < /tmp/wp08/.shortlease)"
chk "仍未发生资金写入" "$BASE_E_EV" "$(pg "select count(*) from provider_finance_event where enterprise_id='$ENT_E'")"
echo "  拒绝响应（脱敏）：$(cat /tmp/wp08/.shortlease)"
echo

echo "=============== 8. [C] 候选 TTL 30 分钟：过期候选不可激活 ==============="
C=$(post_json "$CK_C" /provider-finance/activation-quiescence '{"duration_seconds":3600}')
chk "建立 3600 秒租约（C）" "201" "$C"
C=$(post_json "$CK_C" /provider-finance/activation-preview "$EMPTY_DRAFT")
cp /tmp/wp08/.rbody /tmp/wp08/.prevC
chk "预检成功（C）" "200" "$C"
CIDC=$(jsonq candidate_id < /tmp/wp08/.prevC); CHC=$(jsonq candidate_hash < /tmp/wp08/.prevC)
chk "候选 TTL 由库层 CHECK 固定为 30 分钟" "true" \
  "$(pg "select (expires_at = created_at + interval '30 minutes')::text from provider_finance_activation_attempt where id='$CIDC'")"
# 本地时钟注入：候选预览事实不可变（`provider_finance_protect_activation_attempt` 触发器保护
# created_at/expires_at），因此插入一条**逐列等价、仅预览时刻前移 31 分钟**的候选行并移除原始行，
# 语义等价于「真实预检后等待 31 分钟再激活」；哈希/草稿/水位逐字相同。
BACKDATED=$(pgi "insert into provider_finance_activation_attempt
  (id, enterprise_id, candidate_hash, fact_watermark_hash, decision, status, gap_summary, projection_summary,
   usage_repair_baseline, created_by_admin_user_id, created_at, expires_at, candidate_draft)
 select gen_random_uuid(), enterprise_id, candidate_hash, fact_watermark_hash, decision, 'PREVIEWED', gap_summary,
        projection_summary, usage_repair_baseline, created_by_admin_user_id,
        now()-interval '31 minutes', (now()-interval '31 minutes')+interval '30 minutes', candidate_draft
   from provider_finance_activation_attempt where id='$CIDC' returning id")
pg "delete from provider_finance_activation_attempt where id='$CIDC'" >/dev/null
echo "  前移候选行 id=${BACKDATED}（created_at=now()-31min；原行已按本地时钟注入移除）"
chk "前移候选仍满足库层 TTL CHECK" "true" \
  "$(pg "select (expires_at = created_at + interval '30 minutes')::text from provider_finance_activation_attempt where id='$BACKDATED'")"
chk "前移候选已过期" "true" \
  "$(pg "select (expires_at <= now())::text from provider_finance_activation_attempt where id='$BACKDATED'")"
chk "成为该企业最新候选（activation-state 可见且已标记过期）" "$BACKDATED|True" \
  "$(curl -s -H "Cookie: $CK_C" "$CTRL/provider-finance/activation-state" | jsonq latest_candidate.candidate_id)|$(curl -s -H "Cookie: $CK_C" "$CTRL/provider-finance/activation-state" | jsonq latest_candidate.expired)"
C=$(post_json "$CK_C" /provider-finance/activate \
  '{"candidate_id":"'"$BACKDATED"'","candidate_hash":"'"$CHC"'","idempotency_key":"wp08-expired-key-0000001","confirm_enterprise_id":"'"$ENT_C"'"}')
cp /tmp/wp08/.rbody /tmp/wp08/.expired
chk "过期候选激活被拒" "409" "$C"
chk "错误码 candidate_expired" "candidate_expired" "$(jsonq error < /tmp/wp08/.expired)"
chk "未发生资金写入（C）" "0" "$(pg "select count(*) from provider_finance_event where enterprise_id='$ENT_C'")"
chk "strict_writes_enabled 未开启（C）" "False" "$(curl -s -H "Cookie: $CK_C" "$CTRL/provider-finance/activation-state" | jsonq strict_writes_enabled)"
echo "  拒绝响应（脱敏）：$(cat /tmp/wp08/.expired)"
echo

echo "=============== 9. [$POOL_KEY] 正向路径：TTL 内 + 剩余 ≥5 分钟 → 激活成功与幂等重放 ==============="
echo "  本次正向激活企业：$POOL_KEY = ${ENT_F}（池中首个尚未激活者）"
C=$(post_json "$CK_F" /provider-finance/activation-quiescence '{"duration_seconds":3600}')
chk "建立 3600 秒静默租约（${POOL_KEY}）" "201" "$C"
chk "激活前 strict_writes_enabled=false" "False" \
  "$(curl -s -H "Cookie: $CK_F" "$CTRL/provider-finance/activation-state" | jsonq strict_writes_enabled)"
chk "激活前无已激活回执" "" \
  "$(curl -s -H "Cookie: $CK_F" "$CTRL/provider-finance/activation-state" | jsonq activated_at)"
C=$(post_json "$CK_F" /provider-finance/activation-preview "$EMPTY_DRAFT")
cp /tmp/wp08/.rbody /tmp/wp08/.prevF
chk "预检成功（F）" "200" "$C"
chk "预检结论 GO_CANDIDATE（F）" "GO_CANDIDATE" "$(jsonq decision < /tmp/wp08/.prevF)"
CIDF=$(jsonq candidate_id < /tmp/wp08/.prevF); CHF=$(jsonq candidate_hash < /tmp/wp08/.prevF)
chk "静默租约剩余充足（insufficient=false）" "False" \
  "$(curl -s -H "Cookie: $CK_F" "$CTRL/provider-finance/activation-quiescence" | jsonq quiescence.insufficient_for_activation)"
ACTREQ='{"candidate_id":"'"$CIDF"'","candidate_hash":"'"$CHF"'","idempotency_key":"wp08-activate-key-000001","confirm_enterprise_id":"'"$ENT_F"'"}'
C=$(post_json "$CK_F" /provider-finance/activate "$ACTREQ")
cp /tmp/wp08/.rbody /tmp/wp08/.actF
chk "激活成功" "200" "$C"
chk "非重放（首次）" "False" "$(jsonq replayed < /tmp/wp08/.actF)"
chk "回执守恒通过" "True" "$(jsonq receipt.conservationPassed < /tmp/wp08/.actF)"
AT=$(jsonq receipt.activatedAt < /tmp/wp08/.actF)
echo "  回执：candidate_id=$(jsonq candidate_id < /tmp/wp08/.actF) activatedAt=$AT factCounts=$(jsonq receipt.factCounts < /tmp/wp08/.actF)"
C=$(post_json "$CK_F" /provider-finance/activate "$ACTREQ")
chk "相同幂等键重放成功" "200" "$C"
chk "标记为重放" "True" "$(jsonq replayed < /tmp/wp08/.rbody)"
chk "重放回执与首次一致" "$AT" "$(jsonq receipt.activatedAt < /tmp/wp08/.rbody)"
Q=$(curl -s -H "Cookie: $CK_F" "$CTRL/provider-finance/activation-state")
chk "strict_writes_enabled 已开启" "True" "$(echo "$Q" | jsonq strict_writes_enabled)"
chk "activation_receipt 已落库" "True" \
  "$(python3 -c "import json,sys;d=json.loads(sys.argv[1]);print(d.get('activation_receipt') is not None)" "$Q")"
chk "activated_at 已落库" "$AT" "$(echo "$Q" | jsonq activated_at)"
chk "库层 strict_writes_enabled=true" "true" \
  "$(pg "select strict_writes_enabled::text from provider_finance_runtime_state where enterprise_id='$ENT_F'")"
chk "候选行状态 ACTIVATED" "ACTIVATED" \
  "$(pg "select status from provider_finance_activation_attempt where id='$CIDF'")"
echo "-- 附加观测：激活终态不可逆（同企业不可再创建候选；租约仍有效，故先过静默门禁才会到该判定）"
C=$(post_json "$CK_F" /provider-finance/activation-preview "$EMPTY_DRAFT")
chk "已激活企业不可重复创建初始化候选" "409" "$C"
chk "错误码 already_activated" "already_activated" "$(jsonq error < /tmp/wp08/.rbody)"
echo

echo "=============== 10. [$POOL_KEY] Worker 自动续订：静默期跳过 → 到期自动恢复 ==============="
docker cp /tmp/wp08/worker-renewal-fixture.ts "$WORKER:/app/apps/worker/wp08-worker-renewal-fixture.ts" >/dev/null
fixture() { # mode（注意：docker exec 的 -e/-w 必须出现在容器名之前）
  docker exec -w /app/apps/worker \
    -e WP08_ENT="$ENT_F" -e WP08_ADMIN="$(jsonq "tenants.$POOL_KEY.adminId" < "$SECRETS")" \
    -e WP08_PROV="$PROV_F" -e WP08_RES="$RES_F" -e WP08_IDEM="$IDEM_F" \
    "$WORKER" node --import tsx ./wp08-worker-renewal-fixture.ts "$1" 2>&1
}
jline() { grep '^WP08JSON ' | head -1 | sed 's/^WP08JSON //'; }
tickfield() {
  jline | python3 -c '
import sys,json
raw=sys.stdin.read().strip()
print(json.loads(raw)["tick"].get(sys.argv[1]) if raw else "ERR")' "$1"
}
tiplist() {
  jline | python3 -c '
import sys,json
raw=sys.stdin.read().strip()
print(json.dumps(json.loads(raw)["tick"]["skippedQuiescentEnterprises"]) if raw else "ERR")'
}
echo "-- 建合成订阅（CODING_PLAN，周期 [上海昨日零点, 上海今日零点) ）"
FIX=$(fixture fixture); echo "$FIX" | sed 's/^/  /'
chkcontains "合成订阅已写入" "templatePeriod" "$FIX"
chk "自动续订窗口已到期（scanned ≥ 1）" "1" "$(fixture tick | tickfield scanned)"
echo "-- 建立静默租约（F）后跑一次真实 Worker tick"
C=$(post_json "$CK_F" /provider-finance/activation-quiescence '{"duration_seconds":3600}')
chk "建立 3600 秒静默租约（F）" "201" "$C"
T1=$(fixture tick); echo "$T1" | sed 's/^/  /'
chk "静默期 tick 未创建续订" "0" "$(echo "$T1" | tickfield created)"
chkcontains "静默期 tick 将该企业列为跳过" "$ENT_F" "$T1"
echo "-- 租约到期后（本地时钟注入）再跑一次 tick"
pg "update provider_finance_activation_quiescence set started_at=started_at-interval '2 hours', expires_at=expires_at-interval '2 hours' where enterprise_id='$ENT_F'" >/dev/null
T2=$(fixture tick); echo "$T2" | sed 's/^/  /'
chk "到期后 tick 自动恢复并创建 1 条续订" "1" "$(echo "$T2" | tickfield created)"
chk "到期后不再列为跳过" "[]" "$(echo "$T2" | tiplist)"
EV=$(fixture events); echo "$EV" | sed 's/^/  /'
chkcontains "存在 SYSTEM_RENEWAL 资金事件（续订已真实落库）" "SYSTEM_RENEWAL" "$EV"
chk "续订事件恰好 1 条" "1" \
  "$(pg "select count(*) from provider_finance_event where enterprise_id='$ENT_F' and source='SYSTEM_RENEWAL'")"
chk "重复 tick 不重复扣费（幂等）" "0" "$(fixture tick | tickfield created)"
echo

echo "=============== 11. 收尾：清理演练租约（不改动任何资金事实） ==============="
for pair in "A:$CK_A" "C:$CK_C" "E:$CK_E" "$POOL_KEY:$CK_F"; do
  K=${pair%%:*}; CK=${pair#*:}
  C=$(post_json "$CK" /provider-finance/activation-quiescence/release '{"reason":"WP08 7.3 演练收尾"}')
  printf '  release(%s) -> %s\n' "$K" "$C"
done
echo "  演练涉及企业的 strict_writes_enabled（终态）："
for K in A C E "$POOL_KEY"; do
  CK=$(jsonq "tenants.$K.cookie" < "$SECRETS")
  printf '    %s = %s\n' "$K" \
    "$(curl -s -H "Cookie: $CK" "$CTRL/provider-finance/activation-state" | jsonq strict_writes_enabled)"
done
echo "  A/C/E 全程 false（演练零资金写入）；$POOL_KEY 为本地合成企业上的一次性正向激活（不可逆，仅本地一次性库）。"
echo
echo "# 结束(UTC): $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "# 断言汇总: PASS=$ok FAIL=$bad"
[ "$bad" -eq 0 ] && echo "# RESULT: GO" || echo "# RESULT: NO-GO"
