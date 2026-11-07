#!/usr/bin/env bash
# X07 R4 主路线 v3（增量导出→影子恢复→重放 0092→增量回放→retire→verify→swap）独立脚本。
#
# R4 变更（验收二次退回四缺口）：
#   A) 增量含更新：白名单逐表「全行比对」——live 与备份点快照按 PK 全连接，任一列变更
#      或新增行均入增量；清单区分 inserted/updated；回放改 INSERT ... ON CONFLICT (id)
#      DO UPDATE SET <列交集全列>（schema drift 列按交集投影丢弃，R3 语义不变）；
#      二次回放幂等（重放结果不变）。
#   B) 影子库先行：restore/replay/retire/verify 全部只作用于影子库——live 全程零写入；
#      全部校验通过后 swap：单事务内 ALTER DATABASE live→<live>_pre_rollback_keep、
#      影子→live（keep 库＝切换后状态留档；保留策略见操作单 §6.1 v3：回退验证完成后
#      由运维清理，期间不得写入）。任一步失败＝删影子库、live 未动、exit 非 0。
#      DESTRUCTIVE 确认门语义保持（restore/swap 须 ROLLBACK_DELTA_CONFIRM=YES）。
#   D) 门槛退役保持：retire-threshold 子命令在影子内停用并 DROP 0081 种入触发器与
#      函数（0094 down 会在 down 链恢复它们；本步骤使 0094 的退役语义在整库恢复后
#      保持），并删除 API 模式 provider_resource_finance_state 的 PENDING 控制行
#      （控制行非资金事实；删除前行数留档进 --log）。依据＝AFR-02：这是回退包对旧
#      代码行为的有意覆盖（操作单 §6.1/§6.4 v3 声明），非默认放行。
#
# 与 rollback.sh 的编排：restore 子命令提供 -Fc 等价流程且只写影子库（§4.2 复用注意
# a/b 参数化）；rollback.sh 既有段零触碰。重放 0092 up（幂等，§6.2 步骤 3 先例）由旧栈
# migrator 承担（up 重放非 down，rollback.sh:113「禁止叠加 down」不受影响）。
#
# 红线（release-candidate.md §6.5）：不删除新用量（白名单只做导出回放；PENDING 控制
# 行删除仅限 retire-threshold 且留档）；不补造资金（provider_finance_event 不在白名单，
# verify 以 ref 快照全表摘要比对证明零补造）；不改 0092-0096 迁移文件；增量导出失败
# 必须中止（红线 4——v3 下任一管线失败均发生在影子内，live 物理未动）。
#
# 依赖：宿主机 bash/docker；psql/pg_dump/pg_restore 全部容器内执行（不依赖宿主机
# postgres 客户端）。兼容 bash 3.2（无关联数组/进程替换）与 busybox ash。
#
# 白名单与 FK 闭包（终表 16；实测依据＝WP6-X07-R3-20261106/logs/fk-closure-dump.log
# 0096 水位 343 条 FK 边）：
#   根域（R4 补入）：enterprise——0092 按迁移定义为其加列 employee_quota_monthly_from
#     （0092:5，员工月度额度启用状态）；全行比对下该更新随增量保全（缺口③真实路径
#     的 currentScope 前提）；
#   维度：provider provider_resource principal principal_key unified_model model_route
#     billing_rule；
#   消费事实：ai_request upstream_attempt usage_event（FK 强制，0009:26）ledger_line
#     ledger_transaction；
#   员工月度额度域（0092）：principal_grant（principal_quota_usage FK 强制）
#     principal_quota_period principal_quota_usage；
#   累计额度域（R5 补入）：quota_counter（0004:41——累计额度准入 reserveQuota 直接
#     读 used_value；全行比对覆盖已有计数行 used_value 更新与新增授权计数行）。
#   白名单外表（FK 父，不导出，先于备份点存在）：person admin_user historical_import_run
#     employee_model_rule_version provider_finance_legacy_cost_resolution
#     provider_subscription_period（CODING_PLAN 窗口内新建周期被消费引用＝已知边界：
#     影子内回放失败＝删影子、live 未动——gap② 的绿证场景）。
set -euo pipefail
[ "${WP6_R4_DEBUG:-}" = "1" ] && set -x

PROG="${0##*/}"
CONTAINER=""
DB_LIVE=""
DB_REF=""
DB_SHADOW=""
DB_KEEP=""
DUMP_FILE=""
OUT_DIR=""
MANIFEST=""
LOG_PATH=""

# 白名单回放序（FK 依赖序：父先于子；enterprise 为根）。
# R5 补入 quota_counter——累计额度计数行（0004:41，grant_id 唯一约束
# quota_counter_grant_idx）；FK 父 principal_grant 先于它；累计额度准入
# quota-gate-repository reserveQuota 直接读其 used_value（热路径非缓存）。
REPLAY_ORDER="enterprise provider unified_model principal principal_key provider_resource billing_rule model_route ai_request upstream_attempt usage_event ledger_line ledger_transaction principal_grant quota_counter principal_quota_period principal_quota_usage"
# 0092 专属表：0091 备份点快照无此二表（0092 未应用），全行比对按「快照空集」全量导出。
ONLY_0092_TABLES="principal_quota_period principal_quota_usage"
# 白名单外表（FK 父，先于备份点存在；不导出）。
EXTERNAL_PARENTS="person admin_user historical_import_run employee_model_rule_version provider_finance_legacy_cost_resolution provider_subscription_period"
# 0092 重放为目标 schema 补回的白名单列（不属于 drift）：比对集＝live∩ref＋本组。
NINE_TWO_ADDED_COLS="employee_quota_monthly_from quota_basis"
# 种入触发器与函数（0081:185-205；0094 退役；retire-threshold 在影子内使其退役保持）。
SEED_TRIGGER="provider_resource_finance_state_seed_trigger"
SEED_FUNCTION="provider_resource_finance_state_seed"
SEED_TRIGGER_TABLE="provider_resource"
TAB=$'\t'
CONTAINER_DELTA_DIR="/tmp/wp6-r4-delta-in"
ROUTE_0091_HEAD="0091_recorded_cost_accounting_policy"
ROUTE_0092_HEAD="0092_employee_monthly_quota"

