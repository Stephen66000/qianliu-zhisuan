#!/usr/bin/env bash
# CQ-01 探针执行器——用 docker 命令桩逐入口跑红/绿矩阵。
# 用法: run-probes.sh red|green <被测脚本绝对路径> <输出log绝对路径> <捕获根目录>
# 不连真实 Docker：PATH 前置桩目录，DOCKER_HOST 指向不存在的 sock。
# 兼容 bash 3.2。
set -u
MODE="${1:?red|green}"
SCRIPT_UNDER_TEST="${2:?script path}"
LOG="${3:?log path}"
CAP_ROOT="${4:?capture root}"

STUB_SRC="$(cd "$(dirname "$0")" && pwd)"
REPLAY_ORDER="enterprise provider unified_model principal principal_key provider_resource billing_rule model_route ai_request upstream_attempt usage_event ledger_line ledger_transaction principal_grant quota_counter principal_quota_period principal_quota_usage"
EMPTY_SHA="e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
FIX="$CAP_ROOT/fixtures"
mkdir -p "$FIX/delta-out" "$FIX/captures"

# 桩 bin：PATH 前置目录内必须存在名为 docker 的可执行（bash 3.2 无 ln -s 兼容问题，用复制）
STUB_BIN="$CAP_ROOT/.stub-bin"
rm -rf "$STUB_BIN"; mkdir -p "$STUB_BIN"
cp "$STUB_SRC/stub-docker.sh" "$STUB_BIN/docker"
chmod +x "$STUB_BIN/docker"
STUB_DIR="$STUB_BIN"

# ── 夹具 ────────────────────────────────────────────────────────────────
: > "$FIX/dump.bin"
i=0
while [ "$i" -lt 20 ]; do printf 'WP6-R4-CQ01-FAKE-DUMP-FOR-STUBXXXXXXXXXX' >> "$FIX/dump.bin"; i=$((i+1)); done
for T in $REPLAY_ORDER; do : > "$FIX/delta-out/$T.copy"; done

build_manifest() { # $1=out $2=mode(full|missing-first)
  M="$1"
  {
    printf 'manifest_version\twp6-r4-1\n'
    printf 'generated_at\t2026-11-07T00:00:00Z\n'
    printf 'container\tpgtest\n'
    printf 'live_db\tsynthetic_live\n'
    printf 'live_migration_head\t0096_official_balance_refresh_request\n'
    printf 'ref_db\trefdb\n'
    printf 'ref_migration_head\t0091_recorded_cost_accounting_policy\n'
    printf 'dump_sha256\t%s\n' "$(shasum -a 256 "$FIX/dump.bin" | awk '{print $1}')"
    printf 'replay_order\t%s\n' "$(printf '%s' "$REPLAY_ORDER" | tr ' ' ',')"
    printf 'external_parents\tperson,admin_user,historical_import_run,employee_model_rule_version,provider_finance_legacy_cost_resolution,provider_subscription_period\n'
    printf 'begin_tables\n'
    for T in $REPLAY_ORDER; do
      [ "$2" = "missing-first" ] && [ "$T" = "enterprise" ] && continue
      printf 'table\t%s\trows=0\tinserted=0\tupdated=0\tsha256=%s\tref_present=yes\tcolumns=id\ttypes=id:integer\n' "$T" "$EMPTY_SHA"
    done
    printf 'end_tables\n'
  } > "$M"
  printf 'manifest_done\t%s\n' "$(shasum -a 256 "$M" | awk '{print $1}')" >> "$M"
}
build_manifest "$FIX/manifest-full.tsv" full
build_manifest "$FIX/manifest-missing-enterprise.tsv" missing-first
# T4/B6 桩用例夹具：有效水位清单去掉末行 manifest_done 完成标记
# （＝export 未完成时落盘的制品形态；其余字段与 manifest-full 逐字一致）。
grep -v '^manifest_done' "$FIX/manifest-full.tsv" > "$FIX/manifest-no-done.tsv"

# ── 执行器 ──────────────────────────────────────────────────────────────
CASE_NO=0
CASE_ENV_A=()
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
  {
    echo "exit=$CODE"
    echo "stderr: $(head -3 "$CAP/stderr")"
    echo "stdout-head: $(head -c 200 "$CAP/stdout" | tr '\n' ' ')"
    bash "$STUB_SRC/audit-capture.sh" "$CAP"
  } >> "$LOG" 2>&1
  CASE_ENV_A=()
}

