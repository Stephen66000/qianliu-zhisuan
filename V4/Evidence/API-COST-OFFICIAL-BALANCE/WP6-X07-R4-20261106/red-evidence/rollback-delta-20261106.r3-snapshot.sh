#!/usr/bin/env bash
# X07 R3 主路线 v2（增量导出→恢复→重放 0092→增量回放）独立脚本。
#
# 与 rollback.sh 的编排（release-candidate.md §6.1 v2）：
#   1) 本脚本 export   ——破坏动作之前：对白名单表逐表导出「live 库有、备份点快照没有」
#      的行（主键反连接，不做时间戳切割），产出行数＋sha256 清单；导出或校验失败
#      ＝中止回退（exit 非 0），live 库全程零写入。
#   2) rollback.sh 既有段（dropdb/createdb＋灌全量快照）——本脚本 restore 子命令提供
#      等价 -Fc 流程（§4.2 复用注意 a/b：备份点水位与制品格式均按本脚本参数化），
#      两者二选一；本脚本不动 rollback.sh 既有段。
#   3) 重放 0092 up（幂等，§6.2 步骤 3 先例）——由旧栈 migrator 承担，非本脚本职责
#      （migrate 需要应用代码库；rollback.sh:113「禁止叠加 down」语义不受影响：
#      0092 是 up 重放不是 down）。
#   4) 本脚本 replay ——按 FK 依赖序把增量行导回恢复库，全部
#      INSERT ... ON CONFLICT (id) DO NOTHING；二次执行幂等；回放期间禁用 0081
#      种入触发器（恢复点 0091＋0092 重放下触发器在位，不禁用会给回放资源种入
#      PENDING、旧代码将拒绝服务——违反 AT-X07），事务内禁用、失败自动随事务回滚、
#      提交后校验触发器恢复 ENABLED。
#
# 红线（release-candidate.md §6.5，违反任何一条即操作无效）：
#   1) 不删除新用量——白名单只做导出回放，不做任何 DELETE/UPDATE；
#   2) 不补造资金——provider_finance_event 不在白名单（增量面恒为空集），
#      全程零期初/充值/更正类 finance 事件写入；
#   3) 不改 0092-0096 迁移文件——本脚本不触碰任何迁移文件；
#   4) 增量导出失败必须中止（R3 新增）——export 任一步非 0 即退出，无完整清单
#      （manifest_done）时 replay 拒绝执行。
#
# 依赖：宿主机 bash/docker；psql/pg_dump/pg_restore 全部容器内执行（不依赖宿主机
# postgres 客户端，release-wecom-report-delivery-20261019.sh:14 同款先例）。
# 兼容 bash 3.2（macOS 自带；不使用关联数组/进程替换）与 busybox ash（容器内
# sh -c 一律 POSIX 语义：不用 ${@:2}）。
#
# 白名单与 FK 闭包（终表；实测依据＝V4/Evidence/API-COST-OFFICIAL-BALANCE/
# WP6-X07-R3-20261106/logs/fk-closure-dump.log，0096 水位 343 条 FK 边全量 dump）：
#   维度（切换后可能新建）：provider provider_resource principal principal_key
#     unified_model model_route billing_rule（resource_pool 不是独立表——仅为
#     provider_resource.resource_pool_id varchar 列（0010:23），「如存在」分支落空）；
#   消费事实：ai_request upstream_attempt usage_event（FK 强制纳入：
#     ledger_line.usage_event_id NOT NULL→usage_event，0009:26；X07 受保护行集
#     原有成员）ledger_line ledger_transaction；
#   员工月度额度域（0092）：principal_grant（0092:6 加列＋principal_quota_usage
#     外键强制）principal_quota_period principal_quota_usage（0092:9,20）。
#   白名单外表（FK 父，不导出，先于备份点存在——0000-0091 已应用，切换窗口不新建）：
#     enterprise person admin_user historical_import_run（ai_request.import_run_id
#     置空即不用）employee_model_rule_version（grant.authorization_rule_version_id
#     可空）provider_finance_legacy_cost_resolution（ledger_line.legacy_cost_resolution_id
#     可空）provider_subscription_period（ledger_line.subscription_period_id 可空；
#     CODING_PLAN 窗口新周期为已知边界：若「备份后新建周期被窗口内消费引用」，
#     回放将 FK 失败＝fail-closed 中止，不产生半途状态）。
#   白名单反向引用表（restore 后随整库回退、不在回放面，属回退语义的可接受丢失，
#   均为派生/监测/瞬态）：provider_resource_operating_snapshot／_sync_attempt、
#   usage_bucket_aggregate、quota_counter、dispatch_decision、route_candidate、
#   concurrency_lease、request_attribution_snapshot 等——fk-closure-dump.log
#   reverse-only 清单全量可查。
set -euo pipefail