usage() {
  cat <<EOF
用法:
  $PROG export --container C --db-live DB --db-ref REFDB --dump-file DUMP --out-dir DIR
  $PROG restore --container C --db-live DB --db-shadow SHADOW --dump-file DUMP   (须 ROLLBACK_DELTA_CONFIRM=YES)
  $PROG replay  --container C --db-live DB --db-shadow SHADOW --manifest MANIFEST_TSV --delta-dir DIR
  $PROG retire-threshold --container C --db-live DB --db-shadow SHADOW --log PATH
  $PROG verify --container C --db-live DB --db-shadow SHADOW --db-ref REFDB --manifest MANIFEST_TSV
  $PROG swap --container C --db-live DB --db-shadow SHADOW --db-ref REFDB --manifest MANIFEST_TSV [--keep-name K]   (须 ROLLBACK_DELTA_CONFIRM=YES)
  $PROG check-contract [--container C --db-live DB]
语义:
  export  破坏动作之前执行。备份点快照载入 --db-ref（只写 ref 草稿库），逐白名单表
          全行比对（PK 全连接，任一列变更或新增行均入增量）导出 COPY text＋
          rows/inserted/updated/sha256 清单；任何失败 exit 非 0，live 零写入。
  restore 只写影子库：dropdb --force 影子→createdb→pg_restore 备份点到影子。
          失败＝删影子、exit 非 0；live 物理未动。
  replay  影子内回放增量（staging temp 表＋ON CONFLICT (id) DO UPDATE SET 全列投影，
          二次执行幂等）；回放期禁用种入触发器；失败＝删影子、exit 非 0。
  retire-threshold 影子内 DROP 0081 种入触发器＋函数＋删除 API 模式 PENDING 控制行
          （行数留档 --log）；失败＝删影子、exit 非 0。
  verify  影子校验：水位／白名单全表摘要（live∩ref 列交集）＝live／资金事实全表摘要
          ＝ref 快照（零补造）／种入触发器与函数已退役／API PENDING＝0。
          失败＝删影子、exit 非 0。
  swap    单事务：ALTER DATABASE live→keep、影子→live（keep＝切换后状态留档）。
          失败＝事务回滚＋删影子、exit 非 0；须 ROLLBACK_DELTA_CONFIRM=YES。
          执行门（CQ-R1-01）：swap 另须 --db-ref/--manifest——在发出任何改名前
          以同一组 live/shadow/ref/清单内联重跑 verify 全部校验（水位／白名单
          全表摘要＝live／资金事实摘要＝ref 零补造／种入触发器与函数退役／
          API PENDING=0）；缺验证必需参数、清单 container/live_db/ref_db 与待
          切换对象不符、或任一校验失败＝改名之前 exit 非 0（校验失败＝删影子）。
          未经过本次内联验证的影子不得接管 live 名称（旧成功日志/独立布尔/
          仅存在性检查不作验证凭据）。
  参数防护（CQ-01）：restore/replay/retire-threshold/verify/swap 五入口要求
          --db-live 必填（live 标识缺失＝同名防护退化为空串比较），且
          live/shadow/keep/ref 互不同名、shadow 非系统库——校验先于任何
          dropdb/写入/改名/失败清理，拒绝＝exit 非 0。
EOF
}

die() { echo "FAIL-CLOSED[$1]: $2" >&2; exit "$1"; }

# CQ-01（v1.5 质量预检整改）：影子管线入口统一参数防护。
# restore/replay/retire-threshold/verify/swap 五个会写入/删除/改名影子库或执行失败
# 清理的入口，必须在任何 dropdb/写入/改名/失败清理之前调用本函数。缺陷本相：实现
# 以「DB_SHADOW != DB_LIVE」保护 live，但 DB_LIVE 可为空——省略 --db-live 且误把
# 真实 live 名填入 --db-shadow 时，保护退化为与空串比较，通过后对该名执行
# dropdb --force（审核报告 CQ-01 桩证：exit 0＋对 synthetic_live 发出 dropdb）。
# 故 DB_LIVE 非空为硬性前置；live/keep/ref 同名冲突组合一并拒绝（ref＝live 时
# 资金事件摘要 live 自比，零补造证明空洞——审核返工补充红证）。
# 拒绝＝exit 非 0，且此时未发出任何容器内 dropdb/写入/改名调用（docker 命令桩留证：
# V4/Evidence/API-COST-OFFICIAL-BALANCE/CODE-QUALITY-V15-20261107/）。
guard_shadow_pipeline() { # $1=子命令名
  [ -n "$DB_LIVE" ] || die 2 "$1 缺少 --db-live（live 标识必填：缺省＝shadow≠live 同名防护退化为空串比较）"
  [ -n "$DB_SHADOW" ] || die 2 "$1 缺少 --db-shadow"
  [ "$DB_SHADOW" != "$DB_LIVE" ] || die 3 "$1 影子库不得与 live 同名: $DB_SHADOW"
  local keep="${DB_KEEP:-${DB_LIVE}_pre_rollback_keep}"
  [ "$keep" != "$DB_LIVE" ] || die 3 "$1 keep 库名不得与 live 同名: ${keep}（--keep-name 或默认派生）"
  [ "$DB_SHADOW" != "$keep" ] || die 3 "$1 影子库不得与 keep 库同名: $keep"
  if [ -n "$DB_REF" ]; then
    [ "$DB_SHADOW" != "$DB_REF" ] || die 3 "$1 影子库不得与 ref 快照库同名: $DB_REF"
    [ "$DB_REF" != "$DB_LIVE" ] || die 3 "$1 ref 快照库不得与 live 同名: $DB_REF"
  fi
  case "$DB_SHADOW" in postgres|template0|template1) die 3 "$1 拒绝系统库 $DB_SHADOW";; esac
}

need_tools() {
  command -v docker >/dev/null 2>&1 || die 2 "宿主机缺少 docker"
  command -v awk >/dev/null 2>&1 || die 2 "宿主机缺少 awk"
  command -v comm >/dev/null 2>&1 || die 2 "宿主机缺少 comm"
  command -v paste >/dev/null 2>&1 || die 2 "宿主机缺少 paste"
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'
  else die 2 "宿主机缺少 sha256sum/shasum"; fi
}

sha256_stdin() {
  # 流式摘要（verify 全表比对用；避免落盘大表）。
  if command -v sha256sum >/dev/null 2>&1; then sha256sum | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 | awk '{print $1}'
  else die 2 "宿主机缺少 sha256sum/shasum"; fi
}

psql_in() {
  docker exec "$CONTAINER" sh -c 'db="$1"; shift; exec psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$db" "$@"' \
    sh "$@"
}

require_env() {
  [ -n "$CONTAINER" ] || die 2 "缺少 --container"
  docker exec "$CONTAINER" sh -c 'true' 2>/dev/null || die 3 "容器不可达: $CONTAINER"
}

