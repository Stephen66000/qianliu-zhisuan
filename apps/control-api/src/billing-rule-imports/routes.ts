import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { BillingRuleImportConflictError } from "@qianliu/database";
import { requireAuth } from "../plugins/auth-guard.js";
import { CreateBillingRuleSchema, toBillingRuleInput } from "../read-models/routes.js";
import {
  normalizedPrice,
  type RuleExtractor,
  type RuleImportWarning,
} from "./extractor.js";

const PreviewSchema = z.object({
  model_route_id: z.string().uuid(),
  image_data_url: z.string().max(7_500_000),
}).strict();

const DraftRuleSchema = z.object({
  rule_type: z.enum(["API_PRICE", "TIME_WINDOW", "MODEL_TIER"]),
  windows: z.array(z.object({
    timezone: z.string(),
    days_of_week: z.string(),
    start_time: z.string(),
    end_time: z.string(),
  }).strict()).max(32),
  multiplier: z.string(),
  cache_hit_price: z.string(),
  cache_miss_price: z.string(),
  output_price: z.string(),
  currency: z.string().length(3),
  priority: z.number().int().min(0),
}).strict();

const ConfirmSchema = z.object({
  expected_version: z.number().int().positive(),
  rule_version: z.string().min(1).max(64),
  effective_from: z.string().datetime(),
  effective_to: z.string().datetime().nullable(),
  acknowledged_warning_codes: z.array(z.string()).max(100),
  source_price_unit: z.enum(["CNY_PER_TOKEN", "CNY_PER_THOUSAND_TOKENS", "CNY_PER_MILLION_TOKENS"]),
  rules: z.array(DraftRuleSchema).min(1).max(32),
}).strict();

const WarningSchema = z.object({
  code: z.string(), message: z.string(), field: z.string().nullable(), blocking: z.boolean(),
});

const StoredEvidenceSchema = z.object({
  targetModel: z.string(),
  unifiedModelName: z.string(),
  unitBasis: z.string(),
  targetRow: z.object({
    model_name: z.string(),
    context_display: z.string().nullable(),
    input_price: z.object({ current: z.string().nullable(), original: z.string().nullable() }),
    output_price: z.object({ current: z.string().nullable(), original: z.string().nullable() }),
    cache_storage: z.string().nullable(),
    cache_hit_price: z.object({ current: z.string().nullable(), original: z.string().nullable() }),
    input_modalities: z.array(z.string()),
    badges: z.array(z.string()),
    time_windows: z.array(z.object({
      timezone: z.string().nullable(),
      days_of_week: z.array(z.number()).nullable(),
      start_time: z.string(),
      end_time: z.string(),
      multiplier: z.string(),
    })),
    model_tier_multiplier: z.string().nullable(),
  }).nullable(),
});

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

function decodeImage(dataUrl: string): { bytes: Buffer; mime: string; sha256: string } {
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!match) throw new Error("仅支持 PNG、JPEG 和 WebP 的 Base64 图片");
  const bytes = Buffer.from(match[2]!, "base64");
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) throw new Error("图片必须在 5MB 以内");
  const mime = match[1]!;
  const magicOk = mime === "image/png"
    ? bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    : mime === "image/jpeg"
      ? bytes[0] === 0xff && bytes[1] === 0xd8
      : bytes.subarray(0, 4).toString("ascii") === "RIFF"
        && bytes.subarray(8, 12).toString("ascii") === "WEBP";
  if (!magicOk) throw new Error("图片 MIME 与文件内容不一致");
  return { bytes, mime, sha256: createHash("sha256").update(bytes).digest("hex") };
}

async function enabledRoute(app: FastifyInstance, enterpriseId: string, routeId: string) {
  return app.db.selectFrom("model_route")
    .innerJoin("unified_model", "unified_model.id", "model_route.unified_model_id")
    .innerJoin("provider_resource", "provider_resource.id", "model_route.provider_resource_id")
    .select([
      "model_route.id", "model_route.provider_resource_id", "model_route.upstream_model",
      "unified_model.display_name as unified_model_name",
    ])
    .where("model_route.enterprise_id", "=", enterpriseId)
    .where("unified_model.enterprise_id", "=", enterpriseId)
    .where("provider_resource.enterprise_id", "=", enterpriseId)
    .where("model_route.id", "=", routeId)
    .where("model_route.enabled", "=", true)
    .where("unified_model.status", "=", "ACTIVE")
    .where("provider_resource.status", "in", ["ACTIVE", "DEGRADED"])
    .executeTakeFirst();
}

function importView(row: {
  id: string; status: string; version: number; image_sha256: string; image_mime: string;
  image_bytes: number; extractor_model: string; extractor_request_id: string | null;
  source_evidence: Record<string, unknown>; candidate_rules: Record<string, unknown>[];
  warnings: Record<string, unknown>[]; created_rule_ids: string[] | null;
}) {
  return {
    id: row.id,
    status: row.status,
    version: row.version,
    imageSha256: row.image_sha256,
    imageMime: row.image_mime,
    imageBytes: row.image_bytes,
    extractorModel: row.extractor_model,
    extractorRequestId: row.extractor_request_id,
    sourceEvidence: row.source_evidence,
    candidateRules: row.candidate_rules,
    warnings: row.warnings,
    createdRuleIds: row.created_rule_ids,
  };
}