PROG="${0##*/}"
CONTAINER=""
DB_LIVE=""
DB_REF=""
DB_TARGET=""
DUMP_FILE=""
OUT_DIR=""
MANIFEST=""

# 白名单回放序（FK 依赖序：父先于子）。
REPLAY_ORDER="provider unified_model principal principal_key provider_resource billing_rule model_route ai_request upstream_attempt usage_event ledger_line ledger_transaction principal_grant principal_quota_period principal_quota_usage"
# 0092 专属表：0091 备份点快照无此二表（0092 未应用），反连接按「快照空集」全量导出。
ONLY_0092_TABLES="principal_quota_period principal_quota_usage"
# 白名单外表（FK 父，先于备份点存在；不导出）。
EXTERNAL_PARENTS="enterprise person admin_user historical_import_run employee_model_rule_version provider_finance_legacy_cost_resolution provider_subscription_period"
# 种入触发器（0081:202；0094 退役；恢复点 0091＋0092 重放后在位）。
SEED_TRIGGER="provider_resource_finance_state_seed_trigger"
SEED_TRIGGER_TABLE="provider_resource"
TAB=$'\t'
CONTAINER_DELTA_DIR="/tmp/wp6-r3-delta-in"
ROUTE_0091_HEAD="0091_recorded_cost_accounting_policy"
ROUTE_0092_HEAD="0092_employee_monthly_quota"

usage() {
  cat <<EOF
用法:
  $PROG export --container C --db-live DB --db-ref REFDB --dump-file DUMP --out-dir DIR
  $PROG restore --container C --db-target DB --dump-file DUMP   (须 ROLLBACK_DELTA_CONFIRM=YES)
  $PROG replay  --container C --db-target DB --manifest MANIFEST_TSV --delta-dir DIR
  $PROG check-contract [--container C --db-live DB]
子命令:
  export  破坏动作前执行。备份点快照载入 --db-ref（只写 ref 草稿库），逐白名单表
          主键反连接导出增量行（COPY text）＋行数＋sha256 清单；任何失败 exit 非 0，
          live 库零写入（红线 4）。
  restore dropdb --if-exists/--force ＋ createdb ＋ pg_restore（-Fc 全量快照到备份点）。
          危险动作：须 ROLLBACK_DELTA_CONFIRM=YES。
  replay  按 FK 依赖序回放增量行（staging temp 表＋ON CONFLICT (id) DO NOTHING，
          二次执行幂等）；校验清单 sha256 与制品一致，否则拒绝；事务内禁用种入
          触发器、提交后校验其恢复 ENABLED。
  check-contract 自检：静态契约回显；提供 --container/--db-live 时另做只读实测
          （白名单存在性、单列主键 id、FK 父闭包、回放序拓扑合法）。
环境: DOCKER_HOST 按需导出；PG 工具全部容器内执行（\$POSTGRES_USER 取自容器环境）。
EOF
}

die() { echo "FAIL-CLOSED[$1]: $2" >&2; exit "$1"; }

need_tools() {
  command -v docker >/dev/null 2>&1 || die 2 "宿主机缺少 docker"
  command -v awk >/dev/null 2>&1 || die 2 "宿主机缺少 awk"
  command -v comm >/dev/null 2>&1 || die 2 "宿主机缺少 comm"
  command -v paste >/dev/null 2>&1 || die 2 "宿主机缺少 paste"
}

sha256_file() {
  # macOS/Linux 双兼容。
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'
  else die 2 "宿主机缺少 sha256sum/shasum"; fi
}

