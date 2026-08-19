import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { Decimal } from "decimal.js";
import { sql } from "kysely";
import { z } from "zod";
import { requireAuth } from "../plugins/auth-guard.js";
import { listResourceUtilization } from "./query.js";

const Month = z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/);
const NoteBody = z.object({
  note: z.string().max(4000),
  expected_version: z.number().int().nonnegative(),
  idempotency_key: z.string().min(1).max(128),
});

interface PriorNoteReceipt { request_hash: string; response_snapshot: unknown }

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function registerResourceInsightRoutes(
  app: FastifyInstance,
  options: { utilizationV2?: boolean; procurementReview?: boolean } = {},
): void {
  if (options.utilizationV2 !== false) app.get("/provider-resources/utilization", { preHandler: [requireAuth] }, async (req, reply) => {
    const parsed = z.object({ month: Month }).safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request", message: "month 必须为 YYYY-MM" });
    }
    return {
      month: parsed.data.month,
      resources: await listResourceUtilization(app.db, req.admin!.enterpriseId, parsed.data.month),
      generatedAt: new Date().toISOString(),
    };
  });

  if (options.procurementReview !== false) app.get<{ Params: { month: string } }>(
    "/procurement-reviews/:month",
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const parsed = Month.safeParse(req.params.month);
      if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
      const enterpriseId = req.admin!.enterpriseId;
      const [resources, bill, noteResult] = await Promise.all([
        listResourceUtilization(app.db, enterpriseId, parsed.data),
        app.operatingBillRepo.getBill(enterpriseId, parsed.data),
        sql<{ note: string; version: number; updated_at: Date; updated_by_name: string }>`
          SELECT n.note, n.version, n.updated_at, a.display_name AS updated_by_name
            FROM procurement_review_note n
            JOIN admin_user a ON a.id = n.updated_by
           WHERE n.enterprise_id = ${enterpriseId}::uuid
             AND n.month = ${`${parsed.data}-01`}::date
        `.execute(app.db),
      ]);
      const note = noteResult.rows[0];
      const billByResource = new Map(bill.providers.map((row) => [row.providerResourceId, row]));
      const frozenCurrency = bill.summary.endingBalanceCurrency;
      return {
        month: parsed.data,
        summary: {
          purchaseCashAmounts: currencyTotals(bill.providers.flatMap((row) => row.purchases)),
          apiSpends: frozenAmounts(bill.summary.apiSpends, bill.summary.apiCost, frozenCurrency),
          packageCosts: frozenAmounts(
            bill.summary.packageCosts, bill.summary.packageCost, frozenCurrency,
          ),
          planUtilization: bill.summary.planUtilization,
        },
        resources: resources.map((resource) => {
          const operating = billByResource.get(resource.resourceId);
          const purchaseCashAmounts = currencyTotals(operating?.purchases ?? []);
          const merged = {
            ...resource,
            apiCost: operating?.apiCost ?? null,
            ledgerApiCost: operating?.ledgerApiCost ?? null,
            apiSpendReason: operating?.apiSpendReason ?? null,
            packageCost: operating?.packageCost ?? null,
            currency: operating?.currency ?? resource.currency,
            purchaseCashAmount: purchaseCashAmounts.length === 0 ? "0.00000000"
              : purchaseCashAmounts.length === 1 ? purchaseCashAmounts[0]!.amount : null,
            purchaseCashAmounts,
          };
          return { ...merged, reviewLabel: reviewLabel(merged), reviewReason: reviewReason(merged) };
        }),
        note: note
          ? { text: note.note, version: note.version, updatedAt: note.updated_at.toISOString(), updatedBy: note.updated_by_name }
          : { text: "", version: 0, updatedAt: null, updatedBy: null },
      };
    },
  );

  if (options.procurementReview !== false) app.put<{ Params: { month: string } }>(
    "/procurement-reviews/:month/note",
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const month = Month.safeParse(req.params.month);
      const body = NoteBody.safeParse(req.body);
      if (!month.success || !body.success) {
        return reply.code(400).send({ error: "invalid_request", message: "备注参数无效" });
      }
      const enterpriseId = req.admin!.enterpriseId;
      const monthStart = `${month.data}-01`;
      const requestHash = sha256({ month: month.data, note: body.data.note, expectedVersion: body.data.expected_version });
      const outcome = await app.db.transaction().execute(async (trx) => {
        await sql`select pg_advisory_xact_lock(hashtext(${`${enterpriseId}:${month.data}:${body.data.idempotency_key}`}))`.execute(trx);
        const prior = await sql<PriorNoteReceipt>`
          SELECT request_hash, response_snapshot
            FROM procurement_review_note_idempotency
           WHERE enterprise_id = ${enterpriseId}::uuid AND month = ${monthStart}::date
             AND idempotency_key = ${body.data.idempotency_key}
        `.execute(trx);
        const receipt = prior.rows[0];
        if (receipt) {
          return receipt.request_hash === requestHash
            ? { kind: "ok" as const, value: receipt.response_snapshot }
            : { kind: "idempotency_conflict" as const };
        }
        const current = await sql<{ id: string; version: number }>`
          SELECT id, version FROM procurement_review_note
           WHERE enterprise_id = ${enterpriseId}::uuid AND month = ${monthStart}::date
           FOR UPDATE
        `.execute(trx);
        const existing = current.rows[0];
        if ((existing?.version ?? 0) !== body.data.expected_version) {
          return { kind: "version_conflict" as const };
        }
        const saved = existing
          ? await sql<{ id: string; note: string; version: number; updated_at: Date }>`
              UPDATE procurement_review_note
                 SET note = ${body.data.note}, version = version + 1,
                     updated_by = ${req.admin!.adminUserId}::uuid, updated_at = now()
               WHERE id = ${existing.id}::uuid
               RETURNING id, note, version, updated_at
            `.execute(trx)
          : await sql<{ id: string; note: string; version: number; updated_at: Date }>`
              INSERT INTO procurement_review_note (enterprise_id, month, note, updated_by)
              VALUES (${enterpriseId}::uuid, ${monthStart}::date, ${body.data.note}, ${req.admin!.adminUserId}::uuid)
              RETURNING id, note, version, updated_at
            `.execute(trx);
        const row = saved.rows[0]!;
        const value = { note: row.note, version: row.version, updatedAt: row.updated_at.toISOString() };
        await sql`
          INSERT INTO procurement_review_note_idempotency
            (enterprise_id, month, idempotency_key, request_hash, response_snapshot)
          VALUES (${enterpriseId}::uuid, ${monthStart}::date, ${body.data.idempotency_key},
                  ${requestHash}, ${JSON.stringify(value)}::jsonb)
        `.execute(trx);
        return { kind: "ok" as const, value, id: row.id };
      });
      if (outcome.kind === "idempotency_conflict") {
        return reply.code(409).send({ error: "idempotency_conflict", message: "幂等键已用于不同内容" });
      }
      if (outcome.kind === "version_conflict") {
        return reply.code(409).send({ error: "conflict", message: "备注已被其他管理员修改" });
      }
      if (outcome.id) {
        await app.auditRepo.write({
          enterprise_id: enterpriseId, admin_user_id: req.admin!.adminUserId,
          action: "procurement_review_note.update", target_type: "procurement_review_note",
          target_id: outcome.id, change_summary: { month: month.data, version: (outcome.value as { version: number }).version }, result: "SUCCESS",
        });
      }
      return outcome.value;
    },
  );
}

