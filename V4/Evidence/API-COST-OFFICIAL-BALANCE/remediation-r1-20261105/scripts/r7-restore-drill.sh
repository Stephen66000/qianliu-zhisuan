#!/usr/bin/env bash
# R7（F7）整库备份恢复实际演练 —— 隔离库全脚本化演练（验收意见 6）。
#
# 演练目标：整库备份主路线在隔离库实际恢复并核对迁移头与受保护数据摘要。
#   1) 隔离 Postgres 容器 wp6-r7-restore（端口 55436；镜像 digest 与先例
#      packages/testing/src/postgres-container.ts 一致；结束保留待复核）。
#   2) 候选代码 migrateToLatest（水位 0096）＋ seedDrill 同型造数
#      （无期初 API 资源＋存量 PENDING 资源＋一笔已结算消费 0.00104000
#      ＋员工月度额度行；行集与摘要口径同 wp6-rollback-drill）。
#   3) 备份点摘要：八组受保护行集 sha256＋迁移头（应 0096）
#      ＋kysely_migration 全表规范化 JSON 摘要。
#   4) 两种制品各备份一次：a) pg_dump -Fc（先例 release-wecom-report-delivery
#      同构）；b) pg_dump -Fp | gzip（rollback.sh 消费的 .sql.gz 同构）。均非空校验。
#   5) 破坏性模拟：写入备份后新增数据（一个新 provider_resource＋一笔新
#      ai_request）——验证恢复后确实消失（回到备份点）。
#   6) 恢复路线 A（rollback.sh 模式，.sql.gz）：dropdb --force＋createdb →
#      gunzip | psql → 核对迁移头/摘要/新增数据消失/无 down 需要。
#   7) 恢复路线 B（-Fc）：dropdb --force＋createdb → pg_restore → 同款核对。
#   8) 结束状态：容器保留（0096 恢复态）；制品与 JSON 移入证据目录 backups/。
#
# 范围与安全：
#   - 只操作本脚本自建的演练容器/演练库；不触碰真实生产/主仓/docker exec
#     生产容器；不改代码/测试/迁移。
#   - dropdb/createdb 均发生在演练隔离容器内（演练必需动作）。
#
# 运行（本 worktree 根）：
#   bash V4/Evidence/API-COST-OFFICIAL-BALANCE/remediation-r1-20261105/scripts/r7-restore-drill.sh \
#     2>&1 | tee V4/Evidence/API-COST-OFFICIAL-BALANCE/remediation-r1-20261105/logs/28-r7-restore-drill.log
set -euo pipefail

WORKTREE="/Users/mac/Projects/仟流智算-api-decouple"
EV="$WORKTREE/V4/Evidence/API-COST-OFFICIAL-BALANCE/remediation-r1-20261105"
PHASE="$EV/scripts/r7-restore-drill-phase.ts"
TSX="$WORKTREE/node_modules/.bin/tsx"

CONTAINER="wp6-r7-restore"
PORT=55436
DB="wp6_r7_drill"
PGUSER="wp6_r7"
PGPASSWORD="wp6_r7_drill_only"
# 先例 digest（packages/testing/src/postgres-container.ts 锁定的 postgres:17-alpine）。
IMAGE="postgres:17-alpine@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193"
CONN="postgres://${PGUSER}:${PGPASSWORD}@127.0.0.1:${PORT}/${DB}"
HEAD_0096="0096_official_balance_refresh_request"

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/r7-restore-drill.XXXXXX")"
trap 'echo "[R7] work dir kept: $WORK_DIR" >&2' EXIT

FIXTURE="$WORK_DIR/fixture.json"
BASELINE="$WORK_DIR/baseline.json"
MUTATION="$WORK_DIR/mutation.json"
ROUTEA="$WORK_DIR/routeA-verify.json"
ROUTEB="$WORK_DIR/routeB-verify.json"
DUMP_FC="$WORK_DIR/r7-drill-fc.dump"
DUMP_GZ="$WORK_DIR/r7-drill-full.sql.gz"
EMPTY_DIGEST="$(printf '[]' | shasum -a 256 | cut -d' ' -f1)"  # sha256(canonicalJson([]))

