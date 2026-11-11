/**
 * R3/F3 证据探针：0091 水位（billing_rule 无 source_status 列）上的估算与 legacy 报表行为。
 *
 * 核实两件事（R3 实施合同 3.d「legacy 报表语义核实」）：
 *   1) F3 后 loadApiCostEstimation 的 SQL 只读 ledger_line.billing_rule_snapshot->>'sourceStatus'
 *      （JSONB 键读取，0020+ 即有该列）——在 0091 水位直接调用不报缺列错误，且
 *      快照含键行按冻结值、缺键行回退 UNVERIFIED；
 *   2) usage-overview-repository 的 S2B 列存在性门保留：0091 水位 getOverviewSnapshot
 *      不产出 priceBasisUnverified（undefined＝「无此信息」，legacy 报表合同不变）；
 *      升到最新水位后同一数据开始产出该字段（0093+ 新语义）。
 *
 * 只读证据脚本：写库仅为夹具（企业/规则/账本行），无业务数据修改。
 *
 * 运行（本 worktree 根）：
 *   DOCKER_HOST=unix:///Users/mac/.colima/default/docker.sock \
 *   TESTCONTAINERS_RYUK_DISABLED=true \
 *   corepack pnpm@11.11.0 exec tsx \
 *   V4/Evidence/API-COST-OFFICIAL-BALANCE/remediation-r1-20261105/scripts/f3-legacy-watermark-probe.ts
 */
import { randomUUID } from "node:crypto";
// kysely 经 database 包内依赖的绝对路径引入（证据目录不在 workspace 包内，bare import 不可解析）。
import { sql } from "/Users/mac/Projects/仟流智算-api-decouple/packages/database/node_modules/kysely/dist/esm/index.js";
import { createKysely } from "/Users/mac/Projects/仟流智算-api-decouple/packages/database/src/kysely.ts";
import { createMigrator, migrateToLatest } from "/Users/mac/Projects/仟流智算-api-decouple/packages/database/src/migrator.ts";
import { loadApiCostEstimation } from "/Users/mac/Projects/仟流智算-api-decouple/packages/database/src/repositories/api-cost-estimation.ts";
import { UsageOverviewRepository } from "/Users/mac/Projects/仟流智算-api-decouple/packages/database/src/repositories/usage-overview-repository.ts";
import { startPostgresContainer } from "/Users/mac/Projects/仟流智算-api-decouple/packages/testing/src/index.ts";
import type { Kysely } from "/Users/mac/Projects/仟流智算-api-decouple/packages/database/node_modules/kysely/dist/esm/index.d.ts";
import type { Database } from "/Users/mac/Projects/仟流智算-api-decouple/packages/database/src/kysely.ts";

const LEGACY_HEAD = "0091_recorded_cost_accounting_policy";

