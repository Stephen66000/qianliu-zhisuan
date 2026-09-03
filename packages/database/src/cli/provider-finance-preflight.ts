import { createKysely } from "../kysely.js";
import { ProviderFinanceCutoverRepository } from "../repositories/provider-finance-cutover-repository.js";
import { PROVIDER_FINANCE_CUTOVER } from "../repositories/provider-finance-types.js";

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = process.argv.find((item) => item.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const enterpriseId = argument("enterprise");
if (!enterpriseId
  || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(enterpriseId)) {
  throw new Error("--enterprise must be a UUID");
}
const apply = process.argv.includes("--apply-usage-backfill");
const resolveLegacyCost = process.argv.includes("--resolve-legacy-api-cost");
const month = argument("month") ?? "2026-09";
if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(month)) throw new Error("--month must be YYYY-MM");
if ((apply || resolveLegacyCost) && argument("confirm-enterprise") !== enterpriseId) {
  throw new Error("write operation requires --confirm-enterprise matching --enterprise");
}
if (resolveLegacyCost) {
  for (const name of ["resource", "admin", "currency", "window-end", "snapshot",
    "evidence", "idempotency-key"]) {
    if (!argument(name)) throw new Error(`--${name} is required for legacy cost resolution`);
  }
  if (!["CNY", "USD"].includes(argument("currency")!)) {
    throw new Error("--currency must be CNY or USD");
  }
  if (Number.isNaN(Date.parse(argument("window-end")!))) {
    throw new Error("--window-end must be an ISO timestamp");
  }
}

const db = createKysely();
try {
  const repository = new ProviderFinanceCutoverRepository(db);
  const before = await repository.buildPreflightReport(enterpriseId);
  const usageBackfill = await repository.backfillUsageFacts(enterpriseId, apply);
  const legacyCostResolution = resolveLegacyCost
    ? await repository.resolveLegacyApiCostGap({
      enterpriseId,
      resourceId: argument("resource") ?? "",
      adminId: argument("admin") ?? "",
      accountCurrency: argument("currency") === "USD" ? "USD" : "CNY",
      windowStart: PROVIDER_FINANCE_CUTOVER,
      windowEndInclusive: new Date(argument("window-end") ?? "invalid"),
      providerBalanceSnapshotId: argument("snapshot") ?? "",
      evidenceRef: argument("evidence") ?? "",
      idempotencyKey: argument("idempotency-key") ?? "",
    }) : null;
  const after = apply || resolveLegacyCost
    ? await repository.buildPreflightReport(enterpriseId) : before;
  const conservation = await repository.buildConservationReport(enterpriseId, month);
  const result = {
    mode: apply ? "APPLY_USAGE_BACKFILL" : "DRY_RUN",
    enterpriseId,
    generatedAt: new Date().toISOString(),
    before,
    usageBackfill,
    legacyCostResolution,
    after,
    conservation,
    decision: after.ready && conservation.passed ? "GO_CANDIDATE" : "NO_GO",
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!after.ready) process.exitCode = 2;
} finally {
  await db.destroy();
}
