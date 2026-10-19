/* eslint-disable no-console -- Read-only operational CLI and explicit controlled resend output. */
import { createHash } from "node:crypto";
import { createKysely, ReportDeliveryRepository, reportTypes, type Database, type ReportType } from "@qianliu/database";
import type { Kysely } from "kysely";
import { executeReportBundle, summarizeMessages } from "./delivery.js";

export function parseDeliveryCommand(args: string[]) {
  const flags = new Map<string,string>();
  const boolean = new Set(["--execute", "--allow-unknown"]);
  const accepted = new Set(["--enterprise", "--type", "--period", "--recipient", "--preview-hash", "--reason", "--schedule-date", ...boolean]);
  for (let i=0;i<args.length;i++) {
    const flag=args[i]!;
    if (!accepted.has(flag) || flags.has(flag)) throw new Error("Unknown or duplicate report-delivery option");
    const value=boolean.has(flag) ? "1" : args[++i];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
    flags.set(flag,value);
  }
  const required = (key: string) => { const value=flags.get(key); if (!value) throw new Error(`Required ${key}`); return value; };
  const enterprise=required("--enterprise"), type=required("--type") as ReportType;
  if (!/^[0-9a-f-]{36}$/i.test(enterprise) || !reportTypes.includes(type)) throw new Error("Invalid enterprise or report type");
  const execute=flags.has("--execute"), reason=flags.get("--reason");
  const scheduleDate=flags.get("--schedule-date");
  if (scheduleDate && (!/^\d{4}-\d{2}-\d{2}$/.test(scheduleDate)
    || !Number.isFinite(Date.parse(`${scheduleDate}T00:00:00Z`))
    || new Date(`${scheduleDate}T00:00:00Z`).toISOString().slice(0,10)!==scheduleDate)) {
    throw new Error("Invalid --schedule-date; expected a real YYYY-MM-DD date");
  }
  if (execute && (!reason || reason.length>200 || /[\r\n]|access_token|secret|password/i.test(reason))) throw new Error("Execution requires a short non-secret audit reason");
  if (execute && !/^[0-9a-f]{64}$/.test(required("--preview-hash"))) throw new Error("Execution requires the current preview hash");
  return { enterprise, type, period: required("--period"), recipient: required("--recipient"), execute,
    scheduleDate, previewHash: flags.get("--preview-hash"), reason: reason ?? "", allowUnknown: flags.has("--allow-unknown") };
}

export async function runDeliveryCommand(args: string[], providedDb?: Kysely<Database>) {
  const options=parseDeliveryCommand(args), db=providedDb ?? createKysely();
  try {
    const repo=new ReportDeliveryRepository(db);
    const bundles=await repo.bundles(options.enterprise,options.type,options.period,options.recipient);
    // Query/preview is strictly read-only, including stale leases. Expiry is performed by execution.
    const rows=await Promise.all(bundles.map(async bundle => {
      const messages=await repo.messages(options.enterprise,bundle.id);
      return { bundleId: bundle.id, contentHash: bundle.content_hash, recipient: bundle.recipient_ref,
        periodStart: bundle.period_start, periodEnd: bundle.period_end, windowEnd: bundle.window_end,
        summary: summarizeMessages(messages), messages, attempts: await repo.attempts(options.enterprise,bundle.id) };
    }));
    const schedules=options.scheduleDate ? await repo.schedule(options.enterprise,options.type,options.scheduleDate) : [];
    const previewHash=createHash("sha256").update(JSON.stringify({rows,schedules})).digest("hex");
    if (!options.execute) { const preview={ mode: "PREVIEW", previewHash, tasks: rows, schedules }; console.log(JSON.stringify(preview)); return preview; }
    if (previewHash!==options.previewHash || !bundles.length) throw new Error("Preview changed or no frozen report matches; inspect again");
    if (!options.allowUnknown && rows.some(row=>row.messages.some(m=>m.status==="UNKNOWN"))) throw new Error("UNKNOWN requires --allow-unknown after manual delivery verification");
    const kek=process.env.CREDENTIAL_KEK;
    if (!kek) throw new Error("CREDENTIAL_KEK required for execution");
    const deadline=new Date(Date.now()+5*60_000);
    const results=[];
    for (const bundle of bundles) {
      const row=rows.find(row=>row.bundleId===bundle.id)!;
      const versions=Object.fromEntries(row.messages.filter(m=>!["SENT","SENDING","SKIPPED"].includes(m.status)).map(m=>[m.id,m.version]));
      results.push(await executeReportBundle({ repo,bundle,kekBase64:kek,
        manual:{ versions,allowUnknown:options.allowUnknown,reason:options.reason,deadline } }));
    }
    const result={ mode:"EXECUTED", results }; console.log(JSON.stringify(result)); return result;
  } finally { if (!providedDb) await db.destroy(); }
}
