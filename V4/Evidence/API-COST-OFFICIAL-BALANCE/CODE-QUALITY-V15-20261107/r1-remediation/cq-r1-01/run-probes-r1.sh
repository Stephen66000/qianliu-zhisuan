#!/usr/bin/env bash
# CQ-R1-01 探针执行器（R1 返修专用）——swap 前置影子库验证门 先红后绿。
# 基线＝CQ-01 run-probes.sh（SHA256
# fb433709aec66e88f1040155a8ebc71f6cf0592e53a91e09271da70d912d561e，
# 位于 ../red-evidence/）；复用其桩协议与捕获审计，追加：
#   ①逐用例程序化断言（exit/零 RENAME/破坏调用目标/RENAME 目标序/验证先于改名）；
#   ②R1 红/绿矩阵（未验证影子直接 swap／verify 失败后 swap／环境失败区分）；
#   ③regression 模式：CQ-01 绿证 20 用例逐字复刻（唯一适配＝ok-swap-distinct
#     补 swap 新必需参数 --db-ref/--manifest，与 X07 调用方适配同规）。
# 用法: run-probes-r1.sh <mode> <被测脚本绝对路径> <输出log绝对路径> <捕获根目录>
#   mode = red | green | regression
# 不连真实 Docker：PATH 前置桩目录，DOCKER_HOST 指向不存在的 sock。零真实库接触。
set -u
MODE="${1:?red|green|regression}"
SCRIPT_UNDER_TEST="${2:?script path}"
LOG="${3:?log path}"
CAP_ROOT="${4:?capture root}"

STUB_SRC="$(cd "$(dirname "$0")" && pwd)"
REPLAY_ORDER="enterprise provider unified_model principal principal_key provider_resource billing_rule model_route ai_request upstream_attempt usage_event ledger_line ledger_transaction principal_grant quota_counter principal_quota_period principal_quota_usage"
EMPTY_SHA="e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
FIX="$CAP_ROOT/fixtures"
mkdir -p "$FIX/delta-out" "$FIX/captures"

# 桩 bin：PATH 前置目录内必须存在名为 docker 的可执行（用复制，兼容 bash 3.2）
STUB_BIN="$CAP_ROOT/.stub-bin"
rm -rf "$STUB_BIN"; mkdir -p "$STUB_BIN"
cp "$STUB_SRC/stub-docker-r1.sh" "$STUB_BIN/docker"
chmod +x "$STUB_BIN/docker"
STUB_DIR="$STUB_BIN"

# ── 夹具 ────────────────────────────────────────────────────────────────
: > "$FIX/dump.bin"
i=0
while [ "$i" -lt 20 ]; do printf 'WP6-R4-CQ01-FAKE-DUMP-FOR-STUBXXXXXXXXXX' >> "$FIX/dump.bin"; i=$((i+1)); done
for T in $REPLAY_ORDER; do : > "$FIX/delta-out/$T.copy"; done

build_manifest() { # $1=out $2=live_db  （container=pgtest ref_db=refdb，与 CQ-01 夹具同构）
  M="$1"; LIVE_DB_FIX="$2"
  {
    printf 'manifest_version\twp6-r4-1\n'
    printf 'generated_at\t2026-11-07T00:00:00Z\n'
    printf 'container\tpgtest\n'
    printf 'live_db\t%s\n' "$LIVE_DB_FIX"
    printf 'live_migration_head\t0096_official_balance_refresh_request\n'
    printf 'ref_db\trefdb\n'
    printf 'ref_migration_head\t0091_recorded_cost_accounting_policy\n'
    printf 'dump_sha256\t%s\n' "$(shasum -a 256 "$FIX/dump.bin" | awk '{print $1}')"
    printf 'replay_order\t%s\n' "$(printf '%s' "$REPLAY_ORDER" | tr ' ' ',')"
    printf 'external_parents\tperson,admin_user,historical_import_run,employee_model_rule_version,provider_finance_legacy_cost_resolution,provider_subscription_period\n'
    printf 'begin_tables\n'
    for T in $REPLAY_ORDER; do
      printf 'table\t%s\trows=0\tinserted=0\tupdated=0\tsha256=%s\tref_present=yes\tcolumns=id\ttypes=id:integer\n' "$T" "$EMPTY_SHA"
    done
    printf 'end_tables\n'
  } > "$M"
  printf 'manifest_done\t%s\n' "$(shasum -a 256 "$M" | awk '{print $1}')" >> "$M"
}
build_manifest "$FIX/manifest-full.tsv" synthetic_live      # live_db＝synthetic_live（CQ-01 夹具同构）
build_manifest "$FIX/manifest-live-other.tsv" other_live    # live_db＝other_live（回归 ok-swap-distinct 适配用）

