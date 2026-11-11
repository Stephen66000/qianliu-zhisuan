/**
 * 经营快照（operating snapshot）合同：内外两份 schema、跨字段校验、
 * API/套餐模式与资金字段守卫、以及 schema 输出到入库入参的转换。
 * 由 contracts.ts 统一再导出，公共导出面保持不变。
 */
import { Decimal } from "decimal.js";
import { z } from "zod";

const DecimalText = z.union([z.string(), z.number()]).transform(String)
  .refine((value) => /^\d+(?:\.\d+)?$/.test(value), "必须是非负十进制数");

const ADMIN_MONEY_FIELDS = [
  "recharge_amount",
  "current_balance",
  "cumulative_cost",
  "current_period_cost",
  "package_cost",
] as const;

/**
 * F1 返修（R2，2026-11-05）：内外合同拆分。
 * - 基础对象保留全枚举 source（服务端路径专用）：O1a 账单手填导入
 *   （POST /operating-bill-snapshot-imports，operating-bills/routes.ts:131 服务端
 *   硬编码 BILL_RECONCILIATION）行为不变。
 * - 客户端合同 `ClientOperatingSnapshotSchema`：source 收紧为字面 "ADMIN"——
 *   资源创建/编辑/onboarding 三个 HTTP 入口提交 PROVIDER_SYNC/BILL_RECONCILIATION
 *   直接校验失败返回 400（拒绝且零落库，development-summary §6 意见 1）。
 */
const OperatingSnapshotObjectSchema = z.object({
  source: z.enum(["ADMIN", "PROVIDER_SYNC", "BILL_RECONCILIATION"]).default("ADMIN"),
  collected_at: z.string().datetime(),
  currency: z.string().min(3).max(8).nullable().optional(),
  recharge_amount: DecimalText.nullable().optional(),
  current_balance: DecimalText.nullable().optional(),
  cumulative_cost: DecimalText.nullable().optional(),
  current_period_cost: DecimalText.nullable().optional(),
  cost_period_start: z.string().datetime().nullable().optional(),
  cost_period_end: z.string().datetime().nullable().optional(),
  balance_updated_at: z.string().datetime().nullable().optional(),
  package_name: z.string().max(255).nullable().optional(),
  package_cost: DecimalText.nullable().optional(),
  total_quota: DecimalText.nullable().optional(),
  quota_unit: z.string().min(1).max(32).nullable().optional(),
  used_quota: DecimalText.nullable().optional(),
  remaining_quota: DecimalText.nullable().optional(),
  effective_from: z.string().datetime().nullable().optional(),
  effective_until: z.string().datetime().nullable().optional(),
  reset_cycle: z.string().max(32).nullable().optional(),
  reset_anchor_at: z.string().datetime().nullable().optional(),
  next_reset_at: z.string().datetime().nullable().optional(),
});

/**
 * 内外两份 schema 共用的跨字段校验（ADMIN 两位小数守卫/生效失效序/额度守恒）。
 */
function checkOperatingSnapshot(
  value: z.output<typeof OperatingSnapshotObjectSchema>,
  ctx: z.RefinementCtx,
): void {
  if (value.source === "ADMIN") {
    for (const field of ADMIN_MONEY_FIELDS) {
      const amount = value[field];
      if (amount !== null && amount !== undefined && !/^\d+(?:\.\d{1,2})?$/.test(amount)) {
        ctx.addIssue({ code: "custom", path: [field], message: "人工录入金额最多保留两位小数" });
      }
    }
  }
  if (value.effective_from && value.effective_until
      && new Date(value.effective_until) <= new Date(value.effective_from)) {
    ctx.addIssue({ code: "custom", path: ["effective_until"], message: "套餐失效时间必须晚于生效时间" });
  }
  if (value.total_quota !== null && value.total_quota !== undefined
      && value.used_quota !== null && value.used_quota !== undefined
      && value.remaining_quota !== null && value.remaining_quota !== undefined
      && !new Decimal(value.total_quota).equals(new Decimal(value.used_quota).plus(value.remaining_quota))) {
    ctx.addIssue({ code: "custom", path: ["remaining_quota"], message: "总额度必须等于已用额度加剩余额度" });
  }
}

/** 服务端/内部合同（全枚举 source）：仅 O1a 导入注入路径使用，行为不变。 */
export const OperatingSnapshotSchema = OperatingSnapshotObjectSchema.superRefine(
  checkOperatingSnapshot,
);

/** 客户端合同（F1 收紧）：source 只接受字面 "ADMIN"。 */
export const ClientOperatingSnapshotSchema = OperatingSnapshotObjectSchema.extend({
  source: z.literal("ADMIN").default("ADMIN"),
}).superRefine(checkOperatingSnapshot);

const API_ONLY_OPERATING_FIELDS = [
  "recharge_amount", "current_balance", "cumulative_cost", "current_period_cost",
  "cost_period_start", "cost_period_end", "balance_updated_at",
] as const;

