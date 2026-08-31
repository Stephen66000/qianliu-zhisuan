const { createHash } = require("node:crypto");
const { readFile } = require("node:fs/promises");
const { join } = require("node:path");
const { Pool } = require("pg");

const TARGET_ENTERPRISE = "52000000-0000-4000-8000-000000000001";
const CROSS_ENTERPRISE_A = "54000000-0000-4000-8000-000000000001";
const TENANT_COLUMNS = [
  "admin_session",
  "employee_login",
  "quota_counter",
  "person",
  "person_external_identity",
  "availability_rule",
  "availability_rule_version",
  "availability_event",
  "notification_endpoint",
  "notification_delivery",
];

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function databaseUrl(database, user = "postgres", password = process.env.POC_POSTGRES_PASSWORD) {
  const port = process.env.POC_POSTGRES_PORT;
  check(port, "POC_POSTGRES_PORT is required");
  check(password, "database password is required");
  return `postgresql://${user}:${encodeURIComponent(password)}@127.0.0.1:${port}/${database}`;
}

async function runSqlFile(pool, filename, options = {}) {
  const client = await pool.connect();
  const sql = await readFile(join(__dirname, filename), "utf8");
  try {
    if (options.targetEnterpriseId) {
      await client.query("select set_config('poc20.target_enterprise_id', $1, false)", [options.targetEnterpriseId]);
    } else {
      await client.query("reset poc20.target_enterprise_id");
    }
    await client.query(sql);
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function expectSqlState(operation, expected, label) {
  try {
    await operation();
  } catch (error) {
    check(error.code === expected, `${label}: expected SQLSTATE ${expected}, got ${error.code}: ${error.message}`);
    return { code: error.code, message: error.message };
  }
  throw new Error(`${label}: expected SQLSTATE ${expected}, but operation succeeded`);
}

async function assertMigrationAnchor(pool) {
  const result = await pool.query("select name from kysely_migration order by timestamp desc, name desc limit 1");
  check(result.rows[0]?.name === "0044_operating_bill_model_identity", `expected 0044 anchor, got ${result.rows[0]?.name}`);
  const count = await pool.query("select count(*)::int as count from kysely_migration");
  check(count.rows[0].count === 45, `expected 45 migrations through 0044, got ${count.rows[0].count}`);
  return { last: result.rows[0].name, count: count.rows[0].count };
}

async function originalShape(pool) {
  const tables = await pool.query(`
    select table_name
      from information_schema.tables
     where table_schema = 'public'
       and table_type = 'BASE TABLE'
       and table_name not in ('kysely_migration', 'kysely_migration_lock')
     order by table_name
  `);
  const shape = {};
  for (const { table_name: table } of tables.rows) {
    const columns = await pool.query(`
      select column_name
        from information_schema.columns
       where table_schema = 'public' and table_name = $1
       order by ordinal_position
    `, [table]);
    shape[table] = columns.rows.map((row) => row.column_name);
  }
  return shape;
}

function quoteIdentifier(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

async function dataFingerprint(pool, shape) {
  const tableDigests = {};
  for (const [table, columns] of Object.entries(shape)) {
    const projection = columns.map(quoteIdentifier).join(", ");
    const query = `
      select coalesce(
        jsonb_agg(to_jsonb(row_data) order by to_jsonb(row_data)::text),
        '[]'::jsonb
      )::text as payload
      from (select ${projection} from ${quoteIdentifier(table)}) row_data
    `;
    const result = await pool.query(query);
    tableDigests[table] = digest(result.rows[0].payload);
  }
  return digest(JSON.stringify(tableDigests));
}

async function schemaFingerprint(pool, capture) {
  const [columns, constraints, indexes] = await Promise.all([
    pool.query(`
      select table_name, column_name, data_type, udt_name,
             is_nullable, coalesce(column_default, '') as column_default
        from information_schema.columns
       where table_schema = 'public'
         and table_name not in ('kysely_migration', 'kysely_migration_lock')
       order by table_name, column_name
    `),
    pool.query(`
      select rel.relname as table_name, con.conname,
             pg_get_constraintdef(con.oid, true) as definition
        from pg_constraint con
        join pg_class rel on rel.oid = con.conrelid
        join pg_namespace nsp on nsp.oid = rel.relnamespace
       where nsp.nspname = 'public'
       order by rel.relname, con.conname
    `),
    pool.query(`
      select tablename, indexname, indexdef
        from pg_indexes
       where schemaname = 'public'
         and tablename not in ('kysely_migration', 'kysely_migration_lock')
       order by tablename, indexname
    `),
  ]);
  const serialized = JSON.stringify({ columns: columns.rows, constraints: constraints.rows, indexes: indexes.rows });
  if (capture) capture.serialized = serialized;
  return digest(serialized);
}

function firstSchemaDifference(leftSerialized, rightSerialized) {
  const left = JSON.parse(leftSerialized);
  const right = JSON.parse(rightSerialized);
  for (const section of ["columns", "constraints", "indexes"]) {
    const length = Math.max(left[section].length, right[section].length);
    for (let index = 0; index < length; index += 1) {
      const a = JSON.stringify(left[section][index]);
      const b = JSON.stringify(right[section][index]);
      if (a !== b) return { section, index, first: left[section][index], second: right[section][index] };
    }
  }
  return null;
}

async function invariants(pool) {
  const totals = await pool.query(`
    select
      (select count(*)::int from ai_request) as requests,
      (select count(*)::int from upstream_attempt) as attempts,
      (select count(*)::int from usage_event) as usages,
      (select count(*)::int from ledger_line) as lines,
      (select count(*)::int from ledger_transaction) as transactions,
      (select coalesce(sum(total_input_tokens), 0)::text from ledger_transaction) as input_tokens,
      (select coalesce(sum(total_output_tokens), 0)::text from ledger_transaction) as output_tokens,
      (select coalesce(sum(total_cache_tokens), 0)::text from ledger_transaction) as cache_tokens,
      (select coalesce(sum(total_reasoning_tokens), 0)::text from ledger_transaction) as reasoning_tokens,
      (select coalesce(sum(total_deducted_quota), 0)::text from ledger_transaction) as deducted_quota,
      (select coalesce(sum(total_api_cost), 0)::text from ledger_transaction) as transaction_api_cost,
      (select count(*)::int from ledger_line where resource_mode = 'API' and api_cost is null) as unknown_api_cost_lines,
      (select count(*)::int from operating_bill_period) as periods,
      (select count(*)::int from operating_bill_version) as bill_versions
  `);
  const usageMismatch = await pool.query(`
    select count(*)::int as count
      from usage_event usage
      full join ledger_line line
        on line.enterprise_id = usage.enterprise_id
       and line.usage_event_id = usage.id
     where usage.id is null or line.id is null
        or line.ai_request_id <> usage.ai_request_id
        or line.upstream_attempt_id <> usage.upstream_attempt_id
        or line.provider_resource_id <> usage.provider_resource_id
        or line.raw_input_tokens <> usage.input_tokens
        or line.raw_output_tokens <> usage.output_tokens
        or line.raw_cache_tokens <> usage.cache_tokens
        or line.raw_reasoning_tokens <> usage.reasoning_tokens
        or line.usage_quality <> usage.usage_quality
  `);
  const transactionMismatch = await pool.query(`
    with line_sum as (
      select enterprise_id, ai_request_id,
             sum(raw_input_tokens) as input_tokens,
             sum(raw_output_tokens) as output_tokens,
             sum(raw_cache_tokens) as cache_tokens,
             sum(raw_reasoning_tokens) as reasoning_tokens,
             coalesce(sum(deducted_quota), 0) as deducted_quota,
             count(*) filter (where resource_mode = 'API') as api_lines,
             count(api_cost) filter (where resource_mode = 'API') as known_api_lines,
             coalesce(sum(api_cost) filter (where resource_mode = 'API'), 0) as known_api_cost
        from ledger_line
       group by enterprise_id, ai_request_id
    ), attempt_sum as (
      select enterprise_id, ai_request_id, count(*) as attempt_count
        from upstream_attempt
       group by enterprise_id, ai_request_id
    )
    select count(*)::int as count
      from ledger_transaction tx
      join line_sum lines using (enterprise_id, ai_request_id)
      join attempt_sum attempts using (enterprise_id, ai_request_id)
     where tx.status <> 'SETTLED'
        or tx.attempt_count <> attempts.attempt_count
        or tx.total_input_tokens <> lines.input_tokens
        or tx.total_output_tokens <> lines.output_tokens
        or tx.total_cache_tokens <> lines.cache_tokens
        or tx.total_reasoning_tokens <> lines.reasoning_tokens
        or tx.total_deducted_quota <> lines.deducted_quota
        or (lines.api_lines = lines.known_api_lines and tx.total_api_cost <> lines.known_api_cost)
  `);
  const result = {
    ...totals.rows[0],
    usage_line_mismatches: usageMismatch.rows[0].count,
    transaction_mismatches: transactionMismatch.rows[0].count,
  };
  const expected = {
    requests: 3,
    attempts: 4,
    usages: 2,
    lines: 2,
    transactions: 2,
    input_tokens: "9007199254741093",
    output_tokens: "90",
    cache_tokens: "180",
    reasoning_tokens: "7",
    deducted_quota: "200",
    transaction_api_cost: "2.50",
    unknown_api_cost_lines: 0,
    periods: 2,
    bill_versions: 2,
    usage_line_mismatches: 0,
    transaction_mismatches: 0,
  };
  check(JSON.stringify(result) === JSON.stringify(expected), `ledger invariant mismatch: ${JSON.stringify(result)}`);
  return result;
}

async function tenantSchemaState(pool) {
  const columns = await pool.query(`
    select table_name, is_nullable
      from information_schema.columns
     where table_schema = 'public'
       and column_name = 'enterprise_id'
       and table_name = any($1::text[])
     order by table_name
  `, [TENANT_COLUMNS]);
  const constraints = await pool.query(`
    select count(*)::int as count
      from pg_constraint
     where conname like 'poc20_%'
  `);
  const contract = await pool.query("select schema_version, minimum_writer_version, writer_cutover from poc20_schema_contract");
  return {
    enterprise_columns: columns.rows.length,
    all_not_null: columns.rows.every((row) => row.is_nullable === "NO"),
    poc_constraints: constraints.rows[0].count,
    contract: contract.rows[0],
  };
}

async function tenantColumnOrdinals(pool) {
  const result = await pool.query(`
    select table_name, ordinal_position
      from information_schema.columns
     where table_schema = 'public'
       and column_name = 'enterprise_id'
       and table_name = any($1::text[])
     order by table_name
  `, [TENANT_COLUMNS]);
  return result.rows;
}

async function assertNoOverlayResidue(pool) {
  const columns = await pool.query(`
    select count(*)::int as count
      from information_schema.columns
     where table_schema = 'public'
       and column_name = 'enterprise_id'
       and table_name = any($1::text[])
  `, [TENANT_COLUMNS]);
  const contract = await pool.query("select to_regclass('public.poc20_schema_contract') as reg");
  check(columns.rows[0].count === 0, `expected no overlay enterprise columns, got ${columns.rows[0].count}`);
  check(contract.rows[0].reg === null, "poc20_schema_contract residue found");
}

async function crossTenantConstraintCheck(pool) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("insert into enterprise(id, name) values ('55000000-0000-4000-8000-000000000001', '临时企业 B')");
    await client.query(`
      insert into principal(id, enterprise_id, type, name, status)
      values ('55000000-0000-4000-8000-000000000011', '55000000-0000-4000-8000-000000000001', 'EMPLOYEE', '临时 B 主体', 'ACTIVE')
    `);
    await client.query("savepoint cross_write");
    const failure = await expectSqlState(() => client.query(`
      insert into principal_key(id, enterprise_id, principal_id, key_prefix, key_digest, status)
      values ('55000000-0000-4000-8000-000000000012', $1, '55000000-0000-4000-8000-000000000011', 'cross', 'temporary-cross-digest', 'ACTIVE')
    `, [TARGET_ENTERPRISE]), "23503", "cross-tenant composite FK");
    await client.query("rollback to savepoint cross_write");
    await client.query("rollback");
    return failure.code;
  } finally {
    client.release();
  }
}

async function legacyRoleCheck(database) {
  const pool = new Pool({ connectionString: databaseUrl(database, "ql_poc_v1", process.env.POC_V1_PASSWORD), max: 1 });
  try {
    const read = await pool.query("select count(*)::int as count from ai_request");
    const write = await expectSqlState(() => pool.query(`
      insert into ai_request(id, enterprise_id, principal_id, principal_key_id, protocol, unified_model, status)
      values ('56000000-0000-4000-8000-000000000001', $1, '52000000-0000-4000-8000-000000000031', '52000000-0000-4000-8000-000000000041', 'chat', 'ql-poc-model', 'PENDING')
    `, [TARGET_ENTERPRISE]), "42501", "legacy writer fence");
    return { read_rows: read.rows[0].count, write_sqlstate: write.code };
  } finally {
    await pool.end();
  }
}

async function main() {
  const valid = new Pool({ connectionString: databaseUrl("poc_valid"), max: 2 });
  const ambiguous = new Pool({ connectionString: databaseUrl("poc_ambiguous"), max: 1 });
  const corrupt = new Pool({ connectionString: databaseUrl("poc_cross"), max: 1 });
  const evidence = {};

  try {
    evidence.migration_anchor = await assertMigrationAnchor(valid);
    await Promise.all([assertMigrationAnchor(ambiguous), assertMigrationAnchor(corrupt)]);

    await runSqlFile(valid, "seed_valid.sql");
    const shape = await originalShape(valid);
    const originalSchema = await schemaFingerprint(valid);
    const originalData = await dataFingerprint(valid, shape);
    const originalInvariants = await invariants(valid);
    evidence.original_0044 = {
      schema_sha256: originalSchema,
      old_columns_data_sha256: originalData,
      invariants: originalInvariants,
    };

    const firstStarted = process.hrtime.bigint();
    await runSqlFile(valid, "representative_up.sql", { targetEnterpriseId: TARGET_ENTERPRISE });
    evidence.first_up_ms = Number(process.hrtime.bigint() - firstStarted) / 1e6;
    const firstSchemaCapture = {};
    const firstSchema = await schemaFingerprint(valid, firstSchemaCapture);
    const firstData = await dataFingerprint(valid, shape);
    check(firstData === originalData, "old-column data hash changed after first up");
    check(JSON.stringify(await invariants(valid)) === JSON.stringify(originalInvariants), "invariants changed after first up");
    const firstState = await tenantSchemaState(valid);
    const firstOrdinals = await tenantColumnOrdinals(valid);
    check(firstState.enterprise_columns === 10 && firstState.all_not_null, "ten enterprise columns were not backfilled NOT NULL");
    check(firstState.poc_constraints >= 70, `expected representative constraint set, got ${firstState.poc_constraints}`);
    evidence.first_up = {
      schema_sha256: firstSchema,
      old_columns_data_sha256: firstData,
      tenant_schema: firstState,
      enterprise_column_ordinals: firstOrdinals,
      cross_tenant_write_sqlstate: await crossTenantConstraintCheck(valid),
      legacy_role: await legacyRoleCheck("poc_valid"),
    };

    const downStarted = process.hrtime.bigint();
    await runSqlFile(valid, "representative_down.sql");
    evidence.down_ms = Number(process.hrtime.bigint() - downStarted) / 1e6;
    await assertNoOverlayResidue(valid);
    const downSchema = await schemaFingerprint(valid);
    const downData = await dataFingerprint(valid, shape);
    check(downSchema === originalSchema, "rollback schema fingerprint differs from original 0044");
    check(downData === originalData, "old-column data hash changed after down");
    check(JSON.stringify(await invariants(valid)) === JSON.stringify(originalInvariants), "invariants changed after down");
    evidence.rollback_to_0044 = {
      schema_sha256: downSchema,
      old_columns_data_sha256: downData,
      legacy_role: await legacyRoleCheck("poc_valid"),
    };

    const secondStarted = process.hrtime.bigint();
    await runSqlFile(valid, "representative_up.sql", { targetEnterpriseId: TARGET_ENTERPRISE });
    evidence.second_up_ms = Number(process.hrtime.bigint() - secondStarted) / 1e6;
    const secondSchemaCapture = {};
    const secondSchema = await schemaFingerprint(valid, secondSchemaCapture);
    const secondData = await dataFingerprint(valid, shape);
    check(
      secondSchema === firstSchema,
      `second up schema fingerprint differs from first up: ${JSON.stringify(firstSchemaDifference(firstSchemaCapture.serialized, secondSchemaCapture.serialized))}`,
    );
    check(secondData === originalData, "old-column data hash changed after second up");
    check(JSON.stringify(await invariants(valid)) === JSON.stringify(originalInvariants), "invariants changed after second up");
    const secondOrdinals = await tenantColumnOrdinals(valid);
    evidence.reupgrade = {
      schema_sha256: secondSchema,
      old_columns_data_sha256: secondData,
      same_as_first_up: true,
      enterprise_column_ordinals: secondOrdinals,
      physical_column_ordinal_drift: JSON.stringify(secondOrdinals) !== JSON.stringify(firstOrdinals),
    };

    await valid.query("update poc20_schema_contract set writer_cutover = true");
    const cutoverFailure = await expectSqlState(
      () => runSqlFile(valid, "representative_down.sql"),
      "P2004",
      "down after writer cutover",
    );
    evidence.cutover_down_guard = cutoverFailure.code;

    await runSqlFile(ambiguous, "seed_ambiguous.sql");
    const missingManifest = await expectSqlState(
      () => runSqlFile(ambiguous, "representative_up.sql"),
      "P2000",
      "missing target enterprise manifest",
    );
    await assertNoOverlayResidue(ambiguous);
    evidence.missing_manifest = { sqlstate: missingManifest.code, no_ddl_residue: true };

    await runSqlFile(corrupt, "seed_cross_tenant.sql");
    const crossReference = await expectSqlState(
      () => runSqlFile(corrupt, "representative_up.sql", { targetEnterpriseId: CROSS_ENTERPRISE_A }),
      "P2002",
      "cross-enterprise preflight",
    );
    await assertNoOverlayResidue(corrupt);
    evidence.cross_enterprise_preflight = { sqlstate: crossReference.code, no_ddl_residue: true };

    console.log(JSON.stringify({
      result: "PASS_WITH_LIMITATIONS",
      scope: "real 0000-0044 chain plus representative 2.0 overlay; not formal 0045 or production rehearsal",
      evidence,
    }, null, 2));
  } finally {
    await Promise.all([valid.end(), ambiguous.end(), corrupt.end()]);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
