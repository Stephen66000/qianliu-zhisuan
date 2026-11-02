import { readQuotaSwitchPreflight } from "./quota-preflight.js";
import { createKysely, previewEmployeeQuotaReconciliation } from "@qianliu/database";
import { sql } from "kysely";

export function quotaReconcileScope(args: string[]) {
  if (args[0] !== "preview" || args.some(arg => ["--execute", "--apply"].includes(arg)))
    throw new Error("quota-reconcile supports read-only preview only; historical writes require separate authorization.");
  const value = (flag: string) => { const index = args.indexOf(flag); return index < 0 ? undefined : args[index + 1]; };
  const enterpriseId = value("--enterprise");
  const principalIds = value("--principals")?.split(",").map(id => id.trim()).filter(Boolean);
  const from = value("--from") ?? "";
  const to = value("--to") ?? "";
  const start = new Date(from);
  const end = new Date(to);
  if (!enterpriseId || !principalIds?.length || !Number.isFinite(+start) || !Number.isFinite(+end) || !/(Z|[+-]\d{2}:\d{2})$/.test(from) || !/(Z|[+-]\d{2}:\d{2})$/.test(to) || !(end > start))
    throw new Error("Required: quota-reconcile preview --enterprise <id> --principals <employee-principal-ids> --from <ISO> --to <ISO>");
  return { enterpriseId, principalIds, start, end };
}

/** Explicit scope, read-only transaction, evidence JSON only. No sender, initializer or apply path. */
export async function runQuotaReconcileCommand(args: string[]) {
  const preflight = args[0] === "preflight";
  const scope = preflight ? quotaPreflightScope(args) : quotaReconcileScope(args);
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  const db = createKysely(process.env.DATABASE_URL);
  try {
    const evidence = await db.transaction().setIsolationLevel("repeatable read").execute(async trx => {
      await sql`SET TRANSACTION READ ONLY`.execute(trx);
      return preflight ? readQuotaSwitchPreflight(trx, scope as ReturnType<typeof quotaPreflightScope>)
        : previewEmployeeQuotaReconciliation(trx, scope as ReturnType<typeof quotaReconcileScope>);
    });
    process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  } finally { await db.destroy(); }
}

export function quotaPreflightScope(args: string[]) {
  if (args[0] !== "preflight" || args.some(arg => ["--execute", "--apply"].includes(arg))) throw new Error("preflight is read-only");
  const value = (flag: string) => { const index = args.indexOf(flag); return index < 0 ? undefined : args[index + 1]; };
  const enterpriseId = value("--enterprise"), month = value("--month");
  if (!enterpriseId || !month || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error("Required: quota-reconcile preflight --enterprise <id> --month <YYYY-MM>");
  return { enterpriseId, month };
}