step() { echo "[R7 $(date '+%H:%M:%S')] === $* ==="; }
note() { echo "[R7 $(date '+%H:%M:%S')] $*"; }

# 逐步骤命令＋退出码留证：成功路径打印 exit=0；失败由 set -e 中止（非零）。
run() {
  echo "+ $*"
  "$@"
  local rc=$?
  echo "  exit=$rc"
  return "$rc"
}

pexec() { docker exec -i "$CONTAINER" sh -ceu "$1"; }

docker_ready() {
  docker info >/dev/null 2>&1
}

# ───────────────────────── Step 0：前置检查 ─────────────────────────
step "Step 0 前置检查"
run docker_ready
note "docker daemon OK（context=$(docker context show)）"
if docker ps -a --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  note "发现同名演练容器残留，仅清理演练容器 $CONTAINER"
  run docker rm -f "$CONTAINER"
fi

# ─────────────────────── Step 1：起隔离容器 ───────────────────────
step "Step 1 起隔离 Postgres 容器 ${CONTAINER}（端口 ${PORT}，digest 与先例一致）"
run docker run -d --name "$CONTAINER" \
  -e POSTGRES_DB="$DB" -e POSTGRES_USER="$PGUSER" -e POSTGRES_PASSWORD="$PGPASSWORD" \
  -p "127.0.0.1:${PORT}:5432" "$IMAGE"
READY=0
for i in $(seq 1 30); do
  if pexec 'pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"' >/dev/null 2>&1; then
    READY=1; break
  fi
  sleep 2
done
if [ "$READY" -ne 1 ]; then
  echo "ERROR: PostgreSQL 未在等待窗口内就绪" >&2
  exit 2
fi
note "演练库就绪（db=$DB user=$PGUSER port=${PORT}）"
pexec 'psql -At -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "select version()"'

# ─────────────── Step 2：候选代码 migrateToLatest＋造数 ───────────────
step "Step 2 候选代码 migrateToLatest（0096）＋seedDrill 同型造数"
echo "+ DATABASE_URL=$CONN $TSX $PHASE prepare"
DATABASE_URL="$CONN" "$TSX" "$PHASE" prepare | tee "$WORK_DIR/prepare.out"
echo "  exit=0 (pipeline)"
jq -e --arg h "$HEAD_0096" '.executedMigrations | index($h) != null' "$WORK_DIR/prepare.out" >/dev/null
jq -e --arg h "$HEAD_0096" '.migrationHeads.byTimestamp == $h' "$WORK_DIR/prepare.out" >/dev/null
mv "$WORK_DIR/prepare.out" "$FIXTURE"
note "迁移链含 0096 且水位=0096；fixture 已记录（enterprise=$(jq -r .fixture.enterpriseId "$FIXTURE")）"

# ───────────────────── Step 3：备份点摘要 ─────────────────────
step "Step 3 备份点摘要（八组受保护行集 sha256＋迁移头＋kysely_migration 摘要）"
echo "+ DATABASE_URL=$CONN $TSX $PHASE digest $FIXTURE"
DATABASE_URL="$CONN" "$TSX" "$PHASE" digest "$FIXTURE" | tee "$WORK_DIR/digest.out"
echo "  exit=0 (pipeline)"
sed -n '/^{/,$p' "$WORK_DIR/digest.out" > "$BASELINE"
# 夹具自证：迁移头＝0096；八行集无空集摘要混入。
jq -e --arg h "$HEAD_0096" '.migrationHeads.byTimestamp == $h and .migrationHeads.byName == $h' "$BASELINE" >/dev/null
EMPTY_IN_SETS="$(jq -r --arg e "$EMPTY_DIGEST" '.protectedDigests | to_entries | map(select(.value == $e)) | length' "$BASELINE")"
if [ "$EMPTY_IN_SETS" != "0" ]; then
  echo "ERROR: 备份点存在空集摘要（count=${EMPTY_IN_SETS}）" >&2
  exit 3