# 容器内 psql（先例 release-wecom-report-delivery-20261019.sh:14；POSIX sh 取参）。
# 用法: psql_in DB [psql 参数...]
psql_in() {
  docker exec "$CONTAINER" sh -c 'db="$1"; shift; exec psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$db" "$@"' \
    sh "$@"
}

require_env() {
  [ -n "$CONTAINER" ] || die 2 "缺少 --container"
  docker exec "$CONTAINER" sh -c 'true' 2>/dev/null || die 3 "容器不可达: $CONTAINER"
}

dump_integrity_gate() {
  # 备份制品非空＋可被 pg_restore 解析（§4.1:46 非空校验同款升级为格式校验）。
  [ -n "$DUMP_FILE" ] || die 3 "缺少 --dump-file"
  [ -s "$DUMP_FILE" ] || die 3 "备份制品不存在或为零字节（Verified backup required）: $DUMP_FILE"
  docker exec -i "$CONTAINER" sh -c 'pg_restore --list >/dev/null' \
    < "$DUMP_FILE" || die 3 "备份制品无法被 pg_restore 解析（格式损坏）: $DUMP_FILE"
}

migration_head() { # $1=db → 输出水位名
  psql_in "$1" -Atq -c "SET timezone TO 'UTC'" \
    -c "SELECT name FROM kysely_migration ORDER BY timestamp DESC, name DESC LIMIT 1"
}

manifest_field() { # $1=行首标记 → 输出该行第二个字段
  sed -n "s/^$1	//p" "$MANIFEST" | head -1
}