dump_integrity_gate() {
  [ -n "$DUMP_FILE" ] || die 3 "缺少 --dump-file"
  [ -s "$DUMP_FILE" ] || die 3 "备份制品不存在或为零字节（Verified backup required）: $DUMP_FILE"
  docker exec -i "$CONTAINER" sh -c 'pg_restore --list >/dev/null' \
    < "$DUMP_FILE" || die 3 "备份制品无法被 pg_restore 解析（格式损坏）: $DUMP_FILE"
}

migration_head() {
  psql_in "$1" -Atq -c "SET timezone TO 'UTC'" \
    -c "SELECT name FROM kysely_migration ORDER BY timestamp DESC, name DESC LIMIT 1"
}

db_exists() { # $1=db → 输出 t/f
  docker exec "$CONTAINER" sh -c 'db="$1"; shift; exec psql -X -Atq -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 -c "SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = '"'"'$db'"'"')"' \
    sh "$1" | tail -1
}

drop_shadow_or_die() { # 失败清理：删影子（尽力而为）后 die
  local code="$1" msg="$2" shadow="$3"
  docker exec "$CONTAINER" sh -c 'dropdb --if-exists --force -U "$POSTGRES_USER" "$1"' sh "$shadow" >/dev/null 2>&1 || true
  die "$code" "$msg"
}

manifest_field() {
  sed -n "s/^$1$TAB//p" "$MANIFEST" | head -1
}

# 全表（或列投影）流式 sha256：容器内 \copy TO STDOUT → 宿主机 sha256_stdin。
copy_digest() { # $1=db $2=table $3=列逗号串（空＝SELECT *）
  local db="$1" t="$2" cols="$3"
  if [ -z "$cols" ]; then
    docker exec "$CONTAINER" sh -c 'db="$1"; t="$2"; exec psql -X -Atq -U "$POSTGRES_USER" -d "$db" -c "SET timezone TO 'UTC'" -c "\\copy (SELECT * FROM $t ORDER BY id) TO STDOUT WITH (FORMAT text)"' \
      sh "$db" "$t" | sha256_stdin
  else
    docker exec "$CONTAINER" sh -c 'db="$1"; t="$2"; cols="$3"; exec psql -X -Atq -U "$POSTGRES_USER" -d "$db" -c "SET timezone TO 'UTC'" -c "\\copy (SELECT $cols FROM $t ORDER BY id) TO STDOUT WITH (FORMAT text)"' \
      sh "$db" "$t" "$cols" | sha256_stdin
  fi
}

table_columns() { # $1=db $2=table → 逗号串（ordinal 序）
  psql_in "$1" -Atq -c \
    "SELECT string_agg(column_name, ',' ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema='public' AND table_name='$2'"
}

table_types() {
  psql_in "$1" -Atq -c \
    "SELECT string_agg(data_type, ',' ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema='public' AND table_name='$2'"
}