fi
note "备份点八行集全部非空；迁移头双口径均=$HEAD_0096"

# ───────────────── Step 4：两种制品各备份一次 ─────────────────
step "Step 4a 备份制品 A：pg_dump -Fc（先例同构）"
echo "+ docker exec $CONTAINER pg_dump -Fc -U $PGUSER -d $DB > $DUMP_FC"
docker exec -i "$CONTAINER" sh -ceu 'pg_dump -Fc -U "$POSTGRES_USER" -d "$POSTGRES_DB"' > "$DUMP_FC"
echo "  exit=0"
[ -s "$DUMP_FC" ] || { echo "ERROR: -Fc 备份为空" >&2; exit 4; }
echo "+ docker cp $DUMP_FC → $CONTAINER:/tmp/（容器内 pg_restore --list 结构校验）"
docker cp "$DUMP_FC" "$CONTAINER:/tmp/r7-drill-fc.dump"
pexec 'pg_restore --list /tmp/r7-drill-fc.dump >/dev/null && echo "pg_restore --list OK"'
note "制品 A 大小: $(wc -c < "$DUMP_FC") bytes"

step "Step 4b 备份制品 B：pg_dump -Fp | gzip（rollback.sh 消费的 .sql.gz 同构）"
echo "+ docker exec $CONTAINER pg_dump -Fp -U $PGUSER -d $DB | gzip > $DUMP_GZ"
docker exec -i "$CONTAINER" sh -ceu 'pg_dump -Fp -U "$POSTGRES_USER" -d "$POSTGRES_DB"' | gzip > "$DUMP_GZ"
echo "  exit=0 (pipeline, pipefail)"
[ -s "$DUMP_GZ" ] || { echo "ERROR: .sql.gz 备份为空" >&2; exit 4; }
run gzip -t "$DUMP_GZ"
note "制品 B 大小: $(wc -c < "$DUMP_GZ") bytes；gzip -t 通过"

# ───────────────────── Step 5：破坏性模拟 ─────────────────────
step "Step 5 破坏性模拟：写入备份后新增数据（备份点之外）"
echo "+ DATABASE_URL=$CONN $TSX $PHASE mutate $FIXTURE"
DATABASE_URL="$CONN" "$TSX" "$PHASE" mutate "$FIXTURE" | tee "$WORK_DIR/mutate.out"
echo "  exit=0 (pipeline)"
sed -n '/^{/,$p' "$WORK_DIR/mutate.out" > "$MUTATION"
MUT_RES="$(jq -r .providerResourceId "$MUTATION")"
MUT_REQ="$(jq -r .requestId "$MUTATION")"
RES_COUNT="$(pexec "psql -At -U \"$PGUSER\" -d \"$DB\" -c \"select count(*) from provider_resource where id='$MUT_RES'\"")"
REQ_COUNT="$(pexec "psql -At -U \"$PGUSER\" -d \"$DB\" -c \"select count(*) from ai_request where id='$MUT_REQ'\"")"
[ "$RES_COUNT" = "1" ] && [ "$REQ_COUNT" = "1" ] || { echo "ERROR: 破坏性数据未确认在库" >&2; exit 5; }
note "备份后新增数据已确认在库：provider_resource id=${MUT_RES}（count=1）、ai_request id=${MUT_REQ}（count=1）"

# ─────────── Step 6：恢复路线 A（rollback.sh 模式，.sql.gz） ───────────
step "Step 6 恢复路线 A（rollback.sh 模式）：dropdb --force＋createdb → gunzip | psql"
echo "+ pexec 'dropdb --if-exists --force ...; createdb ...'（演练隔离容器内）"
pexec 'case "$POSTGRES_DB" in postgres|template0|template1) echo "拒绝恢复到系统数据库" >&2; exit 1;; esac
  dropdb --if-exists --force -U "$POSTGRES_USER" "$POSTGRES_DB"
  createdb -U "$POSTGRES_USER" -O "$POSTGRES_USER" "$POSTGRES_DB"'
