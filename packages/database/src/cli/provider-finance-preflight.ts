import { createKysely } from "../kysely.js";
import { ProviderFinanceCutoverRepository } from "../repositories/provider-finance-cutover-repository.js";

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
const month = argument("month") ?? "2026-09";
if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(month)) throw new Error("--month must be YYYY-MM");
if (apply && argument("confirm-enterprise") !== enterpriseId) {
  throw new Error("usage backfill requires --confirm-enterprise matching --enterprise");
}

const db = createKysely();
try {
  const repository = new ProviderFinanceCutoverRepository(db);
  const before = await repository.buildPreflightReport(enterpriseId);
  const usageBackfill = await repository.backfillUsageFacts(enterpriseId, apply);
  const after = apply ? await repository.buildPreflightReport(enterpriseId) : before;
  const conservation = await repository.buildConservationReport(enterpriseId, month);
  const result = {
    mode: apply ? "APPLY_USAGE_BACKFILL" : "DRY_RUN",
    enterpriseId,
    generatedAt: new Date().toISOString(),
    before,
    usageBackfill,
    after,
    conservation,
    decision: after.ready && conservation.passed ? "GO_CANDIDATE" : "NO_GO",
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!after.ready) process.exitCode = 2;
} finally {
  await db.destroy();
}