# ── 场景矩阵（与合同红证 a/b/c 对应）────────────────────────────────────
case "$MODE" in
red)
  # a) 按旧帮助省略 --db-live 的 restore，shadow=真实 live 名 → 预期复现桩证（dropdb live 名）
  CASE_ENV_A=(ROLLBACK_DELTA_CONFIRM=YES)
  run_case restore-omit-live-shadow-is-live \
    restore --container pgtest --db-shadow synthetic_live --dump-file "$FIX/dump.bin"
  # c) 明确指定 --db-live 且 shadow==live：restore 当前行为（如实记录）
  CASE_ENV_A=(ROLLBACK_DELTA_CONFIRM=YES)
  run_case restore-live-eq-shadow \
    restore --container pgtest --db-live synthetic_live --db-shadow synthetic_live --dump-file "$FIX/dump.bin"
  # b) replay：缺 live 标识（shadow=真实 live 名）
  run_case replay-omit-live-shadow-is-live \
    replay --container pgtest --db-shadow synthetic_live --manifest "$FIX/manifest-full.tsv" --delta-dir "$FIX/delta-out"
  # b) replay：显式 --db-live 且 shadow==live
  run_case replay-live-eq-shadow \
    replay --container pgtest --db-live synthetic_live --db-shadow synthetic_live --manifest "$FIX/manifest-full.tsv" --delta-dir "$FIX/delta-out"
  # b) retire-threshold：缺 live 标识（shadow=真实 live 名）
  run_case retire-omit-live-shadow-is-live \
    retire-threshold --container pgtest --db-shadow synthetic_live --log "$FIX/retire.log"
  # b) verify：shadow==live（清单缺表触发失败清理路径→drop 影子＝drop live 名）
  run_case verify-live-eq-shadow-fail-cleanup \
    verify --container pgtest --db-live synthetic_live --db-shadow synthetic_live --db-ref refdb --manifest "$FIX/manifest-missing-enterprise.tsv"
  # b) verify：shadow==ref（零补造比对自证空洞——如实记录其输出）
  run_case verify-shadow-eq-ref-vacuous-pass \
    verify --container pgtest --db-live other_live --db-shadow refdb --db-ref refdb --manifest "$FIX/manifest-full.tsv"
  # b) swap：shadow==live → 直达改名 SQL（如实记录）
  CASE_ENV_A=(ROLLBACK_DELTA_CONFIRM=YES STUB_EXISTING_DBS=synthetic_live)
  run_case swap-live-eq-shadow \
    swap --container pgtest --db-live synthetic_live --db-shadow synthetic_live
  # b) swap：keep==live（现状被 keep 存在性检查拦截？如实记录）
  CASE_ENV_A=(ROLLBACK_DELTA_CONFIRM=YES "STUB_EXISTING_DBS=synthetic_live shadow_ok")
  run_case swap-keep-eq-live \
    swap --container pgtest --db-live synthetic_live --db-shadow shadow_ok --keep-name synthetic_live
  # b) swap：shadow==keep（现状如实记录）
  CASE_ENV_A=(ROLLBACK_DELTA_CONFIRM=YES "STUB_EXISTING_DBS=synthetic_live keepname")
  run_case swap-shadow-eq-keep \
    swap --container pgtest --db-live synthetic_live --db-shadow keepname --keep-name keepname
  # 对照：既有守卫基线（应拒绝——记录为「本已守卫」）
  run_case baseline-restore-omit-shadow \
    restore --container pgtest --dump-file "$FIX/dump.bin"
  run_case baseline-replay-omit-shadow \
    replay --container pgtest --manifest "$FIX/manifest-full.tsv" --delta-dir "$FIX/delta-out"
  run_case baseline-retire-omit-shadow \
    retire-threshold --container pgtest --log "$FIX/retire.log"
  run_case baseline-verify-omit-live \
    verify --container pgtest --db-shadow shadow_ok --db-ref refdb --manifest "$FIX/manifest-full.tsv"
  run_case baseline-swap-omit-live \
    swap --container pgtest --db-shadow shadow_ok
  ;;
