#!/bin/bash
# WP08 7.1 迁移兼容性 + 备份可恢复性演练（仅本地一次性容器；不接触任何生产库）
set -u
REPO=/Users/mac/Projects/仟流智算-provider-finance-init-20260921
cd "$REPO" || exit 1
export COREPACK_ENABLE_STRICT=0
export QIANLIU_ENV_FILE=/tmp/wp08/local.env
export CANDIDATE_TAG=c9bc9b93deb2
COMPOSE="docker compose -f deploy/compose.yaml -f /tmp/wp08/compose.wp08-local.yaml"

psql_() { $COMPOSE exec -T postgres psql -U qianliu -d qianliu -v ON_ERROR_STOP=1 -At -c "$1"; }
psqlf() { $COMPOSE exec -T postgres psql -U qianliu -d qianliu -v ON_ERROR_STOP=1 "$@"; }
mig()   { $COMPOSE run --rm -T migrate node --import tsx packages/database/src/cli/migrate.ts "$1" 2>&1; }

echo "# WP08 7.1 迁移兼容性与备份可恢复性演练"
echo "# 开始(UTC): $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "# 数据库: 一次性本地容器 qianliu-zhisuan-postgres-1（postgres:17-alpine@sha256:742f40ea…）"
echo "# 迁移代码来源: 候选 control-api 镜像（qianliu-candidate/control-api:c9bc9b93deb2）"
echo "# 生产数据库: 未连接、未备份、未迁移（本演练全程仅 127.0.0.1:5433 的本地容器）"
echo

echo "=============== 0. 初始状态（空库；先重建以确保可重复） ==============="
$COMPOSE exec -T postgres psql -U qianliu -d postgres -v ON_ERROR_STOP=1 -At \
  -c "DROP DATABASE IF EXISTS qianliu;" -c "CREATE DATABASE qianliu OWNER qianliu;" >/dev/null 2>&1
echo "  qianliu 库已重建（仅本地容器）"
psql_ "SELECT version();" | head -1
psql_ "SELECT count(*) FROM information_schema.tables WHERE table_schema='public';" | sed 's/^/  初始 public 表数: /'
echo

echo "=============== 1. migrate up：全量应用到最新 ==============="
mig up | tail -8
echo "-- 迁移台账（kysely_migration，按名称排序，末 6 条）"
psql_ "SELECT name FROM kysely_migration ORDER BY name DESC LIMIT 6;" | sed 's/^/  /'
echo "-- 已应用迁移总数: $(psql_ "SELECT count(*) FROM kysely_migration;" | tr -d ' ')"
echo "-- 0078/0079 关键对象是否存在"
psql_ "SELECT to_regclass('public.provider_finance_activation_attempt') IS NOT NULL AS attempt,
               to_regclass('public.provider_finance_activation_quiescence') IS NOT NULL AS quiescence,
               to_regclass('public.provider_resource_finance_state') IS NOT NULL AS finance_state,
               EXISTS(SELECT 1 FROM information_schema.columns WHERE table_name='provider_finance_activation_attempt' AND column_name='candidate_draft') AS has_candidate_draft;"
echo

echo "=============== 2. 回退两步 → 精确停在 0077 ==============="
mig down | tail -3
mig down | tail -3
echo "-- 迁移台账末 4 条（应为 …0076/0077）"
psql_ "SELECT name FROM kysely_migration ORDER BY name DESC LIMIT 4;" | sed 's/^/  /'
echo "-- 0078/0079 对象是否已移除（应全为 f / 空）"
psql_ "SELECT to_regclass('public.provider_finance_activation_attempt') AS attempt,
               to_regclass('public.provider_finance_activation_quiescence') AS quiescence,
               to_regclass('public.provider_resource_finance_state') AS finance_state;"
echo

echo "=============== 3. 在 0077 上播种「既有事实」（迁移前就存在的数据） ==============="
psqlf <<'SQL'
BEGIN;
INSERT INTO enterprise (id, name) VALUES ('11111111-1111-4111-8111-111111111111', 'WP08-SYNTHETIC 既有企业');
INSERT INTO admin_user (id, enterprise_id, username, password_hash, status)
  VALUES ('22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111',
          'wp08-synthetic-admin', 'not-a-real-hash', 'ACTIVE');
-- 该企业上线前即存在的资金运行时状态行：严格写关闭、未激活（既有口径不得被迁移改写）
INSERT INTO provider_finance_runtime_state (enterprise_id, strict_writes_enabled, activated_at)
  VALUES ('11111111-1111-4111-8111-111111111111', false, NULL);
