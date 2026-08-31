const { Pool } = require("pg");

const ENT_A = "63000000-0000-4000-8000-000000000001";
const ENT_B = "63000000-0000-4000-8000-000000000002";
const PERIOD_FAIL = "63000000-0000-4000-8000-000000000101";
const PERIOD_SETTLEMENT_FIRST = "63000000-0000-4000-8000-000000000102";
const PERIOD_CLOSE_FIRST = "63000000-0000-4000-8000-000000000103";
const PERIOD_CRASH = "63000000-0000-4000-8000-000000000104";
const PERIOD_TZ_A = "63000000-0000-4000-8000-000000000105";
const PERIOD_TZ_B = "63000000-0000-4000-8000-000000000201";

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function transaction(pool, operation) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const value = await operation(client);
    await client.query("commit");
    return value;
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
    check(error.code === expected, `${label}: expected ${expected}, got ${error.code}: ${error.message}`);
    return error.code;
  }
  throw new Error(`${label}: expected SQLSTATE ${expected}, operation succeeded`);
}

async function beginCheck(db, enterpriseId, periodId, expectedVersion, now, leaseSeconds = 30) {
  const result = await db.query(
    "select poc20_begin_check($1, $2, $3, $4, $5) as attempt",
    [enterpriseId, periodId, expectedVersion, now, leaseSeconds],
  );
  return result.rows[0].attempt;
}

async function failCheck(db, enterpriseId, periodId, attempt, items, now) {
  await db.query(
    "select poc20_fail_check($1, $2, $3, $4::jsonb, $5)",
    [enterpriseId, periodId, attempt, JSON.stringify(items), now],
  );
}

async function closePeriod(db, enterpriseId, periodId, expectedVersion, commandKey, now) {
  const result = await db.query(
    "select version, trim(statement_hash) as statement_hash, fact_count from poc20_close_period($1, $2, $3, $4, $5)",
    [enterpriseId, periodId, expectedVersion, commandKey, now],
  );
  return result.rows[0];
}

async function beginAndClose(pool, enterpriseId, periodId, expectedVersion, commandKey, now) {
  return transaction(pool, async (client) => {
    await beginCheck(client, enterpriseId, periodId, expectedVersion, now, 30);
    return closePeriod(client, enterpriseId, periodId, expectedVersion, commandKey, now);
  });
}

async function recordSettlement(db, input) {
  await db.query(
    "select poc20_record_settlement($1,$2,$3,$4,$5,$6,$7,$8,$9)",
    [
      input.enterpriseId,
      input.periodId,
      input.id,
      input.occurredAt,
      input.settledAt ?? null,
      input.status,
      input.inputTokens,
      input.outputTokens,
      input.apiCost,
    ],
  );
}

async function periodState(pool, periodId) {
  const result = await pool.query(`
    select status, current_version, check_attempt, checking_lease_until,
           last_settlement_seq, ledger_watermark_seq,
           ledger_watermark_at, ledger_watermark_id, trim(current_statement_hash) as current_statement_hash
      from operating_bill_period where id = $1
  `, [periodId]);
  return result.rows[0];
}