# ── 执行器（捕获协议＝CQ-01 run-probes.sh；另写 $CAP/exit 供程序化断言）──
CASE_NO=0
CASE_ENV_A=()
PASS=0; FAIL=0; FAIL_LIST=""
run_case() { # $1=场景名; 其余=脚本参数; 附加环境经数组 CASE_ENV_A 传入（调用前置空）
  NAME="$1"; shift
  CASE_NO=$((CASE_NO+1))
  CAP="$CAP_ROOT/captures/$NAME"
  rm -rf "$CAP"; mkdir -p "$CAP"
  {
    echo "──────────────────────────────────────────────────────────"
    echo "## CASE $CASE_NO: $NAME"
    echo "argv: $*"
    if [ "${#CASE_ENV_A[@]}" -gt 0 ]; then
      printf 'env-extra:'
      for kv in ${CASE_ENV_A[@]+"${CASE_ENV_A[@]}"}; do printf ' %s' "$kv"; done
      printf '\n'
    fi
    echo "env-base: PATH=stub-first DOCKER_HOST=unix:///nonexistent-cq01-guard.sock"
  } >> "$LOG"
  CODE=0
  PATH="$STUB_DIR:$PATH" DOCKER_HOST=unix:///nonexistent-cq01-guard.sock STUB_CAPTURE_DIR="$CAP" \
    env ${CASE_ENV_A[@]+"${CASE_ENV_A[@]}"} bash "$SCRIPT_UNDER_TEST" "$@" \
    > "$CAP/stdout" 2> "$CAP/stderr" || CODE=$?
  echo "$CODE" > "$CAP/exit"
  {
    echo "exit=$CODE"
    echo "stderr: $(head -3 "$CAP/stderr")"
    echo "stdout-head: $(head -c 200 "$CAP/stdout" | tr '\n' ' ')"
    bash "$STUB_SRC/audit-capture.sh" "$CAP"
  } >> "$LOG" 2>&1
  CASE_ENV_A=()
}