# ── export（全行比对）───────────────────────────────────────────────────
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
  WORK="$(mktemp -d "${TMPDIR:-/tmp}/wp6-r4-export.XXXXXX")"

  LIVE_HEAD="$(migration_head "$DB_LIVE")" || die 4 "live 水位读取失败（库不可达？）"

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
  printf 'manifest_version\twp6-r4-1\n' >> "$MANIFEST"
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

  for T in $REPLAY_ORDER; do
    LIVE_COLS="$(table_columns "$DB_LIVE" "$T")" || die 4 "白名单表 $T 列读取失败（fail-closed）"
    [ -n "$LIVE_COLS" ] || die 4 "白名单表 $T 在 live 库不存在（fail-closed）"

    # 比对集＝live∩ref＋0092 新增列（employee_quota_monthly_from/quota_basis 由 0092
    # 重放补回，非 drift）；其余 live−ref 列（0093 source_status 等）为 drift，不比对、
    # 回放按列交集投影丢弃。
    ADDED="$(printf '%s\n' "$NINE_TWO_ADDED_COLS" | awk -v lc=",$LIVE_COLS," \
      'NR == 1 { n = split($0, arr, " "); out = ""
        for (i = 1; i <= n; i++) { s = "," arr[i] ","; if (arr[i] != "" && index(lc, s) > 0) out = out (out == "" ? "" : ",") arr[i] }
        print out }')"
    REF_EXISTS="$(psql_in "$DB_REF" -Atq -c "SELECT to_regclass('public.$T') IS NOT NULL")" \
      || die 4 "ref 存在性探测失败: $T"
    if [ "$REF_EXISTS" = "t" ]; then
      REF_PRESENT="yes"
      REF_COLS="$(table_columns "$DB_REF" "$T")"
      CMP_COLS="$(printf '%s\n' "$LIVE_COLS" | awk -v rc=",$REF_COLS,$ADDED," \
        'NR == 1 { n = split($0, arr, ","); out = ""
          for (i = 1; i <= n; i++) { s = "," arr[i] ","; if (index(rc, s) > 0) out = out (out == "" ? "" : ",") arr[i] }
          print out }')"
      CMP_TYPES="$(printf '%s\n' "$LIVE_COLS" | awk -v rc=",$REF_COLS,$ADDED," -v types="$(table_types "$DB_LIVE" "$T")" \
        'NR == 1 {
           n = split($0, arr, ","); m = split(types, ty, ",")
           for (j = 1; j <= n; j++) type[arr[j]] = ty[j]
           out = ""; first = 1
           for (i = 1; i <= n; i++) { s = "," arr[i] ","; if (index(rc, s) > 0) { out = out (first ? "" : ",") arr[i] ":" type[arr[i]]; first = 0 } }
           print out }')"
      # ref 侧导出列＝比对集剔除 0092 补回列（ref 无此列）；宿主侧按列数补 \N 占位
      # （ALTER ADD 列必在表尾，位置对齐成立）。
      REF_SELECT="$(printf '%s\n' "$CMP_COLS" | awk -v rc=",$REF_COLS," \
        'NR == 1 { n = split($0, arr, ","); out = ""
          for (i = 1; i <= n; i++) { s = "," arr[i] ","; if (index(rc, s) > 0) out = out (out == "" ? "" : ",") arr[i] }
          print out }')"
    else
      REF_PRESENT="no"
      CMP_COLS="$LIVE_COLS"
      CMP_TYPES="$(table_types "$DB_LIVE" "$T")"
      : > "$WORK/ref.$T.copy"
    fi
    echo "export: DEBUG $T ref_exists=$REF_EXISTS ref_present=$REF_PRESENT added=$ADDED cmp_cols=${CMP_COLS:0:60} ref_select=${REF_SELECT:0:60}" >&2
    case " $ONLY_0092_TABLES " in
      *" $T "*)
        [ "$REF_PRESENT" = "no" ] || die 4 "$T 应为 0092 专属表但 ref 快照已存在，契约不符";;
    esac
    if [ "$REF_PRESENT" = "yes" ]; then
      docker exec "$CONTAINER" sh -c 'db="$1"; t="$2"; cols="$3"; exec psql -X -Atq -U "$POSTGRES_USER" -d "$db" -c "SET timezone TO '"'"'UTC'"'"'" -c "\copy (SELECT $cols FROM $t ORDER BY id) TO STDOUT WITH (FORMAT text)"' \
        sh "$DB_REF" "$T" "$REF_SELECT" > "$WORK/ref.$T.copy" || die 4 "ref 全表导出失败: $T"
      ADDED_N="$(printf '%s\n' "$ADDED" | awk 'NR == 1 { n = split($0, arr, ","); c = 0; for (i = 1; i <= n; i++) if (arr[i] != "") c++; print c }')"
      if [ "$ADDED_N" != "0" ]; then
        awk -v n="$ADDED_N" \
          'BEGIN { pad = ""; for (i = 1; i <= n; i++) pad = pad (i == 1 ? "" : "\t") "\\N" }
           { print $0 "\t" pad }' "$WORK/ref.$T.copy" > "$WORK/ref.$T.copy.pad" \
          && mv "$WORK/ref.$T.copy.pad" "$WORK/ref.$T.copy" || die 4 "ref 增量占位失败: $T"
      fi
    else
      : > "$WORK/ref.$T.copy"
    fi
      docker exec "$CONTAINER" sh -c 'db="$1"; t="$2"; cols="$3"; exec psql -X -Atq -U "$POSTGRES_USER" -d "$db" -c "SET timezone TO '"'"'UTC'"'"'" -c "\copy (SELECT $cols FROM $t ORDER BY id) TO STDOUT WITH (FORMAT text)"' \
      sh "$DB_LIVE" "$T" "$CMP_COLS" > "$WORK/live.$T.copy" || die 4 "live 全表导出失败: $T"

    # 全行比对（PK 全连接）：新增或任一列变更均入增量。
    awk -F'\t' -v cf="$WORK/counts.$T" -v reffile="$WORK/ref.$T.copy" \
      'FILENAME == reffile { ref[$1]=$0; next }
       {
         if ($1 in ref) { if ($0 != ref[$1]) { u++; print } }
         else { i++; print }
       }
       END { printf "%d\t%d\n", i + 0, u + 0 > cf }' \
      "$WORK/ref.$T.copy" "$WORK/live.$T.copy" > "$OUT_DIR/$T.copy" || die 4 "全行比对失败: $T"
    read -r INSERTED UPDATED < "$WORK/counts.$T"
    ROWS="$((INSERTED + UPDATED))"
    if [ "${WP6_R4_DEBUG:-}" = "1" ]; then
      echo "export-debug: $T live_rows=$(wc -l < "$WORK/live.$T.copy" | tr -d ' ') ref_rows=$(wc -l < "$WORK/ref.$T.copy" | tr -d ' ') inserted=$INSERTED updated=$UPDATED" >&2
    fi
    GOT="$(wc -l < "$OUT_DIR/$T.copy" | tr -d ' ')"
    [ "$GOT" -eq "$ROWS" ] || die 4 "行数校验失败: $T 期望 $ROWS 实得 $GOT"

    SHA="$(sha256_file "$OUT_DIR/$T.copy")"
    printf 'table\t%s\trows=%s\tinserted=%s\tupdated=%s\tsha256=%s\tref_present=%s\tcolumns=%s\ttypes=%s\n' \
      "$T" "$ROWS" "$INSERTED" "$UPDATED" "$SHA" "$REF_PRESENT" "$CMP_COLS" "$CMP_TYPES" >> "$MANIFEST"
    echo "export: table=$T rows=$ROWS inserted=$INSERTED updated=$UPDATED sha256=$SHA ref_present=$REF_PRESENT"
  done

  while IFS= read -r line; do
    case "$line" in
      table*)
        T="$(printf '%s' "$line" | cut -f2)"
        S="$(printf '%s\n' "$line" | awk -F'\t' '$6 ~ /^sha256=/ { sub(/^sha256=/, "", $6); print $6 }')"
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

# ── restore（影子库）────────────────────────────────────────────────────
cmd_restore() {
  need_tools
  guard_shadow_pipeline "restore"
  require_env
  dump_integrity_gate
  [ "${ROLLBACK_DELTA_CONFIRM:-}" = "YES" ] \
    || die 5 "危险动作：须环境 ROLLBACK_DELTA_CONFIRM=YES（dropdb --force 影子库＋createdb，DESTRUCTIVE 定级同 rollback.sh:5）"
  if ! docker exec "$CONTAINER" sh -c 'dropdb --if-exists --force -U "$POSTGRES_USER" "$1"' sh "$DB_SHADOW" \
    || ! docker exec "$CONTAINER" sh -c 'createdb -U "$POSTGRES_USER" "$1"' sh "$DB_SHADOW" \
    || ! docker exec -i "$CONTAINER" sh -c 'db="$1"; shift; exec pg_restore --no-owner --no-privileges -U "$POSTGRES_USER" -d "$db"' \
      sh "$DB_SHADOW" < "$DUMP_FILE"; then
    drop_shadow_or_die 5 "影子恢复失败（影子已删，live 未动）: $DB_SHADOW" "$DB_SHADOW"
  fi
  echo "restore: OK shadow=$DB_SHADOW head=$(migration_head "$DB_SHADOW")（live 未动；备份点水位，禁止叠加 down——rollback.sh:113 同规）"
}

