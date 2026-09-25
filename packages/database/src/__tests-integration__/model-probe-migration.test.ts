import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { startPostgresContainer } from "@qianliu/testing";
import { createKysely, ProviderRepository, type Database } from "../index.js";
import { createMigrator, migrateDown } from "../migrator.js";
import { rollbackTo } from "./migration-rollback.js";

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
      // 0077（run 身份唯一约束）起为后续新增且可回滚：先回滚到 0077（跳过其后追加的
      // 迁移头，惯例见 migration-rollback.ts docstring），再触发 0076 门禁。
      const rolledBack = await rollbackTo(db, "0077_provider_model_probe_run_identity");
      expect(rolledBack.at(-1)).toBe("0077_provider_model_probe_run_identity");
      await expect(migrateDown(db)).rejects.toThrow("0076 contains probe evidence");
    } finally { await db.destroy(); await pg.stop(); }
  }, 180_000);

  it("0077 run 身份原子化：同 idempotency_key 并发写入恰一条 run，item 不重复，写入错误不再静默", async () => {
    const pg = await startPostgresContainer("model_probe_migration_identity");
    const db: Database = createKysely(pg.connectionString);
    try {
      const migrator = createMigrator(db);
      expect((await migrator.migrateToLatest()).error).toBeUndefined();
      const ent = (await db.insertInto("enterprise").values({ name: "probe-identity" })
        .returning("id").executeTakeFirstOrThrow()).id;
      const repo = new ProviderRepository(db);
      const input = {
        enterpriseId: ent, providerId: null, providerResourceId: null,
        providerCode: "kimi", resourceMode: "CODING_PLAN" as const,
        credentialFingerprint: "c".repeat(16), endpointScope: "MODE_DEFAULT" as const,
        endpointHost: "api.kimi.com", idempotencyKey: `hash-ent:${new Date("2026-09-21T00:00:00Z").toISOString()}`,
        requestHash: "h".repeat(64),
        items: [
          { upstreamModel: "k3", validationStatus: "READY" as const, httpStatus: 200, errorCode: null,
            errorCategory: "READY", retryable: false, diagnosticHash: "d1", checkedAt: new Date() },
          { upstreamModel: "k3-256k", validationStatus: "PLAN_NOT_ENTITLED" as const, httpStatus: 403,
            errorCode: "MODEL_PROBE_PLAN_NOT_ENTITLED", errorCategory: "PLAN_NOT_ENTITLED",
            retryable: false, diagnosticHash: "d2", checkedAt: new Date() },
        ],
      };
      // P2：并发飞行（模拟 select-then-insert 竞态窗口）同键并发写入——
      // 恰一条 run 胜出，落败方回查复用同一 id，item 只随胜出 run 落一次。
      const ids = await Promise.all(Array.from({ length: 6 }, () => repo.recordModelProbeRun(input)));
      expect(new Set(ids)).not.toContain(null);
      expect(new Set(ids).size).toBe(1);
      const runs = await db.selectFrom("provider_model_probe_run")
        .selectAll().where("enterprise_id", "=", ent).execute();
      expect(runs).toHaveLength(1);
      expect(runs[0]!.request_hash).toBe("h".repeat(64));
      expect(await db.selectFrom("provider_model_probe_item")
        .where("probe_run_id", "=", ids[0]!).execute()).toHaveLength(2);
      // run 身份可由 request_hash 审计定位（0076 已建 (enterprise_id, request_hash) 索引）。
      const byHash = await db.selectFrom("provider_model_probe_run")
        .where("enterprise_id", "=", ent).where("request_hash", "=", "h".repeat(64)).execute();
      expect(byHash).toHaveLength(1);
      // 唯一约束在位：绕过仓储直接插入同 (enterprise_id, idempotency_key) 必须被拒绝。
      await expect(db.insertInto("provider_model_probe_run").values({
        enterprise_id: ent, provider_code: "kimi", resource_mode: "CODING_PLAN",
        credential_fingerprint: "c".repeat(16), endpoint_scope: "MODE_DEFAULT",
        endpoint_host: "api.kimi.com", status: "COMPLETED",
        idempotency_key: input.idempotencyKey, request_hash: input.requestHash,
      }).execute()).rejects.toThrow();
      // 写入错误不再静默：items 违反唯一约束（同 run 同模型重复）应抛出而非返回 null。
      await expect(repo.recordModelProbeRun({
        ...input,
        idempotencyKey: `hash-ent2:${new Date("2026-09-21T00:00:00Z").toISOString()}`,
        items: [
          { ...input.items[0]! },
          { ...input.items[0]! },
        ],
      })).rejects.toThrow();
    } finally { await db.destroy(); await pg.stop(); }
  }, 180_000);

  it("终审整改三：0077 预检 fail-closed——存在重复 run 时拒绝执行且证据零损失", async () => {
    const pg = await startPostgresContainer("model_probe_migration_fail_closed");
    const db: Database = createKysely(pg.connectionString);
    try {
      const migrator = createMigrator(db);
      expect((await migrator.migrateTo("0076_provider_model_probe")).error).toBeUndefined();
      const ent = (await db.insertInto("enterprise").values({ name: "probe-fail-closed" })
        .returning("id").executeTakeFirstOrThrow()).id;
      // 模拟异常环境的重复历史：直接插入同 (enterprise_id, idempotency_key) 的两条 run。
      const values = {
        enterprise_id: ent, provider_code: "kimi", resource_mode: "CODING_PLAN" as const,
        credential_fingerprint: "f".repeat(16), endpoint_scope: "MODE_DEFAULT" as const,
        endpoint_host: "api.kimi.com", status: "COMPLETED",
        idempotency_key: "dupe-run-key", request_hash: "x".repeat(64),
      };
      const run1 = await db.insertInto("provider_model_probe_run").values(values)
        .returning("id").executeTakeFirstOrThrow();
      const run2 = await db.insertInto("provider_model_probe_run").values(values)
        .returning("id").executeTakeFirstOrThrow();
      for (const runId of [run1.id, run2.id]) {
        await db.insertInto("provider_model_probe_item").values({
          probe_run_id: runId, upstream_model: "k3", validation_status: "READY",
          http_status: 200, error_code: null, error_category: "READY",
          retryable: false, diagnostic_hash: "d", checked_at: new Date(),
        }).execute();
      }
      // 0077 必须失败关闭：预检发现重复即拒绝，绝不自动删除审计证据。
      expect((await migrator.migrateToLatest()).error).toBeDefined();
      // 证据零损失：重复 run 与明细原样保留。
      expect(await db.selectFrom("provider_model_probe_run")
        .where("enterprise_id", "=", ent).execute()).toHaveLength(2);
      expect(await db.selectFrom("provider_model_probe_item")
        .where("probe_run_id", "in", [run1.id, run2.id]).execute()).toHaveLength(2);
      // 部署规则：运维人工甄别合并重复（此处模拟保留最早一条）后重试即可通过。
      await db.deleteFrom("provider_model_probe_run").where("id", "=", run2.id).execute();
      expect((await migrator.migrateToLatest()).error).toBeUndefined();
      expect(await db.selectFrom("provider_model_probe_run")
        .where("enterprise_id", "=", ent).execute()).toHaveLength(1);
      expect(await db.selectFrom("provider_model_probe_item")
        .where("probe_run_id", "=", run1.id).execute()).toHaveLength(1);
    } finally { await db.destroy(); await pg.stop(); }
  }, 180_000);
});