# ── 程序化断言（断言失败不中断，逐项记入 LOG 与总结）────────────────────
assert() { # $1=断言名 $2=期望 $3=实际
  if [ "$2" = "$3" ]; then
    PASS=$((PASS+1)); echo "  ASSERT-PASS $1 (expect=$2 actual=$3)" >> "$LOG"
  else
    FAIL=$((FAIL+1)); FAIL_LIST="$FAIL_LIST $1"
    echo "  ASSERT-FAIL $1 (expect=$2 actual=$3)" >> "$LOG"
  fi
}
assert_match() { # $1=断言名 $2=模式 $3=被检文件（grep -q 语义）
  if grep -q -- "$2" "$3" 2>/dev/null; then
    PASS=$((PASS+1)); echo "  ASSERT-PASS $1 (pattern found)" >> "$LOG"
  else
    FAIL=$((FAIL+1)); FAIL_LIST="$FAIL_LIST $1"
    echo "  ASSERT-FAIL $1 (pattern NOT found: $2)" >> "$LOG"
  fi
}
cap_exit()           { cat "$CAP_ROOT/captures/$1/exit"; }
cap_rename_lines()   { cat "$CAP_ROOT/captures/$1"/*.stdin 2>/dev/null | grep "ALTER DATABASE" | sed 's/^[[:space:]]*//' || true; }
cap_rename_count()   { cap_rename_lines "$1" | grep -c "ALTER DATABASE" || true; }
cap_dropdb_targets() { grep -l "dropdb" "$CAP_ROOT/captures/$1"/*.argv 2>/dev/null | while read -r f; do tail -1 "$f"; done; }
cap_docker_calls()   { ls "$CAP_ROOT/captures/$1"/*.argv 2>/dev/null | wc -l | tr -d ' '; }
cap_file_ids_with() { # $1=场景 $2=模式 → 捕获序号列表（argv＋stdin 都搜：\copy 在 argv、改名 SQL 在 stdin）
  { grep -l -- "$2" "$CAP_ROOT/captures/$1"/*.argv "$CAP_ROOT/captures/$1"/*.stdin 2>/dev/null || true; } \
    | sed 's#.*/\([0-9]*\)\.\(argv\|stdin\)#\1#' | sort
}

assert_zero_rename() { # $1=场景
  assert "$1/zero-ALTER-DATABASE" "0" "$(cap_rename_count "$1")"
}
assert_only_destructive() { # $1=场景 $2=唯一允许的 dropdb 目标（空＝不允许任何 dropdb；createdb 恒须为零）
  DROPS="$(cap_dropdb_targets "$1" | sort -u | tr '\n' ' ' | sed 's/ $//')"
  assert "$1/dropdb-targets" "$2" "$DROPS"
  CREATEDB_N="$(grep -l "createdb" "$CAP_ROOT/captures/$1"/*.argv 2>/dev/null | wc -l | tr -d ' ')"
  assert "$1/zero-createdb" "0" "$CREATEDB_N"
}
assert_rename_pair() { # $1=场景 $2=live $3=keep $4=shadow：恰两条且序＝live→keep 先、shadow→live 后
  assert "$1/rename-count" "2" "$(cap_rename_count "$1")"
  assert "$1/rename-1-live-to-keep" "ALTER DATABASE \"$2\" RENAME TO \"$3\";" \
    "$(cap_rename_lines "$1" | sed -n '1p')"
  assert "$1/rename-2-shadow-to-live" "ALTER DATABASE \"$4\" RENAME TO \"$2\";" \
    "$(cap_rename_lines "$1" | sed -n '2p')"
}
assert_verify_precedes_rename() { # $1=场景：带 ALTER DATABASE 的调用序号须大于首个摘要调用序号
  REN_ID="$(cap_file_ids_with "$1" "ALTER DATABASE" | tail -1)"
  DIG_FIRST="$(cap_file_ids_with "$1" "TO STDOUT" | head -1)"
  if [ -n "$REN_ID" ] && [ -n "$DIG_FIRST" ] && [ "$REN_ID" \> "$DIG_FIRST" ]; then
    PASS=$((PASS+1)); echo "  ASSERT-PASS $1 (verify-digest id=$DIG_FIRST precedes rename id=$REN_ID)" >> "$LOG"
  else
    FAIL=$((FAIL+1)); FAIL_LIST="$FAIL_LIST $1/verify-before-rename"
    echo "  ASSERT-FAIL $1 (ren_id=$REN_ID dig_first=$DIG_FIRST)" >> "$LOG"
  fi
}
summary() {
  {
    echo "──────────────────────────────────────────────────────────"
    echo "== SUMMARY mode=$MODE cases=$CASE_NO asserts-pass=$PASS asserts-fail=$FAIL =="
    [ -n "$FAIL_LIST" ] && echo "failed-asserts:$FAIL_LIST" || echo "ALL-ASSERTS-PASS"
    echo "VERDICT mode=$MODE: $( [ "$FAIL" = "0" ] && echo PASS || echo FAIL )"
  } >> "$LOG"
  echo "DONE mode=$MODE cases=$CASE_NO asserts_pass=$PASS asserts_fail=$FAIL log=$LOG"
  [ "$FAIL" = "0" ] || exit 1
}

# ════════════════════════════════════════════════════════════════════════
case "$MODE" in
red)
  # 被测＝e136e8a 原版快照。断言方向＝「缺陷本相应复现」：红证成立＝这些断言全过。
  echo "==== CQ-R1-01 RED probes（被测：$(basename "$SCRIPT_UNDER_TEST")）====" >> "$LOG"

  # 红1：影子库存在但从未经过 verify → 直接 swap。合同要求＝拒绝且零 RENAME；
  # 原版预期（红）＝exit 0＋发出双 RENAME。
  CASE_ENV_A=(ROLLBACK_DELTA_CONFIRM=YES STUB_EXISTING_DBS="synthetic_live shadow_ok")
  run_case red1-swap-unverified-shadow \
    swap --container pgtest --db-live synthetic_live --db-shadow shadow_ok
  assert "red1/exit" "0" "$(cap_exit red1-swap-unverified-shadow)"
  assert "red1/rename-count" "2" "$(cap_rename_count red1-swap-unverified-shadow)"
  assert_rename_pair red1-swap-unverified-shadow synthetic_live synthetic_live_pre_rollback_keep shadow_ok

  # 红2a：先跑 verify 使其失败（影子摘要与 live 不符）→ 原版 verify 本身 fail-closed
  # （exit 8＋删影子）——记录验证失败路径的形态。
  CASE_ENV_A=(STUB_SHADOW_DIGEST_ALT=1)
  run_case red2a-verify-digest-mismatch-fails \
    verify --container pgtest --db-live synthetic_live --db-shadow shadow_ok --db-ref refdb --manifest "$FIX/manifest-full.tsv"
  assert "red2a/exit" "8" "$(cap_exit red2a-verify-digest-mismatch-fails)"
  assert_only_destructive red2a-verify-digest-mismatch-fails "shadow_ok"
  assert_zero_rename red2a-verify-digest-mismatch-fails

  # 红2b：验证失败（红2a 同型影子）后再 swap → 原版不查 verify、不跑摘要，仍放行
  # 并发出双 RENAME——缺陷本相（红）。
  CASE_ENV_A=(ROLLBACK_DELTA_CONFIRM=YES STUB_EXISTING_DBS="synthetic_live shadow_ok" STUB_SHADOW_DIGEST_ALT=1)
  run_case red2b-swap-after-verify-failure-still-passes \
    swap --container pgtest --db-live synthetic_live --db-shadow shadow_ok
  assert "red2b/exit" "0" "$(cap_exit red2b-swap-after-verify-failure-still-passes)"
  assert "red2b/rename-count" "2" "$(cap_rename_count red2b-swap-after-verify-failure-still-passes)"
  assert_rename_pair red2b-swap-after-verify-failure-still-passes synthetic_live synthetic_live_pre_rollback_keep shadow_ok

  # 红3：前置环境失败（容器不可达）——原版在 require_env 处 exit 3、零破坏调用。
  # 如实记录：这是前置环境失败，不算验证拒绝（不触发任何 verify/摘要）。
  CASE_ENV_A=(ROLLBACK_DELTA_CONFIRM=YES STUB_FAIL_ENV=1 STUB_EXISTING_DBS="synthetic_live shadow_ok")
  run_case red3-swap-env-unreachable \
    swap --container pgtest --db-live synthetic_live --db-shadow shadow_ok
  assert "red3/exit" "3" "$(cap_exit red3-swap-env-unreachable)"
  assert_zero_rename red3-swap-env-unreachable
  assert_only_destructive red3-swap-env-unreachable ""
  ;;