echo "  exit=0"
echo "+ gunzip -c $DUMP_GZ | docker exec -i $CONTAINER psql -v ON_ERROR_STOP=1 ..."
gunzip -c "$DUMP_GZ" | docker exec -i "$CONTAINER" sh -ceu 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' > "$WORK_DIR/routeA-psql.out" 2>&1
echo "  exit=0 (pipeline, pipefail)；psql 输出行数: $(wc -l < "$WORK_DIR/routeA-psql.out")"
echo "+ DATABASE_URL=$CONN $TSX $PHASE verify $FIXTURE $BASELINE $MUTATION"
ROUTE_A_RC=0
DATABASE_URL="$CONN" "$TSX" "$PHASE" verify "$FIXTURE" "$BASELINE" "$MUTATION" > "$WORK_DIR/routeA-verify.out" 2>&1 || ROUTE_A_RC=$?
cat "$WORK_DIR/routeA-verify.out"
echo "  verify exit=$ROUTE_A_RC"
grep -q "allPass=true" "$WORK_DIR/routeA-verify.out" || ROUTE_A_RC=1
sed -n '/^{/,$p' "$WORK_DIR/routeA-verify.out" > "$ROUTEA"

# ─────────── Step 7：恢复路线 B（pg_dump -Fc → pg_restore） ───────────
step "Step 7 恢复路线 B（-Fc）：重复破坏（dropdb --force＋createdb）→ pg_restore"
echo "+ pexec 'dropdb --if-exists --force ...; createdb ...'（再次破坏到空库）"
pexec 'case "$POSTGRES_DB" in postgres|template0|template1) echo "拒绝恢复到系统数据库" >&2; exit 1;; esac
  dropdb --if-exists --force -U "$POSTGRES_USER" "$POSTGRES_DB"
  createdb -U "$POSTGRES_USER" -O "$POSTGRES_USER" "$POSTGRES_DB"'
echo "  exit=0"
echo "+ docker exec $CONTAINER pg_restore --exit-on-error -U $PGUSER -d $DB /tmp/r7-drill-fc.dump"
pexec 'pg_restore --exit-on-error -U "$POSTGRES_USER" -d "$POSTGRES_DB" /tmp/r7-drill-fc.dump > /dev/null && echo "pg_restore OK"'
echo "+ DATABASE_URL=$CONN $TSX $PHASE verify $FIXTURE $BASELINE $MUTATION"
ROUTE_B_RC=0
DATABASE_URL="$CONN" "$TSX" "$PHASE" verify "$FIXTURE" "$BASELINE" "$MUTATION" > "$WORK_DIR/routeB-verify.out" 2>&1 || ROUTE_B_RC=$?
cat "$WORK_DIR/routeB-verify.out"
echo "  verify exit=$ROUTE_B_RC"
grep -q "allPass=true" "$WORK_DIR/routeB-verify.out" || ROUTE_B_RC=1
sed -n '/^{/,$p' "$WORK_DIR/routeB-verify.out" > "$ROUTEB"

# ─────────────── Step 8：制品移入证据目录＋结束状态 ───────────────
step "Step 8 制品移入证据目录＋容器保留（0096 恢复态）"
BACKUP_OUT="$EV/backups"
mkdir -p "$BACKUP_OUT"
cp "$FIXTURE" "$BACKUP_OUT/r7-fixture.json"
cp "$BASELINE" "$BACKUP_OUT/r7-baseline-digest.json"
cp "$MUTATION" "$BACKUP_OUT/r7-mutation.json"
cp "$ROUTEA" "$BACKUP_OUT/r7-routeA-verify.json"
cp "$ROUTEB" "$BACKUP_OUT/r7-routeB-verify.json"
cp "$DUMP_FC" "$BACKUP_OUT/r7-drill-fc.dump"
cp "$DUMP_GZ" "$BACKUP_OUT/r7-drill-full.sql.gz"
note "制品与 JSON 已复制到 $BACKUP_OUT"