INSERT INTO provider (id, enterprise_id, code, name, adapter_type)
  VALUES ('33333333-3333-4333-8333-333333333333', '11111111-1111-4111-8111-111111111111',
          'zhipu', 'WP08-SYNTHETIC 智谱', 'OPENAI_COMPATIBLE');
INSERT INTO provider_resource (id, enterprise_id, provider_id, name, mode, credential_type)
  VALUES ('44444444-4444-4444-8444-444444444444', '11111111-1111-4111-8111-111111111111',
          '33333333-3333-4333-8333-333333333333', 'WP08-SYNTHETIC 套餐', 'CODING_PLAN', 'SUBSCRIPTION_SESSION');
-- 迁移前既有的旧购买记录（切换时点后、尚无资金事件）
INSERT INTO resource_purchase_record
  (enterprise_id, provider_resource_id, purchase_type, amount, currency, purchased_at,
   service_period_start, service_period_end, source, created_by, description, evidence_ref)
  VALUES ('11111111-1111-4111-8111-111111111111', '44444444-4444-4444-8444-444444444444',
          'PACKAGE_PURCHASE', 199.00, 'CNY', '2026-09-10T02:00:00Z',
          '2026-09-01', '2026-09-30', 'ADMIN',
          '22222222-2222-4222-8222-222222222222', 'WP08 合成既有套餐', 'synthetic://wp08-legacy');
COMMIT;
SQL
echo "-- 既有事实基线（迁移前快照）"
psql_ "SELECT 'strict_writes_enabled=' || strict_writes_enabled::text FROM provider_finance_runtime_state
        WHERE enterprise_id='11111111-1111-4111-8111-111111111111';" | sed 's/^/  /'
psql_ "SELECT 'legacy_purchase_records=' || count(*)::text FROM resource_purchase_record
        WHERE enterprise_id='11111111-1111-4111-8111-111111111111';" | sed 's/^/  /'
echo

echo "=============== 4. 前进 0077 → 0078 → 0079 ==============="
mig up | tail -8
echo "-- 迁移台账末 4 条（应含 0078、0079）"
psql_ "SELECT name FROM kysely_migration ORDER BY name DESC LIMIT 4;" | sed 's/^/  /'
echo

echo "=============== 5. 关键断言：迁移不自动激活、既有事实不被篡改 ==============="
echo "-- (a) 既有企业 strict_writes_enabled 仍为 false（未被迁移改写）"
psql_ "SELECT 'strict_writes_enabled=' || strict_writes_enabled::text
        FROM provider_finance_runtime_state WHERE enterprise_id='11111111-1111-4111-8111-111111111111';" | sed 's/^/  /'
echo "-- (b) 迁移未产生任何资金事件 / 候选 / 静默租约（应全为 0）"
psql_ "SELECT 'provider_finance_event=' || count(*)::text FROM provider_finance_event;"
psql_ "SELECT 'activation_attempt=' || count(*)::text FROM provider_finance_activation_attempt;"
psql_ "SELECT 'activation_quiescence=' || count(*)::text FROM provider_finance_activation_quiescence;"
psql_ "SELECT 'resource_finance_state=' || count(*)::text FROM provider_resource_finance_state;"
echo "-- (c) 既有旧购买记录未被迁移删除或改写（逐列内容指纹 + 关闭审计计数）"
psql_ "SELECT 'legacy_rows=' || count(*)::text FROM resource_purchase_record
        WHERE enterprise_id='11111111-1111-4111-8111-111111111111';" | sed 's/^/  /'
psql_ "SELECT 'content_fingerprint=' || md5(string_agg(
          purchase_type||'|'||amount::text||'|'||currency||'|'||purchased_at::text||'|'||
          service_period_start::text||'|'||service_period_end::text||'|'||source||'|'||
          description||'|'||evidence_ref, ',' ORDER BY id))
        FROM resource_purchase_record WHERE enterprise_id='11111111-1111-4111-8111-111111111111';" | sed 's/^/  /'
echo "     （该表无关闭列：关闭裁决落 operation_log 审计 + 资金事件 legacy-purchase 标记，故断言关闭审计数为 0）"
psql_ "SELECT 'legacy_close_audit_rows=' || count(*)::text FROM operation_log
        WHERE action LIKE '%legacy_purchase%' OR action LIKE '%legacy-purchase%';" | sed 's/^/  /'
echo "-- (d) 迁移后新增 API 资源：strict_writes_enabled=false ⇒ 播种触发器不得创建资金状态行"
psqlf <<'SQL'
INSERT INTO provider (id, enterprise_id, code, name, adapter_type) VALUES
 ('55555555-5555-4555-8555-555555555555','11111111-1111-4111-8111-111111111111','deepseek','WP08-SYNTHETIC DeepSeek','OPENAI_COMPATIBLE');
