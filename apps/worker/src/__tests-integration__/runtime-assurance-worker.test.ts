import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createKysely,
  migrateToLatest,
  RuntimeAssuranceRepository,
  type Database,
} from "@qianliu/database";
import { encryptCredential } from "@qianliu/provider-adapters";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";
import type { Kysely } from "kysely";
import { runRuntimeAssuranceTick } from "../runtime-assurance/runner.js";
import { WecomAppClient } from "../runtime-assurance/wecom-client.js";
import { withRuntimeSchedulerLock } from "../runtime-assurance/scheduler.js";

let pg: PostgresTestInstance;
let db: Kysely<Database>;
const enterpriseId = randomUUID();
const principalId = randomUUID();
const kek = Buffer.alloc(32, 7);
const kekBase64 = kek.toString("base64");
const sentBodies: Array<Record<string, unknown>> = [];

beforeAll(async () => {
  pg = await startPostgresContainer();
  db = createKysely(pg.connectionString);
  await migrateToLatest(db);
  await db.insertInto("enterprise").values({ id: enterpriseId, name: "RA Worker" }).execute();
}, 120_000);

afterAll(async () => {
  if (db) await db.destroy();
  if (pg) await pg.stop();
}, 60_000);

describe("RA-W05A/W05B/W06 Worker 闭环", () => {
  it("无页面访问自动恢复，触发／恢复各向本人 userid 发送一次", async () => {
    const actorId = randomUUID();
    await db.insertInto("admin_user").values({
      id: actorId, enterprise_id: enterpriseId, username: `ra-worker-${actorId}`,
      password_hash: "test-only", status: "ACTIVE",
    }).execute();
    const person = await db.insertInto("person").values({ name: "试点人员" }).returningAll().executeTakeFirstOrThrow();
    const identity = await db.insertInto("person_external_identity").values({
      person_id: person.id, provider: "WECOM", provider_user_id: "pilot-userid", status: "ACTIVE",
    }).returningAll().executeTakeFirstOrThrow();
    await db.insertInto("principal").values({
      id: principalId, enterprise_id: enterpriseId, type: "EMPLOYEE", name: "试点主体", person_id: person.id,
    }).execute();
    const repository = new RuntimeAssuranceRepository(db);
    const rule = await repository.createRule({
      name: "额度恢复测试", ruleType: "UPSTREAM_SIGNAL", actorId,
      version: { unified_signal: "QUOTA_EXHAUSTED", action: "BLOCK", recovery_method: "UPSTREAM_RESET_TIME" },
    });
    await repository.publishRule(rule.rule.id, rule.current_version.version, actorId);
    const encrypted = encryptCredential("worker-secret-canary", kek);
    await repository.saveEndpoint({
      corpId: "corp-test", agentId: "1000002", secretCiphertext: JSON.stringify(encrypted),
      secretFingerprint: "fingerprint-only", status: "ACTIVE",
    });
    const provider = await db.insertInto("provider").values({
      enterprise_id: enterpriseId, code: `worker-${actorId.slice(0, 12)}`, name: "Worker Provider", adapter_type: "zhipu",
    }).returningAll().executeTakeFirstOrThrow();
    const resource = await db.insertInto("provider_resource").values({
      enterprise_id: enterpriseId, provider_id: provider.id, name: "Worker Resource",
      mode: "API", credential_type: "API_KEY",
    }).returningAll().executeTakeFirstOrThrow();
    const principalKey = await db.insertInto("principal_key").values({
      enterprise_id: enterpriseId, principal_id: principalId,
      key_prefix: "worker-test", key_digest: randomUUID(), status: "ACTIVE",
    }).returningAll().executeTakeFirstOrThrow();
    const aiRequestId = randomUUID();
    await db.insertInto("ai_request").values({
      id: aiRequestId, enterprise_id: enterpriseId, principal_id: principalId,
      principal_key_id: principalKey.id, protocol: "chat", unified_model: "glm-test",
    }).execute();
    const started = new Date(Date.now() + 1_000);
    const signal = await repository.recordSignal({
      enterpriseId, providerId: provider.id, providerResourceId: resource.id, unifiedModelId: null,
      upstreamModel: "glm-test", signal: "QUOTA_EXHAUSTED", upstreamCode: "1310",
      upstreamRecoverAt: new Date(started.getTime() + 1_000), aiRequestId, principalId,
      now: started, mode: "ENFORCE", wecomNotify: true,
    });
    expect(signal.event?.status).toBe("OPEN");

    const projectOwner = await db.insertInto("person").values({ name: "项目负责人" }).returningAll().executeTakeFirstOrThrow();
    const projectIdentity = await db.insertInto("person_external_identity").values({
      person_id: projectOwner.id, provider: "WECOM", provider_user_id: "project-owner-userid", status: "ACTIVE",
    }).returningAll().executeTakeFirstOrThrow();
    const projectPrincipal = await db.insertInto("principal").values({
      enterprise_id: enterpriseId, type: "PROJECT", name: "试点项目", owner_person_id: projectOwner.id,
    }).returningAll().executeTakeFirstOrThrow();
    const missingPerson = await db.insertInto("person").values({ name: "未绑定企微人员" }).returningAll().executeTakeFirstOrThrow();
    const missingPrincipal = await db.insertInto("principal").values({
      enterprise_id: enterpriseId, type: "EMPLOYEE", name: "未绑定企微主体", person_id: missingPerson.id,
    }).returningAll().executeTakeFirstOrThrow();
    const concurrentSignals: Parameters<RuntimeAssuranceRepository["recordSignal"]>[0][] = [];
    for (const affectedPrincipalId of [projectPrincipal.id, missingPrincipal.id]) {
      const key = await db.insertInto("principal_key").values({
        enterprise_id: enterpriseId, principal_id: affectedPrincipalId,
        key_prefix: `worker-${affectedPrincipalId.slice(0, 6)}`, key_digest: randomUUID(), status: "ACTIVE",
      }).returningAll().executeTakeFirstOrThrow();
      const requestId = randomUUID();
      await db.insertInto("ai_request").values({
        id: requestId, enterprise_id: enterpriseId, principal_id: affectedPrincipalId,
        principal_key_id: key.id, protocol: "chat", unified_model: "glm-test",
      }).execute();
      concurrentSignals.push({
        enterpriseId, providerId: provider.id, providerResourceId: resource.id, unifiedModelId: null,
        upstreamModel: "glm-test", signal: "QUOTA_EXHAUSTED", upstreamCode: "1310",
        upstreamRecoverAt: new Date(started.getTime() + 1_000), aiRequestId: requestId,
        principalId: affectedPrincipalId, now: started, mode: "ENFORCE", wecomNotify: true,
      });
    }
    concurrentSignals.push({
      enterpriseId, providerId: provider.id, providerResourceId: resource.id, unifiedModelId: null,
      upstreamModel: "glm-test", signal: "QUOTA_EXHAUSTED", upstreamCode: "1310",
      upstreamRecoverAt: new Date(started.getTime() + 1_000), aiRequestId, principalId,
      now: started, mode: "ENFORCE", wecomNotify: true,
    });
    await Promise.all(concurrentSignals.map((input) => repository.recordSignal(input)));
    const deduplicatedEvent = await db.selectFrom("availability_event").selectAll()
      .where("id", "=", signal.event!.id).executeTakeFirstOrThrow();
    expect(deduplicatedEvent.affected_request_count).toBe(4);
    expect(deduplicatedEvent.affected_person_count).toBe(3);

    const fakeFetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.origin).toBe("https://qyapi.weixin.qq.com");
      if (url.pathname.endsWith("/gettoken")) {
        return new Response(JSON.stringify({ errcode: 0, access_token: "test-token", expires_in: 7200 }));
      }
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      sentBodies.push(body);
      return new Response(JSON.stringify({ errcode: 0, errmsg: "ok", msgid: randomUUID() }));
    };
    const result = await runRuntimeAssuranceTick({
      repository,
      wecom: new WecomAppClient(
        kekBase64, fakeFetch as typeof fetch, () => started.getTime() + 2_000, "https://admin.example.test",
      ),
      wecomNotify: true,
      now: new Date(started.getTime() + 2_000),
    });
    expect(result.recoveredDue).toBe(1);
    expect(result.deliveriesProcessed).toBe(4);
    expect(sentBodies).toHaveLength(4);
    expect(sentBodies.filter((body) => body.touser === identity.provider_user_id)).toHaveLength(2);
    expect(sentBodies.filter((body) => body.touser === projectIdentity.provider_user_id)).toHaveLength(2);
    expect(sentBodies.every((body) => body.chatid === undefined && body.webhook === undefined)).toBe(true);
    expect(sentBodies.every((body) => String((body.text as { content: string }).content).includes("https://admin.example.test/runtime-assurance"))).toBe(true);
    const deliveries = await repository.listDeliveries();
    expect(deliveries.filter((item) => item.status === "SENT")).toHaveLength(4);
    expect(deliveries.filter((item) => item.status === "SKIPPED" && item.last_error_classification === "RECIPIENT_IDENTITY_MISSING")).toHaveLength(2);
  });

  it("调度锁互斥，同一时刻只有一个责任方", async () => {
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const lockEntered = new Promise<void>((resolve) => { entered = resolve; });
    const first = withRuntimeSchedulerLock(db, async () => { entered(); await held; return "first"; });
    await lockEntered;
    const second = await withRuntimeSchedulerLock(db, async () => "second");
    expect(second).toBeNull();
    release();
    expect(await first).toBe("first");
  });

  it("企微限频指数退避，不回滚事件", async () => {
    const delivery = await db.selectFrom("notification_delivery").selectAll()
      .where("recipient_identity_id", "is not", null).limit(1).executeTakeFirstOrThrow();
    await db.updateTable("notification_delivery").set({ status: "PENDING", attempt_count: 0 }).where("id", "=", delivery.id).execute();
    const throttledFetch = async (input: string | URL | Request) => {
      const url = new URL(String(input));
      return new Response(JSON.stringify(url.pathname.endsWith("/gettoken")
        ? { errcode: 0, access_token: "retry-token", expires_in: 7200 }
        : { errcode: 45009, errmsg: "rate limited" }));
    };
    const now = new Date(Date.now() + 60_000);
    await runRuntimeAssuranceTick({
      repository: new RuntimeAssuranceRepository(db),
      wecom: new WecomAppClient(kekBase64, throttledFetch as typeof fetch, () => now.getTime()),
      wecomNotify: true, now,
    });
    const retried = await db.selectFrom("notification_delivery").selectAll().where("id", "=", delivery.id).executeTakeFirstOrThrow();
    expect(retried.status).toBe("RETRYABLE_FAILED");
    expect(retried.next_attempt_at).toEqual(new Date(now.getTime() + 30_000));
  });

  it("旧 UNAVAILABLE 先 Shadow，只迁移有技术故障证据的资源", async () => {
    const provider = await db.insertInto("provider").values({
      enterprise_id: enterpriseId, code: `legacy-${randomUUID().slice(0, 8)}`,
      name: "Legacy Provider", adapter_type: "deepseek",
    }).returningAll().executeTakeFirstOrThrow();
    const technical = await db.insertInto("provider_resource").values({
      enterprise_id: enterpriseId, provider_id: provider.id, name: "Technical Legacy",
      mode: "API", credential_type: "API_KEY", status: "UNAVAILABLE",
    }).returningAll().executeTakeFirstOrThrow();
    const unknown = await db.insertInto("provider_resource").values({
      enterprise_id: enterpriseId, provider_id: provider.id, name: "Unknown Legacy",
      mode: "API", credential_type: "API_KEY", status: "UNAVAILABLE",
    }).returningAll().executeTakeFirstOrThrow();
    await db.insertInto("resource_status_event").values({
      enterprise_id: enterpriseId, provider_resource_id: technical.id,
      from_status: "DEGRADED", to_status: "UNAVAILABLE", reason: "FAILURE_THRESHOLD",
      error_classification: "UPSTREAM_TEMPORARY", actor: "system",
    }).execute();
    const repository = new RuntimeAssuranceRepository(db);
    const shadow = await repository.assessLegacyUnavailable();
    expect(shadow.find((item) => item.resource_id === technical.id)?.disposition).toBe("SAFE_DOWNGRADE");
    expect(shadow.find((item) => item.resource_id === unknown.id)?.disposition).toBe("MANUAL_REVIEW");
    await repository.migrateSafeLegacyUnavailable();
    expect((await db.selectFrom("provider_resource").select("status").where("id", "=", technical.id).executeTakeFirstOrThrow()).status).toBe("DEGRADED");
    expect((await db.selectFrom("provider_resource").select("status").where("id", "=", unknown.id).executeTakeFirstOrThrow()).status).toBe("UNAVAILABLE");
  });
});