FINAL_HEAD="$(pexec "psql -At -U \"$PGUSER\" -d \"$DB\" -c \"select name from kysely_migration order by timestamp desc limit 1\"")"
SHA_FC="$(shasum -a 256 "$BACKUP_OUT/r7-drill-fc.dump" | cut -d' ' -f1)"
SHA_GZ="$(shasum -a 256 "$BACKUP_OUT/r7-drill-full.sql.gz" | cut -d' ' -f1)"

jq -n \
  --arg drill "R7 整库备份恢复实际演练（F7，验收意见 6）" \
  --arg date "$(date '+%Y-%m-%dT%H:%M:%S%z')" \
  --arg container "$CONTAINER" --argjson port "$PORT" \
  --arg db "$DB" --arg image "$IMAGE" \
  --arg head0096 "$HEAD_0096" \
  --arg finalHead "$FINAL_HEAD" \
  --arg routeAResult "$( [ "$ROUTE_A_RC" -eq 0 ] && echo PASS || echo FAIL )" \
  --arg routeBResult "$( [ "$ROUTE_B_RC" -eq 0 ] && echo PASS || echo FAIL )" \
  --argjson routeAChecks "$(jq '.checks' "$ROUTEA")" \
  --argjson routeBChecks "$(jq '.checks' "$ROUTEB")" \
  --arg baseline "$BASELINE" --arg mutation "$MUTATION" \
  --arg mutRes "$MUT_RES" --arg mutReq "$MUT_REQ" \
  --arg artifactFc "$BACKUP_OUT/r7-drill-fc.dump" \
  --arg artifactGz "$BACKUP_OUT/r7-drill-full.sql.gz" \
  --arg shaFc "$SHA_FC" --arg shaGz "$SHA_GZ" \
  --argjson sizeFc "$(wc -c < "$BACKUP_OUT/r7-drill-fc.dump")" \
  --argjson sizeGz "$(wc -c < "$BACKUP_OUT/r7-drill-full.sql.gz")" \
  '{
    drill: $drill, date: $date,
    isolation: { container: $container, port: $port, database: $db, image: $image, retained: true },
    routeA_rollback_sh_sql_gz: {
      restore: "dropdb --force + createdb; gunzip | psql -v ON_ERROR_STOP=1",
      result: $routeAResult, checks: $routeAChecks
    },
    routeB_pg_dump_fc: {
      restore: "dropdb --force + createdb; pg_restore --exit-on-error",
      result: $routeBResult, checks: $routeBChecks
    },
    destructiveMutation: {
      providerResourceId: $mutRes, aiRequestId: $mutReq,
      absentAfterRouteA: (($routeAChecks + $routeBChecks) | map(select(.check | test("post_backup_.*_absent"))) | all(.pass)),
      baseline: $baseline, mutation: $mutation
    },
    artifacts: {
      fc: { path: $artifactFc, bytes: $sizeFc, sha256: $shaFc },
      sqlGz: { path: $artifactGz, bytes: $sizeGz, sha256: $shaGz }
    },
    finalState: { migrationHead: $finalHead, expectedHead: $head0096 }
  }' > "$EV/logs/28-r7-restore-drill-result.json"
note "结构化结果: $EV/logs/28-r7-restore-drill-result.json"

note "结束状态：容器 $CONTAINER 保留（docker ps 如下）"
run docker ps --filter "name=$CONTAINER" --format '{{.Names}} {{.Image}} {{.Status}} {{.Ports}}'
note "最终迁移头（容器内 rollback.sh 口径）: $FINAL_HEAD"
note "work dir 保留于: $WORK_DIR"

if [ "$ROUTE_A_RC" -ne 0 ] || [ "$ROUTE_B_RC" -ne 0 ]; then
  echo "[R7] RESULT=FAIL routeA=$ROUTE_A_RC routeB=$ROUTE_B_RC" >&2
  exit 6
fi
echo "[R7] RESULT=PASS"