async function statementRows(pool, periodId) {
  const result = await pool.query(`
    select version, trim(statement_hash) as statement_hash, fact_count,
           total_input_tokens::text, total_output_tokens::text, total_api_cost::text,
           ledger_watermark_seq, ledger_watermark_at, ledger_watermark_id
      from poc20_operating_statement
     where period_id = $1 order by version
  `, [periodId]);
  return result.rows;
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  check(connectionString, "DATABASE_URL is required");
  const pool = new Pool({ connectionString, max: 8 });
  const evidence = {};

  try {
    const statusConstraint = await pool.query(`
      select pg_get_constraintdef(oid) as definition
        from pg_constraint
       where conname = 'operating_bill_period_status_check'
    `);
    const definition = statusConstraint.rows[0].definition;
    for (const status of ["DRAFT", "CHECKING", "CLOSED", "REOPENED"]) {
      check(definition.includes(status), `status constraint missing ${status}`);
    }
    check(!definition.includes("CHECKING_FAILED"), "CHECKING_FAILED must not be a period state");
    evidence.period_states = ["DRAFT", "CHECKING", "CLOSED", "REOPENED"];

    const failedAttempt = await beginCheck(pool, ENT_A, PERIOD_FAIL, 0, "2026-05-10T00:00:00Z", 30);
    check((await periodState(pool, PERIOD_FAIL)).status === "CHECKING", "period did not enter CHECKING");
    await failCheck(
      pool,
      ENT_A,
      PERIOD_FAIL,
      failedAttempt,
      [{ code: "UNSETTLED_FACT", retryable: true }],
      "2026-05-10T00:00:01Z",
    );
    check((await periodState(pool, PERIOD_FAIL)).status === "DRAFT", "failed check must return period to DRAFT");
    const failedRow = await pool.query(`
      select result, items from poc20_period_check
       where period_id = $1 and attempt = $2
    `, [PERIOD_FAIL, failedAttempt]);
    check(failedRow.rows[0].result === "FAILED", "period_check failure result missing");
    evidence.failed_check = { period_status: "DRAFT", check_result: "FAILED" };

    const pendingFact = {
      enterpriseId: ENT_A,
      periodId: PERIOD_FAIL,
      id: "63000000-0000-4000-8000-000000001001",
      occurredAt: "2026-05-12T00:00:00Z",
      settledAt: null,
      status: "PENDING",
      inputTokens: "10",
      outputTokens: "2",
      apiCost: "0.10",
    };
    await recordSettlement(pool, pendingFact);
    const pendingAttempt = await beginCheck(pool, ENT_A, PERIOD_FAIL, 0, "2026-05-12T00:00:01Z", 30);
    const pendingCode = await expectSqlState(
      () => closePeriod(pool, ENT_A, PERIOD_FAIL, 0, "pending-close", "2026-05-12T00:00:02Z"),
      "P3002",
      "pending settlement close",
    );
    await failCheck(
      pool,
      ENT_A,
      PERIOD_FAIL,
      pendingAttempt,
      [{ code: "PENDING_SETTLEMENT", retryable: true }],
      "2026-05-12T00:00:03Z",
    );
    await recordSettlement(pool, {
      ...pendingFact,
      status: "SETTLED",
      settledAt: "2026-05-12T00:00:04Z",
    });
    const recoveredClose = await beginAndClose(
      pool,
      ENT_A,
      PERIOD_FAIL,
      0,
      "pending-fixed-close",
      "2026-05-12T00:00:05Z",
    );
    check(recoveredClose.fact_count === 1, "recovered pending fact missing from statement");
    evidence.pending_recovery = { blocked_sqlstate: pendingCode, closed_fact_count: 1 };

    const crashClient = await pool.connect();
    try {
      await crashClient.query("begin");
      await beginCheck(crashClient, ENT_A, PERIOD_CRASH, 0, "2026-10-10T00:00:00Z", 30);
      await crashClient.query("rollback");
    } finally {
      crashClient.release();
    }
    check((await periodState(pool, PERIOD_CRASH)).status === "DRAFT", "rollback before check commit left CHECKING");
    const rolledBackChecks = await pool.query("select count(*)::int as count from poc20_period_check where period_id = $1", [PERIOD_CRASH]);
    check(rolledBackChecks.rows[0].count === 0, "rollback before check commit left check row");

    await beginCheck(pool, ENT_A, PERIOD_CRASH, 0, "2026-10-10T00:00:00Z", 1);
    const partialClient = await pool.connect();
    try {
      await partialClient.query("begin");
      await closePeriod(partialClient, ENT_A, PERIOD_CRASH, 0, "crash-after-statement", "2026-10-10T00:00:01Z");
      await expectSqlState(() => partialClient.query("select 1 / 0"), "22012", "fault after statement insert");
      await partialClient.query("rollback");
    } finally {
      partialClient.release();
    }
    check((await periodState(pool, PERIOD_CRASH)).status === "CHECKING", "failed close transaction did not roll back atomically");
    check((await statementRows(pool, PERIOD_CRASH)).length === 0, "partial statement survived rollback");
    const recovered = await pool.query(
      "select poc20_recover_stale_check($1, $2, $3) as recovered",
      [ENT_A, PERIOD_CRASH, "2026-10-10T00:00:02Z"],
    );
    check(recovered.rows[0].recovered === true, "stale CHECKING was not recovered");
    check((await periodState(pool, PERIOD_CRASH)).status === "DRAFT", "stale recovery did not return DRAFT");
    evidence.failure_injection = {
      precommit_rollback_residue: 0,
      statement_transaction_residue: 0,
      stale_check_recovered: true,
    };

    const settlementClient = await pool.connect();
    let closeOutcome;
    try {
      await settlementClient.query("begin");
      await recordSettlement(settlementClient, {
        enterpriseId: ENT_A,
        periodId: PERIOD_SETTLEMENT_FIRST,
        id: "63000000-0000-4000-8000-000000001002",
        occurredAt: "2026-06-15T01:00:00Z",
        settledAt: "2026-07-01T00:00:00Z",
        status: "SETTLED",
        inputTokens: "40",
        outputTokens: "5",
        apiCost: "0.40",
      });
      let closeFinished = false;
      const closePromise = beginAndClose(
        pool,
        ENT_A,
        PERIOD_SETTLEMENT_FIRST,
        0,
        "settlement-first-close",
        "2026-07-01T00:00:01Z",
      ).then(
        (value) => ({ ok: true, value }),
        (error) => ({ ok: false, error }),
      ).finally(() => { closeFinished = true; });
      await delay(150);
      check(!closeFinished, "close did not wait for settlement-first barrier");
      await settlementClient.query("commit");
      closeOutcome = await closePromise;
      check(closeOutcome.ok, `settlement-first close failed: ${closeOutcome.error?.message}`);
      check(closeOutcome.value.fact_count === 1, "settlement-first fact was lost");
    } catch (error) {
      await settlementClient.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      settlementClient.release();
    }
    evidence.settlement_first = {
      close_waited_for_lock: true,
      fact_count: closeOutcome.value.fact_count,
    };

    const closeClient = await pool.connect();
    let lateOutcome;
    try {
      await closeClient.query("begin");
      await beginCheck(closeClient, ENT_A, PERIOD_CLOSE_FIRST, 0, "2026-10-01T00:00:00Z", 30);
      const closeFirst = await closePeriod(
        closeClient,
        ENT_A,
        PERIOD_CLOSE_FIRST,
        0,
        "close-first-close",
        "2026-10-01T00:00:01Z",
      );
      check(closeFirst.fact_count === 0, "zero-fact close should be explicit");
      let lateFinished = false;
      const latePromise = transaction(pool, (client) => recordSettlement(client, {
        enterpriseId: ENT_A,
        periodId: PERIOD_CLOSE_FIRST,
        id: "63000000-0000-4000-8000-000000001003",
        occurredAt: "2026-09-20T00:00:00Z",
        settledAt: "2026-10-01T00:00:02Z",
        status: "SETTLED",
        inputTokens: "1",
        outputTokens: "1",
        apiCost: "0.01",
      })).then(
        (value) => ({ ok: true, value }),
        (error) => ({ ok: false, error }),
      ).finally(() => { lateFinished = true; });
      await delay(150);
      check(!lateFinished, "late settlement did not wait for close-first barrier");
      await closeClient.query("commit");
      lateOutcome = await latePromise;
      check(!lateOutcome.ok && lateOutcome.error.code === "P3003", "late settlement was not rejected after close");
    } catch (error) {
      await closeClient.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      closeClient.release();
    }
    evidence.close_first = {
      settlement_waited_for_lock: true,
      late_settlement_sqlstate: lateOutcome.error.code,
      fact_count: 0,
    };

    const firstClose = closeOutcome.value;
    const replayClose = await closePeriod(
      pool,
      ENT_A,
      PERIOD_SETTLEMENT_FIRST,
      0,
      "settlement-first-close",
      "2026-07-02T00:00:00Z",
    );
    check(JSON.stringify(replayClose) === JSON.stringify(firstClose), "same close key did not replay same result");
    const concurrentReplays = await Promise.all(
      Array.from({ length: 20 }, () => closePeriod(
        pool,
        ENT_A,
        PERIOD_SETTLEMENT_FIRST,
        0,
        "settlement-first-close",
        "2026-07-02T00:00:00Z",
      )),
    );
    check(
      concurrentReplays.every((result) => JSON.stringify(result) === JSON.stringify(firstClose)),
      "concurrent close replay returned inconsistent results",
    );
    const secondCloseCode = await expectSqlState(
      () => closePeriod(pool, ENT_A, PERIOD_SETTLEMENT_FIRST, 0, "different-close-key", "2026-07-02T00:00:00Z"),
      "P3006",
      "different close key on CLOSED period",
    );
    const initialStatements = await statementRows(pool, PERIOD_SETTLEMENT_FIRST);
    check(initialStatements.length === 1, "duplicate close created statement");
    const firstHash = initialStatements[0].statement_hash;

    const reopenVersion = await pool.query(
      "select poc20_reopen_period($1,$2,$3,$4,$5) as version",
      [ENT_A, PERIOD_SETTLEMENT_FIRST, 1, "reopen-1", "2026-07-03T00:00:00Z"],
    );
    const replayReopen = await pool.query(
      "select poc20_reopen_period($1,$2,$3,$4,$5) as version",
      [ENT_A, PERIOD_SETTLEMENT_FIRST, 1, "reopen-1", "2026-07-04T00:00:00Z"],
    );
    check(reopenVersion.rows[0].version === 1 && replayReopen.rows[0].version === 1, "reopen idempotency failed");
    check((await periodState(pool, PERIOD_SETTLEMENT_FIRST)).status === "REOPENED", "period did not retain REOPENED state");
    check((await statementRows(pool, PERIOD_SETTLEMENT_FIRST)).length === 1, "reopen removed prior statement");

    await recordSettlement(pool, {
      enterpriseId: ENT_A,
      periodId: PERIOD_SETTLEMENT_FIRST,
      id: "63000000-0000-4000-8000-000000001004",
      occurredAt: "2026-06-20T01:00:00Z",
      settledAt: "2026-07-03T00:00:01Z",
      status: "SETTLED",
      inputTokens: "60",
      outputTokens: "6",
      apiCost: "0.60",
    });
    const secondClose = await beginAndClose(
      pool,
      ENT_A,
      PERIOD_SETTLEMENT_FIRST,
      1,
      "reclose-2",
      "2026-07-03T00:00:02Z",
    );
    check(secondClose.version === 2 && secondClose.fact_count === 2, "reclose did not produce version 2 with two facts");
    const reopenedStatements = await statementRows(pool, PERIOD_SETTLEMENT_FIRST);
    check(reopenedStatements.length === 2, "reclose statement history mismatch");
    check(reopenedStatements[0].statement_hash === firstHash, "reopen changed old statement hash");
    check(
      Number(reopenedStatements[0].ledger_watermark_seq) === 1
        && Number(reopenedStatements[1].ledger_watermark_seq) === 2,
      "statement settlement waterline did not advance monotonically",
    );
    const delayedReplay = await pool.query(
      "select poc20_reopen_period($1,$2,$3,$4,$5) as version",
      [ENT_A, PERIOD_SETTLEMENT_FIRST, 1, "reopen-1", "2026-07-05T00:00:00Z"],
    );
    check(delayedReplay.rows[0].version === 1, "old reopen replay did not return original result");
    check((await periodState(pool, PERIOD_SETTLEMENT_FIRST)).status === "CLOSED", "old reopen replay reopened version 2");
    const abaCode = await expectSqlState(
      () => pool.query(
        "select poc20_reopen_period($1,$2,$3,$4,$5)",
        [ENT_A, PERIOD_SETTLEMENT_FIRST, 1, "stale-reopen-new-key", "2026-07-05T00:00:01Z"],
      ),
      "P3013",
      "stale reopen ABA",
    );
    const recomputed = await pool.query(`
      select trim(statement_hash) as stored,
             encode(digest(convert_to(payload::text, 'UTF8'), 'sha256'), 'hex') as recomputed
        from poc20_operating_statement
       where period_id = $1 order by version
    `, [PERIOD_SETTLEMENT_FIRST]);
    check(recomputed.rows.every((row) => row.stored === row.recomputed), "statement hash is not reproducible");
    const immutableCode = await expectSqlState(
      () => pool.query("update poc20_operating_statement set fact_count = fact_count + 1 where period_id = $1", [PERIOD_SETTLEMENT_FIRST]),
      "P3008",
      "statement immutability",
    );
    evidence.idempotency_and_reopen = {
      same_close_key_replayed: true,
      concurrent_same_key_replays: concurrentReplays.length,
      different_close_key_sqlstate: secondCloseCode,
      reopen_replayed: true,
      stale_reopen_replay_changed_state: false,
      stale_reopen_new_key_sqlstate: abaCode,
      versions: 2,
      settlement_watermarks: reopenedStatements.map((row) => Number(row.ledger_watermark_seq)),
      old_statement_hash_unchanged: true,
      statement_hash_recomputed: true,
      immutable_sqlstate: immutableCode,
    };

    const lockClient = await pool.connect();
    try {
      await lockClient.query("begin");
      await lockClient.query("select poc20_period_lock($1,$2)", [ENT_A, PERIOD_TZ_A]);
      const independent = Promise.race([
        beginCheck(pool, ENT_B, PERIOD_TZ_B, 0, "2026-08-01T03:00:00Z", 30).then((attempt) => ({ attempt })),
        delay(750).then(() => ({ timeout: true })),
      ]);
      const outcome = await independent;
      check(!outcome.timeout, "different enterprise period lock was blocked");
      await failCheck(
        pool,
        ENT_B,
        PERIOD_TZ_B,
        outcome.attempt,
        [{ code: "INDEPENDENCE_PROBE", retryable: true }],
        "2026-08-01T03:00:01Z",
      );
      await lockClient.query("commit");
      evidence.enterprise_lock_independence = true;
    } catch (error) {
      await lockClient.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      lockClient.release();
    }

    const sameInstant = "2026-08-01T03:00:00Z";
    await recordSettlement(pool, {
      enterpriseId: ENT_A,
      periodId: PERIOD_TZ_A,
      id: "63000000-0000-4000-8000-000000001005",
      occurredAt: sameInstant,
      settledAt: "2026-08-01T03:00:01Z",
      status: "SETTLED",
      inputTokens: "8",
      outputTokens: "1",
      apiCost: "0.08",
    });
    await recordSettlement(pool, {
      enterpriseId: ENT_B,
      periodId: PERIOD_TZ_B,
      id: "63000000-0000-4000-8000-000000001006",
      occurredAt: sameInstant,
      settledAt: "2026-08-01T03:00:01Z",
      status: "SETTLED",
      inputTokens: "7",
      outputTokens: "1",
      apiCost: "0.07",
    });
    const boundaryCode = await expectSqlState(
      () => recordSettlement(pool, {
        enterpriseId: ENT_A,
        periodId: PERIOD_TZ_A,
        id: "63000000-0000-4000-8000-000000001007",
        occurredAt: "2026-08-31T16:00:00Z",
        settledAt: "2026-08-31T16:00:01Z",
        status: "SETTLED",
        inputTokens: "1",
        outputTokens: "0",
        apiCost: "0.01",
      }),
      "P3005",
      "exclusive period end boundary",
    );
    const [tzAClose, tzBClose] = await Promise.all([
      beginAndClose(pool, ENT_A, PERIOD_TZ_A, 0, "tz-a-close", "2026-09-01T00:00:00Z"),
      beginAndClose(pool, ENT_B, PERIOD_TZ_B, 0, "tz-b-close", "2026-08-01T08:00:00Z"),
    ]);
    check(tzAClose.fact_count === 1 && tzBClose.fact_count === 1, "timezone period attribution failed");
    evidence.timezone_attribution = {
      instant: sameInstant,
      asia_shanghai_period: "2026-08",
      america_los_angeles_period: "2026-07",
      fact_count_each: 1,
      exclusive_end_sqlstate: boundaryCode,
    };

    const finalChecking = await pool.query("select count(*)::int as count from operating_bill_period where status = 'CHECKING'");
    check(finalChecking.rows[0].count === 0, "permanent CHECKING period remains");
    const duplicateFacts = await pool.query(`
      select count(*)::int as count from (
        select enterprise_id, period_id, id, count(*)
          from poc20_settlement_fact group by enterprise_id, period_id, id having count(*) > 1
      ) duplicates
    `);
    check(duplicateFacts.rows[0].count === 0, "duplicate settlement facts found");
    const statementMismatches = await pool.query(`
      select count(*)::int as count
        from operating_bill_period period
        join poc20_operating_statement statement
          on statement.enterprise_id = period.enterprise_id
         and statement.period_id = period.id
         and statement.version = period.current_version
       where period.current_version > 0
         and trim(statement.statement_hash) <> trim(period.current_statement_hash)
    `);
    check(statementMismatches.rows[0].count === 0, "current period points to a mismatched statement hash");
    const runningChecks = await pool.query(
      "select count(*)::int as count from poc20_period_check where result = 'RUNNING'",
    );
    check(runningChecks.rows[0].count === 0, "unfinished period checks remain");
    evidence.final_invariants = {
      permanent_checking_periods: 0,
      running_checks: 0,
      duplicate_settlements: 0,
      statement_version_hash_mismatches: 0,
    };

    console.log(JSON.stringify({
      result: "PASS_WITH_LIMITATIONS",
      scope: "existing 1.0 concurrency regression plus representative 2.0 period overlay; not product implementation",
      evidence,
    }, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