# ── export ──────────────────────────────────────────────────────────────
cmd_export() {
  need_tools
  [ -n "$DB_LIVE" ] || die 2 "export 缺少 --db-live"
  [ -n "$DB_REF" ] || die 2 "export 缺少 --db-ref"
  [ -n "$OUT_DIR" ] || die 2 "export 缺少 --out-dir"
  require_env
  dump_integrity_gate
  [ "$DB_LIVE" != "$DB_REF" ] || die 3 "ref 草稿库不得与 live 同名"
  case "$DB_LIVE" in postgres|template0|template1) die 3 "拒绝系统库 $DB_LIVE";; esac
  mkdir -p "$OUT_DIR"
  WORK="$(mktemp -d "${TMPDIR:-/tmp}/wp6-r3-export.XXXXXX")"

  LIVE_HEAD="$(migration_head "$DB_LIVE")" || die 4 "live 水位读取失败（库不可达？）"

  # 1) 备份点快照 → ref 草稿库（只写 ref，不触 live）。
  docker exec "$CONTAINER" sh -c 'dropdb --if-exists --force -U "$POSTGRES_USER" "$1"' sh "$DB_REF" \
    || die 4 "ref 草稿库清理失败"
  docker exec "$CONTAINER" sh -c 'createdb -U "$POSTGRES_USER" "$1"' sh "$DB_REF" \
    || die 4 "ref 草稿库创建失败"
  docker exec -i "$CONTAINER" sh -c 'db="$1"; shift; exec pg_restore --no-owner --no-privileges -U "$POSTGRES_USER" -d "$db"' \
    sh "$DB_REF" < "$DUMP_FILE" || die 4 "备份点快照载入 ref 失败（pg_restore 非 0）"
  REF_HEAD="$(migration_head "$DB_REF")" || die 4 "ref 水位读取失败"
  DUMP_SHA="$(sha256_file "$DUMP_FILE")"

  MANIFEST="$OUT_DIR/manifest.tsv"
  : > "$MANIFEST"
  printf 'manifest_version\twp6-r3-1\n' >> "$MANIFEST"
  printf 'generated_at\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$MANIFEST"
  printf 'container\t%s\n' "$CONTAINER" >> "$MANIFEST"
  printf 'live_db\t%s\n' "$DB_LIVE" >> "$MANIFEST"
  printf 'live_migration_head\t%s\n' "$LIVE_HEAD" >> "$MANIFEST"
  printf 'ref_db\t%s\n' "$DB_REF" >> "$MANIFEST"
  printf 'ref_migration_head\t%s\n' "$REF_HEAD" >> "$MANIFEST"
  printf 'dump_sha256\t%s\n' "$DUMP_SHA" >> "$MANIFEST"
  printf 'replay_order\t%s\n' "$(printf '%s' "$REPLAY_ORDER" | tr ' ' ',')" >> "$MANIFEST"
  printf 'external_parents\t%s\n' "$(printf '%s' "$EXTERNAL_PARENTS" | tr ' ' ',')" >> "$MANIFEST"
  printf 'begin_tables\n' >> "$MANIFEST"

  # 2) 逐白名单表：主键反连接导出（不做时间戳切割）。
  for T in $REPLAY_ORDER; do
    LIVE_COLS="$(psql_in "$DB_LIVE" -Atq -c \
      "SELECT string_agg(column_name, ',' ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema='public' AND table_name='$T'")" \
      || die 4 "白名单表 $T 列读取失败（fail-closed）"
    [ -n "$LIVE_COLS" ] || die 4 "白名单表 $T 在 live 库不存在（fail-closed）"
    LIVE_TYPES="$(psql_in "$DB_LIVE" -Atq -c \
      "SELECT string_agg(data_type, ',' ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema='public' AND table_name='$T'")" \
      || die 4 "白名单表 $T 类型读取失败（fail-closed）"

    if psql_in "$DB_REF" -Atq -c "SELECT 1 FROM $T LIMIT 1" >/dev/null 2>&1; then
      REF_PRESENT="yes"
      psql_in "$DB_REF" -Atq -c "SELECT id::text FROM $T ORDER BY id" > "$WORK/ref.$T.pk" \
        || die 4 "ref 主键集读取失败: $T"
    else
      REF_PRESENT="no"
      : > "$WORK/ref.$T.pk"
    fi
    case " $ONLY_0092_TABLES " in
      *" $T "*)
        [ "$REF_PRESENT" = "no" ] || die 4 "$T 应为 0092 专属表但 ref 快照已存在，契约不符";;
    esac
    psql_in "$DB_LIVE" -Atq -c "SELECT id::text FROM $T ORDER BY id" > "$WORK/live.$T.pk" \
      || die 4 "live 主键集读取失败: $T"
    LC_ALL=C sort "$WORK/live.$T.pk" > "$WORK/live.$T.pk.s"
    LC_ALL=C sort "$WORK/ref.$T.pk" > "$WORK/ref.$T.pk.s"
    comm -23 "$WORK/live.$T.pk.s" "$WORK/ref.$T.pk.s" > "$WORK/delta.$T.pk" \
      || die 4 "反连接失败: $T"
    ROWS="$(wc -l < "$WORK/delta.$T.pk" | tr -d ' ')"

    if [ "$ROWS" -gt 0 ]; then
      # 全表 COPY text（列序＝live ordinal 序）→ 主键过滤为增量行。
      docker exec "$CONTAINER" sh -c 'db="$1"; t="$2"; exec psql -X -Atq -v tz=UTC -U "$POSTGRES_USER" -d "$db" -c "SET timezone TO :'"'"'tz'"'"'" -c "\copy (SELECT * FROM $t ORDER BY id) TO STDOUT WITH (FORMAT text)"' \
        sh "$DB_LIVE" "$T" > "$WORK/full.$T.copy" || die 4 "live 全表导出失败: $T"
      awk 'NR==FNR { want[$0]=1; next } { head=$0; sub(/\t.*/, "", head); if (head in want) print }' \
        "$WORK/delta.$T.pk" "$WORK/full.$T.copy" > "$OUT_DIR/$T.copy" || die 4 "增量过滤失败: $T"
      GOT="$(wc -l < "$OUT_DIR/$T.copy" | tr -d ' ')"
      [ "$GOT" -eq "$ROWS" ] || die 4 "行数校验失败: $T 期望 $ROWS 实得 $GOT"
    else
      : > "$OUT_DIR/$T.copy"
    fi
    SHA="$(sha256_file "$OUT_DIR/$T.copy")"
    printf 'table\t%s\trows=%s\tsha256=%s\tref_present=%s\tcolumns=%s\ttypes=%s\n' \
      "$T" "$ROWS" "$SHA" "$REF_PRESENT" "$LIVE_COLS" "$LIVE_TYPES" >> "$MANIFEST"
    echo "export: table=$T rows=$ROWS sha256=$SHA ref_present=$REF_PRESENT"
  done

  # 3) 完整性闭环：清单自校验（逐行重算 sha256 与行数）＋完成标记（replay 的门）。
  while IFS= read -r line; do
    case "$line" in
      table*)
        T="$(printf '%s' "$line" | cut -f2)"
        S="$(printf '%s\n' "$line" | awk -F'\t' '$4 ~ /^sha256=/ { sub(/^sha256=/, "", $4); print $4 }')"
        R="$(printf '%s\n' "$line" | awk -F'\t' '$3 ~ /^rows=/ { sub(/^rows=/, "", $3); print $3 }')"
        [ "$(sha256_file "$OUT_DIR/$T.copy")" = "$S" ] || die 4 "清单自校验失败: $T"
        [ "$(wc -l < "$OUT_DIR/$T.copy" | tr -d ' ')" = "$R" ] || die 4 "清单行数自校验失败: $T"
        ;;
    esac
  done < "$MANIFEST"
  printf 'end_tables\n' >> "$MANIFEST"
  printf 'manifest_done\t%s\n' "$(sha256_file "$MANIFEST")" >> "$MANIFEST"
  echo "export: OK manifest=$MANIFEST live_head=$LIVE_HEAD ref_head=${REF_HEAD}（live 库零写入）"
}