function sanitizedTargetEvidence(target: NonNullable<Awaited<ReturnType<RuleExtractor["extract"]>>["targetEvidence"]> | null) {
  if (!target) return null;
  return {
    model_name: target.model_name,
    context_display: target.context_display,
    input_price: target.input_price,
    output_price: target.output_price,
    cache_storage: target.cache_storage,
    cache_hit_price: target.cache_hit_price,
    input_modalities: target.input_modalities,
    badges: target.badges,
    time_windows: target.time_windows.map(({ source_text: _sourceText, ...window }) => window),
    model_tier_multiplier: target.model_tier_multiplier,
  };
}

function sanitizedWarning(warning: RuleImportWarning): RuleImportWarning {
  const message = warning.code === "PRICE_UNIT_UNCONFIRMED"
    ? "价格单位待管理员确认"
    : warning.code === "TARGET_MODEL_NOT_FOUND"
      ? "截图中未找到目标模型"
      : warning.field === "cache_miss_price"
        ? "输入现价缺失"
        : warning.field === "output_price"
          ? "输出现价缺失"
          : warning.field === "windows.timezone"
            ? "时倍率窗口缺少时区"
            : "源截图存在未解析歧义";
  return { code: warning.code.slice(0, 128), field: warning.field, blocking: warning.blocking, message };
}