# ── replay（影子内，DO UPDATE 幂等）────────────────────────────────────
cmd_replay() {
  need_tools
  guard_shadow_pipeline "replay"
  [ -n "$MANIFEST" ] || die 2 "replay 缺少 --manifest"
  [ -n "$OUT_DIR" ] || die 2 "replay 缺少 --delta-dir"
  require_env
  WORK="$(mktemp -d "${TMPDIR:-/tmp}/wp6-r4-replay.XXXXXX")"
  REF_HEAD="$(manifest_field ref_migration_head)"
  [ -n "$REF_HEAD" ] || die 6 "清单缺 ref_migration_head"
  TARGET_HEAD="$(migration_head "$DB_SHADOW")" || drop_shadow_or_die 6 "影子水位读取失败（0092 重放是否已执行？）" "$DB_SHADOW"
  if [ "$TARGET_HEAD" != "$REF_HEAD" ]; then
    if [ "$REF_HEAD" = "$ROUTE_0091_HEAD" ] && [ "$TARGET_HEAD" = "$ROUTE_0092_HEAD" ]; then
      echo "replay: 水位=${ROUTE_0092_HEAD}（＝备份点 0091＋0092 幂等重放，§6.2 步骤 3 先例）"
    else
      drop_shadow_or_die 6 "影子库水位 $TARGET_HEAD 既非备份点 $REF_HEAD 也非 0092 重放后水位——拒绝回放" "$DB_SHADOW"
    fi
  fi
  grep -q "^manifest_done$TAB" "$MANIFEST" || drop_shadow_or_die 6 "清单无 manifest_done 完成标记（export 未成功）——拒绝回放" "$DB_SHADOW"
  DECLARED="$(sed -n "s/^manifest_done$TAB//p" "$MANIFEST" | tail -1)"
  BODY="$(grep -v "^manifest_done$TAB" "$MANIFEST")"
  [ "$(printf '%s\n' "$BODY" | sha256_file /dev/stdin)" = "$DECLARED" ] || drop_shadow_or_die 6 "清单 sha256 不符（被篡改/截断）——拒绝回放" "$DB_SHADOW"

  set -- $(sed -n "s/^table$TAB\\([^$TAB]*\\).*rows=\\([0-9]*\\).*sha256=\\([^$TAB]*\\).*\$/\\1:\\2:\\3/p" "$MANIFEST")
  for ITEM in "$@"; do
    T="${ITEM%%:*}"; REST="${ITEM#*:}"; R="${REST%%:*}"; S="${REST##*:}"
    [ -f "$OUT_DIR/$T.copy" ] || drop_shadow_or_die 6 "增量制品缺失: $T" "$DB_SHADOW"
    [ "$(sha256_file "$OUT_DIR/$T.copy")" = "$S" ] || drop_shadow_or_die 6 "增量制品 sha256 不符: $T" "$DB_SHADOW"
    [ "$(wc -l < "$OUT_DIR/$T.copy" | tr -d ' ')" = "$R" ] || drop_shadow_or_die 6 "增量制品行数不符: $T" "$DB_SHADOW"
  done

  SQL="$WORK/replay.sql"
  : > "$SQL"
  {
    printf '\\set ON_ERROR_STOP on\n'
    printf 'BEGIN;\n'
    printf "SET timezone TO 'UTC';\n"
    printf 'ALTER TABLE %s DISABLE TRIGGER %s; -- 回放期禁用 0081 种入（retire-threshold 将在此后使其退役保持）\n' \
      "$SEED_TRIGGER_TABLE" "$SEED_TRIGGER"
    for T in $REPLAY_ORDER; do
      LINE="$(sed -n "s/^table$TAB$T$TAB//p" "$MANIFEST" | tail -1)"
      [ -n "$LINE" ] || drop_shadow_or_die 6 "清单缺表: $T" "$DB_SHADOW"
      ROWS="$(printf '%s\n' "$LINE" | awk -F'\t' '$1 ~ /^rows=/ { sub(/^rows=/, "", $1); print $1 }')"
      MCOLS="$(printf '%s\n' "$LINE" | awk -F'\t' '$6 ~ /^columns=/ { sub(/^columns=/, "", $6); print $6 }')"
      MTYPES="$(printf '%s\n' "$LINE" | awk -F'\t' '$7 ~ /^types=/ { sub(/^types=/, "", $7); print $7 }')"
      [ -n "$MCOLS" ] || drop_shadow_or_die 6 "清单缺列信息: $T" "$DB_SHADOW"
      [ -n "$MTYPES" ] || drop_shadow_or_die 6 "清单缺类型信息: $T" "$DB_SHADOW"
      if [ "$ROWS" -eq 0 ]; then
        printf -- '-- %s rows=0 skip\n' "$T"
        continue
      fi
      TCOLS="$(table_columns "$DB_SHADOW" "$T")" || drop_shadow_or_die 6 "影子库列读取失败: $T" "$DB_SHADOW"
      [ -n "$TCOLS" ] || drop_shadow_or_die 6 "影子库缺表: ${T}（fail-closed）" "$DB_SHADOW"
      DROPD="$(printf '%s\n' "$MCOLS" | awk -v tc=",$TCOLS," \
        'NR == 1 { n = split($0, arr, ","); out = ""
          for (i = 1; i <= n; i++) { s = "," arr[i] ","; if (index(tc, s) == 0) out = out (out == "" ? "" : ",") arr[i] }
          print out }')"
      ICCOLS="$(printf '%s\n' "$MCOLS" | awk -v tc=",$TCOLS," \
        'NR == 1 { n = split($0, arr, ","); out = ""
          for (i = 1; i <= n; i++) { s = "," arr[i] ","; if (index(tc, s) > 0) out = out (out == "" ? "" : ",") arr[i] }
          print out }')"
      [ -n "$ICCOLS" ] || drop_shadow_or_die 6 "列交集为空: $T" "$DB_SHADOW"
      if [ -n "$DROPD" ]; then
        cat >> "$SQL" <<SQLDRIFT
DO \$\$ BEGIN RAISE WARNING 'schema drift: $T dropped columns (target lacks): $DROPD'; END \$\$;
SQLDRIFT
      fi
      COLDEFS="$(printf '%s\n' "$MCOLS" | awk -v t="$MTYPES" \
        'NR == 1 { n = split($0, c, ","); m = split(t, ty, ",")
          if (n != m) { print "TYPE_COUNT_MISMATCH" > "/dev/stderr"; exit 42 }
          out = ""
          for (i = 1; i <= n; i++) { cc = index(ty[i], ":"); typ = (cc > 0) ? substr(ty[i], cc + 1) : ty[i]
            out = out (i == 1 ? "" : ", ") c[i] " " typ }
          print out }')"
      [ "${COLDEFS#TYPE_COUNT_MISMATCH}" = "$COLDEFS" ] || drop_shadow_or_die 6 "清单列/类型数不一致: $T" "$DB_SHADOW"
      printf 'CREATE TEMP TABLE stage_%s (%s);\n' "$T" "$COLDEFS"
      printf "\\copy stage_%s (%s) FROM '%s/%s.copy' WITH (FORMAT text)\n" "$T" "$MCOLS" "$CONTAINER_DELTA_DIR" "$T"
      SETCLS="$(printf '%s\n' "$ICCOLS" | awk         'NR == 1 { n = split($0, arr, ","); out = ""
          for (i = 1; i <= n; i++) { if (arr[i] == "id") continue; out = out (out == "" ? "" : ", ") arr[i] " = EXCLUDED." arr[i] }
          print out }')"
      printf 'WITH ins AS (INSERT INTO %s (%s) SELECT %s FROM stage_%s ON CONFLICT (id) DO UPDATE SET %s RETURNING 1)\n' \
        "$T" "$ICCOLS" "$ICCOLS" "$T" "$SETCLS"
      printf "SELECT 'REPLAY_RESULT table=%s applied=' || count(*)::text FROM ins;\n" "$T"
    done
    printf 'COMMIT;\n'
    printf 'ALTER TABLE %s ENABLE TRIGGER %s; -- 回放完成恢复 0091 种入语义（retire-threshold 随后退役保持）\n' \
      "$SEED_TRIGGER_TABLE" "$SEED_TRIGGER"
    cat >> "$SQL" <<SQLTRIG
