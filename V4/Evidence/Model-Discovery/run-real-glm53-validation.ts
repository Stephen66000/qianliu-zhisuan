import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { createKysely, migrateToLatest, type Database } from "../../../packages/database/src/index.js";
import { startPostgresContainer, type PostgresTestInstance } from "../../../packages/testing/src/index.js";
import { hashPassword } from "../../../apps/control-api/src/auth/password.js";

const token = process.env.QIANLIU_TEST_ZHIPU_TOKEN;
if (!token) throw new Error("QIANLIU_TEST_ZHIPU_TOKEN is required");
process.env.LOG_LEVEL = "silent";

let pg: PostgresTestInstance | undefined;
let db: Database | undefined;
let app: FastifyInstance | undefined;

function assertStatus(label: string, actual: number, expected: number): void {
  if (actual !== expected) throw new Error(`${label}: expected ${expected}, got ${actual}`);
}

try {
  pg = await startPostgresContainer();
  db = createKysely(pg.connectionString);
  await migrateToLatest(db);

  const enterpriseId = randomUUID();
  await db.insertInto("enterprise").values({ id: enterpriseId, name: "GLM-5.3 local real validation" }).execute();
  await db.insertInto("admin_user").values({
    enterprise_id: enterpriseId,
    username: "glm53-local-admin",
    display_name: "GLM-5.3 Local Admin",
    password_hash: await hashPassword("GLM53-Local-Validation!"),
    status: "ACTIVE",
  }).execute();

  const { buildControlApi } = await import("../../../apps/control-api/src/server.js");
  app = buildControlApi(db);
  await app.ready();

  const login = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { username: "glm53-local-admin", password: "GLM53-Local-Validation!" },
  });
  assertStatus("login", login.statusCode, 200);
  const setCookie = login.headers["set-cookie"];
  const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(";")[0];
  if (!cookie) throw new Error("login cookie missing");

  const providerResponse = await app.inject({
    method: "POST",
    url: "/providers",
    headers: { cookie },
    payload: { code: "zhipu", name: "智谱本机真实验证", adapter_type: "zhipu" },
  });
  assertStatus("create provider", providerResponse.statusCode, 201);
  const providerId = providerResponse.json().provider.id as string;

  const resourceResponse = await app.inject({
    method: "POST",
    url: "/provider-resources",
    headers: { cookie },
    payload: {
      provider_id: providerId,
      name: "GLM-5.3 本机一次性真实验证资源",
      mode: "CODING_PLAN",
      credential_type: "API_KEY",
      credential_plaintext: token,
      concurrency_limit: 1,
    },
  });
  assertStatus("create resource", resourceResponse.statusCode, 201);
  const resourceId = resourceResponse.json().resource.id as string;

  const sync = await app.inject({
    method: "POST",
    url: `/provider-resources/${resourceId}/models/sync`,
    headers: { cookie },
    payload: {},
  });
  assertStatus("sync models", sync.statusCode, 200);
  const syncBody = sync.json();
  const glm53 = (syncBody.models as Array<Record<string, unknown>>)
    .find((model) => model.id === "glm-5.3");
  if (!glm53 || syncBody.stale !== false || syncBody.source !== "OFFICIAL_DOCUMENTATION") {
    throw new Error("live official discovery did not produce fresh glm-5.3");
  }

  const confirm = await app.inject({
    method: "POST",
    url: `/provider-resources/${resourceId}/models/confirm`,
    headers: { cookie },
    payload: { selected_model_ids: ["glm-5.3"] },
  });
  assertStatus("confirm glm-5.3", confirm.statusCode, 200);

  const route = await db.selectFrom("model_route").selectAll()
    .where("enterprise_id", "=", enterpriseId)
    .where("provider_resource_id", "=", resourceId)
    .where("upstream_model", "=", "glm-5.3")
    .executeTakeFirstOrThrow();

  const enableBeforeValidation = await app.inject({
    method: "PATCH",
    url: `/model-routes/${route.id}`,
    headers: { cookie },
    payload: { expected_version: route.version, enabled: true },
  });
  assertStatus("enable before validation", enableBeforeValidation.statusCode, 409);

  const validation = await app.inject({
    method: "POST",
    url: `/provider-resources/${resourceId}/models/glm-5.3/validate`,
    headers: { cookie },
    payload: {
      idempotency_key: `glm53-real-${randomUUID()}`,
      confirm_quota_consumption: true,
    },
  });
  assertStatus("real validation", validation.statusCode, 200);
  const validationResult = validation.json().validation as {
    validationId: string;
    requestId: string;
    status: "SUCCEEDED" | "FAILED";
    errorCode: string | null;
    checks: Array<Record<string, unknown>>;
  };

  let enableAfterValidation: { statusCode: number; enabled: boolean | null } = {
    statusCode: 0,
    enabled: null,
  };
  if (validationResult.status === "SUCCEEDED") {
    const enabled = await app.inject({
      method: "PATCH",
      url: `/model-routes/${route.id}`,
      headers: { cookie },
      payload: { expected_version: route.version, enabled: true },
    });
    enableAfterValidation = {
      statusCode: enabled.statusCode,
      enabled: enabled.statusCode === 200 ? Boolean(enabled.json().route.enabled) : null,
    };
  }

  const [keyCount, grantCount, validationRow, auditRows] = await Promise.all([
    db.selectFrom("principal_key").select(({ fn }) => fn.countAll<string>().as("count")).executeTakeFirstOrThrow(),
    db.selectFrom("principal_grant").select(({ fn }) => fn.countAll<string>().as("count")).executeTakeFirstOrThrow(),
    db.selectFrom("provider_model_validation").selectAll()
      .where("id", "=", validationResult.validationId).executeTakeFirstOrThrow(),
    db.selectFrom("operation_log").select(["action", "result", "change_summary"])
      .where("enterprise_id", "=", enterpriseId)
      .where("action", "in", ["provider_resource.models_sync", "provider_resource.models_confirm", "provider_resource.model_validate"])
      .orderBy("created_at").execute(),
  ]);

  const output = {
    environment: {
      database: "ephemeral-pg17-testcontainer",
      macMiniTouched: false,
      productionTouched: false,
    },
    discovery: {
      source: syncBody.source,
      parserVersion: syncBody.parser_version,
      sourceUrl: syncBody.source_url,
      sourceContentHash: syncBody.source_content_hash,
      sourceCheckedAt: syncBody.source_checked_at,
      stale: syncBody.stale,
      glm53,
    },
    gate: {
      enableBeforeValidation: {
        statusCode: enableBeforeValidation.statusCode,
        error: enableBeforeValidation.json().error,
      },
      enableAfterValidation,
    },
    validation: validationResult,
    persistedValidation: {
      id: validationRow.id,
      status: validationRow.status,
      result: validationRow.result,
      startedAt: validationRow.started_at,
      finishedAt: validationRow.finished_at,
    },
    authorizationSideEffects: {
      principalKeys: Number(keyCount.count),
      principalGrants: Number(grantCount.count),
    },
    audits: auditRows,
  };
  console.log(JSON.stringify(output, null, 2));

  if (validationResult.status !== "SUCCEEDED") process.exitCode = 1;
  if (enableAfterValidation.statusCode !== 200 || enableAfterValidation.enabled !== true) process.exitCode = 1;
  if (Number(keyCount.count) !== 0 || Number(grantCount.count) !== 0) process.exitCode = 1;
} finally {
  await app?.close().catch(() => undefined);
  await db?.destroy().catch(() => undefined);
  await pg?.stop().catch(() => undefined);
}