green)
  # 被测＝整改后脚本。断言方向＝「验证门生效」：负向全部在任何 RENAME 之前 exit≠0。
  echo "==== CQ-R1-01 GREEN probes（被测：$(basename "$SCRIPT_UNDER_TEST")）====" >> "$LOG"

  # 绿1（负）：缺验证必需参数 --db-ref/--manifest → exit≠0、零容器调用（先于 require_env）。
  CASE_ENV_A=(ROLLBACK_DELTA_CONFIRM=YES STUB_EXISTING_DBS="synthetic_live shadow_ok")
  run_case green1-swap-missing-verify-params-rejected \
    swap --container pgtest --db-live synthetic_live --db-shadow shadow_ok
  assert "green1/exit-nonzero" "2" "$(cap_exit green1-swap-missing-verify-params-rejected)"
  assert "green1/zero-docker-calls" "0" "$(cap_docker_calls green1-swap-missing-verify-params-rejected)"
  assert_zero_rename green1-swap-missing-verify-params-rejected
  assert_match "green1/stderr-mentions-db-ref" "db-ref" "$CAP_ROOT/captures/green1-swap-missing-verify-params-rejected/stderr"

  # 绿2（负）：有 --db-ref 缺 --manifest → exit≠0、零容器调用。
  CASE_ENV_A=(ROLLBACK_DELTA_CONFIRM=YES)
  run_case green2-swap-missing-manifest-rejected \
    swap --container pgtest --db-live synthetic_live --db-shadow shadow_ok --db-ref refdb
  assert "green2/exit-nonzero" "2" "$(cap_exit green2-swap-missing-manifest-rejected)"
  assert "green2/zero-docker-calls" "0" "$(cap_docker_calls green2-swap-missing-manifest-rejected)"
  assert_zero_rename green2-swap-missing-manifest-rejected

  # 绿3（负）：--manifest 指向不存在文件 → exit≠0、零容器调用。
  CASE_ENV_A=(ROLLBACK_DELTA_CONFIRM=YES)
  run_case green3-swap-manifest-file-missing-rejected \
    swap --container pgtest --db-live synthetic_live --db-shadow shadow_ok --db-ref refdb --manifest "$FIX/nonexistent.tsv"
  assert "green3/exit-nonzero" "2" "$(cap_exit green3-swap-manifest-file-missing-rejected)"
  assert "green3/zero-docker-calls" "0" "$(cap_docker_calls green3-swap-manifest-file-missing-rejected)"
  assert_zero_rename green3-swap-manifest-file-missing-rejected

  # 绿4（负）：验证对象与待切换对象不符——清单 live_db=synthetic_live ≠ --db-live other_live。
  CASE_ENV_A=(ROLLBACK_DELTA_CONFIRM=YES)
  run_case green4-swap-live-object-mismatch-rejected \
    swap --container pgtest --db-live other_live --db-shadow shadow_ok --db-ref refdb --manifest "$FIX/manifest-full.tsv"
  assert "green4/exit-nonzero" "9" "$(cap_exit green4-swap-live-object-mismatch-rejected)"
  assert_zero_rename green4-swap-live-object-mismatch-rejected
  assert_only_destructive green4-swap-live-object-mismatch-rejected ""
  assert_match "green4/stderr-mentions-mismatch" "清单" "$CAP_ROOT/captures/green4-swap-live-object-mismatch-rejected/stderr"

  # 绿5（负）：容器与清单 container 不符。
  CASE_ENV_A=(ROLLBACK_DELTA_CONFIRM=YES)
  run_case green5-swap-container-mismatch-rejected \
    swap --container otherpg --db-live synthetic_live --db-shadow shadow_ok --db-ref refdb --manifest "$FIX/manifest-full.tsv"
  assert "green5/exit-nonzero" "9" "$(cap_exit green5-swap-container-mismatch-rejected)"
  assert_zero_rename green5-swap-container-mismatch-rejected
  assert_only_destructive green5-swap-container-mismatch-rejected ""

  # 绿6（负）：ref 与清单 ref_db 不符（验证对象≠待切换 ref）。
  CASE_ENV_A=(ROLLBACK_DELTA_CONFIRM=YES)
  run_case green6-swap-ref-mismatch-rejected \
    swap --container pgtest --db-live synthetic_live --db-shadow shadow_ok --db-ref otherref --manifest "$FIX/manifest-full.tsv"
  assert "green6/exit-nonzero" "9" "$(cap_exit green6-swap-ref-mismatch-rejected)"
  assert_zero_rename green6-swap-ref-mismatch-rejected
  assert_only_destructive green6-swap-ref-mismatch-rejected ""

  # 绿7（负）：既有停写/确认前提保持——全参但无 ROLLBACK_DELTA_CONFIRM=YES → exit 9。
  run_case green7-swap-no-confirm-rejected \
    swap --container pgtest --db-live synthetic_live --db-shadow shadow_ok --db-ref refdb --manifest "$FIX/manifest-full.tsv"
  assert "green7/exit-nonzero" "9" "$(cap_exit green7-swap-no-confirm-rejected)"
  assert_zero_rename green7-swap-no-confirm-rejected
  assert_only_destructive green7-swap-no-confirm-rejected ""
  assert_match "green7/stderr-mentions-confirm" "ROLLBACK_DELTA_CONFIRM" "$CAP_ROOT/captures/green7-swap-no-confirm-rejected/stderr"

  # 绿8（负）：影子校验失败（摘要不符）→ 内联 verify 在改名前拒绝：
  # exit 8＋仅清理对应影子库＋零 RENAME。
  CASE_ENV_A=(ROLLBACK_DELTA_CONFIRM=YES STUB_EXISTING_DBS="synthetic_live shadow_ok" STUB_SHADOW_DIGEST_ALT=1)
  run_case green8-swap-verify-failure-blocks-rename \
    swap --container pgtest --db-live synthetic_live --db-shadow shadow_ok --db-ref refdb --manifest "$FIX/manifest-full.tsv"
  assert "green8/exit-nonzero" "8" "$(cap_exit green8-swap-verify-failure-blocks-rename)"
  assert_zero_rename green8-swap-verify-failure-blocks-rename
  assert_only_destructive green8-swap-verify-failure-blocks-rename "shadow_ok"
  assert_match "green8/stderr-mentions-digest" "摘要不符" "$CAP_ROOT/captures/green8-swap-verify-failure-blocks-rename/stderr"

  # 绿9（正）：verify 全过 → 原事务切换；验证调用先于改名；RENAME 恰两条且序正确。
  CASE_ENV_A=(ROLLBACK_DELTA_CONFIRM=YES STUB_EXISTING_DBS="synthetic_live shadow_ok")
  run_case green9-swap-ok-transaction-after-verify \
    swap --container pgtest --db-live synthetic_live --db-shadow shadow_ok --db-ref refdb --manifest "$FIX/manifest-full.tsv"
  assert "green9/exit" "0" "$(cap_exit green9-swap-ok-transaction-after-verify)"
  assert_rename_pair green9-swap-ok-transaction-after-verify synthetic_live synthetic_live_pre_rollback_keep shadow_ok
  assert_verify_precedes_rename green9-swap-ok-transaction-after-verify
  assert_match "green9/stdout-verify-ok" "verify: OK" "$CAP_ROOT/captures/green9-swap-ok-transaction-after-verify/stdout"

  # 绿10（对照）：前置环境失败（容器不可达）仍走 require_env exit 3、零破坏——
  # 与验证拒绝可区分（如实记录：环境失败≠验证拒绝）。
  CASE_ENV_A=(ROLLBACK_DELTA_CONFIRM=YES STUB_FAIL_ENV=1)
  run_case green10-swap-env-unreachable-still-precondition \
    swap --container pgtest --db-live synthetic_live --db-shadow shadow_ok --db-ref refdb --manifest "$FIX/manifest-full.tsv"
  assert "green10/exit" "3" "$(cap_exit green10-swap-env-unreachable-still-precondition)"
  assert_zero_rename green10-swap-env-unreachable-still-precondition
  assert_only_destructive green10-swap-env-unreachable-still-precondition ""

  # 绿11（对照）：verify 子命令语义不变——全过路径 exit 0、17 表 digest=match。
  run_case green11-verify-cmd-unchanged-pass \
    verify --container pgtest --db-live synthetic_live --db-shadow shadow_ok --db-ref refdb --manifest "$FIX/manifest-full.tsv"
  assert "green11/exit" "0" "$(cap_exit green11-verify-cmd-unchanged-pass)"
  # 口径＝X07 断言 G 同款：白名单 17 表各一条 "table=<T> digest=match"
  # （资金零补造行 "provider_finance_event digest=match" 另计，不含 table= 前缀）。
  assert "green11/whitelist-digest-match-count" "17" "$(grep -c 'table=[a-z_]* digest=match' "$CAP_ROOT/captures/green11-verify-cmd-unchanged-pass/stdout")"
  assert "green11/finance-digest-match-count" "1" "$(grep -c 'provider_finance_event digest=match' "$CAP_ROOT/captures/green11-verify-cmd-unchanged-pass/stdout")"
  assert_match "green11/stdout-verify-ok" "verify: OK" "$CAP_ROOT/captures/green11-verify-cmd-unchanged-pass/stdout"

  # 绿12（对照）：verify 子命令语义不变——摘要失配仍 exit 8＋删影子（重构未放宽）。
  CASE_ENV_A=(STUB_SHADOW_DIGEST_ALT=1)
  run_case green12-verify-cmd-unchanged-fail \
    verify --container pgtest --db-live synthetic_live --db-shadow shadow_ok --db-ref refdb --manifest "$FIX/manifest-full.tsv"
  assert "green12/exit" "8" "$(cap_exit green12-verify-cmd-unchanged-fail)"
  assert_only_destructive green12-verify-cmd-unchanged-fail "shadow_ok"
  assert_zero_rename green12-verify-cmd-unchanged-fail
  ;;