# ── restore ─────────────────────────────────────────────────────────────
cmd_restore() {
  need_tools
  [ -n "$DB_TARGET" ] || die 2 "restore 缺少 --db-target"
  require_env
  dump_integrity_gate
  case "$DB_TARGET" in postgres|template0|template1) die 5 "拒绝系统库 $DB_TARGET";; esac
  [ "${ROLLBACK_DELTA_CONFIRM:-}" = "YES" ] \
    || die 5 "危险动作：须环境 ROLLBACK_DELTA_CONFIRM=YES（dropdb --force＋createdb，安全等级同 rollback.sh:5 DESTRUCTIVE）"
  docker exec "$CONTAINER" sh -c 'dropdb --if-exists --force -U "$POSTGRES_USER" "$1"' sh "$DB_TARGET" \
    || die 5 "dropdb 失败: $DB_TARGET"
  docker exec "$CONTAINER" sh -c 'createdb -U "$POSTGRES_USER" "$1"' sh "$DB_TARGET" \
    || die 5 "createdb 失败: $DB_TARGET"
  docker exec -i "$CONTAINER" sh -c 'db="$1"; shift; exec pg_restore --no-owner --no-privileges -U "$POSTGRES_USER" -d "$db"' \
    sh "$DB_TARGET" < "$DUMP_FILE" || die 5 "pg_restore 失败: $DB_TARGET"
  echo "restore: OK target=$DB_TARGET head=$(migration_head "$DB_TARGET")（备份点水位，禁止叠加 down——rollback.sh:113 同规）"
}

