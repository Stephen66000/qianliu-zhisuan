/* eslint-disable no-console -- Operational preview / explicitly authorized rollback export. */
import { sql } from "kysely";
import { createClient } from "redis";
import { createKysely, type ReportBundle } from "@qianliu/database";

/** Preserve legacy scheduling guards; this never upgrades a legacy flag to a delivery receipt. */
export async function runReportRollbackCompat(args: string[]) {
  if (args.some(arg=>!["--execute","--allow-unknown"].includes(arg))) throw new Error("Unsupported rollback compatibility option");
  const db=createKysely(), redis=createClient({url:process.env.REDIS_URL});
  try {
    const pending=await sql<{status:string;count:string}>`SELECT status,count(*)::text FROM report_delivery_message WHERE status IN ('SENDING','UNKNOWN') GROUP BY status`.execute(db);
    if(args.includes("--execute") && pending.rows.some(row=>row.status==="SENDING" || !args.includes("--allow-unknown"))) {
      throw new Error("Review SENDING/UNKNOWN receipts before exporting rollback guards");
    }
    const commands:Array<{key:string;member?:string;ttl:number}>=[];
    const claims=await sql<{enterprise_id:string;scope:string}>`SELECT enterprise_id,scope FROM report_delivery_claim ORDER BY enterprise_id,scope`.execute(db);
    for(const claim of claims.rows){
      const [kind,unit,period,member]=claim.scope.split(":");
      if(kind==="top1"&&unit==="day")commands.push({key:`milestone:top1:issued:${claim.enterprise_id}:${period}`,ttl:2*86400});
      if(kind==="top1"&&unit==="week")commands.push({key:`milestone:top1:users:${claim.enterprise_id}:${period}`,member,ttl:14*86400});
      if(kind==="over50"&&unit==="month")commands.push({key:`milestone:over50:users:${claim.enterprise_id}:${period}`,member,ttl:45*86400});
    }
    // Exact success facts for the old monthly per-recipient store.
    const sent=await sql<ReportBundle>`SELECT b.* FROM report_delivery_bundle b WHERE EXISTS(SELECT 1 FROM report_delivery_message m WHERE m.bundle_id=b.id)
      AND NOT EXISTS(SELECT 1 FROM report_delivery_message m WHERE m.bundle_id=b.id AND m.status<>'SENT')`.execute(db);
    for(const bundle of sent.rows){
      if(bundle.report_type==="COMPANY_MONTHLY")commands.push({key:`scheduler:monthly_report:${bundle.enterprise_id}:${bundle.period_key}:company`,ttl:90*86400});
      if(bundle.report_type==="PERSONAL_MONTHLY")commands.push({key:`scheduler:monthly_report:${bundle.enterprise_id}:${bundle.period_key}:personal:${bundle.recipient_ref}`,ttl:90*86400});
    }
    if(args.includes("--execute")){
      await redis.connect();
      for(const command of commands){if(command.member){await redis.sAdd(command.key,command.member);await redis.expire(command.key,command.ttl);}
        else await redis.set(command.key,"1",{EX:command.ttl});}
    }
    const result={mode:args.includes("--execute")?"APPLIED":"PREVIEW",compatibilityGuards:commands.length,pending:pending.rows,
      note:"Claims are conservative rollback frequency guards, not delivered facts; win counts are not fabricated."};
    console.log(JSON.stringify(result));return result;
  }finally{if(redis.isOpen)await redis.quit();await db.destroy();}
}