export function registerBillingRuleImportRoutes(app: FastifyInstance, extractor: RuleExtractor): void {
  app.post("/billing-rule-imports/preview", { preHandler: [requireAuth] }, async (req, reply) => {
    const parsed = PreviewSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", message: parsed.error.message });
    let image: ReturnType<typeof decodeImage>;
    try {
      image = decodeImage(parsed.data.image_data_url);
    } catch (error) {
      return reply.code(400).send({ error: "invalid_image", message: (error as Error).message });
    }
    const route = await enabledRoute(app, req.admin!.enterpriseId, parsed.data.model_route_id);
    if (!route) return reply.code(409).send({ error: "route_not_enabled", message: "目标 Model Route 不可用" });
    try {
      const extracted = await extractor.extract({
        imageDataUrl: parsed.data.image_data_url,
        targetUpstreamModel: route.upstream_model,
      });
      const imported = await app.billingRuleImportRepo.create({
        enterpriseId: req.admin!.enterpriseId,
        adminUserId: req.admin!.adminUserId,
        modelRouteId: route.id,
        imageSha256: image.sha256,
        imageMime: image.mime,
        imageBytes: image.bytes.length,
        extractorModel: extracted.extractorModel,
        extractorRequestId: extracted.extractorRequestId,
        sourceEvidence: {
          targetModel: route.upstream_model,
          unifiedModelName: route.unified_model_name,
          unitBasis: extracted.extraction.unit_basis,
          targetRow: sanitizedTargetEvidence(extracted.targetEvidence),
        },
        candidateRules: extracted.candidateRules as unknown as Record<string, unknown>[],
        warnings: extracted.warnings.map(sanitizedWarning) as unknown as Record<string, unknown>[],
      });
      await app.auditRepo.write({
        enterprise_id: req.admin!.enterpriseId,
        admin_user_id: req.admin!.adminUserId,
        action: "billing_rule_import.preview",
        target_type: "billing_rule_import",
        target_id: imported.id,
        change_summary: {
          image_sha256: image.sha256,
          image_mime: image.mime,
          image_bytes: image.bytes.length,
          extractor_model: extracted.extractorModel,
          extractor_request_id: extracted.extractorRequestId,
          warning_codes: extracted.warnings.map((warning) => warning.code),
        },
        result: "SUCCESS",
      });
      return reply.code(201).send({ import: importView(imported) });
    } catch (error) {
      await app.auditRepo.write({
        enterprise_id: req.admin!.enterpriseId,
        admin_user_id: req.admin!.adminUserId,
        action: "billing_rule_import.preview",
        target_type: "billing_rule_import",
        change_summary: { image_sha256: image.sha256, image_mime: image.mime, image_bytes: image.bytes.length },
        result: "FAILURE",
        failure_reason: error instanceof Error ? error.message.slice(0, 255) : "UNKNOWN",
      });
      return reply.code(502).send({ error: "rule_extraction_failed", message: error instanceof Error ? error.message : "截图识别失败" });
    }
  });

  app.post<{ Params: { id: string } }>(
    "/billing-rule-imports/:id/confirm",
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const parsed = ConfirmSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid_request", message: parsed.error.message });
      const imported = await app.billingRuleImportRepo.get(req.admin!.enterpriseId, req.params.id);
      if (!imported) return reply.code(404).send({ error: "not_found", message: "截图导入不存在" });
      const route = await enabledRoute(app, req.admin!.enterpriseId, imported.model_route_id);
      if (!route) return reply.code(409).send({ error: "route_not_enabled", message: "目标 Model Route 已不可用" });
      const warnings = z.array(WarningSchema).parse(imported.warnings) as RuleImportWarning[];
      const acknowledged = new Set(parsed.data.acknowledged_warning_codes);
      const evidence = StoredEvidenceSchema.parse(imported.source_evidence);
      const warningCorrected = (warning: RuleImportWarning): boolean => {
        if (warning.code === "PRICE_UNIT_UNCONFIRMED") return Boolean(parsed.data.source_price_unit);
        if (warning.code === "TARGET_MODEL_NOT_FOUND") return false;
        if (warning.field === "cache_miss_price") {
          return parsed.data.rules.some((rule) => rule.rule_type === "API_PRICE" && rule.cache_miss_price !== "");
        }
        if (warning.field === "output_price") {
          return parsed.data.rules.some((rule) => rule.rule_type === "API_PRICE" && rule.output_price !== "");
        }
        if (warning.field === "windows.timezone") {
          return parsed.data.rules.every((rule) => rule.windows.every((window) => window.timezone !== ""));
        }
        return true;
      };
      const unresolved = warnings.filter((warning) =>
        warning.blocking && (!acknowledged.has(warning.code) || !warningCorrected(warning)));
      if (unresolved.length > 0) return reply.code(409).send({
        error: "unresolved_import_warnings",
        message: "仍有待确认字段",
        warnings: unresolved,
      });
      const knownEvidenceUnit = (["CNY_PER_TOKEN", "CNY_PER_THOUSAND_TOKENS", "CNY_PER_MILLION_TOKENS"] as const)
        .find((unit) => unit === evidence.unitBasis) ?? null;
      if (knownEvidenceUnit && knownEvidenceUnit !== parsed.data.source_price_unit) {
        return reply.code(409).send({ error: "source_unit_mismatch", message: "确认的价格单位与截图识别证据不一致" });
      }
      if (evidence.targetRow) {
        const expectedPrices = {
          cache_hit_price: normalizedPrice(evidence.targetRow.cache_hit_price.current, parsed.data.source_price_unit),
          cache_miss_price: normalizedPrice(evidence.targetRow.input_price.current, parsed.data.source_price_unit),
          output_price: normalizedPrice(evidence.targetRow.output_price.current, parsed.data.source_price_unit),
        };
        const mismatched = parsed.data.rules.some((rule) => rule.rule_type === "API_PRICE"
          && (rule.cache_hit_price !== expectedPrices.cache_hit_price
            || rule.cache_miss_price !== expectedPrices.cache_miss_price
            || rule.output_price !== expectedPrices.output_price));
        if (mismatched) return reply.code(409).send({
          error: "price_normalization_mismatch",
          message: "候选单价与截图原值及确认单位的服务端换算结果不一致",
        });
      }
      const completeRules = [];
      for (const rule of parsed.data.rules) {
        const validated = CreateBillingRuleSchema.safeParse({
          ...rule,
          provider_resource_id: route.provider_resource_id,
          upstream_model: route.upstream_model,
          rule_version: parsed.data.rule_version,
          effective_from: parsed.data.effective_from,
          effective_to: parsed.data.effective_to,
          multiplier: rule.multiplier || null,
          cache_hit_price: rule.cache_hit_price || null,
          cache_miss_price: rule.cache_miss_price || null,
          output_price: rule.output_price || null,
          windows: rule.windows.length > 0 ? rule.windows.map((window) => ({
            timezone: window.timezone,
            days_of_week: window.days_of_week
              ? window.days_of_week.split(",").map((day) => Number(day.trim()))
              : null,
            start_time: window.start_time,
            end_time: window.end_time,
          })) : null,
          source: `SCREENSHOT_IMPORT:${imported.id}`,
        });
        if (!validated.success) return reply.code(400).send({
          error: "invalid_rule_candidate",
          message: validated.error.message,
        });
        completeRules.push(validated.data);
      }
      try {
        const confirmed = await app.billingRuleImportRepo.confirm({
          enterpriseId: req.admin!.enterpriseId,
          importId: imported.id,
          expectedVersion: parsed.data.expected_version,
          rules: completeRules.map((rule) => toBillingRuleInput(req.admin!.enterpriseId, rule)),
          adminUserId: req.admin!.adminUserId,
          acknowledgedWarningCodes: parsed.data.acknowledged_warning_codes,
        });
        if (!confirmed) return reply.code(404).send({ error: "not_found", message: "截图导入不存在" });
        return reply.code(201).send({
          import: importView({ ...imported, status: "CONFIRMED", version: imported.version + 1, created_rule_ids: confirmed.rules.map((rule) => rule.id) }),
          rules: confirmed.rules,
        });
      } catch (error) {
        if (error instanceof BillingRuleImportConflictError) {
          return reply.code(409).send({ error: "conflict", message: error.message });
        }
        throw error;
      }
    },
  );
}
