#!/usr/bin/env bash
# CQ-01 docker 命令桩——不连真实 Docker/任何数据库。
# 记录每次调用的完整 argv 与 stdin（exec -i），按场景返回罐头输出。
# 环境变量：
#   STUB_CAPTURE_DIR   必填，捕获目录（每次调用写 NNNN.argv / NNNN.stdin / NNNN.meta）
#   STUB_MIG_HEAD      kysely_migration 水位查询返回值（默认 0091_recorded_cost_accounting_policy）
#   STUB_EXISTING_DBS  db_exists 探测返回 t 的库名（空格分隔，默认空＝全部返回 f）
#   STUB_FAIL_GATE     =1 时 pg_restore --list 门返回 1
#   STUB_FAIL_RESTORE  =1 时 pg_restore 恢复调用返回 1
set -u
CAPTURE_DIR="${STUB_CAPTURE_DIR:?STUB_CAPTURE_DIR required}"
mkdir -p "$CAPTURE_DIR"

# ── 记录 ────────────────────────────────────────────────────────────────
SEQ_FILE="$CAPTURE_DIR/.seq"
SEQ=$(( $(cat "$SEQ_FILE" 2>/dev/null || echo 0) + 1 ))
printf '%s' "$SEQ" > "$SEQ_FILE"
ID="$(printf '%04d' "$SEQ")"
ARGV_FILE="$CAPTURE_DIR/$ID.argv"
: > "$ARGV_FILE"
for arg in "$@"; do printf '%s\n' "$arg" >> "$ARGV_FILE"; done

# 判断是否消费 stdin（-i 在 argv 前部）
CONSUME_STDIN=0
prev=""
for arg in "$@"; do
  [ "$prev" = "-i" ] && CONSUME_STDIN=1
  prev="$arg"
done
STDIN_FILE="$CAPTURE_DIR/$ID.stdin"
if [ "$CONSUME_STDIN" = "1" ] && [ ! -t 0 ]; then
  cat > "$STDIN_FILE"
else
  : > "$STDIN_FILE"
fi

# ── 分类（在全部 argv 拼接串上匹配；SQL 可能位于 sh -c 后续参数或 stdin）──
JOIN="$(printf '%s ' "$@")"
STDIN_TEXT=""
[ -s "$STDIN_FILE" ] && STDIN_TEXT="$(cat "$STDIN_FILE")"
ALL="$JOIN $STDIN_TEXT"

# 容器名＝exec/cp 后第一个非常见旗标参数（供记录；逻辑判定不依赖它）
SUBCMD="$1"

exit_with() { # $1=code $2=stdout
  if [ -n "$2" ]; then printf '%s\n' "$2"; fi
  printf 'exit=%s\n' "$1" > "$CAPTURE_DIR/$ID.meta"
  exit "$1"
}

# docker cp → 恒成功（记录即可）
if [ "$SUBCMD" = "cp" ]; then exit_with 0 ""; fi
if [ "$SUBCMD" != "exec" ]; then exit_with 0 ""; fi

# pg_restore --list 完整性门
case "$ALL" in *"pg_restore --list"*)
  [ "${STUB_FAIL_GATE:-0}" = "1" ] && exit_with 1 ""
  exit_with 0 "";;
esac
# require_env true
case "$ALL" in *"sh -c true"*) exit_with 0 "";; esac

# dropdb / createdb（破坏标记，记录即成功）
case "$ALL" in *"dropdb "*)
  [ "${STUB_FAIL_DROP:-0}" = "1" ] && exit_with 1 ""
  exit_with 0 "";;
esac
case "$ALL" in *"createdb "*)
  [ "${STUB_FAIL_CREATE:-0}" = "1" ] && exit_with 1 ""
  exit_with 0 "";;
esac
# pg_restore 实际恢复
case "$ALL" in *"pg_restore --no-owner"*)
  [ "${STUB_FAIL_RESTORE:-0}" = "1" ] && exit_with 1 ""
  exit_with 0 "";;
esac

# 容器内 rm -rf / mkdir（回放暂存目录准备）
case "$ALL" in *"rm -rf"*|*"mkdir -p"*) exit_with 0 "";; esac

# psql 查询类：按 SQL 语义返回罐头输出
case "$ALL" in
  *"RETIRE"*)
    # retire-threshold 主调用：成功输出（触发器/函数退役、PENDING 清零）
    printf 'RETIRE pending_api_before=1\n'
    printf 'RETIRE finance_state_rows_before=2\n'
    printf 'RETIRE pending_api_after=0\n'
    printf 'RETIRE finance_state_rows_after=1\n'
    printf 'RETIRE seed_trigger_present=0\n'
    printf 'RETIRE seed_function_present=0\n'
    printf 'exit=0\n' > "$CAPTURE_DIR/$ID.meta"
    exit 0;;
esac
case "$ALL" in
  *"kysely_migration"*) exit_with 0 "${STUB_MIG_HEAD:-0091_recorded_cost_accounting_policy}";;
esac
case "$ALL" in
  *"pg_database"*)
    DBNAME=""
    # db_exists 调用形如: sh -c <script> sh <db> → -c 后第 2 个 sh 的下一段
    found_c=0; idx=0; args=("$@")
    for ((i=0; i<${#args[@]}; i++)); do
      [ "${args[$i]}" = "-c" ] && { found_c=1; cidx=$i; }
    done
    if [ "$found_c" = "1" ] && [ "${args[$((cidx+2))]:-}" = "sh" ]; then
      DBNAME="${args[$((cidx+3))]:-}"
    fi
    MATCH=f
    for existing in ${STUB_EXISTING_DBS:-}; do
      [ "$existing" = "$DBNAME" ] && MATCH=t
    done
    exit_with 0 "$MATCH";;
esac
case "$ALL" in
  *"string_agg(column_name"*) exit_with 0 "${STUB_TABLE_COLUMNS:-id}";;
esac
case "$ALL" in
  *"to_regclass"*) exit_with 0 "f";;
esac
case "$ALL" in
  *"pg_trigger"*) exit_with 0 "0";;
esac
case "$ALL" in
  *"to_regproc"*) exit_with 0 "0";;
esac
case "$ALL" in
  *"provider_resource_finance_state"*) exit_with 0 "0";;
esac
# \copy 导出/摘要 → 空（两侧摘要同为空串 → 相等）
case "$ALL" in
  *"TO STDOUT"*|*"\\copy"*) exit_with 0 "";;
esac
# 其余 psql（含 swap 的 -d postgres 改名执行、replay 的影子写入执行）→ 成功无输出
exit_with 0 ""