# ── replay ──────────────────────────────────────────────────────────────
cmd_replay() {
  need_tools
  [ -n "$DB_TARGET" ] || die 2 "replay 缺少 --db-target"
  [ -n "$MANIFEST" ] || die 2 "replay 缺少 --manifest"
  [ -n "$OUT_DIR" ] || die 2 "replay 缺少 --delta-dir"
  require_env
  WORK="$(mktemp -d "${TMPDIR:-/tmp}/wp6-r3-replay.XXXXXX")"
  # 门 0：水位路由（恢复点＝ref 水位，或已按操作单重放 0092）。
  REF_HEAD="$(manifest_field ref_migration_head)"
  [ -n "$REF_HEAD" ] || die 6 "清单缺 ref_migration_head"
  TARGET_HEAD="$(migration_head "$DB_TARGET")" || die 6 "目标库水位读取失败（0092 重放是否已执行？）"
  if [ "$TARGET_HEAD" != "$REF_HEAD" ]; then
    if [ "$REF_HEAD" = "$ROUTE_0091_HEAD" ] && [ "$TARGET_HEAD" = "$ROUTE_0092_HEAD" ]; then
      echo "replay: 水位=${ROUTE_0092_HEAD}（＝备份点 0091＋0092 幂等重放，§6.2 步骤 3 先例）"
    else
      die 6 "目标库水位 $TARGET_HEAD 既非备份点 $REF_HEAD 也非 0092 重放后水位——拒绝回放"
    fi
  fi
  # 门 1：清单完整性（红线 4 的下游面）。
  grep -q "^manifest_done	" "$MANIFEST" || die 6 "清单无 manifest_done 完成标记（export 未成功）——拒绝回放"
  DECLARED="$(sed -n 's/^manifest_done	//p' "$MANIFEST" | tail -1)"
  BODY="$(grep -v "^manifest_done	" "$MANIFEST")"
  [ "$(printf '%s\n' "$BODY" | sha256_file /dev/stdin)" = "$DECLARED" ] || die 6 "清单 sha256 不符（被篡改/截断）——拒绝回放"

  # 门 2：逐表制品 sha256＋行数。
  set -- $(sed -n 's/^table	\([^	]*\).*rows=\([0-9]*\).*sha256=\([^	]*\).*$/\1:\2:\3/p' "$MANIFEST")
  for ITEM in "$@"; do
    T="${ITEM%%:*}"; REST="${ITEM#*:}"; R="${REST%%:*}"; S="${REST##*:}"
    [ -f "$OUT_DIR/$T.copy" ] || die 6 "增量制品缺失: $T"
    [ "$(sha256_file "$OUT_DIR/$T.copy")" = "$S" ] || die 6 "增量制品 sha256 不符: $T"
    [ "$(wc -l < "$OUT_DIR/$T.copy" | tr -d ' ')" = "$R" ] || die 6 "增量制品行数不符: $T"
  done

  # 生成回放 SQL（列交集：manifest 列序 ∩ 恢复库现列；差集记 schema drift WARNING）。
  SQL="$WORK/replay.sql"
  : > "$SQL"
  {
    printf '\\set ON_ERROR_STOP on\n'
    printf 'BEGIN;\n'
    printf "SET timezone TO 'UTC';\n"
    printf 'ALTER TABLE %s DISABLE TRIGGER %s; -- 回放期禁用 0081 种入（0091+0092 重放下在位），失败随事务回滚\n' \
      "$SEED_TRIGGER_TABLE" "$SEED_TRIGGER"
    for T in $REPLAY_ORDER; do
      LINE="$(sed -n "s/^table	$T	//p" "$MANIFEST" | tail -1)"
      [ -n "$LINE" ] || die 6 "清单缺表: $T"
      ROWS="$(printf '%s\n' "$LINE" | awk -F'\t' '$1 ~ /^rows=/ { sub(/^rows=/, "", $1); print $1 }')"
      MCOLS="$(printf '%s\n' "$LINE" | awk -F'\t' '$4 ~ /^columns=/ { sub(/^columns=/, "", $4); print $4 }')"
      MTYPES="$(printf '%s\n' "$LINE" | awk -F'\t' '$5 ~ /^types=/ { sub(/^types=/, "", $5); print $5 }')"
      [ -n "$MCOLS" ] || die 6 "清单缺列信息: $T"
      [ -n "$MTYPES" ] || die 6 "清单缺类型信息: $T"
      if [ "$ROWS" -eq 0 ]; then
        printf -- '-- %s rows=0 skip\n' "$T"
        continue
      fi
      TCOLS="$(psql_in "$DB_TARGET" -Atq -c \
        "SELECT string_agg(column_name, ',' ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema='public' AND table_name='$T'")" \
        || die 6 "恢复库列读取失败: $T"
      [ -n "$TCOLS" ] || die 6 "恢复库缺表: ${T}（fail-closed）"
      # bash 3.2 对 $() 内含引号模式的 case 存在解析缺陷——交集/差集用 awk 完成。
      DROPD="$(printf '%s\n' "$MCOLS" | awk -v tc=",$TCOLS," \
        'NR == 1 { n = split($0, arr, ","); out = ""
          for (i = 1; i <= n; i++) { s = "," arr[i] ","; if (index(tc, s) == 0) out = out (out == "" ? "" : ",") arr[i] }
          print out }')"
      ICCOLS="$(printf '%s\n' "$MCOLS" | awk -v tc=",$TCOLS," \
        'NR == 1 { n = split($0, arr, ","); out = ""
          for (i = 1; i <= n; i++) { s = "," arr[i] ","; if (index(tc, s) > 0) out = out (out == "" ? "" : ",") arr[i] }
          print out }')"
      [ -n "$ICCOLS" ] || die 6 "列交集为空: $T"
      if [ -n "$DROPD" ]; then
        cat >> "$SQL" <<SQLDRIFT
DO \$\$ BEGIN RAISE WARNING 'schema drift: $T dropped columns (target lacks): $DROPD'; END \$\$;
SQLDRIFT
      fi
      COLDEFS="$(printf '%s\n' "$MCOLS" | awk -v t="$MTYPES" 'NR == 1 { n = split($0, c, ","); m = split(t, ty, ","); if (n != m) { print "TYPE_COUNT_MISMATCH" > "/dev/stderr"; exit 42 } out = ""; for (i = 1; i <= n; i++) out = out (i == 1 ? "" : ", ") c[i] " " ty[i]; print out }')"
      [ "${COLDEFS#TYPE_COUNT_MISMATCH}" = "$COLDEFS" ] || die 6 "清单列/类型数不一致: $T"
      printf 'CREATE TEMP TABLE stage_%s (%s);\n' "$T" "$COLDEFS"
      printf "\\copy stage_%s (%s) FROM '%s/%s.copy' WITH (FORMAT text)\n" "$T" "$MCOLS" "$CONTAINER_DELTA_DIR" "$T"
      printf 'WITH ins AS (INSERT INTO %s (%s) SELECT %s FROM stage_%s ON CONFLICT (id) DO NOTHING RETURNING 1)\n' \
        "$T" "$ICCOLS" "$ICCOLS" "$T"
      printf "SELECT 'REPLAY_RESULT table=%s inserted=' || count(*)::text FROM ins;\n" "$T"
    done
    printf 'COMMIT;\n'
    printf 'ALTER TABLE %s ENABLE TRIGGER %s; -- 回放完成后恢复 0091 种入语义（恢复后新建资源仍走旧门槛）\n' \
      "$SEED_TRIGGER_TABLE" "$SEED_TRIGGER"
    cat >> "$SQL" <<SQLTRIG
DO \$\$ BEGIN
  IF (SELECT tgenabled FROM pg_trigger WHERE tgname='$SEED_TRIGGER' AND NOT tgisinternal) IS DISTINCT FROM 'O' THEN
    RAISE EXCEPTION 'seed trigger not re-ENABLED after replay (must return to 0091 semantics)';
  END IF;
END \$\$;
SQLTRIG
  } >> "$SQL" || die 6 "回放 SQL 生成失败"

  # 制品送入容器（psql \copy 为容器内路径；rows=0 的空制品跳过）。
  docker exec "$CONTAINER" sh -c 'rm -rf "$1" && mkdir -p "$1"' sh "$CONTAINER_DELTA_DIR" \
    || die 6 "容器暂存目录准备失败"
  for T in $REPLAY_ORDER; do
    if [ -s "$OUT_DIR/$T.copy" ]; then
      docker cp "$OUT_DIR/$T.copy" "$CONTAINER:$CONTAINER_DELTA_DIR/$T.copy" || die 6 "制品入容器失败: $T"
    fi
  done

  docker exec -i "$CONTAINER" sh -c 'db="$1"; shift; exec psql -X -q -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$db"' \
    sh "$DB_TARGET" < "$SQL" || die 6 "回放执行失败（事务已回滚，库不变）"
  docker exec "$CONTAINER" sh -c 'rm -rf "$1"' sh "$CONTAINER_DELTA_DIR"
  echo "replay: OK target=$DB_TARGET target_head=${TARGET_HEAD}（ON CONFLICT DO NOTHING，二次执行幂等）"
}