INSERT INTO provider_resource (id, enterprise_id, provider_id, name, mode, credential_type) VALUES
 ('66666666-6666-4666-8666-666666666666','11111111-1111-4111-8111-111111111111','55555555-5555-4555-8555-555555555555','WP08-SYNTHETIC API','API','API_KEY');
SQL
psql_ "SELECT 'finance_state_after_new_api_resource=' || count(*)::text FROM provider_resource_finance_state;" | sed 's/^/  /'
echo

echo "=============== 6. 备份可恢复性演练（本地 pg_dump → 恢复到一次性库 → 逐表比对） ==============="
$COMPOSE exec -T postgres pg_dump -U qianliu -d qianliu --format=custom --no-owner --no-privileges \
  > /tmp/wp08/wp08-backup.dump 2>/tmp/wp08/pgdump.err
echo "-- pg_dump 退出码: $?  大小: $(wc -c < /tmp/wp08/wp08-backup.dump | tr -d ' ') 字节"
echo "-- pg_dump 备份内容清单条目数（pg_restore -l 统计）"
docker run --rm -i postgres:17-alpine pg_restore -l /dev/stdin < /tmp/wp08/wp08-backup.dump 2>/dev/null \
  | grep -cE "^[0-9]+;" | sed 's/^/  备份对象条目数: /'
echo "-- 备份内含的迁移台账条目（抽取 TOC 中的 kysely_migration 相关行，前 6 行）"
docker run --rm -i postgres:17-alpine pg_restore -l /dev/stdin < /tmp/wp08/wp08-backup.dump 2>/dev/null \
  | grep -i "TABLE DATA public kysely_migration" | head -6
echo "-- 建立一次性恢复库 wp08_restore"
psql_ "DROP DATABASE IF EXISTS wp08_restore;" >/dev/null
psql_ "CREATE DATABASE wp08_restore;" >/dev/null
$COMPOSE exec -T postgres pg_restore -U qianliu -d wp08_restore --no-owner --no-privileges \
  < /tmp/wp08/wp08-backup.dump 2>/tmp/wp08/pgrestore.err
echo "-- pg_restore 退出码: $?"
if [ -s /tmp/wp08/pgrestore.err ]; then echo "-- pg_restore 非空输出（前 10 行）:"; head -10 /tmp/wp08/pgrestore.err; else echo "-- pg_restore 无错误输出"; fi
restore_q() { $COMPOSE exec -T postgres psql -U qianliu -d wp08_restore -At -t -c "$1"; }
echo "-- 源库与恢复库逐表计数比对"
for T in kysely_migration enterprise admin_user provider provider_resource resource_purchase_record \
         provider_finance_runtime_state provider_finance_event provider_finance_activation_attempt \
         provider_finance_activation_quiescence provider_resource_finance_state; do
  SRC=$(psql_ "SELECT count(*) FROM $T;" | tr -d ' ')
  DST=$(restore_q "SELECT count(*) FROM $T;" | tr -d ' ')
  printf '  %-42s src=%-6s restore=%-6s %s\n' "$T" "$SRC" "$DST" "$( [ "$SRC" = "$DST" ] && echo OK || echo MISMATCH )"
done
echo "-- 逐列结构比对（迁移台账 + 关键表列集合）"
SRC_COLS=$(psql_ "SELECT string_agg(table_name||'.'||column_name, ',' ORDER BY table_name, column_name)
                  FROM information_schema.columns WHERE table_schema='public'
                    AND table_name IN ('provider_finance_activation_attempt','provider_resource_finance_state','kysely_migration');")
DST_COLS=$(restore_q "SELECT string_agg(table_name||'.'||column_name, ',' ORDER BY table_name, column_name)
                  FROM information_schema.columns WHERE table_schema='public'
                    AND table_name IN ('provider_finance_activation_attempt','provider_resource_finance_state','kysely_migration');")
[ "$SRC_COLS" = "$DST_COLS" ] && echo "  列结构: IDENTICAL" || { echo "  列结构: MISMATCH"; diff <(echo "$SRC_COLS" | tr ',' '\n') <(echo "$DST_COLS" | tr ',' '\n'); }
echo "-- 恢复库迁移台账末 3 条（应含 0079）"
restore_q "SELECT name FROM kysely_migration ORDER BY name DESC LIMIT 3;" | sed 's/^/  /'
echo "-- 清理一次性恢复库"
psql_ "DROP DATABASE IF EXISTS wp08_restore;" >/dev/null && echo "  wp08_restore 已删除"
echo
echo "# 结束(UTC): $(date -u +%Y-%m-%dT%H:%M:%SZ)"
