const { performance } = require("node:perf_hooks");
const { Pool } = require("pg");

const ENTERPRISE_A = "64000000-0000-4000-8000-000000000001";
const ENTERPRISE_B = "64000000-0000-4000-8000-000000000099";

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function percentile(values, value) {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((value / 100) * sorted.length) - 1);
  return Number(sorted[index].toFixed(3));
}

function summary(values) {
  return {
    min_ms: Number(Math.min(...values).toFixed(3)),
    p50_ms: percentile(values, 50),
    p95_ms: percentile(values, 95),
    p99_ms: percentile(values, 99),
    max_ms: Number(Math.max(...values).toFixed(3)),
  };
}

async function timed(operation) {
  const started = performance.now();
  const value = await operation();
  return { value, durationMs: Number((performance.now() - started).toFixed(3)) };
}

async function tenantCount(pool, enterpriseId) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local role poc20_capacity_runtime");
    await client.query("select set_config('app.enterprise_id', $1, true)", [enterpriseId]);
    const result = await client.query("select count(*)::bigint as count from poc20_capacity_ledger_line");
    await client.query("commit");
    return Number(result.rows[0].count);
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  check(connectionString, "DATABASE_URL is required");
  const rows = Number(process.env.POC20_USAGE_ROWS ?? "1000000");
  const batchSize = Number(process.env.POC20_INSERT_BATCH ?? "1000000");
  check(Number.isInteger(rows) && rows > 0, "POC20_USAGE_ROWS must be a positive integer");
  check(Number.isInteger(batchSize) && batchSize > 0, "POC20_INSERT_BATCH must be a positive integer");
  const pool = new Pool({ connectionString, max: 40 });

  try {
    await pool.query(`
      insert into poc20_capacity_principal(id, enterprise_id, principal_type, team_id, cost_center_id)
      select id, $1::uuid,
             case when id % 5 = 0 then 'PROJECT' else 'EMPLOYEE' end,
             ((id - 1) % 40) + 1,
             ((id - 1) % 20) + 1
        from generate_series(1, 1000) id
    `, [ENTERPRISE_A]);

    const insertion = await timed(async () => {
      for (let start = 1; start <= rows; start += batchSize) {
        const end = Math.min(rows, start + batchSize - 1);
        await pool.query(`
          insert into poc20_capacity_ledger_line(
            id, enterprise_id, period_month, principal_id, project_id,
            occurred_at, settled_at, settlement_seq,
            input_tokens, output_tokens, api_cost
          )
          select sequence,
                 $1::uuid,
                 date '2026-08-01',
                 ((sequence - 1) % 1000)::integer + 1,
                 case when sequence % 5 = 0 then ((sequence - 1) % 200)::integer + 1 else null end,
                 timestamptz '2026-08-01 00:00:00+00' + ((sequence - 1) % 2678400) * interval '1 second',
                 timestamptz '2026-08-01 00:00:01+00' + ((sequence - 1) % 2678400) * interval '1 second',
                 sequence,
                 100 + (sequence % 101),
                 20 + (sequence % 31),
                 ((sequence % 1000)::numeric / 100000::numeric)::numeric(24, 8)
            from generate_series($2::bigint, $3::bigint) sequence
        `, [ENTERPRISE_A, start, end]);
      }
    });

    const indexing = await timed(async () => {
      await pool.query(`
        create index poc20_capacity_ledger_tenant_period_principal_seq
          on poc20_capacity_ledger_line(enterprise_id, period_month, principal_id, settlement_seq)
      `);
      await pool.query(`
        create index poc20_capacity_ledger_tenant_period_settled
          on poc20_capacity_ledger_line(enterprise_id, period_month, settled_at, id)
      `);
      await pool.query("analyze poc20_capacity_ledger_line");
    });

    const closing = await timed(async () => {
      await pool.query("truncate poc20_capacity_monthly_rollup");
      await pool.query(`
        insert into poc20_capacity_monthly_rollup(
          enterprise_id, period_month, principal_id, request_count,
          input_tokens, output_tokens, api_cost
        )
        select enterprise_id, period_month, principal_id, count(*),
               sum(input_tokens), sum(output_tokens), sum(api_cost)
          from poc20_capacity_ledger_line
         where enterprise_id = $1 and period_month = date '2026-08-01'
         group by enterprise_id, period_month, principal_id
      `, [ENTERPRISE_A]);
    });

    const managementLatencies = [];
    for (let index = 0; index < 100; index += 1) {
      const measured = await timed(() => pool.query(`
        select sum(request_count), sum(input_tokens), sum(output_tokens), sum(api_cost)
          from poc20_capacity_monthly_rollup
         where enterprise_id = $1 and period_month = date '2026-08-01'
      `, [ENTERPRISE_A]));
      managementLatencies.push(measured.durationMs);
    }

    const detailLatencies = [];
    for (let index = 0; index < 100; index += 1) {
      const principalId = (index % 1000) + 1;
      const measured = await timed(() => pool.query(`
        select id, occurred_at, input_tokens, output_tokens, api_cost
          from poc20_capacity_ledger_line
         where enterprise_id = $1 and period_month = date '2026-08-01'
           and principal_id = $2 and settlement_seq > $3
         order by settlement_seq limit 100
      `, [ENTERPRISE_A, principalId, index * 10]));
      check(measured.value.rows.length > 0, "detail query returned no rows");
      detailLatencies.push(measured.durationMs);
    }

    const concurrentLatencies = [];
    const concurrentResults = await Promise.all(Array.from({ length: 500 }, async (_, index) => {
      const measured = await timed(() => index % 2 === 0
        ? pool.query(`
            select sum(request_count), sum(input_tokens), sum(output_tokens), sum(api_cost)
              from poc20_capacity_monthly_rollup
             where enterprise_id = $1 and period_month = date '2026-08-01'
          `, [ENTERPRISE_A])
        : pool.query(`
            select id, settlement_seq
              from poc20_capacity_ledger_line
             where enterprise_id = $1 and period_month = date '2026-08-01'
               and principal_id = $2
             order by settlement_seq desc limit 100
          `, [ENTERPRISE_A, (index % 1000) + 1]));
      concurrentLatencies.push(measured.durationMs);
      return measured.value.rowCount;
    }));
    check(concurrentResults.every((count) => count > 0), "concurrent management query returned empty result");

    const invariants = await pool.query(`
      select count(*)::bigint as row_count,
             sum(id)::numeric::text as id_sum,
             sum(input_tokens)::numeric::text as input_tokens,
             sum(output_tokens)::numeric::text as output_tokens,
             sum(api_cost)::numeric::text as api_cost,
             md5(concat_ws('|', count(*)::text, sum(id)::text, sum(input_tokens)::text,
                                sum(output_tokens)::text, sum(api_cost)::text)) as invariant_hash
        from poc20_capacity_ledger_line
    `);
    check(Number(invariants.rows[0].row_count) === rows, "capacity row count mismatch");
    const rollup = await pool.query(`
      select count(*)::integer as rows, sum(request_count)::bigint as request_count,
             sum(input_tokens)::numeric::text as input_tokens,
             sum(output_tokens)::numeric::text as output_tokens,
             sum(api_cost)::numeric::text as api_cost
        from poc20_capacity_monthly_rollup
    `);
    check(Number(rollup.rows[0].request_count) === rows, "rollup request count mismatch");
    check(rollup.rows[0].input_tokens === invariants.rows[0].input_tokens, "rollup input token mismatch");
    check(rollup.rows[0].output_tokens === invariants.rows[0].output_tokens, "rollup output token mismatch");
    check(rollup.rows[0].api_cost === invariants.rows[0].api_cost, "rollup api cost mismatch");

    const storage = await pool.query(`
      select pg_total_relation_size('poc20_capacity_ledger_line')::bigint as ledger_total_bytes,
             pg_relation_size('poc20_capacity_ledger_line')::bigint as ledger_heap_bytes,
             pg_indexes_size('poc20_capacity_ledger_line')::bigint as ledger_index_bytes,
             pg_total_relation_size('poc20_capacity_monthly_rollup')::bigint as rollup_total_bytes
    `);
    const sameTenantRows = await tenantCount(pool, ENTERPRISE_A);
    const crossTenantRows = await tenantCount(pool, ENTERPRISE_B);
    check(sameTenantRows === rows && crossTenantRows === 0, "RLS capacity isolation mismatch");

    process.stdout.write(`${JSON.stringify({
      result: "PASS_WITH_LIMITATIONS",
      scope: "representative 2.0 ledger/read-model schema on PostgreSQL 17; not formal product schema",
      load: { members: 100, principals: 1000, monthly_ledger_rows: rows, insert_batch: batchSize },
      durations_ms: {
        data_insert: insertion.durationMs,
        index_and_analyze: indexing.durationMs,
        close_rollup: closing.durationMs,
      },
      query_latency: {
        management_rollup: summary(managementLatencies),
        ledger_detail: summary(detailLatencies),
        mixed_500_concurrent: summary(concurrentLatencies),
      },
      candidate_checks: {
        close_le_30_minutes: closing.durationMs <= 30 * 60 * 1000,
        common_query_p95_le_500ms: percentile(managementLatencies, 95) <= 500
          && percentile(detailLatencies, 95) <= 500,
        mixed_500_query_p95_le_500ms: percentile(concurrentLatencies, 95) <= 500,
      },
      invariants: {
        ...invariants.rows[0],
        rollup_rows: Number(rollup.rows[0].rows),
        rollup_request_count: Number(rollup.rows[0].request_count),
        rls_same_tenant_rows: sameTenantRows,
        rls_cross_tenant_rows: crossTenantRows,
      },
      storage_bytes: {
        ledger_total: Number(storage.rows[0].ledger_total_bytes),
        ledger_heap: Number(storage.rows[0].ledger_heap_bytes),
        ledger_indexes: Number(storage.rows[0].ledger_index_bytes),
        rollup_total: Number(storage.rows[0].rollup_total_bytes),
      },
    }, null, 2)}\n`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