# ── check-contract ──────────────────────────────────────────────────────
cmd_check_contract() {
  echo "== 静态契约 =="
  echo "whitelist+replay_order: $REPLAY_ORDER"
  echo "only_0092_tables(ref 必无): $ONLY_0092_TABLES"
  echo "external_parents(先于备份点): $EXTERNAL_PARENTS"
  echo "seed_trigger(disable during replay): $SEED_TRIGGER"
  echo "conflict_clause: ON CONFLICT (id) DO NOTHING（幂等）"
  echo "fail_closed: export/校验失败 exit 非 0，live 零写入；无 manifest_done 拒绝 replay"
  echo "finance_redline: provider_finance_event 不在白名单（增量面恒空）——零补造资金"
  if [ -z "$CONTAINER" ] || [ -z "$DB_LIVE" ]; then
    echo "check-contract: 静态回显完成（未做库内实测）"
    return 0
  fi
  require_env
  echo "== 库内实测（只读）=="
  for T in $REPLAY_ORDER; do
    EXISTS="$(psql_in "$DB_LIVE" -Atq -c "SELECT to_regclass('public.$T') IS NOT NULL")" \
      || die 7 "存在性查询失败: $T"
    [ "$EXISTS" = "t" ] || die 7 "白名单表在 live 库不存在: $T"
    PKCOLS="$(psql_in "$DB_LIVE" -Atq -c \
      "SELECT string_agg(a.attname, ',' ORDER BY a.attnum) FROM pg_index i JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=ANY(i.indkey) WHERE i.indrelid='public.$T'::regclass AND i.indisprimary")" \
      || die 7 "主键查询失败: $T"
    [ "$PKCOLS" = "id" ] || die 7 "主键非单列 id: $T (pk=$PKCOLS)"
    # FK 父闭包：父必须在白名单∪外表集。
    BAD="$(psql_in "$DB_LIVE" -Atq -c \
      "SELECT DISTINCT confrelid::regclass::text FROM pg_constraint WHERE contype='f' AND conrelid='public.$T'::regclass")" \
      || die 7 "FK 查询失败: $T"
    for P in $BAD; do
      PN="${P##*.}"
      case " $REPLAY_ORDER $EXTERNAL_PARENTS " in
        *" $PN "*) ;;
        *) die 7 "FK 父超出契约闭包: $T -> $PN";;
      esac
    done
    echo "check-contract: $T OK pk=id parents=[$(printf '%s' "$BAD" | tr '\n' ' ' | sed 's/ $//')]"
  done
  # 回放序拓扑合法性（白名单内部边：子必须排在父后）。
  TOPO_FAIL=0
  ORD_BAD="$(psql_in "$DB_LIVE" -Atq -c \
    "SELECT conrelid::regclass::text || '->' || confrelid::regclass::text FROM pg_constraint WHERE contype='f'")" \
    || die 7 "FK 全图查询失败"
  for EDGE in $ORD_BAD; do
    CHILD="${EDGE%%->*}"; PARENT="${EDGE##*->}"
    CB="${CHILD##*.}"; PB="${PARENT##*.}"
    CI=-1; PI=-1; IDX=0
    for T in $REPLAY_ORDER; do
      [ "$T" = "$CB" ] && CI=$IDX
      [ "$T" = "$PB" ] && PI=$IDX
      IDX=$((IDX+1))
    done
    if [ "$CI" -ge 0 ] && [ "$PI" -ge 0 ] && [ "$CI" -le "$PI" ]; then
      echo "check-contract: TOPO-FAIL ${EDGE}（子先于父回放）"
      TOPO_FAIL=1
    fi
  done
  [ "$TOPO_FAIL" -eq 0 ] || die 7 "回放序拓扑不合法"
  echo "check-contract: OK（白名单闭包＋回放序拓扑实测通过）"
}

# ── 参数解析 ────────────────────────────────────────────────────────────
CMD="${1:-}"
if [ $# -gt 0 ]; then shift; fi
while [ $# -gt 0 ]; do
  case "$1" in
    --container) CONTAINER="${2:-}"; shift 2;;
    --db-live) DB_LIVE="${2:-}"; shift 2;;
    --db-ref) DB_REF="${2:-}"; shift 2;;
    --db-target) DB_TARGET="${2:-}"; shift 2;;
    --dump-file) DUMP_FILE="${2:-}"; shift 2;;
    --out-dir|--delta-dir) OUT_DIR="${2:-}"; shift 2;;
    --manifest) MANIFEST="${2:-}"; shift 2;;
    *) usage; die 2 "未知参数: $1";;
  esac
done

WORK="$(mktemp -d "${TMPDIR:-/tmp}/wp6-r3.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

case "$CMD" in
  export) cmd_export;;
  restore) cmd_restore;;
  replay) cmd_replay;;
  check-contract) cmd_check_contract;;
  *) usage; die 2 "缺少或未知子命令: ${CMD:-（空）}";;
esac