green)
  # 桩正路径对照组：名称全异 → 行为保持（exit 0＋破坏只落 shadow/改名序正确）
  CASE_ENV_A=(ROLLBACK_DELTA_CONFIRM=YES)
  run_case ok-restore-distinct \
    restore --container pgtest --db-live other_live --db-shadow shadow_ok --dump-file "$FIX/dump.bin"
  run_case ok-replay-distinct \
    replay --container pgtest --db-live other_live --db-shadow shadow_ok --manifest "$FIX/manifest-full.tsv" --delta-dir "$FIX/delta-out"
  run_case ok-retire-distinct \
    retire-threshold --container pgtest --db-live other_live --db-shadow shadow_ok --log "$FIX/retire.log"
  run_case ok-verify-distinct \
    verify --container pgtest --db-live other_live --db-shadow shadow_ok --db-ref refdb --manifest "$FIX/manifest-full.tsv"
  CASE_ENV_A=(ROLLBACK_DELTA_CONFIRM=YES "STUB_EXISTING_DBS=other_live shadow_ok")
  run_case ok-swap-distinct \
    swap --container pgtest --db-live other_live --db-shadow shadow_ok
  # 桩负向组：缺 live／同名／空值／keep·ref 冲突 → 预期 exit≠0 且零破坏调用
  CASE_ENV_A=(ROLLBACK_DELTA_CONFIRM=YES)
  run_case neg-restore-omit-live-shadow-is-live \
    restore --container pgtest --db-shadow synthetic_live --dump-file "$FIX/dump.bin"
  CASE_ENV_A=(ROLLBACK_DELTA_CONFIRM=YES)
  run_case neg-restore-live-eq-shadow \
    restore --container pgtest --db-live synthetic_live --db-shadow synthetic_live --dump-file "$FIX/dump.bin"
  CASE_ENV_A=(ROLLBACK_DELTA_CONFIRM=YES)
  run_case neg-restore-empty-live \
    restore --container pgtest --db-live "" --db-shadow shadow_ok --dump-file "$FIX/dump.bin"
  run_case neg-replay-omit-live-shadow-is-live \
    replay --container pgtest --db-shadow synthetic_live --manifest "$FIX/manifest-full.tsv" --delta-dir "$FIX/delta-out"
  run_case neg-replay-live-eq-shadow \
    replay --container pgtest --db-live synthetic_live --db-shadow synthetic_live --manifest "$FIX/manifest-full.tsv" --delta-dir "$FIX/delta-out"
  run_case neg-replay-empty-live \
    replay --container pgtest --db-live "" --db-shadow shadow_ok --manifest "$FIX/manifest-full.tsv" --delta-dir "$FIX/delta-out"
  # T4/B6（EG-03 遗留缺口固化）：清单缺 manifest_done 完成标记（有效水位夹具去 done 行）
  # → 到达完成标记校验，exit 6、原因明确缺标记；不发回放 SQL、live 零操作；
  # 如有清理调用仅指向影子库（shadow_ok）。容器不可达等前置失败不计通过。
  run_case neg-no-done-manifest \
    replay --container pgtest --db-live other_live --db-shadow shadow_ok --manifest "$FIX/manifest-no-done.tsv" --delta-dir "$FIX/delta-out"
  run_case neg-retire-omit-live-shadow-is-live \
    retire-threshold --container pgtest --db-shadow synthetic_live --log "$FIX/retire.log"
  run_case neg-retire-live-eq-shadow \
    retire-threshold --container pgtest --db-live synthetic_live --db-shadow synthetic_live --log "$FIX/retire.log"
  run_case neg-verify-live-eq-shadow \
    verify --container pgtest --db-live synthetic_live --db-shadow synthetic_live --db-ref refdb --manifest "$FIX/manifest-full.tsv"
  run_case neg-verify-shadow-eq-ref \
    verify --container pgtest --db-live other_live --db-shadow refdb --db-ref refdb --manifest "$FIX/manifest-full.tsv"
  run_case neg-verify-omit-live \
    verify --container pgtest --db-shadow shadow_ok --db-ref refdb --manifest "$FIX/manifest-full.tsv"
  run_case neg-verify-live-eq-ref \
    verify --container pgtest --db-live other_live --db-shadow shadow_ok --db-ref other_live --manifest "$FIX/manifest-full.tsv"
  CASE_ENV_A=(ROLLBACK_DELTA_CONFIRM=YES STUB_EXISTING_DBS=synthetic_live)
  run_case neg-swap-live-eq-shadow \
    swap --container pgtest --db-live synthetic_live --db-shadow synthetic_live
  CASE_ENV_A=(ROLLBACK_DELTA_CONFIRM=YES "STUB_EXISTING_DBS=synthetic_live shadow_ok")
  run_case neg-swap-keep-eq-live \
    swap --container pgtest --db-live synthetic_live --db-shadow shadow_ok --keep-name synthetic_live
  CASE_ENV_A=(ROLLBACK_DELTA_CONFIRM=YES "STUB_EXISTING_DBS=synthetic_live keepname")
  run_case neg-swap-shadow-eq-keep \
    swap --container pgtest --db-live synthetic_live --db-shadow keepname --keep-name keepname
  ;;
red-supplement)
  # 返工补红：live==ref 在 d82559f 快照上的行为（资金摘要 live 自比空洞）
  run_case verify-live-eq-ref-vacuous-pass \
    verify --container pgtest --db-live other_live --db-shadow shadow_ok --db-ref other_live --manifest "$FIX/manifest-full.tsv"
  ;;
*) echo "mode must be red|green|red-supplement" >&2; exit 64;;
esac

echo "DONE mode=$MODE cases=$CASE_NO log=$LOG"