function frozenAmounts(
  facts: Array<{ currency: string; amount: string }> | undefined,
  amount: string | null,
  currency: string | null,
) {
  if (Array.isArray(facts)) return facts;
  return amount !== null && currency !== null ? [{ currency, amount }] : [];
}

function currencyTotals(facts: Array<{ currency: string; amount: string }>) {
  const totals = new Map<string, Decimal>();
  for (const fact of facts) {
    totals.set(fact.currency, (totals.get(fact.currency) ?? new Decimal(0)).plus(fact.amount));
  }
  return [...totals.entries()].sort(([left], [right]) => left.localeCompare(right))
    .map(([currency, amount]) => ({ currency, amount: amount.toDecimalPlaces(8).toFixed(8) }));
}

type ReviewResource = Pick<Awaited<ReturnType<typeof listResourceUtilization>>[number],
  "forecastExhaustAt" | "forecastNotCalculableReason" | "utilizationStatus" |
  "utilizationRate" | "notCalculableReason" | "mode" | "requestCount">;

function reviewLabel(resource: ReviewResource): string {
  if (resource.forecastExhaustAt || resource.utilizationStatus === "EXHAUSTED") return "关注耗尽";
  if (resource.utilizationStatus === "UNDERUSED") return "利用不足";
  if (resource.utilizationStatus === "OVER_BUDGET" || resource.utilizationStatus === "WARNING") return "关注预算";
  if (["NORMAL", "HEALTHY", "WINDOW_FACT_ONLY"].includes(resource.utilizationStatus)) return "维持";
  return "数据不足";
}

function reviewReason(resource: ReviewResource): string {
  const parts: string[] = [];
  if (resource.forecastExhaustAt) parts.push(`预计 ${resource.forecastExhaustAt} 耗尽`);
  else if (resource.forecastNotCalculableReason) parts.push(resource.forecastNotCalculableReason);
  if (resource.utilizationRate === null) parts.push(resource.notCalculableReason ?? "缺少可计算分母");
  else parts.push(resource.mode === "API" ? "API 费用占月预算比例" : "订阅周期原生额度使用比例");
  if (resource.requestCount === 0) parts.push("本月没有已结算请求");
  return [...new Set(parts)].join("；");
}