regression)
  # CQ-01 桩绿证 20 用例逐字复刻（../red-evidence/run-probes.sh green 模式），
  # 唯一适配＝ok-swap-distinct 补新必需参数 --db-ref/--manifest（清单夹具
  # manifest-live-other.tsv 的 live_db=other_live 与该用例一致）。
  # 断言：正路径 5 用例行为不变；负路径 15 用例仍全数 exit≠0 且零破坏/零 RENAME。
  echo "==== CQ-01 regression（被测：$(basename "$SCRIPT_UNDER_TEST")）====" >> "$LOG"

  CASE_ENV_A=(ROLLBACK_DELTA_CONFIRM=YES)
  run_case ok-restore-distinct \
    restore --container pgtest --db-live other_live --db-shadow shadow_ok --dump-file "$FIX/dump.bin"
  assert "ok-restore/exit" "0" "$(cap_exit ok-restore-distinct)"
  run_case ok-replay-distinct \
    replay --container pgtest --db-live other_live --db-shadow shadow_ok --manifest "$FIX/manifest-live-other.tsv" --delta-dir "$FIX/delta-out"
  assert "ok-replay/exit" "0" "$(cap_exit ok-replay-distinct)"
  run_case ok-retire-distinct \
    retire-threshold --container pgtest --db-live other_live --db-shadow shadow_ok --log "$FIX/retire.log"
  assert "ok-retire/exit" "0" "$(cap_exit ok-retire-distinct)"
  run_case ok-verify-distinct \
    verify --container pgtest --db-live other_live --db-shadow shadow_ok --db-ref refdb --manifest "$FIX/manifest-live-other.tsv"
  assert "ok-verify/exit" "0" "$(cap_exit ok-verify-distinct)"
  assert "ok-verify/whitelist-digest-match-count" "17" "$(grep -c 'table=[a-z_]* digest=match' "$CAP_ROOT/captures/ok-verify-distinct/stdout")"
  assert "ok-verify/finance-digest-match-count" "1" "$(grep -c 'provider_finance_event digest=match' "$CAP_ROOT/captures/ok-verify-distinct/stdout")"
  CASE_ENV_A=(ROLLBACK_DELTA_CONFIRM=YES "STUB_EXISTING_DBS=other_live shadow_ok")
  run_case ok-swap-distinct \
    swap --container pgtest --db-live other_live --db-shadow shadow_ok --db-ref refdb --manifest "$FIX/manifest-live-other.tsv"
  assert "ok-swap/exit" "0" "$(cap_exit ok-swap-distinct)"
  assert_rename_pair ok-swap-distinct other_live other_live_pre_rollback_keep shadow_ok

  CASE_ENV_A=(ROLLBACK_DELTA_CONFIRM=YES)
  run_case neg-restore-omit-live-shadow-is-live \
    restore --container pgtest --db-shadow synthetic_live --dump-file "$FIX/dump.bin"
  assert "neg-restore-omit-live/exit-nonzero" "2" "$(cap_exit neg-restore-omit-live-shadow-is-live)"
  CASE_ENV_A=(ROLLBACK_DELTA_CONFIRM=YES)
  run_case neg-restore-live-eq-shadow \
    restore --container pgtest --db-live synthetic_live --db-shadow synthetic_live --dump-file "$FIX/dump.bin"
  assert "neg-restore-live-eq-shadow/exit-nonzero" "3" "$(cap_exit neg-restore-live-eq-shadow)"
  CASE_ENV_A=(ROLLBACK_DELTA_CONFIRM=YES)
  run_case neg-restore-empty-live \
    restore --container pgtest --db-live "" --db-shadow shadow_ok --dump-file "$FIX/dump.bin"
  assert "neg-restore-empty-live/exit-nonzero" "2" "$(cap_exit neg-restore-empty-live)"
  run_case neg-replay-omit-live-shadow-is-live \
    replay --container pgtest --db-shadow synthetic_live --manifest "$FIX/manifest-live-other.tsv" --delta-dir "$FIX/delta-out"
  assert "neg-replay-omit-live/exit-nonzero" "2" "$(cap_exit neg-replay-omit-live-shadow-is-live)"
  run_case neg-replay-live-eq-shadow \
    replay --container pgtest --db-live synthetic_live --db-shadow synthetic_live --manifest "$FIX/manifest-live-other.tsv" --delta-dir "$FIX/delta-out"
  assert "neg-replay-live-eq-shadow/exit-nonzero" "3" "$(cap_exit neg-replay-live-eq-shadow)"
  run_case neg-replay-empty-live \
    replay --container pgtest --db-live "" --db-shadow shadow_ok --manifest "$FIX/manifest-live-other.tsv" --delta-dir "$FIX/delta-out"
  assert "neg-replay-empty-live/exit-nonzero" "2" "$(cap_exit neg-replay-empty-live)"
  # T4/B6：清单缺 manifest_done 完成标记 → exit 6、不发回放 SQL、live 零操作。
  grep -v '^manifest_done' "$FIX/manifest-live-other.tsv" > "$FIX/manifest-no-done.tsv"
  run_case neg-no-done-manifest \
    replay --container pgtest --db-live other_live --db-shadow shadow_ok --manifest "$FIX/manifest-no-done.tsv" --delta-dir "$FIX/delta-out"
  assert "neg-no-done/exit-nonzero" "6" "$(cap_exit neg-no-done-manifest)"
  assert_zero_rename neg-no-done-manifest
  run_case neg-retire-omit-live-shadow-is-live \
    retire-threshold --container pgtest --db-shadow synthetic_live --log "$FIX/retire.log"
  assert "neg-retire-omit-live/exit-nonzero" "2" "$(cap_exit neg-retire-omit-live-shadow-is-live)"
  run_case neg-retire-live-eq-shadow \
    retire-threshold --container pgtest --db-live synthetic_live --db-shadow synthetic_live --log "$FIX/retire.log"
  assert "neg-retire-live-eq-shadow/exit-nonzero" "3" "$(cap_exit neg-retire-live-eq-shadow)"
  run_case neg-verify-live-eq-shadow \
    verify --container pgtest --db-live synthetic_live --db-shadow synthetic_live --db-ref refdb --manifest "$FIX/manifest-live-other.tsv"
  assert "neg-verify-live-eq-shadow/exit-nonzero" "3" "$(cap_exit neg-verify-live-eq-shadow)"
  run_case neg-verify-shadow-eq-ref \
    verify --container pgtest --db-live other_live --db-shadow refdb --db-ref refdb --manifest "$FIX/manifest-live-other.tsv"
  assert "neg-verify-shadow-eq-ref/exit-nonzero" "3" "$(cap_exit neg-verify-shadow-eq-ref)"
  run_case neg-verify-omit-live \
    verify --container pgtest --db-shadow shadow_ok --db-ref refdb --manifest "$FIX/manifest-live-other.tsv"
  assert "neg-verify-omit-live/exit-nonzero" "2" "$(cap_exit neg-verify-omit-live)"
  run_case neg-verify-live-eq-ref \
    verify --container pgtest --db-live other_live --db-shadow shadow_ok --db-ref other_live --manifest "$FIX/manifest-live-other.tsv"
  assert "neg-verify-live-eq-ref/exit-nonzero" "3" "$(cap_exit neg-verify-live-eq-ref)"
  CASE_ENV_A=(ROLLBACK_DELTA_CONFIRM=YES STUB_EXISTING_DBS=synthetic_live)
  run_case neg-swap-live-eq-shadow \
    swap --container pgtest --db-live synthetic_live --db-shadow synthetic_live
  assert "neg-swap-live-eq-shadow/exit-nonzero" "3" "$(cap_exit neg-swap-live-eq-shadow)"
  assert_zero_rename neg-swap-live-eq-shadow
  CASE_ENV_A=(ROLLBACK_DELTA_CONFIRM=YES "STUB_EXISTING_DBS=synthetic_live shadow_ok")
  run_case neg-swap-keep-eq-live \
    swap --container pgtest --db-live synthetic_live --db-shadow shadow_ok --keep-name synthetic_live
  assert "neg-swap-keep-eq-live/exit-nonzero" "3" "$(cap_exit neg-swap-keep-eq-live)"
  assert_zero_rename neg-swap-keep-eq-live
  CASE_ENV_A=(ROLLBACK_DELTA_CONFIRM=YES "STUB_EXISTING_DBS=synthetic_live keepname")
  run_case neg-swap-shadow-eq-keep \
    swap --container pgtest --db-live synthetic_live --db-shadow keepname --keep-name keepname
  assert "neg-swap-shadow-eq-keep/exit-nonzero" "3" "$(cap_exit neg-swap-shadow-eq-keep)"
  assert_zero_rename neg-swap-shadow-eq-keep
  ;;
