import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { startPostgresContainer } from "@qianliu/testing";
import { createKysely, ProviderRepository, type Database } from "../index.js";
import { createMigrator, migrateDown } from "../migrator.js";

/** WP04：0076 探针运行/明细迁移与仓储持久化（脱敏，无 Key/正文列）。 */
describe("0076 provider_model_probe 迁移与探针证据", () => {
  it("加法迁移可应用/回滚，探针证据按 request_hash 幂等且随凭证指纹失效", async () => {
    const pg = await startPostgresContainer("model_probe_migration");
    const db: Database = createKysely(pg.connectionString);
    try {
      const migrator = createMigrator(db);
      expect((await migrator.migrateTo("0075_provider_resource_archive")).error).toBeUndefined();
      const ent = (await db.insertInto("enterprise").values({ name: "probe-migration" })
        .returning("id").executeTakeFirstOrThrow()).id;
      const provider = (await db.insertInto("provider").values({
        enterprise_id: ent, code: "Kimi", name: "Kimi", adapter_type: "kimi",
      }).returning("id").executeTakeFirstOrThrow()).id;
      // 历史生产形态：capability_set.base_url 为 Moonshot 平台地址。
      await db.updateTable("provider").set({
        capability_set: { base_url: "https://api.moonshot.cn/v1" },
      }).where("id", "=", provider).execute();
      const resource = (await db.insertInto("provider_resource").values({
        enterprise_id: ent, provider_id: provider, name: "kimi-plan",
        mode: "CODING_PLAN", credential_type: "API_KEY", status: "ACTIVE",
      }).returning("id").executeTakeFirstOrThrow()).id;

      expect((await migrator.migrateToLatest()).error).toBeUndefined();

      const repo = new ProviderRepository(db);
      const fingerprintA = "a".repeat(64);
      const requestHashA = "r".repeat(64);
      const runA = await repo.recordModelProbeRun({
        enterpriseId: ent,
        providerId: provider,
        providerResourceId: resource,
        providerCode: "kimi",
        resourceMode: "CODING_PLAN",
        credentialFingerprint: fingerprintA,
        endpointScope: "MODE_DEFAULT",
        endpointHost: "api.kimi.com",
        discoverySource: "OFFICIAL_DOCUMENTATION",
        discoverySourceHash: "sha256:docs",
        parserVersion: "kimi-code-models-v1",
        idempotencyKey: `idem-${randomUUID()}`,
        requestHash: requestHashA,
        items: [
          { upstreamModel: "k3", validationStatus: "READY", httpStatus: 200, errorCode: null,
            errorCategory: "READY", retryable: false, diagnosticHash: "d1", checkedAt: new Date() },
          { upstreamModel: "k3-256k", validationStatus: "PLAN_NOT_ENTITLED", httpStatus: 403,
            errorCode: "MODEL_PROBE_PLAN_NOT_ENTITLED", errorCategory: "PLAN_NOT_ENTITLED",
            retryable: false, diagnosticHash: "d2", checkedAt: new Date() },
        ],
      });
      expect(runA).toBeTruthy();

      const latest = await repo.latestModelProbeRun(ent, resource);
      expect(latest?.run.endpoint_host).toBe("api.kimi.com");
      expect(latest?.run.credential_fingerprint).toBe(fingerprintA);
      expect(Object.fromEntries((latest?.items ?? []).map((item) => [item.upstream_model, item.validation_status])))
        .toEqual({ k3: "READY", "k3-256k": "PLAN_NOT_ENTITLED" });

      // 幂等：相同 idempotency_key 复用同一 run，不重复写明细。
      const replay = await repo.recordModelProbeRun({
        enterpriseId: ent, providerId: provider, providerResourceId: resource,
        providerCode: "kimi", resourceMode: "CODING_PLAN",
        credentialFingerprint: fingerprintA, endpointScope: "MODE_DEFAULT",
        endpointHost: "api.kimi.com", idempotencyKey: "same-idem-key", requestHash: requestHashA,
        items: [{ upstreamModel: "k3", validationStatus: "READY", httpStatus: 200, errorCode: null,
          errorCategory: "READY", retryable: false, diagnosticHash: "d1", checkedAt: new Date() }],
      });
      const replayAgain = await repo.recordModelProbeRun({
        enterpriseId: ent, providerId: provider, providerResourceId: resource,
        providerCode: "kimi", resourceMode: "CODING_PLAN",
        credentialFingerprint: fingerprintA, endpointScope: "MODE_DEFAULT",
        endpointHost: "api.kimi.com", idempotencyKey: "same-idem-key", requestHash: requestHashA,
        items: [{ upstreamModel: "k3", validationStatus: "READY", httpStatus: 200, errorCode: null,
          errorCategory: "READY", retryable: false, diagnosticHash: "d1", checkedAt: new Date() }],
      });
      expect(replay).toBe(replayAgain);
      expect(await db.selectFrom("provider_model_probe_item")
        .where("probe_run_id", "=", replayAgain!).execute()).toHaveLength(1);

      // Key 变化：credential fingerprint 变化 → 新 request_hash → 新 run，旧结果不再被返回。
      const fingerprintB = "b".repeat(64);
      await repo.recordModelProbeRun({
        enterpriseId: ent, providerId: provider, providerResourceId: resource,
        providerCode: "kimi", resourceMode: "CODING_PLAN",
        credentialFingerprint: fingerprintB, endpointScope: "MODE_DEFAULT",
        endpointHost: "api.kimi.com", discoverySourceHash: "sha256:docs2",
        idempotencyKey: `idem-${randomUUID()}`, requestHash: "r".repeat(63) + "x",
        items: [{ upstreamModel: "k3", validationStatus: "AUTH_FAILED", httpStatus: 401,
          errorCode: "MODEL_PROBE_AUTH_FAILED", errorCategory: "AUTH_FAILED",
          retryable: false, diagnosticHash: "d3", checkedAt: new Date() }],
      });
      const afterKeyChange = await repo.latestModelProbeRun(ent, resource);
      expect(afterKeyChange?.run.credential_fingerprint).toBe(fingerprintB);
      expect(afterKeyChange?.items[0]?.validation_status).toBe("AUTH_FAILED");

      // 脱敏：探针表不存在凭证/正文类列（idempotency_key 为幂等键，非机密）。
      const runColumns = (await db.introspection.getTables())
        .find((table) => table.name === "provider_model_probe_run")?.columns.map((column) => column.name) ?? [];
      const itemColumns = (await db.introspection.getTables())
        .find((table) => table.name === "provider_model_probe_item")?.columns.map((column) => column.name) ?? [];
      const forbidden = /(api_?key|secret|password|authorization|prompt|raw_body|response_body|error_body|content)/i;
      for (const column of [...runColumns, ...itemColumns]) {
        expect(forbidden.test(column)).toBe(false);
      }

      // 有证据后拒绝回滚（与 0073 同样的防丢证据门禁）。
      await expect(migrateDown(db)).rejects.toThrow("0076 contains probe evidence");
    } finally { await db.destroy(); await pg.stop(); }
  }, 180_000);
});
