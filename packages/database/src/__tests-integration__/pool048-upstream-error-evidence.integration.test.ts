import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";

import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";
import { createKysely } from "../kysely.js";
import { createMigrator, migrateDown } from "../migrator.js";
import { GatewayLedgerRepository } from "../repositories/gateway-ledger-repository.js";

let pg: PostgresTestInstance;

beforeAll(async () => {
  pg = await startPostgresContainer("pool048_upstream_error_evidence");
}, 120_000);

afterAll(async () => {
  await pg?.stop();
}, 60_000);

describe("POOL20-048 0055 上游错误证据", () => {
  it("0054 旧行升级为 null，写边界拒绝正文并在有证据时禁止破坏性 down", async () => {
    const db = createKysely(pg.connectionString);
    try {
      const migrator = createMigrator(db);
      expect((await migrator.migrateTo("0054_usage_aggregate_settlement_time")).error).toBeUndefined();
      const enterpriseId = randomUUID();
      const principalId = randomUUID();
      const keyId = randomUUID();
      const providerId = randomUUID();
      const resourceId = randomUUID();
      const requestId = randomUUID();
      await db.insertInto("enterprise").values({ id: enterpriseId, name: "POOL048 企业" }).execute();
      await db.insertInto("principal").values({
        id: principalId, enterprise_id: enterpriseId, type: "EMPLOYEE", name: "POOL048 员工",
      }).execute();
      await db.insertInto("principal_key").values({
        id: keyId, enterprise_id: enterpriseId, principal_id: principalId,
        key_prefix: "pool048", key_digest: randomUUID(), allowed_model_ids: [],
      }).execute();
      await db.insertInto("provider").values({
        id: providerId, enterprise_id: enterpriseId, code: "deepseek", name: "POOL048 DeepSeek",
        adapter_type: "deepseek",
      }).execute();
      await db.insertInto("provider_resource").values({
        id: resourceId, enterprise_id: enterpriseId, provider_id: providerId,
        name: "POOL048 API", mode: "API", credential_type: "API_KEY",
      }).execute();
      await db.insertInto("ai_request").values({
        id: requestId, enterprise_id: enterpriseId, principal_id: principalId,
        principal_key_id: keyId, protocol: "chat", unified_model: "ql-pool048",
        status: "IN_PROGRESS",
      }).execute();
      const attempt = await db.insertInto("upstream_attempt").values({
        ai_request_id: requestId, enterprise_id: enterpriseId, attempt_no: 1,
        provider_resource_id: resourceId, upstream_model: "deepseek-v4-flash",
      }).returning("id").executeTakeFirstOrThrow();

      expect((await migrator.migrateToLatest()).error).toBeUndefined();
      const legacy = await db.selectFrom("upstream_attempt")
        .select(["upstream_error_evidence", "request_shape_summary"])
        .where("id", "=", attempt.id).executeTakeFirstOrThrow();
      expect(legacy).toEqual({ upstream_error_evidence: null, request_shape_summary: null });

      const repository = new GatewayLedgerRepository(db);
      const safeEvidence = {
        httpStatus: 400, type: "invalid_request_error", code: "invalid_request_error",
        param: "tools[].function.parameters.properties.*",
        messageCategory: "INVALID_TOOL_SCHEMA",
        diagnosticHash: "1".repeat(64),
      };
      const safeShape = {
        topLevelFields: ["messages", "model", "stream", "stream_options", "tools"],
        messageCount: 2, messageRoles: { system: 1, user: 1 },
        contentKinds: ["string"], contentBlockTypes: [],
        assistantToolCallCount: 0, toolResultCount: 0,
        unmatchedAssistantToolCallCount: 0, unmatchedToolResultCount: 0,
        toolCount: 1, functionToolCount: 1, invalidToolCount: 1,
        toolSchemaIssueCounts: { PARAMETERS_SCHEMA_INVALID: 1 },
        toolTypes: ["function"], schemaKeywords: ["properties", "required", "type"],
        schemaMaxDepth: 4, schemaNodeCount: 10, schemaPropertyCount: 2,
        toolChoiceKind: "auto", stream: true, streamOptionsIncluded: true,
        countOverflowed: false,
      };
      await repository.updateAttemptResult(attempt.id, {
        http_status: 400,
        error_classification: "CLIENT_INVALID",
        error_code: "invalid_request_error",
        upstream_error_evidence: safeEvidence,
        request_shape_summary: safeShape,
      });
      const stored = await db.selectFrom("upstream_attempt")
        .select(["upstream_error_evidence", "request_shape_summary"])
        .where("id", "=", attempt.id).executeTakeFirstOrThrow();
      expect(stored).toEqual({
        upstream_error_evidence: safeEvidence,
        request_shape_summary: safeShape,
      });

      const unsafeRequestId = randomUUID();
      await db.insertInto("ai_request").values({
        id: unsafeRequestId, enterprise_id: enterpriseId, principal_id: principalId,
        principal_key_id: keyId, protocol: "chat", unified_model: "ql-pool048",
        status: "IN_PROGRESS",
      }).execute();
      const unsafeAttempt = await db.insertInto("upstream_attempt").values({
        ai_request_id: unsafeRequestId, enterprise_id: enterpriseId, attempt_no: 1,
        provider_resource_id: resourceId, upstream_model: "deepseek-v4-flash",
      }).returning("id").executeTakeFirstOrThrow();
      const canary = "POOL048_CUSTOMER_PROMPT_SECRET";
      await repository.updateAttemptResult(unsafeAttempt.id, {
        upstream_error_evidence: { message: canary },
        request_shape_summary: { toolName: canary, schemaProperty: canary },
      });
      const unsafeStored = await db.selectFrom("upstream_attempt")
        .select(["upstream_error_evidence", "request_shape_summary"])
        .where("id", "=", unsafeAttempt.id).executeTakeFirstOrThrow();
      expect(unsafeStored).toEqual({ upstream_error_evidence: null, request_shape_summary: null });
      await repository.updateAttemptResult(unsafeAttempt.id, {
        http_status: 429,
        upstream_error_evidence: safeEvidence,
        request_shape_summary: safeShape,
      });
      expect(await db.selectFrom("upstream_attempt")
        .select(["upstream_error_evidence", "request_shape_summary"])
        .where("id", "=", unsafeAttempt.id).executeTakeFirstOrThrow()).toEqual({
        upstream_error_evidence: null, request_shape_summary: null,
      });
      const canaryHits = await sql<{ hits: string }>`
        SELECT count(*)::text AS hits FROM upstream_attempt
         WHERE coalesce(upstream_error_evidence::text, '') LIKE ${`%${canary}%`}
            OR coalesce(request_shape_summary::text, '') LIKE ${`%${canary}%`}
      `.execute(db);
      expect(canaryHits.rows[0]?.hits).toBe("0");

      await expect(db.updateTable("upstream_attempt").set({
        upstream_error_evidence: safeEvidence,
        request_shape_summary: null,
      }).where("id", "=", unsafeAttempt.id).execute()).rejects.toThrow();
      await expect(db.updateTable("upstream_attempt").set({
        upstream_error_evidence: { ...safeEvidence, httpStatus: 429 },
        request_shape_summary: safeShape,
      }).where("id", "=", unsafeAttempt.id).execute()).rejects.toThrow();

      await expect(db.updateTable("upstream_attempt").set({
        request_shape_summary: { oversized: "x".repeat(5_000) },
      }).where("id", "=", unsafeAttempt.id).execute()).rejects.toThrow();
      expect(await migrateDown(db)).toBe("0061_provider_finance_audit_hardening");
      expect(await migrateDown(db)).toBe("0060_provider_finance_legacy_cost_resolution");
      expect(await migrateDown(db)).toBe("0059_provider_finance_ledger");
      expect(await migrateDown(db)).toBe("0058_principal_grant_archive");
      expect(await migrateDown(db)).toBe("0057_model_discovery_v12");
      expect(await migrateDown(db)).toBe("0056_resource_monthly_budget");
      await expect(migrateDown(db)).rejects.toThrow(/0055 contains diagnostic evidence/);

      await db.updateTable("upstream_attempt").set({
        upstream_error_evidence: null,
        request_shape_summary: null,
      }).execute();
      expect(await migrateDown(db)).toBe("0055_upstream_error_evidence");
      const columnsAfterDown = await sql<{ count: string }>`
        SELECT count(*)::text AS count
          FROM information_schema.columns
         WHERE table_name = 'upstream_attempt'
           AND column_name IN ('upstream_error_evidence', 'request_shape_summary')
      `.execute(db);
      expect(columnsAfterDown.rows[0]?.count).toBe("0");
      expect((await migrator.migrateToLatest()).error).toBeUndefined();
    } finally {
      await db.destroy();
    }
  });
});
