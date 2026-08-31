import type { Kysely } from "kysely";
import type { Database } from "../kysely.js";
import {
  GatewayLedgerRepository,
  type CreateBillingRuleInput,
} from "./gateway-ledger-repository.js";
import { AuditRepository } from "./audit-repository.js";

export class BillingRuleImportConflictError extends Error {}

export class BillingRuleImportRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async create(input: {
    enterpriseId: string;
    adminUserId: string;
    modelRouteId: string;
    imageSha256: string;
    imageMime: string;
    imageBytes: number;
    extractorModel: string;
    extractorRequestId: string | null;
    sourceEvidence: Record<string, unknown>;
    candidateRules: Record<string, unknown>[];
    warnings: Record<string, unknown>[];
  }) {
    return this.db.insertInto("billing_rule_import").values({
      enterprise_id: input.enterpriseId,
      admin_user_id: input.adminUserId,
      model_route_id: input.modelRouteId,
      image_sha256: input.imageSha256,
      image_mime: input.imageMime,
      image_bytes: input.imageBytes,
      extractor_model: input.extractorModel,
      extractor_request_id: input.extractorRequestId,
      source_evidence: JSON.stringify(input.sourceEvidence) as unknown as Record<string, unknown>,
      candidate_rules: JSON.stringify(input.candidateRules) as unknown as Record<string, unknown>[],
      warnings: JSON.stringify(input.warnings) as unknown as Record<string, unknown>[],
      created_rule_ids: null,
      confirmed_at: null,
    }).returningAll().executeTakeFirstOrThrow();
  }

  async get(enterpriseId: string, importId: string) {
    return this.db.selectFrom("billing_rule_import").selectAll()
      .where("enterprise_id", "=", enterpriseId)
      .where("id", "=", importId).executeTakeFirst();
  }

  async confirm(input: {
    enterpriseId: string;
    importId: string;
    expectedVersion: number;
    rules: CreateBillingRuleInput[];
    adminUserId: string;
    acknowledgedWarningCodes: string[];
  }) {
    return this.db.transaction().execute(async (trx) => {
      const imported = await trx.selectFrom("billing_rule_import").selectAll()
        .where("enterprise_id", "=", input.enterpriseId)
        .where("id", "=", input.importId).forUpdate().executeTakeFirst();
      if (!imported) return null;
      if (imported.status !== "EXTRACTED" || imported.version !== input.expectedVersion) {
        throw new BillingRuleImportConflictError("该截图导入已确认或已被其他管理员修改");
      }
      const ledger = new GatewayLedgerRepository(trx);
      const rules = [];
      for (const rule of input.rules) rules.push(await ledger.createBillingRule(rule));
      await trx.updateTable("billing_rule_import").set({
        status: "CONFIRMED",
        created_rule_ids: JSON.stringify(rules.map((rule) => rule.id)) as unknown as string[],
        confirmed_at: new Date(),
        version: imported.version + 1,
      }).where("id", "=", imported.id).execute();
      await new AuditRepository(trx).write({
        enterprise_id: input.enterpriseId,
        admin_user_id: input.adminUserId,
        action: "billing_rule_import.confirm",
        target_type: "billing_rule_import",
        target_id: imported.id,
        change_summary: {
          image_sha256: imported.image_sha256,
          extractor_model: imported.extractor_model,
          extractor_request_id: imported.extractor_request_id,
          created_rule_ids: rules.map((rule) => rule.id),
          acknowledged_warning_codes: input.acknowledgedWarningCodes,
        },
        result: "SUCCESS",
      });
      return { imported: { ...imported, status: "CONFIRMED", version: imported.version + 1 }, rules };
    });
  }
}