let db: Kysely<Database> | null = null;
let stop: (() => Promise<void>) | null = null;
try {
  const pg = await startPostgresContainer("f3_legacy_watermark_probe");
  stop = pg.stop;
  db = createKysely(pg.connectionString);

  // ── 1) 迁到 0091 水位（既有生产 schema 模拟）。
  const migrated = await createMigrator(db).migrateTo(LEGACY_HEAD);
  if (migrated.error) throw migrated.error;
  const column = await sql<{ present: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = 'billing_rule' AND column_name = 'source_status'
    ) AS present`.execute(db);
  console.log("[probe] watermark <= %s", LEGACY_HEAD);
  console.log("[probe] billing_rule.source_status column present at 0091 ==", column.rows[0]?.present);

  // ── 2) 夹具：一家企业、一条规则、两行已计价账本行——
  //       a 行快照含 sourceStatus="VERIFIED"（9bf1560 后生产形态）；
  //       b 行快照缺该键（9bf1560 前旧行形态）。
  //       0091 水位 billing_rule 无 source_status 列：插入语句不得引用该列。
  const enterpriseId = randomUUID();
  const principalId = randomUUID();
  const keyId = randomUUID();
  await db.insertInto("enterprise").values({ id: enterpriseId, name: "F3 水位探针" }).execute();
  await db.insertInto("principal").values({
    id: principalId, enterprise_id: enterpriseId, type: "EMPLOYEE", name: "员工",
  }).execute();
  await db.insertInto("principal_key").values({
    id: keyId, enterprise_id: enterpriseId, principal_id: principalId,
    key_prefix: "f3probe", key_digest: randomUUID(), allowed_model_ids: [],
  }).execute();
  const provider = await db.insertInto("provider").values({
    enterprise_id: enterpriseId, code: "f3probe", name: "F3 探针厂商",
    adapter_type: "OPENAI_COMPATIBLE",
  }).returning("id").executeTakeFirstOrThrow();
  const resource = await db.insertInto("provider_resource").values({
    enterprise_id: enterpriseId, provider_id: provider.id, name: "api 资源", mode: "API",
    credential_type: "API_KEY",
  }).returning("id").executeTakeFirstOrThrow();
  const rule = await db.insertInto("billing_rule").values({
    enterprise_id: enterpriseId, rule_type: "API_PRICE", rule_version: "f3-legacy-v1",
    effective_from: new Date("2026-08-01T00:00:00Z"),
    cache_hit_price: "0", cache_miss_price: "0.000002", output_price: "0.000004",
    currency: "CNY", priority: 10, source: "fixture",
  }).returning("id").executeTakeFirstOrThrow();

  const at = new Date("2026-09-10T12:00:00+08:00");
  for (const [tag, snapshot] of [
    ["with-key", { pricingMode: "ABSOLUTE", currency: "CNY", sourceStatus: "VERIFIED" }],
    ["missing-key", { pricingMode: "ABSOLUTE", currency: "CNY" }],
  ] as const) {
    const requestId = randomUUID();
    await db.insertInto("ai_request").values({
      id: requestId, enterprise_id: enterpriseId, principal_id: principalId,
      principal_key_id: keyId, protocol: "chat", unified_model: "model",
      status: "SUCCEEDED", started_at: at, finished_at: at,
    }).execute();
    const attempt = await db.insertInto("upstream_attempt").values({
      enterprise_id: enterpriseId, ai_request_id: requestId, attempt_no: 1,
      provider_resource_id: resource.id, upstream_model: "model", http_status: 200,
      response_committed: true, finished_at: at,
    }).returning("id").executeTakeFirstOrThrow();
    const usage = await db.insertInto("usage_event").values({
      enterprise_id: enterpriseId, ai_request_id: requestId, upstream_attempt_id: attempt.id,
      provider_resource_id: resource.id, input_tokens: 10n, output_tokens: 2n,
      cache_tokens: 0n, reasoning_tokens: 0n, usage_quality: "PROVIDER_REPORTED",
      dedup_key: requestId, created_at: at,
    }).returning("id").executeTakeFirstOrThrow();
    await db.insertInto("ledger_line").values({
      enterprise_id: enterpriseId, ai_request_id: requestId, upstream_attempt_id: attempt.id,
      usage_event_id: usage.id, provider_resource_id: resource.id, principal_id: principalId,
      resource_mode: "API", raw_input_tokens: 10n, raw_output_tokens: 2n,
      raw_cache_tokens: 0n, raw_reasoning_tokens: 0n,
      api_cost: "1.00000000", api_cost_currency: "CNY", api_cost_status: "PRICED_USAGE",
      usage_quality: "PROVIDER_REPORTED", billing_rule_id: rule.id,
      rule_version: "f3-legacy-v1", billing_rule_snapshot: snapshot,
      settled_at: at, created_at: at,
    }).execute();
    console.log("[probe] seeded priced line %s (snapshot.sourceStatus=%s)", tag,
      "sourceStatus" in snapshot ? snapshot.sourceStatus : "(absent)");
  }

  // ── 3) 0091 水位直接调用 loadApiCostEstimation：F3 后 SQL 不再引用 billing_rule.source_status，
  //       应当成功执行并按快照键分类依据。
  const start = new Date("2026-09-01T00:00:00+08:00");
  const end = new Date("2026-10-01T00:00:00+08:00");
  const estimation = await loadApiCostEstimation(db, enterpriseId, { start, end });
  console.log("[probe] 0091 loadApiCostEstimation OK: amounts=%j completeness=%s",
    estimation.amounts, estimation.completeness);
  console.log("[probe] 0091 priceBasis=%j", estimation.priceBasis);
  console.log("[probe] 0091 gaps=%j", estimation.gaps);

  // ── 4) 0091 水位 getOverviewSnapshot（legacy 报表同路径）：S2B 门应返回 null，
  //       metrics 不含 priceBasisUnverified。
  const legacyOverview = await new UsageOverviewRepository(db).getOverview({
    enterpriseId, subjectType: "EMPLOYEE", period: "MONTH", anchor: at,
  });
  console.log("[probe] 0091 metrics.priceBasisUnverified present=%s value=%j",
    "priceBasisUnverified" in legacyOverview.metrics,
    legacyOverview.metrics.priceBasisUnverified);

  // ── 5) 升到最新水位：同一数据开始按 0093+ 语义产出该字段。
  const executed = await migrateToLatest(db);
  console.log("[probe] migrated to latest: last=%s (0093 in chain=%j)",
    executed[executed.length - 1], executed.includes("0093_billing_rule_source_status"));
  const latestOverview = await new UsageOverviewRepository(db).getOverview({
    enterpriseId, subjectType: "EMPLOYEE", period: "MONTH", anchor: at,
  });
  console.log("[probe] latest metrics.priceBasisUnverified present=%s value=%j",
    "priceBasisUnverified" in latestOverview.metrics,
    latestOverview.metrics.priceBasisUnverified);

  console.log("[probe] done");
} finally {
  await db?.destroy();
  await stop?.();
}