DO \$\$ BEGIN
  IF (SELECT tgenabled FROM pg_trigger WHERE tgname='$SEED_TRIGGER' AND NOT tgisinternal) IS DISTINCT FROM 'O' THEN
    RAISE EXCEPTION 'seed trigger not re-ENABLED after replay (must return to 0091 semantics)';
  END IF;
END \$\$;
SQLTRIG
  } >> "$SQL" || drop_shadow_or_die 6 "回放 SQL 生成失败" "$DB_SHADOW"

  docker exec "$CONTAINER" sh -c 'rm -rf "$1" && mkdir -p "$1"' sh "$CONTAINER_DELTA_DIR" \
    || drop_shadow_or_die 6 "容器暂存目录准备失败" "$DB_SHADOW"
  for T in $REPLAY_ORDER; do
    if [ -s "$OUT_DIR/$T.copy" ]; then
      docker cp "$OUT_DIR/$T.copy" "$CONTAINER:$CONTAINER_DELTA_DIR/$T.copy" || drop_shadow_or_die 6 "制品入容器失败: $T" "$DB_SHADOW"
    fi
  done

  cp "$SQL" /tmp/wp6-r4-replay-debug.sql 2>/dev/null || true
  if ! docker exec -i "$CONTAINER" sh -c 'db="$1"; shift; exec psql -X -q -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$db"' \
    sh "$DB_SHADOW" < "$SQL"; then
    drop_shadow_or_die 6 "回放执行失败（影子已删、事务已回滚，live 未动）" "$DB_SHADOW"
  fi
  docker exec "$CONTAINER" sh -c 'rm -rf "$1"' sh "$CONTAINER_DELTA_DIR"
  echo "replay: OK shadow=$DB_SHADOW shadow_head=${TARGET_HEAD}（ON CONFLICT (id) DO UPDATE 全列投影，二次执行幂等）"
}

# ── retire-threshold（影子内，缺口④）───────────────────────────────────
cmd_retire_threshold() {
  need_tools
  guard_shadow_pipeline "retire-threshold"
  [ -n "$LOG_PATH" ] || die 2 "retire-threshold 缺少 --log"
  require_env
  SQL="$(mktemp "${TMPDIR:-/tmp}/wp6-r4-retire.XXXXXX")"
  {
    printf '\\set ON_ERROR_STOP on\n'
    printf 'BEGIN;\n'
    printf "SELECT 'RETIRE pending_api_before=' || count(*)::text FROM provider_resource_finance_state s JOIN provider_resource r ON r.enterprise_id = s.enterprise_id AND r.id = s.provider_resource_id WHERE s.state = 'PENDING' AND r.mode = 'API';\n"
    printf "SELECT 'RETIRE finance_state_rows_before=' || count(*)::text FROM provider_resource_finance_state;\n"
    printf 'ALTER TABLE %s DISABLE TRIGGER %s;\n' "$SEED_TRIGGER_TABLE" "$SEED_TRIGGER"
    printf 'DROP TRIGGER IF EXISTS %s ON %s;\n' "$SEED_TRIGGER" "$SEED_TRIGGER_TABLE"
    printf 'DROP FUNCTION IF EXISTS %s();\n' "$SEED_FUNCTION"
    printf "DELETE FROM provider_resource_finance_state s USING provider_resource r WHERE s.enterprise_id = r.enterprise_id AND s.provider_resource_id = r.id AND s.state = 'PENDING' AND r.mode = 'API';\n"
    printf 'COMMIT;\n'
    printf "SELECT 'RETIRE pending_api_after=' || count(*)::text FROM provider_resource_finance_state s JOIN provider_resource r ON r.enterprise_id = s.enterprise_id AND r.id = s.provider_resource_id WHERE s.state = 'PENDING' AND r.mode = 'API';\n"
    printf "SELECT 'RETIRE finance_state_rows_after=' || count(*)::text FROM provider_resource_finance_state;\n"
    printf "SELECT 'RETIRE seed_trigger_present=' || CASE WHEN EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = '%s' AND NOT tgisinternal) THEN '1' ELSE '0' END;\n" "$SEED_TRIGGER"
    printf "SELECT 'RETIRE seed_function_present=' || CASE WHEN to_regproc('%s') IS NULL THEN '0' ELSE '1' END;\n" "$SEED_FUNCTION"
  } > "$SQL" || die 7 "retire SQL 生成失败"
  if ! OUT="$(docker exec -i "$CONTAINER" sh -c 'db="$1"; shift; exec psql -X -Atq -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$db"' \
    sh "$DB_SHADOW" < "$SQL")"; then
    drop_shadow_or_die 7 "门槛退役失败（影子已删、事务已回滚，live 未动）" "$DB_SHADOW"
  fi
  {
    echo "threshold_retirement: $(date -u +%Y-%m-%dT%H:%M:%SZ) shadow=$DB_SHADOW"
    printf '%s\n' "$OUT" | grep '^RETIRE ' || true
    echo "basis: AFR-02 退役在回退后保持（0094 down 会恢复触发器/函数；本步骤为回退包对旧代码行为的有意覆盖，非默认放行）"
    echo "pending_rows_are: 资金门槛控制行（非资金事实），删除前计数已留档"
  } > "$LOG_PATH" || die 7 "退役日志写入失败: $LOG_PATH"
  case "$(printf '%s\n' "$OUT" | grep '^RETIRE seed_trigger_present=' | cut -d= -f2)" in
    0) ;;
    *) drop_shadow_or_die 7 "种入触发器退役校验失败" "$DB_SHADOW";;
  esac
  case "$(printf '%s\n' "$OUT" | grep '^RETIRE seed_function_present=' | cut -d= -f2)" in
    0) ;;
    *) drop_shadow_or_die 7 "种入函数退役校验失败" "$DB_SHADOW";;
  esac
  case "$(printf '%s\n' "$OUT" | grep '^RETIRE pending_api_after=' | cut -d= -f2)" in
    0) ;;
    *) drop_shadow_or_die 7 "API PENDING 控制行未清零" "$DB_SHADOW";;
  esac
  printf '%s\n' "$OUT" | grep '^RETIRE '
  echo "retire-threshold: OK shadow=$DB_SHADOW log=$LOG_PATH"
}

