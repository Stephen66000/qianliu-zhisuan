import { randomUUID } from "node:crypto";
import { describe, it, expect, vi, afterEach } from "vitest";
import { CredentialChatProbeRepository, ResourcePoolRepository } from "@qianliu/database";
import { encryptCredential, providerChatConfigHash } from "@qianliu/provider-adapters";
import { app, db, adminCookie, ENT_ID, ADM_ID } from "./w19-admin-fixture.js";

const secret = "private-probe-key-canary";
const configHash = (p: string, mode: string, model: string) => providerChatConfigHash(p as "kimi", mode, model);
const success = { status: 200, committed: true,
  usage: { input: 2, output: 1, cache: 0, quality: "ACTUAL" as const } };
afterEach(() => vi.unstubAllGlobals());

async function seed() {
  let provider = await db.selectFrom("provider").selectAll().where("enterprise_id", "=", ENT_ID)
    .where("code", "=", "kimi").executeTakeFirst();
  provider ??= await db.insertInto("provider").values({ enterprise_id: ENT_ID,
    name: "Kimi probe", code: "kimi", adapter_type: "OPENAI_COMPATIBLE", status: "ACTIVE" })
    .returningAll().executeTakeFirstOrThrow();
  const r = await db.insertInto("provider_resource").values({ enterprise_id: ENT_ID,
    provider_id: provider.id, name: "probe", mode: "CODING_PLAN", credential_type: "API_KEY",
    credential_version: 1, credential_ciphertext: JSON.stringify(encryptCredential(secret, app.credentialKek)),
    status: "ACTIVE" }).returningAll().executeTakeFirstOrThrow();
  await new ResourcePoolRepository(db).recordFailure(r.id, "UPSTREAM_CREDENTIAL_INVALID", new Date(),
    { upstreamModel: "k3-256k", upstreamConfigHash: configHash("kimi", "CODING_PLAN", "k3-256k") });
  return r.id;
}
function post(id: string, key = randomUUID(), body = {}) {
  return app.inject({ method: "POST", url: `/provider-resources/${id}/credential-probes`,
    headers: { cookie: adminCookie }, payload: { idempotency_key: key, confirm_quota_consumption: true, ...body } });
}
function response(status = 200) {
  return new Response(JSON.stringify(status === 200 ? {
    choices: [{ message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
  } : { error: { type: "authentication_error", message: `invalid token ${secret}` } }), { status });
}

describe("credential Chat recovery", () => {
  it("I1: expiry during recovery rolls back the resource and records an expired outcome", async () => {
    const id = await seed(); const repo = new CredentialChatProbeRepository(db);
    const started = await repo.begin({ enterpriseId: ENT_ID, resourceId: id, actorId: ADM_ID, key: randomUUID(), configHash });
    const clock = vi.spyOn(Date, "now");
    let checks = 0;
    try {
      const result = await repo.finish({ enterpriseId: ENT_ID, resourceId: id, probeId: started.probe.id,
        outcome: success, configHash, cancelled: () => {
          if (++checks === 2) clock.mockReturnValue(started.probe.expires_at.getTime() + 1);
          return false;
        } });
      expect(result.status).toBe("EXPIRED");
      expect((await new ResourcePoolRepository(db).getResource(id))?.status).toBe("CREDENTIAL_INVALID");
      expect(await db.selectFrom("operation_log").select("result").where("target_id", "=", id)
        .where("action", "=", "provider_resource.credential_probe").execute()).toEqual([{ result: "FAILURE" }]);
    } finally { clock.mockRestore(); }
  });
  it("uses same credential, original model and endpoint; success restores isolation and records safe evidence", async () => {
    const id = await seed();
    const model = (await db.insertInto("unified_model").values({ enterprise_id: ENT_ID,
      alias: `probe-${id}`, display_name: "probe", status: "ACTIVE" }).returning("id").executeTakeFirstOrThrow()).id;
    await db.insertInto("model_route").values({ enterprise_id: ENT_ID, unified_model_id: model,
      provider_resource_id: id, upstream_model: "k3-256k", enabled: true }).execute();
    await db.insertInto("billing_rule").values({ enterprise_id: ENT_ID, provider_resource_id: id,
      upstream_model: "k3-256k", rule_type: "MODEL_TIER", rule_version: "probe-v1", multiplier: "1",
      effective_from: new Date("2026-01-01"), enabled: true }).execute();
    const principal = (await db.insertInto("principal").values({ enterprise_id: ENT_ID, name: "probe subject",
      type: "EMPLOYEE", status: "ACTIVE" }).returning("id").executeTakeFirstOrThrow()).id;
    const subjectKey = (await db.insertInto("principal_key").values({ enterprise_id: ENT_ID, principal_id: principal,
      key_prefix: "probe-key", key_digest: randomUUID(), allowed_model_ids: [], status: "ACTIVE" })
      .returning("id").executeTakeFirstOrThrow()).id;
    await db.insertInto("principal_grant").values({ enterprise_id: ENT_ID, principal_id: principal,
      provider: "kimi", model_alias: "*", pool_model_alias: "*", quota_value: 10000n, status: "ACTIVE" }).execute();
    let duringStatus: string | undefined;
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => {
      duringStatus = (await db.selectFrom("provider_resource").select("status").where("id", "=", id)
        .executeTakeFirstOrThrow()).status;
      return response();
    });
    vi.stubGlobal("fetch", fetch);
    const key = randomUUID();
    const result = await post(id, key);
    expect(duringStatus).toBe("CREDENTIAL_INVALID");
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://api.kimi.com/coding/v1/chat/completions");
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${secret}`);
    expect(JSON.parse(init.body as string)).toMatchObject({ model: "k3-256k", stream: false, max_tokens: 32 });
    expect(result.statusCode).toBe(200);
    expect(result.json().probe).toMatchObject({ status: "RECOVERED", upstreamModel: "k3-256k", credentialVersion: 1 });
    expect(result.body).not.toContain(secret);
    expect((await post(id, key)).json().probe.status).toBe("RECOVERED");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await db.selectFrom("provider_resource").select("status").where("id", "=", id)
      .executeTakeFirstOrThrow()).status).toBe("DEGRADED");
    expect((await db.selectFrom("principal_key").select("allowed_model_ids").where("id", "=", subjectKey)
      .executeTakeFirstOrThrow()).allowed_model_ids).toContain(model);
    expect(await db.selectFrom("resource_status_event").select("reason").where("provider_resource_id", "=", id)
      .where("reason", "=", "CHAT_AUTH_PROBE_RECOVERED").execute()).toHaveLength(1);
  });

  it("401 stays isolated, does not retry, retains sanitized evidence and imposes cooldown", async () => {
    const id = await seed();
    const fetch = vi.fn(async () => response(401)); vi.stubGlobal("fetch", fetch);
    expect((await post(id)).json().probe).toMatchObject({ status: "FAILED", httpStatus: 401,
      evidence: { messageCategory: "AUTHENTICATION_FAILED" } });
    expect((await post(id)).statusCode).toBe(409);
    expect(fetch).toHaveBeenCalledTimes(1);
    const history = await new CredentialChatProbeRepository(db).list(ENT_ID, id);
    expect(JSON.stringify(history)).not.toContain(secret);
    expect((await new ResourcePoolRepository(db).getResource(id))?.status).toBe("CREDENTIAL_INVALID");
    expect(await new ResourcePoolRepository(db).recordQuotaSyncRecovery(id)).toBeNull();
  });

  it.each(["credential", "failure", "model", "configuration", "disabled"])(
    "stale %s result cannot restore resource", async kind => {
      const id = await seed(); const repo = new CredentialChatProbeRepository(db);
      const started = await repo.begin({ enterpriseId: ENT_ID, resourceId: id, actorId: ADM_ID, key: randomUUID(), configHash });
      if (kind === "credential") await db.updateTable("provider_resource").set({ credential_version: 2 }).where("id", "=", id).execute();
      if (kind === "failure") await new ResourcePoolRepository(db).recordFailure(id, "UPSTREAM_CREDENTIAL_INVALID", new Date(), { upstreamModel: "k3-256k" });
      if (kind === "model") await db.updateTable("provider_resource").set({ auth_failure_model: "k3" }).where("id", "=", id).execute();
      if (kind === "disabled") await db.updateTable("provider_resource").set({ status: "EXPIRED" }).where("id", "=", id).execute();
      const result = await repo.finish({ enterpriseId: ENT_ID, resourceId: id, probeId: started.probe.id,
        outcome: success, cancelled: () => false, configHash: kind === "configuration" ? () => "changed" : configHash });
      expect(result.status).toBe("STALE");
      expect((await new ResourcePoolRepository(db).getResource(id))?.status).not.toBe("DEGRADED");
    });

  it("concurrent clicks acquire one lease; cancelled and expired probes cannot restore", async () => {
    const id = await seed(); const repo = new CredentialChatProbeRepository(db);
    const results = await Promise.allSettled([1, 2].map(() => repo.begin({ enterpriseId: ENT_ID,
      resourceId: id, actorId: ADM_ID, key: randomUUID(), configHash })));
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    const started = results.find(r => r.status === "fulfilled");
    if (!started || started.status !== "fulfilled") throw new Error("probe missing");
    const done = await repo.finish({ enterpriseId: ENT_ID, resourceId: id, probeId: started.value.probe.id,
      outcome: success, cancelled: () => true, configHash });
    expect(done.status).toBe("CANCELLED");
    expect((await new ResourcePoolRepository(db).getResource(id))?.status).toBe("CREDENTIAL_INVALID");
    const next = await repo.begin({ enterpriseId: ENT_ID, resourceId: id, actorId: ADM_ID,
      key: randomUUID(), configHash, now: new Date(Date.now() + 600_000) });
    expect((await repo.finish({ enterpriseId: ENT_ID, resourceId: id, probeId: next.probe.id,
      outcome: success, cancelled: () => false, configHash, now: new Date(Date.now() + 800_000) })).status).toBe("EXPIRED");
  });

  it("requires operation permission and explicit quota consent; cannot select a different model", async () => {
    const id = await seed(); const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    expect((await app.inject({ method: "POST", url: `/provider-resources/${id}/credential-probes`, payload: {} })).statusCode).toBe(401);
    expect((await post(id, randomUUID(), { confirm_quota_consumption: false })).statusCode).toBe(400);
    expect((await post(id, randomUUID(), { model: "k3" })).statusCode).toBe(400);
    expect((await post(randomUUID())).statusCode).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
    await db.updateTable("admin_user").set({ role_code: "CUSTOM" }).where("id", "=", ADM_ID).execute();
    try { expect((await post(id)).statusCode).toBe(403); }
    finally { await db.updateTable("admin_user").set({ role_code: "SUPER_ADMIN" }).where("id", "=", ADM_ID).execute(); }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("network failures and invalid HTTP 200 are not recovery evidence", async () => {
    const id = await seed();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    expect((await post(id)).json().probe.status).toBe("FAILED");
    const next = await seed();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error(secret); }));
    const result = await post(next);
    expect(result.json().probe.status).toBe("FAILED");
    expect(result.body).not.toContain(secret);
  });

  it("cancel during the recovery transaction rolls back all resource changes", async () => {
    const id = await seed(); const repo = new CredentialChatProbeRepository(db);
    const begin = await repo.begin({ enterpriseId: ENT_ID, resourceId: id, actorId: ADM_ID, key: randomUUID(), configHash });
    let checks = 0;
    const result = await repo.finish({ enterpriseId: ENT_ID, resourceId: id, probeId: begin.probe.id,
      outcome: success, configHash, cancelled: () => ++checks > 1 });
    expect(result.status).toBe("CANCELLED");
    expect((await new ResourcePoolRepository(db).getResource(id))?.status).toBe("CREDENTIAL_INVALID");
    expect(await db.selectFrom("resource_status_event").select("id").where("provider_resource_id", "=", id)
      .where("reason", "=", "CHAT_AUTH_PROBE_RECOVERED").execute()).toHaveLength(0);
  });

  it("missing original model refuses probes and isolated quota-sync explains the real reason", async () => {
    const id = await seed();
    await new ResourcePoolRepository(db).recordRefreshFailure(id, "OAUTH_REFRESH_REJECTED");
    expect((await post(id)).json().error).toBe("failure_model_unknown");
    const quota = await app.inject({ method: "POST", url: `/provider-resources/${id}/quota-sync`, headers: { cookie: adminCookie } });
    expect(quota.statusCode).toBe(409);
    expect(quota.json().error).toBe("credential_isolated");
  });
});
