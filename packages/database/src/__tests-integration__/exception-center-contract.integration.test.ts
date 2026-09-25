import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  startPostgresContainer,
  type PostgresTestInstance,
} from "@qianliu/testing";
import { createKysely } from "../kysely.js";
import { createMigrator, migrateDown, migrateToLatest } from "../migrator.js";
import { verifyAlertRecoveries } from "../repositories/alert-event-recovery.js";
import { deriveBackgroundFaults } from "../repositories/alert-event-background.js";
import {
  deriveDispatchAlerts,
  deriveFailedRequestAlerts,
} from "../repositories/alert-event-request-derivations.js";
import { AlertEventRepository } from "../repositories/alert-event-repository.js";
import { writeObservationFault } from "../repositories/alert-observation-writer.js";
import { OperationalFaultRepository } from "../repositories/operational-fault-repository.js";
import { sql } from "kysely";

let pg: PostgresTestInstance;
let db: ReturnType<typeof createKysely>;
beforeAll(async () => {
  pg = await startPostgresContainer();
  db = createKysely(pg.connectionString);
  const source = await createMigrator(db).migrateTo("0069_auth_error_evidence");
  expect(source.error).toBeUndefined();
  expect(await migrateToLatest(db)).toEqual([
    "0070_alert_recovery_evidence",
    "0071_enterprise_contact_details",
    "0072_admin_roles_security",
    "0073_credential_chat_probe",
    "0074_runtime_notification_recipients",
    "0075_provider_resource_archive",
    "0076_provider_model_probe",
    "0077_provider_model_probe_run_identity",
    "0078_provider_model_probe_enum_checks",
    "0079_project_allocation_relations",
    "0080_project_allocation_compute",
    "0081_provider_finance_activation",
    "0082_provider_finance_candidate_draft",
  ]);
}, 120_000);
afterAll(async () => {
  await db?.destroy();
  await pg?.stop();
});
async function fixture() {
  const enterpriseId = randomUUID(),
    principalId = randomUUID(),
    adminId = randomUUID();
  await db
    .insertInto("enterprise")
    .values({ id: enterpriseId, name: "异常中心合同" })
    .execute();
  await db
    .insertInto("admin_user")
    .values({
      id: adminId,
      enterprise_id: enterpriseId,
      username: adminId,
      password_hash: "test-only",
    })
    .execute();
  await db
    .insertInto("principal")
    .values({
      id: principalId,
      enterprise_id: enterpriseId,
      type: "EMPLOYEE",
      name: "主体",
    })
    .execute();
  const key = await db
    .insertInto("principal_key")
    .values({
      enterprise_id: enterpriseId,
      principal_id: principalId,
      key_prefix: "test",
      key_digest: randomUUID(),
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  const provider = await db
    .insertInto("provider")
    .values({
      enterprise_id: enterpriseId,
      code: "test",
      name: "厂商",
      adapter_type: "OPENAI_COMPATIBLE",
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  const resource = await db
    .insertInto("provider_resource")
    .values({
      enterprise_id: enterpriseId,
      provider_id: provider.id,
      name: "资源",
      mode: "API",
      credential_type: "API_KEY",
      status: "ACTIVE",
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return {
    enterpriseId,
    principalId,
    adminId,
    keyId: key.id,
    resourceId: resource.id,
    providerId: provider.id,
    repo: new AlertEventRepository(db),
  };
}
async function request(
  t: Awaited<ReturnType<typeof fixture>>,
  input: {
    status?: string;
    code?: string;
    classification?: string;
    stream?: boolean;
    model?: string;
    modelId?: string;
    at?: Date;
    finishedAt?: Date;
  } = {},
) {
  const id = randomUUID(),
    at = input.at ?? new Date("2026-08-19T04:00:00Z");
  await db
    .insertInto("ai_request")
    .values({
      id,
      enterprise_id: t.enterpriseId,
      principal_id: t.principalId,
      principal_key_id: t.keyId,
      protocol: "chat",
      unified_model: input.model ?? "model-A",
      unified_model_id: input.modelId ?? null,
      status: input.status ?? "FAILED",
      stream: input.stream ?? false,
      started_at: at,
      finished_at: input.finishedAt ?? at,
      error_classification:
        input.status === "SUCCEEDED"
          ? null
          : (input.classification ?? "UPSTREAM_TEMPORARY"),
      error_code:
        input.status === "SUCCEEDED" ? null : (input.code ?? "upstream_error"),
    })
    .execute();
  const attempt = await db
    .insertInto("upstream_attempt")
    .values({
      enterprise_id: t.enterpriseId,
      ai_request_id: id,
      attempt_no: 1,
      provider_resource_id: t.resourceId,
      upstream_model: input.model ?? "model-A",
      started_at: at,
      finished_at: input.finishedAt ?? at,
      http_status: input.status === "SUCCEEDED" ? 200 : 500,
      error_code: input.status === "SUCCEEDED" ? null : "upstream_error",
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return { id, attemptId: attempt.id };
}

it("F01 retains failed sync history before the first visit and separates recurrence", async () => {
  const t = await fixture();
  await operating(t, "FAILED", "SUCCESS", "2026-08-19");
  await operating(t, "SUCCESS", "NOT_SUPPORTED", "2026-08-20");
  await operating(t, "FAILED", "SUCCESS", "2026-09-01");
  const active = (await t.repo.evaluate(t.enterpriseId)).filter(
    (a) => a.signal === "operating_sync_failure",
  );
  const history = (await t.repo.listHistory(t.enterpriseId)).filter(
    (a) => a.signal === "operating_sync_failure",
  );
  expect(active).toHaveLength(1);
  expect(active[0]?.firstSeenAt).toBe("2026-09-01T00:00:00.000Z");
  expect(history).toHaveLength(1);
  expect(history[0]).toMatchObject({
    firstSeenAt: "2026-08-19T00:00:00.000Z",
    sourceClearedAt: "2026-08-20T00:01:00.000Z",
    recoveryEvidence: { kind: "TASK_SUCCEEDED" },
  });
  await t.repo.evaluate(t.enterpriseId);
  expect(
    (await t.repo.listHistory(t.enterpriseId)).filter(
      (a) => a.signal === "operating_sync_failure",
    ),
  ).toHaveLength(1);
  const other = await fixture();
  expect(await other.repo.evaluate(other.enterpriseId)).toEqual([]);
});

it("F02 splits a recovered episode before a new failure without a page visit", async () => {
  const t = await fixture();
  const first = await observation(t);
  await t.repo.setDisposition(
    t.enterpriseId,
    first.row.alert_key,
    "RESOLVED",
    "已检查",
    t.adminId,
    first.row.id,
  );
  await request(t, {
    status: "SUCCEEDED",
    at: new Date("2026-08-20T04:00:00Z"),
  });
  // The resource is unhealthy again now; that must not erase its earlier success.
  await db
    .updateTable("provider_resource")
    .set({ status: "DEGRADED", consecutive_failures: 1 })
    .where("id", "=", t.resourceId)
    .execute();
  const next = await observation(t, "2026-09-01T04:00:00Z");
  expect(next.row.id).not.toBe(first.row.id);
  expect(next.row.first_seen_at.toISOString()).toBe("2026-09-01T04:00:00.000Z");
  expect(next.row.recovery_evidence).toBeNull();
  const old = await db
    .selectFrom("alert_event")
    .selectAll()
    .where("id", "=", first.row.id)
    .executeTakeFirstOrThrow();
  expect(old.status).toBe("RESOLVED");
  expect(old.resolution_note).toBe("已检查");
  expect(old.source_cleared_at?.toISOString()).toBe("2026-08-20T04:00:00.000Z");
});

it("F03 uses the triggering request month and keeps the observation clock separate", async () => {
  const t = await fixture();
  const trigger = await request(t, {
    at: new Date("2026-08-31T15:59:59Z"),
    finishedAt: new Date("2026-08-31T16:00:01Z"),
  });
  const event = await blockEvent(t, "BLOCKED_UPSTREAM");
  await db
    .updateTable("availability_event")
    .set({
      trigger_ai_request_id: trigger.id,
      trigger_principal_id: t.principalId,
    })
    .where("id", "=", event.id)
    .execute();
  const alert = (await t.repo.evaluate(t.enterpriseId)).find(
    (a) => a.alertKey === "AVAILABILITY:" + event.id,
  );
  expect(alert?.firstSeenAt).toBe("2026-08-31T15:59:59.000Z");
  expect(alert?.lastSeenAt).toBe(event.started_at.toISOString());
  const unlinked = await blockEvent(t, "BLOCKED_UPSTREAM");
  expect(
    (await t.repo.evaluate(t.enterpriseId)).find(
      (a) => a.alertKey === "AVAILABILITY:" + unlinked.id,
    )?.firstSeenAt,
  ).toBe(unlinked.started_at.toISOString());
  const other = await fixture();
  const foreign = await request(other);
  await db
    .updateTable("availability_event")
    .set({ trigger_ai_request_id: foreign.id })
    .where("id", "=", unlinked.id)
    .execute();
  expect(
    (await t.repo.evaluate(t.enterpriseId)).find(
      (a) => a.alertKey === "AVAILABILITY:" + unlinked.id,
    )?.firstSeenAt,
  ).toBe(unlinked.started_at.toISOString());
});

it("F02 cannot split an episode on another model's success or on a success after the incoming failure", async () => {
  const t = await fixture();
  const first = await observation(t);
  await request(t, {
    status: "SUCCEEDED",
    model: "model-B",
    at: new Date("2026-08-20T04:00:00Z"),
  });
  await request(t, {
    status: "SUCCEEDED",
    at: new Date("2026-09-02T04:00:00Z"),
  });
  const second = await observation(t, "2026-09-01T04:00:00Z");
  expect(second.row.id).toBe(first.row.id);
  expect(second.row.recovery_evidence).toBeNull();
});

it("usage/fee/forecast warnings are excluded from active and historical lists without deleting facts", async () => {
  const t = await fixture();
  for (const [index, signal] of [
    "principal_usage_anomaly",
    "supply_anomaly",
    "department_budget_warning",
  ].entries()) {
    await db
      .insertInto("alert_event")
      .values({
        enterprise_id: t.enterpriseId,
        alert_key: `warning:${index}`,
        domain: "USAGE_SPIKE",
        signal,
        title: "阈值预警",
        status: index ? "RESOLVED" : "OPEN",
      })
      .execute();
  }
  expect(await t.repo.evaluate(t.enterpriseId)).toEqual([]);
  expect(await t.repo.listHistory(t.enterpriseId)).toEqual([]);
  expect(
    await db
      .selectFrom("alert_event")
      .select("id")
      .where("enterprise_id", "=", t.enterpriseId)
      .execute(),
  ).toHaveLength(3);
});

it("real failed requests use occurrence dates, include missing routing/stream classes and skip ordinary quota/policy/cancel outcomes", async () => {
  const t = await fixture();
  const routing = await request(t, {
    classification: "NO_HEALTHY_CANDIDATE",
    code: "no_healthy_candidate",
  });
  const stream = await request(t, {
    classification: "STREAM_INTERRUPTED_AFTER_COMMIT",
    stream: true,
  });
  const cancelledStream = await request(t, {
    classification: "CLIENT_CANCEL_NOT_PROPAGATED",
    stream: true,
  });
  const failure = await request(t);
  const missing = await request(t);
  await db
    .updateTable("ai_request")
    .set({ error_classification: null, error_code: null, finished_at: null })
    .where("id", "=", missing.id)
    .execute();
  for (const code of [
    "client_cancelled",
    "quota_exceeded",
    "dispatch_rejected",
  ])
    await request(t, { code });
  const alerts = await t.repo.evaluate(t.enterpriseId);
  expect(alerts).toHaveLength(5);
  expect(alerts.find((a) => a.aiRequestId === routing.id)?.signal).toBe(
    "routing_anomaly",
  );
  expect(alerts.find((a) => a.aiRequestId === stream.id)?.signal).toBe(
    "streaming_anomaly",
  );
  expect(alerts.find((a) => a.aiRequestId === failure.id)).toMatchObject({
    signal: "request_failure",
    model: "model-A",
    firstSeenAt: "2026-08-19T04:00:00.000Z",
    lastSeenAt: "2026-08-19T04:00:00.000Z",
    detail: "模型 model-A；分类 UPSTREAM_TEMPORARY；错误码 upstream_error",
  });
  expect(alerts.find((a) => a.aiRequestId === routing.id)).toMatchObject({
    alertKey: `RESOURCE_UNAVAILABLE:routing:${routing.id}`,
    title: "路由无可用候选",
    detail:
      "模型 model-A；分类 NO_HEALTHY_CANDIDATE；错误码 no_healthy_candidate",
  });
  expect(alerts.find((a) => a.aiRequestId === stream.id)).toMatchObject({
    alertKey: `RESOURCE_UNAVAILABLE:streaming:${stream.id}`,
    title: "流式响应异常",
    detail:
      "模型 model-A；分类 STREAM_INTERRUPTED_AFTER_COMMIT；错误码 upstream_error",
  });
  expect(
    alerts.find((a) => a.aiRequestId === cancelledStream.id),
  ).toMatchObject({
    signal: "streaming_anomaly",
    title: "流式响应异常",
    detail:
      "模型 model-A；分类 CLIENT_CANCEL_NOT_PROPAGATED；错误码 upstream_error",
  });
  expect(alerts.find((a) => a.aiRequestId === missing.id)).toMatchObject({
    alertKey: `RESOURCE_UNAVAILABLE:request:${missing.id}`,
    signal: "request_failure",
    title: "模型调用失败",
    detail: "模型 model-A；分类 未分类；错误码 未记录",
    lastSeenAt: "2026-08-19T04:00:00.000Z",
  });
  await t.repo.evaluate(t.enterpriseId);
  expect(
    await db
      .selectFrom("alert_event")
      .select("id")
      .where("enterprise_id", "=", t.enterpriseId)
      .execute(),
  ).toHaveLength(5);
});

it("absence, normal resource state and unrelated model successes cannot turn observations green; matching success can", async () => {
  const t = await fixture();
  const failed = await request(t);
  await writeObservationFault(
    db,
    {
      ...t,
      providerResourceId: t.resourceId,
      unifiedModelId: null,
      upstreamModel: "model-A",
      signal: "TECHNICAL_FAILURE",
      aiRequestId: failed.id,
      mode: "OBSERVE",
      wecomNotify: false,
    },
    new Date("2026-08-19T04:00:00Z"),
  );
  const observation = (await t.repo.evaluate(t.enterpriseId)).find((a) =>
    a.alertKey.startsWith("RUNTIME_ASSURANCE:"),
  )!;
  expect(observation).toMatchObject({
    status: "OPEN",
    recoveryEvidence: null,
    sourceClearedAt: null,
  });
  await request(t, {
    status: "SUCCEEDED",
    model: "model-B",
    at: new Date("2026-08-20T04:00:00Z"),
  });
  await t.repo.evaluate(t.enterpriseId);
  expect(
    (await t.repo.list(t.enterpriseId)).find((a) => a.id === observation.id)
      ?.recoveryEvidence,
  ).toBeNull();
  const success = await request(t, {
    status: "SUCCEEDED",
    at: new Date("2026-09-03T04:00:00Z"),
  });
  await t.repo.evaluate(t.enterpriseId);
  const recovered = (await t.repo.listHistory(t.enterpriseId)).find(
    (a) => a.id === observation.id,
  )!;
  expect(recovered).toMatchObject({
    status: "AUTO_RESOLVED",
    firstSeenAt: "2026-08-19T04:00:00.000Z",
    recoveryEvidence: {
      kind: "SUCCESSFUL_REQUEST",
      referenceId: success.attemptId,
      verifiedAt: expect.any(String),
    },
  });
  expect(
    await t.repo.setDisposition(
      t.enterpriseId,
      recovered.alertKey,
      "RESOLVED",
      "已验证同一资源恢复",
      t.adminId,
      recovered.id,
    ),
  ).toBe(true);
  expect(
    (await t.repo.listHistory(t.enterpriseId)).find(
      (a) => a.id === observation.id,
    ),
  ).toMatchObject({
    status: "RESOLVED",
    resolutionNote: "已验证同一资源恢复",
    recoveryEvidence: { referenceId: success.attemptId },
  });
});

it("recovery follows stable model identity across renames and never accepts a recycled alias", async () => {
  const t = await fixture();
  const modelA = await db
    .insertInto("unified_model")
    .values({
      enterprise_id: t.enterpriseId,
      alias: "old-name",
      display_name: "A",
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  const failed = await request(t, { model: "old-name", modelId: modelA.id });
  await writeObservationFault(
    db,
    {
      ...t,
      providerResourceId: t.resourceId,
      unifiedModelId: modelA.id,
      upstreamModel: "vendor-A",
      signal: "TECHNICAL_FAILURE",
      aiRequestId: failed.id,
      mode: "OBSERVE",
      wecomNotify: false,
    },
    new Date("2026-08-19T04:00:00Z"),
  );
  await db
    .updateTable("unified_model")
    .set({ alias: "renamed-A" })
    .where("id", "=", modelA.id)
    .execute();
  const modelB = await db
    .insertInto("unified_model")
    .values({
      enterprise_id: t.enterpriseId,
      alias: "old-name",
      display_name: "B",
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  await request(t, {
    status: "SUCCEEDED",
    model: "old-name",
    modelId: modelB.id,
    at: new Date("2026-08-20T00:00:00Z"),
  });
  expect(
    (await t.repo.evaluate(t.enterpriseId)).find((a) =>
      a.alertKey.startsWith("RUNTIME_ASSURANCE:"),
    )?.recoveryEvidence,
  ).toBeNull();
  const correct = await request(t, {
    status: "SUCCEEDED",
    model: "renamed-A",
    modelId: modelA.id,
    at: new Date("2026-08-21T00:00:00Z"),
  });
  await t.repo.evaluate(t.enterpriseId);
  expect(
    (await t.repo.listHistory(t.enterpriseId)).find((a) =>
      a.alertKey.startsWith("RUNTIME_ASSURANCE:"),
    )?.recoveryEvidence,
  ).toMatchObject({
    kind: "SUCCESSFUL_REQUEST",
    referenceId: correct.attemptId,
  });
});

it("manual handling needs a note and commits it together with audit; failed audit rolls back", async () => {
  const t = await fixture();
  await request(t);
  const alert = (await t.repo.evaluate(t.enterpriseId))[0]!;
  for (const note of [undefined, " "])
    await expect(
      t.repo.setDisposition(
        t.enterpriseId,
        alert.alertKey,
        "RESOLVED",
        note,
        t.adminId,
        alert.id,
      ),
    ).rejects.toThrow("已处理必须填写处理说明");
  expect(
    await t.repo.setDisposition(
      randomUUID(),
      alert.alertKey,
      "RESOLVED",
      "跨企业",
      t.adminId,
      alert.id,
    ),
  ).toBe(false);
  await sql`CREATE FUNCTION fault_test_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.action='alert.disposition' THEN RAISE EXCEPTION 'audit failure'; END IF; RETURN NEW; END $$`.execute(
    db,
  );
  await sql`CREATE TRIGGER fault_test_audit_failure BEFORE INSERT ON operation_log FOR EACH ROW EXECUTE FUNCTION fault_test_audit_failure()`.execute(
    db,
  );
  try {
    await expect(
      t.repo.setDisposition(
        t.enterpriseId,
        alert.alertKey,
        "RESOLVED",
        "已核对",
        t.adminId,
        alert.id,
      ),
    ).rejects.toThrow("audit failure");
  } finally {
    await sql`DROP TRIGGER fault_test_audit_failure ON operation_log`.execute(
      db,
    );
    await sql`DROP FUNCTION fault_test_audit_failure()`.execute(db);
  }
  expect((await t.repo.list(t.enterpriseId))[0]?.status).toBe("OPEN");
  expect(
    await t.repo.setDisposition(
      t.enterpriseId,
      alert.alertKey,
      "RESOLVED",
      "  已核对并重试  ",
      t.adminId,
      alert.id,
    ),
  ).toBe(true);
  const logs = await db
    .selectFrom("operation_log")
    .select(["target_id", "change_summary"])
    .where("enterprise_id", "=", t.enterpriseId)
    .execute();
  expect(logs).toEqual([
    {
      target_id: alert.id,
      change_summary: {
        alert_key: alert.alertKey,
        status: "RESOLVED",
        resolution_note: "已核对并重试",
      },
    },
  ]);
});

it("background failure is recovered only by a later completed task, not by opening the page", async () => {
  const t = await fixture(),
    jobs = new OperationalFaultRepository(db);
  await jobs.record(
    "test-task",
    "测试任务",
    false,
    new Date("2026-08-19T00:00:00Z"),
  );
  const fault = (await t.repo.evaluate(t.enterpriseId)).find(
    (a) => a.alertKey === "SYSTEM_TASK:test-task",
  )!;
  expect(fault.status).toBe("OPEN");
  await jobs.record(
    "test-task",
    "测试任务",
    true,
    new Date("2026-09-03T00:00:00Z"),
  );
  expect(
    (await t.repo.listHistory(t.enterpriseId)).find((a) => a.id === fault.id),
  ).toMatchObject({
    firstSeenAt: "2026-08-19T00:00:00.000Z",
    recoveryEvidence: { kind: "TASK_SUCCEEDED" },
  });
});

it("late failures cannot lower the recovery barrier, and request completion orders long requests", async () => {
  const t = await fixture();
  const signal = (id: string, at: string) =>
    writeObservationFault(
      db,
      {
        ...t,
        providerResourceId: t.resourceId,
        unifiedModelId: null,
        upstreamModel: "model-A",
        signal: "TECHNICAL_FAILURE",
        aiRequestId: id,
        mode: "OBSERVE",
        wecomNotify: false,
      },
      new Date(at),
    );
  const older = await request(t, {
    at: new Date("2026-08-31T15:59:00Z"),
    finishedAt: new Date("2026-08-31T15:59:10Z"),
  });
  const newer = await request(t, {
    at: new Date("2026-08-31T16:03:00Z"),
    finishedAt: new Date("2026-08-31T16:04:00Z"),
  });
  await request(t, {
    status: "SUCCEEDED",
    at: new Date("2026-08-31T16:02:30Z"),
  });
  await signal(newer.id, "2026-08-31T16:03:00Z");
  await signal(older.id, "2026-08-31T15:59:00Z");
  let observation = (await t.repo.evaluate(t.enterpriseId)).find((a) =>
    a.alertKey.startsWith("RUNTIME_ASSURANCE:"),
  );
  expect(observation).toMatchObject({
    status: "OPEN",
    recoveryEvidence: null,
    aiRequestId: newer.id,
    firstSeenAt: "2026-08-31T15:59:00.000Z",
    lastSeenAt: "2026-08-31T16:04:00.000Z",
  });
  const long = await request(t, {
    at: new Date("2026-08-31T16:00:00Z"),
    finishedAt: new Date("2026-08-31T16:06:00Z"),
  });
  await request(t, {
    status: "SUCCEEDED",
    at: new Date("2026-08-31T16:05:00Z"),
  });
  await signal(long.id, "2026-08-31T16:00:00Z");
  observation = (await t.repo.evaluate(t.enterpriseId)).find((a) =>
    a.alertKey.startsWith("RUNTIME_ASSURANCE:"),
  );
  expect(observation).toMatchObject({
    status: "OPEN",
    recoveryEvidence: null,
    aiRequestId: long.id,
    lastSeenAt: "2026-08-31T16:06:00.000Z",
  });
  const success = await request(t, {
    status: "SUCCEEDED",
    at: new Date("2026-08-31T16:07:00Z"),
  });
  await t.repo.evaluate(t.enterpriseId);
  expect(
    (await t.repo.listHistory(t.enterpriseId)).find(
      (a) => a.id === observation?.id,
    ),
  ).toMatchObject({
    status: "AUTO_RESOLVED",
    recoveryEvidence: { referenceId: success.attemptId },
  });
  // A replay after recovery belongs to the old occurrence, not a fresh current fault.
  await signal(older.id, "2026-08-31T15:59:00Z");
  expect(
    (await t.repo.evaluate(t.enterpriseId)).filter((a) =>
      a.alertKey.startsWith("RUNTIME_ASSURANCE:"),
    ),
  ).toEqual([]);
  const recoveredEpisodes = (await t.repo.listHistory(t.enterpriseId)).filter(
    (a) => a.alertKey.startsWith("RUNTIME_ASSURANCE:"),
  );
  // The 16:05 success now closes the earlier failure even without a page visit.
  // The long request fails at 16:06, so it is a separate episode, recovered at 16:07.
  expect(recoveredEpisodes).toHaveLength(2);
  expect(recoveredEpisodes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        aiRequestId: newer.id,
        sourceClearedAt: "2026-08-31T16:05:00.000Z",
      }),
      expect.objectContaining({
        aiRequestId: long.id,
        sourceClearedAt: "2026-08-31T16:07:00.000Z",
      }),
    ]),
  );
  const recurrence = await request(t, { at: new Date("2026-09-02T00:00:00Z") });
  await signal(recurrence.id, "2026-09-02T00:00:00Z");
  expect(
    (await t.repo.evaluate(t.enterpriseId)).find((a) =>
      a.alertKey.startsWith("RUNTIME_ASSURANCE:"),
    ),
  ).toMatchObject({
    status: "OPEN",
    aiRequestId: recurrence.id,
    firstSeenAt: "2026-09-02T00:00:00.000Z",
  });
  await signal(older.id, "2026-08-31T15:59:00Z");
  expect(
    (await t.repo.evaluate(t.enterpriseId)).find((a) =>
      a.alertKey.startsWith("RUNTIME_ASSURANCE:"),
    ),
  ).toMatchObject({
    aiRequestId: recurrence.id,
    firstSeenAt: "2026-09-02T00:00:00.000Z",
  });
});

async function blockEvent(
  t: Awaited<ReturnType<typeof fixture>>,
  decision: "BLOCKED_SCHEDULE" | "BLOCKED_UPSTREAM",
) {
  const rule = await db
    .insertInto("availability_rule")
    .values({
      name: decision,
      rule_type:
        decision === "BLOCKED_SCHEDULE" ? "SCHEDULE_BLOCK" : "UPSTREAM_SIGNAL",
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  const version = await db
    .insertInto("availability_rule_version")
    .values({
      availability_rule_id: rule.id,
      rule_version: 1,
      action: "BLOCK",
      recovery_method: "MANUAL",
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return db
    .insertInto("availability_event")
    .values({
      availability_rule_id: rule.id,
      rule_version_id: version.id,
      rule_version: 1,
      event_number: "BRK-" + randomUUID().slice(0, 20),
      dedup_key: randomUUID(),
      provider_id: t.providerId,
      provider_resource_id: t.resourceId,
      unified_signal: "UPSTREAM_MAINTENANCE",
      availability_decision: decision,
      recovery_method: "MANUAL",
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

it("planned runtime blocks are excluded from new and historical faults without hiding upstream blocks or cross-tenant uncertainty", async () => {
  const t = await fixture(),
    other = await fixture();
  const planned = await blockEvent(t, "BLOCKED_SCHEDULE");
  const upstream = await blockEvent(t, "BLOCKED_UPSTREAM");
  const foreign = await blockEvent(other, "BLOCKED_SCHEDULE");
  const plannedRequest = await request(t, {
    classification: "RUNTIME_ASSURANCE_BLOCKED",
    code: planned.event_number,
  });
  await db
    .deleteFrom("upstream_attempt")
    .where("ai_request_id", "=", plannedRequest.id)
    .execute();
  const actualFault = await request(t, {
    classification: "RUNTIME_ASSURANCE_BLOCKED",
    code: upstream.event_number,
  });
  const uncertain = await request(t, {
    classification: "RUNTIME_ASSURANCE_BLOCKED",
    code: foreign.event_number,
  });
  const notPolicy = await request(t, {
    classification: "UPSTREAM_TEMPORARY",
    code: planned.event_number,
  });
  for (const status of ["OPEN", "RESOLVED"])
    await db
      .insertInto("alert_event")
      .values({
        enterprise_id: t.enterpriseId,
        alert_key: "legacy-planned:" + status,
        domain: "RESOURCE_UNAVAILABLE",
        signal: "request_failure",
        title: "误收录的计划停用",
        status,
        ai_request_id: plannedRequest.id,
      })
      .execute();
  const faults = (await t.repo.evaluate(t.enterpriseId)).filter(
    (a) => a.signal === "request_failure",
  );
  expect(faults.map((a) => a.aiRequestId).sort()).toEqual(
    [actualFault.id, uncertain.id, notPolicy.id].sort(),
  );
  expect(await t.repo.listHistory(t.enterpriseId)).toEqual([]);
  expect(
    await t.repo.setDisposition(
      t.enterpriseId,
      "legacy-planned:OPEN",
      "RESOLVED",
      "不应处置",
      t.adminId,
    ),
  ).toBe(false);
  expect(
    await db
      .selectFrom("alert_event")
      .select("id")
      .where("ai_request_id", "=", plannedRequest.id)
      .execute(),
  ).toHaveLength(2);
});

async function observation(
  t: Awaited<ReturnType<typeof fixture>>,
  at = "2026-08-19T04:00:00Z",
) {
  const failed = await request(t, { at: new Date(at) });
  await writeObservationFault(
    db,
    {
      ...t,
      providerResourceId: t.resourceId,
      unifiedModelId: null,
      upstreamModel: "model-A",
      signal: "TECHNICAL_FAILURE",
      aiRequestId: failed.id,
      mode: "OBSERVE",
      wecomNotify: false,
    },
    new Date(at),
  );
  const row = await db
    .selectFrom("alert_event")
    .selectAll()
    .where("enterprise_id", "=", t.enterpriseId)
    .where("ai_request_id", "=", failed.id)
    .executeTakeFirstOrThrow();
  return { failed, row };
}
it.each([
  "resource",
  "request-status",
  "request-error",
  "http",
  "attempt-error",
  "observed-time",
  "trigger-time",
  "future",
  "resource-state",
  "failures",
  "credential",
  "block",
  "legacy-key",
] as const)(
  "refuses successful-looking recovery when %s evidence is invalid",
  async (kind) => {
    const t = await fixture(),
      { failed, row } = await observation(t);
    const good = await request(t, {
      status: "SUCCEEDED",
      at: new Date("2026-08-20T04:00:00Z"),
    });
    if (kind === "resource") {
      const resource = await db
        .insertInto("provider_resource")
        .values({
          enterprise_id: t.enterpriseId,
          provider_id: t.providerId,
          name: "另一资源",
          mode: "API",
          credential_type: "API_KEY",
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      await db
        .updateTable("upstream_attempt")
        .set({ provider_resource_id: resource.id })
        .where("id", "=", good.attemptId)
        .execute();
    }
    if (kind === "request-status")
      await db
        .updateTable("ai_request")
        .set({ status: "FAILED" })
        .where("id", "=", good.id)
        .execute();
    if (kind === "request-error")
      await db
        .updateTable("ai_request")
        .set({ error_code: "still-failed" })
        .where("id", "=", good.id)
        .execute();
    if (kind === "http")
      await db
        .updateTable("upstream_attempt")
        .set({ http_status: 503 })
        .where("id", "=", good.attemptId)
        .execute();
    if (kind === "attempt-error")
      await db
        .updateTable("upstream_attempt")
        .set({ error_code: "stream-broke" })
        .where("id", "=", good.attemptId)
        .execute();
    if (kind === "observed-time")
      await db
        .updateTable("alert_event")
        .set({ last_seen_at: new Date("2026-08-21T00:00:00Z") })
        .where("id", "=", row.id)
        .execute();
    if (kind === "trigger-time")
      await db
        .updateTable("ai_request")
        .set({ finished_at: new Date("2026-08-21T00:00:00Z") })
        .where("id", "=", failed.id)
        .execute();
    if (kind === "future")
      await db
        .updateTable("upstream_attempt")
        .set({ finished_at: new Date("2099-01-01T00:00:00Z") })
        .where("id", "=", good.attemptId)
        .execute();
    if (kind === "resource-state")
      await db
        .updateTable("provider_resource")
        .set({ status: "DEGRADED" })
        .where("id", "=", t.resourceId)
        .execute();
    if (kind === "failures")
      await db
        .updateTable("provider_resource")
        .set({ consecutive_failures: 1 })
        .where("id", "=", t.resourceId)
        .execute();
    if (kind === "credential")
      await db
        .updateTable("provider_resource")
        .set({ credential_refresh_status: "FAILED" })
        .where("id", "=", t.resourceId)
        .execute();
    if (kind === "block") await blockEvent(t, "BLOCKED_UPSTREAM");
    if (kind === "legacy-key")
      await db
        .updateTable("alert_event")
        .set({
          alert_key: "RUNTIME_ASSURANCE:TECHNICAL_FAILURE:" + t.resourceId,
        })
        .where("id", "=", row.id)
        .execute();
    await verifyAlertRecoveries(db, t.enterpriseId);
    expect(
      await db
        .selectFrom("alert_event")
        .select(["status", "recovery_evidence", "source_cleared_at"])
        .where("id", "=", row.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({
      status: "OPEN",
      recovery_evidence: null,
      source_cleared_at: null,
    });
  },
);
it.each(["RESOLVED", "IGNORED"] as const)(
  "positive recovery preserves prior human %s and its audit/time",
  async (status) => {
    const t = await fixture(),
      { row } = await observation(t);
    expect(
      await t.repo.setDisposition(
        t.enterpriseId,
        row.alert_key,
        status,
        "已核对，等待验证",
        t.adminId,
        row.id,
      ),
    ).toBe(true);
    const before = await db
      .selectFrom("alert_event")
      .selectAll()
      .where("id", "=", row.id)
      .executeTakeFirstOrThrow();
    const good = await request(t, {
      status: "SUCCEEDED",
      at: new Date("2026-08-20T04:00:00Z"),
    });
    await verifyAlertRecoveries(db, t.enterpriseId);
    const after = await db
      .selectFrom("alert_event")
      .selectAll()
      .where("id", "=", row.id)
      .executeTakeFirstOrThrow();
    expect(after).toMatchObject({
      status,
      resolved_by: t.adminId,
      resolution_note: "已核对，等待验证",
      resolved_at: before.resolved_at,
      recovery_evidence: { referenceId: good.attemptId },
    });
    expect(
      await t.repo.setDisposition(
        t.enterpriseId,
        row.alert_key,
        "INVESTIGATING",
        "改写",
        t.adminId,
        row.id,
      ),
    ).toBe(false);
  },
);
it("concurrent observation writers retain the earliest occurrence and latest completion", async () => {
  const t = await fixture();
  const inputs = await Promise.all(
    [1, 2, 3].map((minute) =>
      request(t, { at: new Date("2026-08-19T00:0" + minute + ":00Z") }),
    ),
  );
  await Promise.all(
    [2, 0, 1].map((index) =>
      writeObservationFault(
        db,
        {
          ...t,
          providerResourceId: t.resourceId,
          unifiedModelId: null,
          upstreamModel: "model-A",
          signal: "TECHNICAL_FAILURE",
          aiRequestId: inputs[index]!.id,
          mode: "OBSERVE",
          wecomNotify: false,
        },
        new Date("2026-08-19T00:0" + (index + 1) + ":00Z"),
      ),
    ),
  );
  const rows = await db
    .selectFrom("alert_event")
    .selectAll()
    .where("enterprise_id", "=", t.enterpriseId)
    .execute();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    first_seen_at: new Date("2026-08-19T00:01:00Z"),
    last_seen_at: new Date("2026-08-19T00:03:00Z"),
    ai_request_id: inputs[2]!.id,
  });
});
async function quotaWindow(
  t: Awaited<ReturnType<typeof fixture>>,
  status: string,
  at: string,
  type = "FIVE_HOUR",
  current = true,
  error: string | null = null,
) {
  return db
    .insertInto("provider_quota_window")
    .values({
      enterprise_id: t.enterpriseId,
      provider_resource_id: t.resourceId,
      window_type: type,
      is_current: current,
      sync_status: status,
      sync_error_code: error,
      collected_at: new Date(at),
      source: "PROVIDER_SYNC",
      adapter_version: "test",
      unit: "PERCENT",
      ratio: "1",
    })
    .returning("id")
    .executeTakeFirstOrThrow();
}
it.each([
  ["SUCCESS", true, null, false],
  ["UNSUPPORTED", true, null, false],
  ["STALE", true, null, false],
  ["STALE", true, "failed", true],
  ["FAILED", true, null, true],
  ["FAILED", false, null, false],
] as const)(
  "quota sync fault uses current failed evidence (%s/%s/%s), not usage ratio",
  async (status, current, error, expected) => {
    const t = await fixture();
    await quotaWindow(
      t,
      status,
      "2026-08-19T00:00:00Z",
      "FIVE_HOUR",
      current,
      error,
    );
    const rows = await deriveBackgroundFaults(db, t.enterpriseId);
    expect(rows).toHaveLength(expected ? 1 : 0);
    if (expected)
      expect(rows[0]).toEqual({
        alertKey: "TASK:quota_sync:" + t.resourceId,
        domain: "RESOURCE_UNAVAILABLE",
        signal: "quota_sync_failure",
        severity: "HIGH",
        title: "厂商额度同步失败",
        detail: "后台同步未成功；请核对厂商连接和凭证",
        resourceId: t.resourceId,
        principalId: null,
        aiRequestId: null,
        occurredAt: new Date("2026-08-19T00:00:00Z"),
        observedAt: new Date("2026-08-19T00:00:00Z"),
      });
  },
);
it("background sources and quota-window queries remain tenant isolated", async () => {
  const a = await fixture(),
    b = await fixture();
  await quotaWindow(b, "FAILED", "2026-08-19T00:00:00Z");
  await blockEvent(b, "BLOCKED_UPSTREAM");
  expect(await deriveBackgroundFaults(db, a.enterpriseId)).toEqual([]);
});
async function operating(
  t: Awaited<ReturnType<typeof fixture>>,
  balance: string,
  cost: string,
  day = "2026-08-20",
) {
  return db
    .insertInto("provider_resource_operating_sync_attempt")
    .values({
      enterprise_id: t.enterpriseId,
      provider_resource_id: t.resourceId,
      sync_day: day,
      balance_status: balance,
      cost_status: cost,
      started_at: new Date(day + "T00:00:00Z"),
      completed_at: new Date(day + "T00:01:00Z"),
      next_sync_at: new Date(day + "T01:00:00Z"),
      adapter_version: "test",
    })
    .returning("id")
    .executeTakeFirstOrThrow();
}
it.each([
  ["FAILED", "SUCCESS", true],
  ["SUCCESS", "FAILED", true],
  ["FAILED", "FAILED", true],
  ["SUCCESS", "NOT_SUPPORTED", false],
  ["SUCCESS", "SUCCESS", false],
] as const)(
  "operating sync surfaces either failed component (%s/%s)",
  async (balance, cost, expected) => {
    const t = await fixture();
    const failed = await operating(t, balance, cost);
    const rows = await deriveBackgroundFaults(db, t.enterpriseId);
    expect(rows).toHaveLength(expected ? 1 : 0);
    if (expected)
      expect(rows[0]).toMatchObject({
        alertKey: "TASK:operating_sync:" + t.resourceId + ":" + failed.id,
        signal: "operating_sync_failure",
        title: "厂商经营数据同步失败",
        detail: "请检查厂商同步连接和凭证",
        occurredAt: new Date("2026-08-20T00:00:00Z"),
      });
    await operating(t, "SUCCESS", "SUCCESS", "2026-08-21");
    // Successful syncs move failed attempts into history instead of erasing them.
    expect(await deriveBackgroundFaults(db, t.enterpriseId)).toHaveLength(
      expected ? 1 : 0,
    );
    expect(
      (await t.repo.evaluate(t.enterpriseId)).filter(
        (a) => a.signal === "operating_sync_failure",
      ),
    ).toEqual([]);
    expect(
      (await t.repo.listHistory(t.enterpriseId)).filter(
        (a) => a.signal === "operating_sync_failure",
      ),
    ).toHaveLength(expected ? 1 : 0);
  },
);
it.each([
  ["FAILED", 0, true],
  ["PARTIAL", 1, true],
  ["PARTIAL", 0, false],
  ["SUCCEEDED", 1, false],
  ["QUEUED", 0, false],
] as const)(
  "directory faults require failure, or a partial outcome with failed rows (%s/%s)",
  async (status, failed, expected) => {
    const t = await fixture();
    await db
      .insertInto("directory_import_run")
      .values({
        enterprise_id: t.enterpriseId,
        mode: "EXCEL",
        job_type: "DIRECTORY_IMPORT_APPLY",
        template_version: "test",
        content_sha256: "a".repeat(64),
        request_hash: "b".repeat(64),
        idempotency_key: randomUUID(),
        created_by_admin_user_id: t.adminId,
        status,
        failed_count: failed,
        created_at: new Date("2026-08-19T00:00:00Z"),
      })
      .execute();
    const rows = await deriveBackgroundFaults(db, t.enterpriseId);
    expect(rows).toHaveLength(expected ? 1 : 0);
    if (expected)
      expect(rows[0]).toMatchObject({
        signal: "directory_task_failure",
        title: "通讯录后台任务失败",
        detail: "任务处理失败；请查看导入或同步记录",
        occurredAt: new Date("2026-08-19T00:00:00Z"),
      });
  },
);
it("only open upstream blocks, not planned or completed blocks, generate availability faults", async () => {
  const t = await fixture();
  await blockEvent(t, "BLOCKED_SCHEDULE");
  expect(await deriveBackgroundFaults(db, t.enterpriseId)).toEqual([]);
  const event = await blockEvent(t, "BLOCKED_UPSTREAM");
  expect(await deriveBackgroundFaults(db, t.enterpriseId)).toEqual([
    expect.objectContaining({
      alertKey: "AVAILABILITY:" + event.id,
      signal: "availability_fault",
      title: "上游服务阻断",
      detail: "上游明确返回不可用",
      resourceId: t.resourceId,
    }),
  ]);
  await db
    .updateTable("availability_event")
    .set({ status: "RECOVERED" })
    .where("id", "=", event.id)
    .execute();
  expect(await deriveBackgroundFaults(db, t.enterpriseId)).toEqual([]);
});
it("quota recovery requires all current windows to complete after the fault and at least one real success", async () => {
  const t = await fixture();
  await quotaWindow(t, "FAILED", "2026-08-19T00:00:00Z");
  const alert = (await t.repo.evaluate(t.enterpriseId)).find(
    (a) => a.signal === "quota_sync_failure",
  )!;
  await quotaWindow(t, "SUCCESS", "2026-08-20T00:00:00Z", "WEEKLY");
  await db
    .updateTable("provider_quota_window")
    .set({ collected_at: new Date("2026-08-20T00:00:00Z") })
    .where("provider_resource_id", "=", t.resourceId)
    .execute();
  const check = async () => {
    await verifyAlertRecoveries(db, t.enterpriseId);
    return (
      await db
        .selectFrom("alert_event")
        .selectAll()
        .where("id", "=", alert.id)
        .executeTakeFirstOrThrow()
    ).recovery_evidence;
  };
  expect(await check()).toBeNull();
  await db
    .updateTable("provider_quota_window")
    .set({ sync_status: "UNSUPPORTED" })
    .where("provider_resource_id", "=", t.resourceId)
    .execute();
  expect(await check()).toBeNull();
  await db
    .updateTable("provider_quota_window")
    .set({
      sync_status: "SUCCESS",
      collected_at: new Date("2026-08-18T00:00:00Z"),
    })
    .where("provider_resource_id", "=", t.resourceId)
    .where("window_type", "=", "FIVE_HOUR")
    .execute();
  expect(await check()).toBeNull();
  await db
    .updateTable("provider_quota_window")
    .set({ collected_at: new Date("2026-08-20T00:00:00Z") })
    .where("provider_resource_id", "=", t.resourceId)
    .execute();
  expect(await check()).toMatchObject({
    kind: "TASK_SUCCEEDED",
    referenceId: "TASK:quota_sync:" + t.resourceId,
    summary: "对应资源后续同步已成功",
  });
});
it("operating recovery requires a later successful balance and nonfailed cost after the fault", async () => {
  const t = await fixture();
  await operating(t, "FAILED", "SUCCESS", "2026-08-19");
  const row = (await t.repo.evaluate(t.enterpriseId)).find(
    (a) => a.signal === "operating_sync_failure",
  )!;
  await operating(t, "SUCCESS", "FAILED", "2026-08-20");
  await verifyAlertRecoveries(db, t.enterpriseId);
  expect(
    (await t.repo.list(t.enterpriseId)).find((a) => a.id === row.id)
      ?.recoveryEvidence,
  ).toBeNull();
  const success = await operating(t, "SUCCESS", "NOT_SUPPORTED", "2026-08-21");
  await verifyAlertRecoveries(db, t.enterpriseId);
  expect(
    (await t.repo.listHistory(t.enterpriseId)).find((a) => a.id === row.id)
      ?.recoveryEvidence,
  ).toMatchObject({
    kind: "TASK_SUCCEEDED",
    referenceId: success.id,
  });
});
it("reconciliation requires resolved status and timestamp before recording objective proof", async () => {
  const t = await fixture();
  const run = await db
    .insertInto("reconciliation_run")
    .values({
      enterprise_id: t.enterpriseId,
      range_from: new Date("2026-08-19"),
      range_to: new Date("2026-08-20"),
      result: "REVIEW",
      algorithm_version: "test",
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  const discrepancy = await db
    .insertInto("reconciliation_discrepancy")
    .values({
      enterprise_id: t.enterpriseId,
      reconciliation_run_id: run.id,
      discrepancy_type: "SETTLEMENT_MISMATCH",
      created_at: new Date("2026-08-19"),
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  const row = (await t.repo.evaluate(t.enterpriseId)).find(
    (a) => a.signal === "call_deduction_anomaly",
  )!;
  await db
    .updateTable("reconciliation_discrepancy")
    .set({ resolved_at: new Date("2026-08-20") })
    .where("id", "=", discrepancy.id)
    .execute();
  await verifyAlertRecoveries(db, t.enterpriseId);
  expect(
    (await t.repo.list(t.enterpriseId)).find((a) => a.id === row.id)
      ?.recoveryEvidence,
  ).toBeNull();
  await db
    .updateTable("reconciliation_discrepancy")
    .set({ status: "RESOLVED", resolved_at: null })
    .where("id", "=", discrepancy.id)
    .execute();
  await verifyAlertRecoveries(db, t.enterpriseId);
  expect(
    (await t.repo.list(t.enterpriseId)).find((a) => a.id === row.id)
      ?.recoveryEvidence,
  ).toBeNull();
  await db
    .updateTable("reconciliation_discrepancy")
    .set({ resolved_at: new Date("2026-08-20") })
    .where("id", "=", discrepancy.id)
    .execute();
  await verifyAlertRecoveries(db, t.enterpriseId);
  expect(
    (await t.repo.listHistory(t.enterpriseId)).find((a) => a.id === row.id)
      ?.recoveryEvidence,
  ).toMatchObject({
    kind: "RECONCILIATION_RESOLVED",
    referenceId: discrepancy.id,
  });
});
it("migration 0070 refuses rollback once any real recovery evidence exists", async () => {
  const t = await fixture(),
    jobs = new OperationalFaultRepository(db);
  await jobs.record(
    "health:test",
    "健康探针",
    false,
    new Date("2026-08-19"),
    t.enterpriseId,
  );
  await jobs.record(
    "health:test",
    "健康探针",
    true,
    new Date("2026-08-20"),
    t.enterpriseId,
  );
  for (const expected of [
    "0082_provider_finance_candidate_draft",
    "0081_provider_finance_activation",
    "0080_project_allocation_compute",
    "0079_project_allocation_relations",
    "0078_provider_model_probe_enum_checks",
    "0077_provider_model_probe_run_identity",
    "0076_provider_model_probe",
    "0075_provider_resource_archive",
    "0074_runtime_notification_recipients",
    "0073_credential_chat_probe",
  ]) {
    expect(await migrateDown(db)).toBe(expected);
  }
  expect(await migrateDown(db)).toBe("0072_admin_roles_security");
  expect(await migrateDown(db)).toBe("0071_enterprise_contact_details");
  await expect(migrateDown(db)).rejects.toThrow(
    "0070 rollback blocked: recovery evidence exists",
  );
  expect(
    (await t.repo.listHistory(t.enterpriseId))[0]?.recoveryEvidence,
  ).toMatchObject({ kind: "SERVICE_HEALTHY" });
  await migrateToLatest(db);
});
it("cross-tenant attempt metadata cannot prove another tenant's recovery", async () => {
  const t = await fixture(),
    other = await fixture();
  const { row } = await observation(t);
  const success = await request(other, {
    status: "SUCCEEDED",
    at: new Date("2026-08-20T04:00:00Z"),
  });
  // Historical schema permits a cross-tenant resource reference on attempts;
  // recovery SQL must therefore retain its explicit tenant predicate.
  await db
    .updateTable("upstream_attempt")
    .set({ provider_resource_id: t.resourceId })
    .where("id", "=", success.attemptId)
    .execute();
  expect(other.enterpriseId).not.toBe(t.enterpriseId);
  expect(
    await db
      .selectFrom("upstream_attempt")
      .select(["enterprise_id", "provider_resource_id"])
      .where("id", "=", success.attemptId)
      .executeTakeFirstOrThrow(),
  ).toEqual({
    enterprise_id: other.enterpriseId,
    provider_resource_id: t.resourceId,
  });
  expect(row.enterprise_id).toBe(t.enterpriseId);
  await verifyAlertRecoveries(db, t.enterpriseId);
  expect(
    await db
      .selectFrom("alert_event")
      .select(["status", "recovery_evidence"])
      .where("id", "=", row.id)
      .executeTakeFirstOrThrow(),
  ).toEqual({ status: "OPEN", recovery_evidence: null });
});

it("dispatch anomalies preserve mismatch and unexplained-baseline details, timestamps and resource fallback", async () => {
  const t = await fixture();
  const policy = await db
    .insertInto("dispatch_policy")
    .values({
      enterprise_id: t.enterpriseId,
      status: "PUBLISHED",
      action: "SWITCH",
      policy_version: randomUUID().slice(0, 32),
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  const mismatch = await request(t, { status: "SUCCEEDED" });
  const mismatchDecision = await db
    .insertInto("dispatch_decision")
    .values({
      enterprise_id: t.enterpriseId,
      ai_request_id: mismatch.id,
      matched_policy_id: policy.id,
      matched_policy_action: "SWITCH",
      final_action: "ALLOW",
      reason_code: "MISMATCH",
      saving_calculable: true,
      decided_at: new Date("2026-08-20T01:00:00Z"),
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  const unexplained = await request(t, { status: "SUCCEEDED" });
  const unexplainedDecision = await db
    .insertInto("dispatch_decision")
    .values({
      enterprise_id: t.enterpriseId,
      ai_request_id: unexplained.id,
      matched_policy_id: policy.id,
      matched_policy_action: "ALLOW",
      final_action: "ALLOW",
      reason_code: "UNEXPLAINED",
      saving_calculable: false,
      not_calculable_reason: "unexplained_baseline",
      switch_target_resource_id: t.resourceId,
      decided_at: new Date("2026-08-20T02:00:00Z"),
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  const normal = await request(t, { status: "SUCCEEDED" });
  await db
    .insertInto("dispatch_decision")
    .values({
      enterprise_id: t.enterpriseId,
      ai_request_id: normal.id,
      matched_policy_id: policy.id,
      matched_policy_action: "ALLOW",
      final_action: "ALLOW",
      reason_code: "NORMAL",
      saving_calculable: true,
    })
    .execute();
  expect(await deriveDispatchAlerts(db, t.enterpriseId)).toEqual([
    {
      alertKey: `RESOURCE_UNAVAILABLE:dispatch:${mismatchDecision.id}`,
      domain: "RESOURCE_UNAVAILABLE",
      signal: "dispatch_anomaly",
      severity: "MEDIUM",
      title: "调度执行异常",
      detail: "策略动作 SWITCH，实际动作 ALLOW",
      resourceId: t.resourceId,
      principalId: null,
      aiRequestId: mismatch.id,
      occurredAt: new Date("2026-08-20T01:00:00Z"),
      observedAt: new Date("2026-08-20T01:00:00Z"),
    },
    {
      alertKey: `RESOURCE_UNAVAILABLE:dispatch:${unexplainedDecision.id}`,
      domain: "RESOURCE_UNAVAILABLE",
      signal: "dispatch_anomaly",
      severity: "MEDIUM",
      title: "调度执行异常",
      detail: "节省基线不可解释：unexplained_baseline",
      resourceId: t.resourceId,
      principalId: null,
      aiRequestId: unexplained.id,
      occurredAt: new Date("2026-08-20T02:00:00Z"),
      observedAt: new Date("2026-08-20T02:00:00Z"),
    },
  ]);
  expect(await deriveFailedRequestAlerts(db, t.enterpriseId)).toEqual([]);
});

it("operational faults isolate tenants, preserve human handling and reject stale failures or successes", async () => {
  const t = await fixture(),
    other = await fixture(),
    jobs = new OperationalFaultRepository(db);
  const task = "health:isolated-" + randomUUID(),
    key = "SYSTEM_TASK:" + task;
  const at = (day: number) => new Date(Date.UTC(2026, 7, day));
  const rows = () =>
    db
      .selectFrom("alert_event")
      .selectAll()
      .where("enterprise_id", "=", t.enterpriseId)
      .where("alert_key", "=", key)
      .orderBy("first_seen_at", "asc")
      .execute();
  await jobs.record(task, "探针", true, at(1), t.enterpriseId);
  expect(await rows()).toEqual([]);
  await jobs.record(task, "探针", false, at(2), t.enterpriseId);
  await jobs.record(task, "探针", false, at(4), t.enterpriseId);
  await jobs.record(task, "探针", false, at(3), t.enterpriseId);
  await jobs.record(task, "探针", true, at(3), t.enterpriseId);
  await jobs.record(task, "探针", true, at(4), t.enterpriseId);
  const first = (await rows())[0]!;
  expect(first).toMatchObject({
    status: "OPEN",
    signal: "service_failure",
    title: "探针失败",
    severity: "HIGH",
    first_seen_at: at(2),
    last_seen_at: at(4),
    recovery_evidence: null,
  });
  expect(
    await db
      .selectFrom("alert_event")
      .select("id")
      .where("enterprise_id", "=", other.enterpriseId)
      .where("alert_key", "=", key)
      .execute(),
  ).toEqual([]);
  await t.repo.setDisposition(
    t.enterpriseId,
    key,
    "RESOLVED",
    "人工已检修",
    t.adminId,
    first.id,
  );
  const handled = (await rows())[0]!;
  await jobs.record(task, "探针", true, at(5), t.enterpriseId);
  await jobs.record(task, "探针", true, at(6), t.enterpriseId);
  await jobs.record(task, "探针", false, at(5), t.enterpriseId);
  expect(await rows()).toEqual([
    expect.objectContaining({
      id: first.id,
      status: "RESOLVED",
      resolution_note: "人工已检修",
      resolved_at: handled.resolved_at,
      recovery_evidence: {
        kind: "SERVICE_HEALTHY",
        summary: "探针后续执行成功",
        verifiedAt: at(5).toISOString(),
        referenceId: task,
      },
    }),
  ]);
  await jobs.record(task, "探针", false, at(7), t.enterpriseId);
  const episodes = await rows();
  expect(episodes).toHaveLength(2);
  expect(episodes[1]).toMatchObject({
    status: "OPEN",
    first_seen_at: at(7),
    last_seen_at: at(7),
    recovery_evidence: null,
  });
  const defaultTask = "job-" + randomUUID();
  const before = Date.now();
  await jobs.record(defaultTask, "普通任务", false, undefined, t.enterpriseId);
  const generic = await db
    .selectFrom("alert_event")
    .selectAll()
    .where("alert_key", "=", "SYSTEM_TASK:" + defaultTask)
    .executeTakeFirstOrThrow();
  expect(generic).toMatchObject({
    title: "普通任务失败",
    signal: "background_task_failure",
    detail:
      "共享后台任务执行失败；请检查运行日志。此记录不表示本企业所有请求均已失败。",
  });
  expect(generic.first_seen_at.getTime()).toBeGreaterThanOrEqual(before);
});

it("late observations correct a recovered occurrence date without reopening it and recheck unsupported legacy recovery", async () => {
  const t = await fixture(),
    { row, failed } = await observation(t, "2026-08-20T00:00:00Z");
  const good = await request(t, {
    status: "SUCCEEDED",
    at: new Date("2026-08-22T00:00:00Z"),
  });
  await verifyAlertRecoveries(db, t.enterpriseId);
  const earlier = await request(t, { at: new Date("2026-08-19T00:00:00Z") });
  const write = (id: string, time: string) =>
    writeObservationFault(
      db,
      {
        ...t,
        providerResourceId: t.resourceId,
        unifiedModelId: null,
        upstreamModel: "model-A",
        signal: "TECHNICAL_FAILURE",
        aiRequestId: id,
        mode: "OBSERVE",
        wecomNotify: false,
      },
      new Date(time),
    );
  await write(earlier.id, "2026-08-19T00:00:00Z");
  expect(
    await db
      .selectFrom("alert_event")
      .selectAll()
      .where("id", "=", row.id)
      .executeTakeFirstOrThrow(),
  ).toMatchObject({
    status: "AUTO_RESOLVED",
    first_seen_at: new Date("2026-08-19T00:00:00Z"),
    ai_request_id: failed.id,
    recovery_evidence: { referenceId: good.attemptId },
  });
  await db
    .updateTable("alert_event")
    .set({
      recovery_evidence: null,
      last_seen_at: new Date("2026-08-18T00:00:00Z"),
    })
    .where("id", "=", row.id)
    .execute();
  await write(earlier.id, "2026-08-19T00:00:00Z");
  expect(
    await db
      .selectFrom("alert_event")
      .selectAll()
      .where("id", "=", row.id)
      .executeTakeFirstOrThrow(),
  ).toMatchObject({
    status: "OPEN",
    source_cleared_at: null,
    resolved_at: null,
    ai_request_id: failed.id,
    last_seen_at: new Date("2026-08-20T00:00:00Z"),
  });
});

it("legacy request records are refreshed without duplicate facts, while note length and handler identity remain enforced", async () => {
  const t = await fixture(),
    failed = await request(t);
  await db
    .updateTable("admin_user")
    .set({ display_name: "测试处置人" })
    .where("id", "=", t.adminId)
    .execute();
  const first = (await t.repo.evaluate(t.enterpriseId)).find(
    (a) => a.aiRequestId === failed.id,
  )!;
  await db
    .updateTable("alert_event")
    .set({
      title: "运行保障预警",
      status: "AUTO_RESOLVED",
      recovery_evidence: null,
      source_cleared_at: new Date("2026-08-21"),
      resolved_at: new Date("2026-08-21"),
      resource_id: null,
      principal_id: null,
      detail: "stale",
      first_seen_at: new Date("2026-08-18"),
    })
    .where("id", "=", first.id)
    .execute();
  expect(
    (await t.repo.listHistory(t.enterpriseId)).find((a) => a.id === first.id),
  ).toMatchObject({ title: "上游故障", principalId: t.principalId });
  expect(
    (await t.repo.evaluate(t.enterpriseId)).find((a) => a.id === first.id),
  ).toMatchObject({
    status: "OPEN",
    sourceClearedAt: null,
    resolvedAt: null,
    resourceId: t.resourceId,
    principalId: t.principalId,
    firstSeenAt: "2026-08-19T04:00:00.000Z",
  });
  await expect(
    t.repo.setDisposition(
      t.enterpriseId,
      first.alertKey,
      "RESOLVED",
      "长".repeat(2001),
      t.adminId,
      first.id,
    ),
  ).rejects.toThrow("处理说明不能超过2000字");
  expect(
    await t.repo.setDisposition(
      t.enterpriseId,
      first.alertKey,
      "INVESTIGATING",
      undefined,
      t.adminId,
      first.id,
    ),
  ).toBe(true);
  expect(
    (await t.repo.list(t.enterpriseId)).find((a) => a.id === first.id),
  ).toMatchObject({
    status: "INVESTIGATING",
    resolutionNote: null,
    resolvedAt: null,
  });
  expect(
    await t.repo.setDisposition(
      t.enterpriseId,
      first.alertKey,
      "RESOLVED",
      "长".repeat(2000),
      t.adminId,
      first.id,
    ),
  ).toBe(true);
  expect(
    (await t.repo.listHistory(t.enterpriseId)).find((a) => a.id === first.id)
      ?.handledBy,
  ).toBe("测试处置人");
  expect(
    await db
      .selectFrom("alert_event")
      .select("id")
      .where("ai_request_id", "=", failed.id)
      .execute(),
  ).toHaveLength(1);
});