# ── verify（影子校验，全过才允许 swap）──────────────────────────────────
# CQ-R1-01（v1.5 正式审核 R1 整改）：校验主体提取为 verify_shadow_body，供
# cmd_verify 与 cmd_swap 共用同一实现（swap 在发出任何改名之前内联重跑全部
# 校验）。校验语义逐字保持：水位／白名单全表摘要（live∩ref 列交集）＝live／
# 资金事实全表摘要＝ref 快照（零补造）／种入触发器与函数已退役／API PENDING=0；
# 任一失败＝drop_shadow_or_die 8（删影子、live 未动、exit 非 0）。
verify_shadow_body() {
  REF_HEAD="$(manifest_field ref_migration_head)"
  TARGET_HEAD="$(migration_head "$DB_SHADOW")" || drop_shadow_or_die 8 "影子水位读取失败" "$DB_SHADOW"
  if [ "$TARGET_HEAD" != "$REF_HEAD" ]; then
    if [ "$REF_HEAD" = "$ROUTE_0091_HEAD" ] && [ "$TARGET_HEAD" = "$ROUTE_0092_HEAD" ]; then
      echo "verify: 水位=${ROUTE_0092_HEAD}（0091＋0092 重放）"
    else
      drop_shadow_or_die 8 "影子水位 $TARGET_HEAD 不符（既非备份点也非 0092 重放）" "$DB_SHADOW"
    fi
  else
    echo "verify: 水位=备份点 $REF_HEAD"
  fi
  # 白名单全表摘要（live∩ref 列交集；0092 专属表交集＝live 全列）。
  for T in $REPLAY_ORDER; do
    LIVE_COLS="$(table_columns "$DB_LIVE" "$T")" || drop_shadow_or_die 8 "live 列读取失败: $T" "$DB_SHADOW"
    [ -n "$LIVE_COLS" ] || drop_shadow_or_die 8 "live 缺白名单表: $T" "$DB_SHADOW"
    # 摘要列＝清单比对集（export 已含 0092 补回列、已剔 drift 列）。
    LINE="$(sed -n "s/^table$TAB$T$TAB//p" "$MANIFEST" | tail -1)"
    [ -n "$LINE" ] || drop_shadow_or_die 8 "清单缺表: $T" "$DB_SHADOW"
    MCMP="$(printf '%s\n' "$LINE" | awk -F'\t' '$6 ~ /^columns=/ { sub(/^columns=/, "", $6); print $6 }')"
    [ -n "$MCMP" ] || drop_shadow_or_die 8 "清单缺列信息: $T" "$DB_SHADOW"
    DL="$(copy_digest "$DB_LIVE" "$T" "$MCMP")"
    DS="$(copy_digest "$DB_SHADOW" "$T" "$MCMP")"
    if [ "$DL" != "$DS" ]; then
      drop_shadow_or_die 8 "白名单表摘要不符（live vs 影子，比对列=${MCMP}）: $T" "$DB_SHADOW"
    fi
    echo "verify: table=$T digest=match"
  done
  # 资金事实零补造：provider_finance_event 全表摘要＝ref（备份点）快照。
  DF_REF="$(copy_digest "$DB_REF" "provider_finance_event" "")"
  DF_SHADOW="$(copy_digest "$DB_SHADOW" "provider_finance_event" "")"
  [ "$DF_REF" = "$DF_SHADOW" ] || drop_shadow_or_die 8 "资金事实摘要不符（影子≠备份点快照——回放引入了资金行）" "$DB_SHADOW"
  echo "verify: provider_finance_event digest=match（零补造）"
  # 门槛退役保持（缺口④）：触发器/函数已退役＋API PENDING＝0。
  TRG="$(psql_in "$DB_SHADOW" -Atq -c "SELECT CASE WHEN EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='$SEED_TRIGGER' AND NOT tgisinternal) THEN '1' ELSE '0' END")"
  [ "$TRG" = "0" ] || drop_shadow_or_die 8 "种入触发器未退役" "$DB_SHADOW"
  FUN="$(psql_in "$DB_SHADOW" -Atq -c "SELECT CASE WHEN to_regproc('$SEED_FUNCTION') IS NULL THEN '0' ELSE '1' END")"
  [ "$FUN" = "0" ] || drop_shadow_or_die 8 "种入函数未退役" "$DB_SHADOW"
  PEND="$(psql_in "$DB_SHADOW" -Atq -c "SELECT count(*)::text FROM provider_resource_finance_state s JOIN provider_resource r ON r.enterprise_id = s.enterprise_id AND r.id = s.provider_resource_id WHERE s.state = 'PENDING' AND r.mode = 'API'")"
  [ "$PEND" = "0" ] || drop_shadow_or_die 8 "API PENDING 控制行未清零" "$DB_SHADOW"
  echo "verify: OK shadow=${DB_SHADOW}（head／17 表摘要／资金零补造／门槛退役 全部通过——live 未动，可 swap）"
}

cmd_verify() {
  need_tools
  guard_shadow_pipeline "verify"
  [ -n "$DB_REF" ] || die 2 "verify 缺少 --db-ref"
  [ -n "$MANIFEST" ] || die 2 "verify 缺少 --manifest"
  require_env
  verify_shadow_body
}

