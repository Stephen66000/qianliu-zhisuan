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
const adminId = argument("admin");
const month = argument("month") ?? "2026-09";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
if (!enterpriseId || !uuid.test(enterpriseId)) throw new Error("--enterprise must be a UUID");
if (!adminId || !uuid.test(adminId)) throw new Error("--admin must be a UUID");
if (argument("confirm-enterprise") !== enterpriseId) {
  throw new Error("activation requires --confirm-enterprise matching --enterprise");
}
if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(month)) throw new Error("--month must be YYYY-MM");

const db = createKysely();
try {
  const result = await new ProviderFinanceCutoverRepository(db)
    .activateStrictWrites(enterpriseId, adminId, month);
  process.stdout.write(`${JSON.stringify({
    mode: "ACTIVATE_STRICT_WRITES",
    enterpriseId,
    month,
    decision: "ACTIVATED",
    ...result,
  }, null, 2)}\n`);
} finally {
  await db.destroy();
}