const PLAN_ONLY_OPERATING_FIELDS = [
  "package_name", "package_cost", "total_quota", "quota_unit", "used_quota",
  "remaining_quota", "effective_from", "effective_until", "reset_cycle",
  "reset_anchor_at", "next_reset_at",
] as const;

export function operatingSnapshotModeError(
  mode: "API" | "CODING_PLAN",
  snapshot: z.output<typeof OperatingSnapshotSchema>,
): string | null {
  const forbidden = mode === "API" ? PLAN_ONLY_OPERATING_FIELDS : API_ONLY_OPERATING_FIELDS;
  const populated = forbidden.filter((field) => {
    const value = snapshot[field];
    return value !== null && value !== undefined && value !== "";
  });
  if (populated.length > 0) {
    return mode === "API"
      ? `API 资源不能写入套餐字段：${populated.join(", ")}`
      : `套餐资源不能写入 API 充值/余额字段：${populated.join(", ")}`;
  }
  if (mode === "CODING_PLAN" && snapshot.source === "ADMIN") {
    const resetCycle = snapshot.reset_cycle?.toUpperCase() ?? "NONE";
    if (!["NONE", "DAILY", "WEEKLY", "MONTHLY", "QUARTERLY", "YEARLY"].includes(resetCycle)) {
      return "重置周期必须是不重置、每日、每周、每月、每季或每年";
    }
    if (resetCycle !== "NONE" && !snapshot.reset_anchor_at) return "启用周期重置时必须填写重置日期";
  }
  return null;
}

export function financeManagedOperatingSnapshotError(
  mode: "API" | "CODING_PLAN",
  snapshot: z.output<typeof OperatingSnapshotSchema>,
): string | null {
  if (snapshot.source !== "ADMIN") return null;
  // AFR-01 / O2（WP2-S3）：API 分支文案调整为退役口径（判定逻辑不变）——
  // 资金字段不再指向“充值与订阅模块”，而是明确已退役、不接受手填。
  const financeFields = mode === "API"
    ? API_ONLY_OPERATING_FIELDS
    : ["package_cost", "effective_from", "effective_until"] as const;
  const populated = financeFields.filter((field) => {
    const value = snapshot[field];
    return value !== null && value !== undefined && value !== "";
  });
  if (populated.length === 0) return null;
  return mode === "API"
    ? `API 内部资金管理已退役，资金字段不接受手填：${populated.join(", ")}`
    : `资金字段只能在充值与订阅模块登记：${populated.join(", ")}`;
}

/**
 * AFR-01 / R1（WP2-S3）：O1a 手填快照导入（POST /operating-bill-snapshot-imports）的
 * API 资金字段守卫。不能复用 `financeManagedOperatingSnapshotError`——该函数仅对 ADMIN
 * 源生效，而 O1a 硬编码 BILL_RECONCILIATION 源恒放行。本判定对 API 模式资源携带 7 个
 * 资金字段任一非空即拒绝（不论快照日期），CP 侧字段与既有 `operatingSnapshotModeError`
 * 校验不动（plan §4a-R1）。
 */
export function retiredApiFundingSnapshotFieldsError(
  mode: "API" | "CODING_PLAN",
  snapshot: z.output<typeof OperatingSnapshotSchema>,
): string | null {
  if (mode !== "API") return null;
  const populated = API_ONLY_OPERATING_FIELDS.filter((field) => {
    const value = snapshot[field];
    return value !== null && value !== undefined && value !== "";
  });
  return populated.length > 0
    ? `API 内部资金管理已退役，资金字段不再接受手填导入：${populated.join(", ")}` : null;
}

export function toOperatingSnapshotInput(
  value: z.output<typeof OperatingSnapshotSchema>,
  mode: "API" | "CODING_PLAN",
) {
  const systemCalculated = value.source === "ADMIN" && mode === "CODING_PLAN";
  return {
    ...value,
    used_quota: systemCalculated ? null : value.used_quota,
    remaining_quota: systemCalculated ? null : value.remaining_quota,
    next_reset_at: systemCalculated ? null : value.next_reset_at ? new Date(value.next_reset_at) : null,
    usage_calculation: systemCalculated ? "SYSTEM_LEDGER" as const : "MANUAL_SNAPSHOT" as const,
    reset_timezone: systemCalculated ? "Asia/Shanghai" : null,
    reset_cycle: systemCalculated ? value.reset_cycle ?? "NONE" : value.reset_cycle,
    collected_at: new Date(value.collected_at),
    cost_period_start: value.cost_period_start ? new Date(value.cost_period_start) : null,
    cost_period_end: value.cost_period_end ? new Date(value.cost_period_end) : null,
    balance_updated_at: value.balance_updated_at ? new Date(value.balance_updated_at) : null,
    effective_from: value.effective_from ? new Date(value.effective_from) : null,
    effective_until: value.effective_until ? new Date(value.effective_until) : null,
    reset_anchor_at: value.reset_anchor_at ? new Date(value.reset_anchor_at) : null,
  };
}