# ── swap（单事务改名；keep＝切换后状态留档）─────────────────────────────
# CQ-R1-01（v1.5 正式审核 R1 整改）：「verify 全过才 swap」从操作单要求落为
# 本入口的强制执行门。凭据只认本次内联重跑的 verify 全过；拒绝路径（全部在
# 任何 ALTER DATABASE RENAME 之前 exit 非 0）：
#   a) 缺验证必需参数 --db-ref/--manifest（或清单不存在/零字节）→ exit 2，
#      且先于 require_env——零容器调用；
#   b) 未确认（ROLLBACK_DELTA_CONFIRM≠YES）→ exit 9（既有停写/确认前提保持）；
#   c) 验证对象与待切换对象不符——清单 container/live_db/ref_db 与本次调用
#      逐字不一致 → exit 9（否则内联校验的不是将被切换的影子管线）；
#   d) 内联 verify 任一校验失败 → 沿用 verify 失败语义：删影子、exit 8，
#      此时零改名 SQL（负向断言留证见 r1-remediation/cq-r1-01/）。
cmd_swap() {
  need_tools
  guard_shadow_pipeline "swap"
  [ -n "$DB_REF" ] || die 2 "swap 缺少 --db-ref（切换前须以同一 ref/清单内联重验影子——verify 全过才 swap）"
  [ -n "$MANIFEST" ] || die 2 "swap 缺少 --manifest（切换前须以同一 ref/清单内联重验影子——verify 全过才 swap）"
  [ -s "$MANIFEST" ] || die 2 "swap 清单不存在或为零字节: $MANIFEST"
  require_env
  [ "${ROLLBACK_DELTA_CONFIRM:-}" = "YES" ] \
    || die 9 "危险动作：须环境 ROLLBACK_DELTA_CONFIRM=YES（单事务改名替换 live，DESTRUCTIVE 定级同 rollback.sh:5）"
  MF_CONTAINER="$(manifest_field container)"
  [ "$MF_CONTAINER" = "$CONTAINER" ] || die 9 "swap 清单 container 与本次调用不符（验证对象≠待切换对象）: 清单=$MF_CONTAINER 调用=$CONTAINER"
  MF_LIVE="$(manifest_field live_db)"
  [ "$MF_LIVE" = "$DB_LIVE" ] || die 9 "swap 清单 live_db 与 --db-live 不符（验证对象≠待切换对象）: 清单=$MF_LIVE 调用=$DB_LIVE"
  MF_REF="$(manifest_field ref_db)"
  [ "$MF_REF" = "$DB_REF" ] || die 9 "swap 清单 ref_db 与 --db-ref 不符（验证对象≠待切换对象）: 清单=$MF_REF 调用=$DB_REF"
  verify_shadow_body
  KEEP="${DB_KEEP:-${DB_LIVE}_pre_rollback_keep}"
  case "$KEEP" in postgres|template0|template1) die 9 "拒绝系统保留名 $KEEP";; esac
  [ "$(db_exists "$DB_LIVE")" = "t" ] || die 9 "live 库不存在: $DB_LIVE"
  [ "$(db_exists "$DB_SHADOW")" = "t" ] || drop_shadow_or_die 9 "影子库不存在（verify 是否已通过？）" "$DB_SHADOW"
  if [ "$(db_exists "$KEEP")" = "t" ]; then
    drop_shadow_or_die 9 "保留库名已存在（先人工处置旧 keep 库）: $KEEP" "$DB_SHADOW"
  fi
  SQL="$(mktemp "${TMPDIR:-/tmp}/wp6-r4-swap.XXXXXX")"
  {
    printf '\\set ON_ERROR_STOP on\n'
    printf 'BEGIN;\n'
    printf 'ALTER DATABASE "%s" RENAME TO "%s";\n' "$DB_LIVE" "$KEEP"
    printf 'ALTER DATABASE "%s" RENAME TO "%s";\n' "$DB_SHADOW" "$DB_LIVE"
    printf 'COMMIT;\n'
  } > "$SQL"
  if ! docker exec -i "$CONTAINER" sh -c 'exec psql -X -q -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d postgres' \
    < "$SQL"; then
    drop_shadow_or_die 9 "swap 失败（事务已回滚，live/影子名称未变；影子已删）" "$DB_SHADOW"
  fi
  rm -f "$SQL"
  echo "swap: OK live=$DB_SHADOW 影子内容已替换为 live；keep=${KEEP}（切换后状态留档——回退验证完成后由运维清理，期间不得写入）"
}

# ── check-contract ──────────────────────────────────────────────────────
cmd_check_contract() {
  echo "== 静态契约 =="
  echo "whitelist+replay_order: $REPLAY_ORDER"
  echo "only_0092_tables(ref 必无): $ONLY_0092_TABLES"
  echo "external_parents(先于备份点): $EXTERNAL_PARENTS"
  echo "seed_trigger(retire in shadow): $SEED_TRIGGER + $SEED_FUNCTION"
  echo "conflict_clause: ON CONFLICT (id) DO UPDATE SET <列交集全列>（二次执行幂等）"
  echo "delta_semantics: 全行比对（PK 全连接，任一列变更或新增行均入增量；清单含 inserted/updated）"
  echo "shadow_pipeline: restore/replay/retire/verify 只写影子；全过才 swap；任一步失败＝删影子、live 未动"
  echo "swap_policy: 单事务 ALTER DATABASE live→keep、影子→live；keep＝切换后状态留档（回退验证完成后由运维清理，期间不得写入）"
  echo "swap_verify_gate: swap 必须带 --db-ref/--manifest 并在改名前内联重跑 verify 全部校验（同一组 live/shadow/ref/清单）；缺参数/对象不符/校验失败＝改名前 exit 非 0（CQ-R1-01）"
  echo "fail_closed: export/校验失败 exit 非 0，live 零写入；无 manifest_done 拒绝 replay"
  echo "finance_redline: provider_finance_event 不在白名单（增量面恒空）＋verify 以 ref 全表摘要证明零补造"
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
    --db-shadow) DB_SHADOW="${2:-}"; shift 2;;
    --db-target) DB_SHADOW="${2:-}"; shift 2;;
    --keep-name) DB_KEEP="${2:-}"; shift 2;;
    --dump-file) DUMP_FILE="${2:-}"; shift 2;;
    --out-dir|--delta-dir) OUT_DIR="${2:-}"; shift 2;;
    --manifest) MANIFEST="${2:-}"; shift 2;;
    --log) LOG_PATH="${2:-}"; shift 2;;
    *) usage; die 2 "未知参数: $1";;
  esac
done

WORK="$(mktemp -d "${TMPDIR:-/tmp}/wp6-r4.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

case "$CMD" in
  export) cmd_export;;
  restore) cmd_restore;;
  replay) cmd_replay;;
  retire-threshold) cmd_retire_threshold;;
  verify) cmd_verify;;
  swap) cmd_swap;;
  check-contract) cmd_check_contract;;
  *) usage; die 2 "缺少或未知子命令: ${CMD:-（空）}";;
esac