closeout)
  # 验收人收口三例（CQ-R1-01 第二批：verify/swap 读清单前过 manifest_done＋正文
  # sha256 完整性门——replay 既有校验的共用提取）。桩环境，pipefail 记录退出码。
  echo "==== CQ-R1-01 CLOSEOUT（被测：$(basename "$SCRIPT_UNDER_TEST")）====" >> "$LOG"
  grep -v '^manifest_done' "$FIX/manifest-full.tsv" > "$FIX/manifest-no-done.tsv"
  # 篡改清单正文（live_migration_head 改写）但保留旧 manifest_done 摘要行 → 正文摘要不符
  sed 's/^live_migration_head\t0096_official_balance_refresh_request$/live_migration_head\t0096_TAMPERED_HEAD/' \
    "$FIX/manifest-full.tsv" > "$FIX/manifest-tampered.tsv"
  grep -q "0096_TAMPERED_HEAD" "$FIX/manifest-tampered.tsv"
  echo "fixture-tampered: $(grep -c 'manifest_done' "$FIX/manifest-tampered.tsv") done-line kept" >> "$LOG"

  # 例1：清单缺 manifest_done 行 → 非零退出＋零改名 SQL（仅清理对应影子库）。
  CASE_ENV_A=(ROLLBACK_DELTA_CONFIRM=YES STUB_EXISTING_DBS="synthetic_live shadow_ok")
  run_case co1-swap-manifest-no-done-rejected \
    swap --container pgtest --db-live synthetic_live --db-shadow shadow_ok --db-ref refdb --manifest "$FIX/manifest-no-done.tsv"
  assert "co1/exit-nonzero" "8" "$(cap_exit co1-swap-manifest-no-done-rejected)"
  assert_zero_rename co1-swap-manifest-no-done-rejected
  assert_only_destructive co1-swap-manifest-no-done-rejected "shadow_ok"
  assert_match "co1/stderr-mentions-done-marker" "完成标记" "$CAP_ROOT/captures/co1-swap-manifest-no-done-rejected/stderr"

  # 例2：正文被改（保留旧 manifest_done 摘要行）→ 摘要不符、非零退出＋零改名 SQL。
  CASE_ENV_A=(ROLLBACK_DELTA_CONFIRM=YES STUB_EXISTING_DBS="synthetic_live shadow_ok")
  run_case co2-swap-manifest-tampered-rejected \
    swap --container pgtest --db-live synthetic_live --db-shadow shadow_ok --db-ref refdb --manifest "$FIX/manifest-tampered.tsv"
  assert "co2/exit-nonzero" "8" "$(cap_exit co2-swap-manifest-tampered-rejected)"
  assert_zero_rename co2-swap-manifest-tampered-rejected
  assert_only_destructive co2-swap-manifest-tampered-rejected "shadow_ok"
  assert_match "co2/stderr-mentions-sha" "sha256 不符" "$CAP_ROOT/captures/co2-swap-manifest-tampered-rejected/stderr"

  # 例3：有效清单 → 完整性过 → 内联 verify 全过 → 正常切换（verify 先于两条 RENAME、exit 0）。
  CASE_ENV_A=(ROLLBACK_DELTA_CONFIRM=YES STUB_EXISTING_DBS="synthetic_live shadow_ok")
  run_case co3-swap-valid-manifest-full-path \
    swap --container pgtest --db-live synthetic_live --db-shadow shadow_ok --db-ref refdb --manifest "$FIX/manifest-full.tsv"
  assert "co3/exit" "0" "$(cap_exit co3-swap-valid-manifest-full-path)"
  assert_rename_pair co3-swap-valid-manifest-full-path synthetic_live synthetic_live_pre_rollback_keep shadow_ok
  assert_verify_precedes_rename co3-swap-valid-manifest-full-path
  assert_match "co3/stdout-verify-ok" "verify: OK" "$CAP_ROOT/captures/co3-swap-valid-manifest-full-path/stdout"
  ;;

*) echo "mode must be red|green|regression|closeout" >&2; exit 64;;
esac

summary
