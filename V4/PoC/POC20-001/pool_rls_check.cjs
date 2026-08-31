const { Pool } = require("pg");

const TENANT_A = "00000000-0000-0000-0000-00000000000a";
const TENANT_B = "00000000-0000-0000-0000-00000000000b";
const PRINCIPAL_A = "10000000-0000-0000-0000-00000000000a";
const PRINCIPAL_B = "10000000-0000-0000-0000-00000000000b";
const RESOURCE_A = "20000000-0000-0000-0000-00000000000a";
const RESOURCE_B = "20000000-0000-0000-0000-00000000000b";

function check(condition, message) {
  if (!condition) throw new Error(message);
}

async function errorCode(operation) {
  try {
    await operation();
    return null;
  } catch (error) {
    return error.code ?? "UNKNOWN";
  }
}

async function errorCodeAtSavepoint(client, name, operation) {
  await client.query(`SAVEPOINT ${name}`);
  try {
    await operation();
    await client.query(`RELEASE SAVEPOINT ${name}`);
    return null;
  } catch (error) {
    await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
    await client.query(`RELEASE SAVEPOINT ${name}`);
    return error.code ?? "UNKNOWN";
  }
}

async function withTenant(pool, enterpriseId, operation) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "select set_config('app.enterprise_id', $1, true)",
      [enterpriseId],
    );
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  check(connectionString, "DATABASE_URL is required");
  const pool = new Pool({ connectionString, max: 1 });
  const evidence = {};

  try {
    const role = await pool.query(`
      select rolname, rolsuper, rolbypassrls
      from pg_roles
      where rolname = current_user
    `);
    check(role.rows[0]?.rolname === "ql_poc_app", "unexpected database role");
    check(role.rows[0].rolsuper === false, "application role must not be superuser");
    check(role.rows[0].rolbypassrls === false, "application role must not bypass RLS");
    evidence.app_role = "NOSUPERUSER/NOBYPASSRLS";

    const rls = await pool.query(`
      select relname, relrowsecurity, relforcerowsecurity
      from pg_class
      join pg_namespace on pg_namespace.oid = pg_class.relnamespace
      where nspname = 'poc20' and relkind = 'r'
      order by relname
    `);
    check(rls.rows.length === 5, "expected five PoC tables");
    check(rls.rows.every((row) => row.relrowsecurity && row.relforcerowsecurity), "RLS/FORCE RLS missing");
    evidence.rls_tables = rls.rows.map((row) => row.relname);

    const noContext = await pool.query("select count(*)::int as count from poc20.usage_event");
    check(noContext.rows[0].count === 0, "missing context must see zero rows");
    evidence.no_context_read = 0;

    const noContextWrite = await errorCode(() =>
      pool.query(
        `insert into poc20.usage_event
         (enterprise_id, id, principal_id, provider_resource_id, total_tokens)
         values ($1, '30000000-0000-0000-0000-000000000099', $2, $3, 1)`,
        [TENANT_A, PRINCIPAL_A, RESOURCE_A],
      ),
    );
    check(noContextWrite === "42501", `missing context write must fail with 42501, got ${noContextWrite}`);
    evidence.no_context_write = noContextWrite;

    const noContextUpdate = await pool.query(
      "update poc20.usage_event set total_tokens = total_tokens + 1",
    );
    const noContextDelete = await pool.query("delete from poc20.usage_event");
    const noContextUpsert = await errorCode(() =>
      pool.query(
        `insert into poc20.usage_event
         (enterprise_id, id, principal_id, provider_resource_id, total_tokens)
         values ($1, '30000000-0000-0000-0000-00000000000a', $2, $3, 101)
         on conflict (enterprise_id, id)
         do update set total_tokens = excluded.total_tokens`,
        [TENANT_A, PRINCIPAL_A, RESOURCE_A],
      ),
    );
    check(noContextUpdate.rowCount === 0, "missing context update must affect zero rows");
    check(noContextDelete.rowCount === 0, "missing context delete must affect zero rows");
    check(noContextUpsert === "42501", `missing context upsert must fail with 42501, got ${noContextUpsert}`);
    evidence.no_context_update = 0;
    evidence.no_context_delete = 0;
    evidence.no_context_upsert = noContextUpsert;

    const tenantA = await withTenant(pool, TENANT_A, async (client) => {
      const own = await client.query("select id from poc20.usage_event order by id");
      const crossDirect = await client.query(
        "select id from poc20.usage_event where enterprise_id = $1",
        [TENANT_B],
      );
      const crossUpdate = await client.query(
        "update poc20.usage_event set total_tokens = 999 where enterprise_id = $1",
        [TENANT_B],
      );
      const crossTenantInsert = await errorCodeAtSavepoint(client, "cross_tenant_insert", () =>
        client.query(
          `insert into poc20.usage_event
           (enterprise_id, id, principal_id, provider_resource_id, total_tokens)
           values ($1, '30000000-0000-0000-0000-000000000098', $2, $3, 1)`,
          [TENANT_B, PRINCIPAL_B, RESOURCE_B],
        ),
      );
      const crossReferenceInsert = await errorCodeAtSavepoint(client, "cross_reference_insert", () =>
        client.query(
          `insert into poc20.usage_event
           (enterprise_id, id, principal_id, provider_resource_id, total_tokens)
           values ($1, '30000000-0000-0000-0000-000000000097', $2, $3, 1)`,
          [TENANT_A, PRINCIPAL_B, RESOURCE_A],
        ),
      );
      const exportRows = await client.query("select object_key from poc20.support_export");
      const plan = await client.query(
        "explain (format json) select * from poc20.usage_event where id = $1",
        ["30000000-0000-0000-0000-00000000000a"],
      );
      return {
        own: own.rows,
        cross_direct: crossDirect.rowCount,
        cross_update: crossUpdate.rowCount,
        cross_tenant_insert: crossTenantInsert,
        cross_reference_insert: crossReferenceInsert,
        export_objects: exportRows.rows.map((row) => row.object_key),
        plan: plan.rows[0]["QUERY PLAN"][0].Plan,
      };
    });
    check(tenantA.own.length === 1, "tenant A must see exactly one own usage row");
    check(tenantA.cross_direct === 0, "tenant A direct read of tenant B must return zero");
    check(tenantA.cross_update === 0, "tenant A update of tenant B must affect zero rows");
    check(tenantA.cross_tenant_insert === "42501", "RLS WITH CHECK must reject tenant B insert");
    check(tenantA.cross_reference_insert === "23503", "composite FK must reject tenant B principal reference");
    check(tenantA.export_objects.length === 1 && tenantA.export_objects[0].includes("enterprise/a/"), "export rows must be tenant scoped");
    evidence.tenant_a = tenantA;

    const afterCommit = await pool.query("select count(*)::int as count from poc20.usage_event");
    check(afterCommit.rows[0].count === 0, "SET LOCAL context must clear after commit and pool reuse");
    evidence.pool_reuse_after_commit = 0;

    const tenantB = await withTenant(pool, TENANT_B, (client) =>
      client.query("select id, total_tokens from poc20.usage_event"),
    );
    check(tenantB.rows.length === 1 && Number(tenantB.rows[0].total_tokens) === 200, "tenant B must see only own row");
    evidence.tenant_b_rows = tenantB.rows.length;

    const rollbackClient = await pool.connect();
    try {
      await rollbackClient.query("BEGIN");
      await rollbackClient.query("select set_config('app.enterprise_id', $1, true)", [TENANT_A]);
      await rollbackClient.query("ROLLBACK");
    } finally {
      rollbackClient.release();
    }
    const afterRollback = await pool.query("select count(*)::int as count from poc20.usage_event");
    check(afterRollback.rows[0].count === 0, "SET LOCAL context must clear after rollback");
    evidence.pool_reuse_after_rollback = 0;

    const invalidClient = await pool.connect();
    let invalidContextCode;
    try {
      await invalidClient.query("BEGIN");
      await invalidClient.query("select set_config('app.enterprise_id', 'not-a-uuid', true)");
      invalidContextCode = await errorCode(() => invalidClient.query("select * from poc20.usage_event"));
      await invalidClient.query("ROLLBACK");
    } finally {
      invalidClient.release();
    }
    check(invalidContextCode === "22P02", `invalid context must fail closed with 22P02, got ${invalidContextCode}`);
    evidence.invalid_context = invalidContextCode;

    const leakClient = await pool.connect();
    try {
      await leakClient.query("select set_config('app.enterprise_id', $1, false)", [TENANT_A]);
    } finally {
      leakClient.release();
    }
    const leaked = await pool.query("select count(*)::int as count from poc20.usage_event");
    check(leaked.rows[0].count === 1, "session-level SET hazard was not reproduced");
    evidence.session_set_hazard = "REPRODUCED: tenant A context survived pool checkout";
    await pool.query("reset app.enterprise_id");
    const afterReset = await pool.query("select count(*)::int as count from poc20.usage_event");
    check(afterReset.rows[0].count === 0, "RESET must restore fail-closed state");

    const concurrentPool = new Pool({ connectionString, max: 4 });
    try {
      const concurrent = await Promise.all(
        Array.from({ length: 24 }, (_, index) => {
          const enterpriseId = index % 2 === 0 ? TENANT_A : TENANT_B;
          const expectedTokens = index % 2 === 0 ? 100 : 200;
          return withTenant(concurrentPool, enterpriseId, async (client) => {
            const result = await client.query(
              "select enterprise_id, total_tokens from poc20.usage_event",
            );
            check(result.rows.length === 1, "concurrent tenant query must see one row");
            check(result.rows[0].enterprise_id === enterpriseId, "concurrent tenant context crossed enterprises");
            check(Number(result.rows[0].total_tokens) === expectedTokens, "concurrent tenant saw wrong fact");
            return result.rows[0].enterprise_id;
          });
        }),
      );
      check(concurrent.filter((id) => id === TENANT_A).length === 12, "tenant A concurrent count mismatch");
      check(concurrent.filter((id) => id === TENANT_B).length === 12, "tenant B concurrent count mismatch");
      evidence.concurrent_pool_max_4 = "24/24 isolated operations";
    } finally {
      await concurrentPool.end();
    }

    console.log(JSON.stringify({ result: "PASS_WITH_LIMITATIONS", evidence }, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
