import { describe, it, expect } from "vitest";
import { StubUpstream } from "@qianliu/provider-adapters";
import { DispatchPolicyRepository } from "@qianliu/database";
import { db, stub, ledgerRepo, dispatchRepo, ENT_ID, authHeader, buildApp, setStub, seedApiSwitch } from "./w16-dispatch-fixture.js";

class FailingDecisionRepository extends DispatchPolicyRepository {
  override async createDecisionIfAbsent(): Promise<string | null> {
    throw new Error("dispatch_decision_write_failure");
  }
}

class FailingSettlementEvidenceRepository extends DispatchPolicyRepository {
  attempts = 0;

  override async enrichDecisionSettlementEvidence(): Promise<void> {
    this.attempts += 1;
    throw new Error("dispatch_settlement_evidence_write_failure");
  }
}

describe("W16 审计与失败", () => {
  it("正文 canary 为 0：经营调度请求 body 不落库（METADATA_ONLY）", async () => {
    const BODY_CANARY = "SECRET_W16_DISPATCH_CANARY_TEST_99999";
    setStub(new StubUpstream({
      default: { kind: "SUCCESS", usage: { input: 100, output: 50, cache: 0 } },
      providerCode: "zhipu",
    }));
    const app = await buildApp(async () => ({
      priceMultiplier: "1",
      remainingQuotaRatio: 0.9,
      forecastExhaustRisk: false,
    }));

    const chatRes = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: authHeader(),
      payload: { model: "ql-glm-5.2", messages: [{ role: "user", content: BODY_CANARY }] },
    });
    expect(chatRes.statusCode).toBe(200);
    await app.close();

    // 扫描 dispatch_decision + 账本表，body 不得命中
    const { sql } = await import("kysely");
    const tables = ["ai_request", "route_candidate", "upstream_attempt", "usage_event", "ledger_line", "ledger_transaction", "dispatch_decision"];
    let total = 0;
    for (const table of tables) {
      const result = await sql`SELECT COUNT(*)::int AS hits FROM (SELECT row_to_json(r)::text AS txt FROM ${sql.raw(table)} r) s WHERE s.txt LIKE ${"%" + BODY_CANARY + "%"}`.execute(db);
      total += Number((result.rows[0] as { hits: number }).hits);
    }
    expect(total, "经营调度请求正文 canary 必须在所有表 0 命中").toBe(0);
  });

  it("决策审计写入失败时禁止执行上游动作", async () => {
    setStub(new StubUpstream({
      default: { kind: "SUCCESS", usage: { input: 100, output: 50, cache: 0 } },
      providerCode: "zhipu",
    }));
    const app = await buildApp(
      async () => ({
        priceMultiplier: "1",
        remainingQuotaRatio: 0.9,
        forecastExhaustRisk: false,
      }),
      undefined,
      new FailingDecisionRepository(db),
    );
    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: authHeader(),
        payload: { model: "ql-glm-5.2", messages: [{ role: "user", content: "hi" }] },
      });
      expect(response.statusCode).toBe(500);
      expect(stub.calls).toHaveLength(0);
      const request = await db.selectFrom("ai_request").selectAll()
        .where("enterprise_id", "=", ENT_ID).orderBy("started_at", "desc")
        .executeTakeFirstOrThrow();
      expect(request.status).toBe("FAILED");
      expect(request.error_classification).toBe("INTERNAL");
      expect(request.error_code).toBe("dispatch_decision_write_failure");
      expect(await db.selectFrom("upstream_attempt").select("id")
        .where("ai_request_id", "=", request.id).execute()).toEqual([]);
      expect(await db.selectFrom("dispatch_decision").select("id")
        .where("ai_request_id", "=", request.id).execute()).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("上游未提交失败与提交后中断都冻结 FAILED，且无调度仓储时不伪造决策", async () => {
    for (const mode of [
      { kind: "ERROR" as const, status: 500, errorCode: "provider_failed", classification: "UPSTREAM" },
      { kind: "STREAM" as const, chunks: ["partial"], usage: { input: 10, output: 4, cache: 0 }, failAfterChunk: 1 },
    ]) {
      setStub(new StubUpstream({ default: mode, providerCode: "deepseek" }));
      const app = await buildApp(undefined, undefined, null);
      try {
        const response = await app.inject({
          method: "POST", url: "/v1/chat/completions", headers: authHeader(),
          payload: { model: "qianliu-deepseek", messages: [{ role: "user", content: "failure" }] },
        });
        const requestId = String(response.headers["x-request-id"]);
        const request = await ledgerRepo.getRequest(requestId);
        expect(request).toMatchObject({ status: "FAILED" });
        expect(request?.error_code).toBeTruthy();
        expect(await dispatchRepo.getDecision(requestId)).toBeUndefined();
      } finally {
        await app.close();
      }
    }
  });

  it("调度补充证据失败不阻断核心终态、账本与租约释放", async () => {
    await seedApiSwitch();
    setStub(new StubUpstream({
      default: { kind: "SUCCESS", usage: { input: 100, output: 50, cache: 0 } },
      providerCode: "deepseek",
    }));
    const failingRepo = new FailingSettlementEvidenceRepository(db);
    const app = await buildApp(
      async () => ({
        priceMultiplier: "1",
        remainingQuotaRatio: 0.9,
        forecastExhaustRisk: false,
      }),
      undefined,
      failingRepo,
    );
    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: authHeader(),
        payload: { model: "qianliu-deepseek", messages: [{ role: "user", content: "hi" }] },
      });
      expect(response.statusCode).toBe(200);
      expect(stub.calls).toHaveLength(1);
      const requestId = String(response.headers["x-request-id"]);
      expect((await ledgerRepo.getRequest(requestId))?.status).toBe("SUCCEEDED");
      expect(await db.selectFrom("ledger_transaction").select("id")
        .where("ai_request_id", "=", requestId).executeTakeFirst()).toBeDefined();
      expect(await db.selectFrom("concurrency_lease").select("id")
        .where("ai_request_id", "=", requestId).where("released_at", "is", null).execute()).toEqual([]);
      expect((await dispatchRepo.getDecision(requestId))?.not_calculable_reason)
        .toBe("pending_settlement");
      expect(failingRepo.attempts).toBe(2);
    } finally {
      await app.close();
    }
  });
});
