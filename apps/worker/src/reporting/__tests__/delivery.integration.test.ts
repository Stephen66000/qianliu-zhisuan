import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sql } from "kysely";
import { startPostgresContainer } from "@qianliu/testing";
import { createKysely, ReportDeliveryRepository, type FreezeReport } from "@qianliu/database";
import { createMigrator } from "../../../../../packages/database/src/migrator.js";
import { encryptCredential } from "@qianliu/provider-adapters";
import { WecomAppClient } from "../../runtime-assurance/wecom-client.js";
import { executeReportBundle } from "../delivery.js";
import { runDeliveryCommand } from "../delivery-cli.js";
import { runReportDeliveryTick } from "../delivery-scheduler.js";

let pg: Awaited<ReturnType<typeof startPostgresContainer>>, db: ReturnType<typeof createKysely>, repo: ReportDeliveryRepository;
const key=Buffer.alloc(32,1).toString("base64"), now=new Date("2026-10-19T01:00:00Z");
let endpointId:string;
beforeAll(async()=>{
  pg=await startPostgresContainer("report_delivery_tests");db=createKysely(pg.connectionString);repo=new ReportDeliveryRepository(db);
  vi.stubGlobal("fetch",async()=>{throw new Error("TEST_EXTERNAL_NETWORK_FORBIDDEN");});
  const migrator=createMigrator(db);
  expect((await migrator.migrateTo("0089_model_validation_binding")).error).toBeUndefined();
  expect((await migrator.migrateToLatest()).error).toBeUndefined();
  endpointId=(await db.insertInto("notification_endpoint").values({provider:"WECOM_APP",corp_id:"fixture",agent_id:"1",secret_ciphertext:JSON.stringify(encryptCredential("fixture",Buffer.from(key,"base64"))),secret_fingerprint:"fixture",status:"ACTIVE"}).returning("id").executeTakeFirstOrThrow()).id;
},60_000);
afterAll(async()=>{vi.unstubAllGlobals();await db?.destroy();await pg?.stop();});
async function fixture(extra:Partial<FreezeReport>={}){
  const ent=(await db.insertInto("enterprise").values({name:"Report test"}).returning("id").executeTakeFirstOrThrow()).id;
  return { enterpriseId:ent,type:"COMPANY_WEEKLY" as const,periodKey:"2026-10-11T16:00:00.000Z",recipientRef:randomUUID(),targetUserId:"fixture-user",endpointId,
    periodStart:new Date("2026-10-11T16:00:00Z"),periodEnd:new Date("2026-10-18T16:00:00Z"),windowStart:now,windowEnd:new Date(now.getTime()+1800_000),
    snapshot:{png:Buffer.from("fixture-png").toString("base64"),text:"frozen summary",filename:"fixture.png"},...extra };
}
function client(failText=false,unknown=false){
  const sent:string[]=[];
  const fetcher:typeof fetch=async(url,init)=>{
    if(String(url).includes("gettoken"))return new Response(JSON.stringify({errcode:0,access_token:"fixture"}));
    if(String(url).includes("media/upload"))return new Response(JSON.stringify({errcode:0,media_id:"fresh"}));
    const kind=JSON.parse(String(init?.body)).msgtype;sent.push(kind);
    if(unknown)throw new Error("response lost");
    return new Response(JSON.stringify(failText&&kind==="text"?{errcode:45009}:{errcode:0,msgid:`${kind}-id`}));
  };
  return {instance:new WecomAppClient(key,fetcher),sent};
}

describe("Postgres report execution invariants",()=>{
  it("freezes snapshot once and parallel workers send each message once",async()=>{
    const input=await fixture();
    const bundles=await Promise.all(Array.from({length:8},()=>repo.freeze(input)));
    expect(new Set(bundles.map(b=>b!.id)).size).toBe(1);
    const bundle=bundles[0]!, c=client();
    await Promise.all([1,2].map(()=>executeReportBundle({repo,bundle,kekBase64:key,client:c.instance,clock:()=>now})));
    expect(c.sent).toEqual(["image","text"]);
    const changed=await repo.freeze({...input,targetUserId:"another",snapshot:{...input.snapshot,text:"changed"}});
    expect(changed!.snapshot.text).toBe("frozen summary");expect(changed!.target_user_id).toBe("fixture-user");
    expect((await repo.messages(input.enterpriseId,bundle.id)).every(m=>m.status==="SENT")).toBe(true);
    expect((await repo.attempts(input.enterpriseId,bundle.id))).toHaveLength(2);
  });
  it("retries only failed text, preserves image message id, applies backoff and max3",async()=>{
    const input=await fixture(),bundle=(await repo.freeze(input))!,c=client(true);
    let clock=now;
    const run=()=>executeReportBundle({repo,bundle,kekBase64:key,client:c.instance,clock:()=>clock});
    await run();await run();expect(c.sent).toEqual(["image","text"]);
    clock=new Date(now.getTime()+35_000);await run();
    clock=new Date(now.getTime()+160_000);await run();
    clock=new Date(now.getTime()+400_000);await run();
    expect(c.sent).toEqual(["image","text","text","text"]);
    const messages=await repo.messages(input.enterpriseId,bundle.id);
    expect(messages.find(m=>m.kind==="IMAGE")).toMatchObject({status:"SENT",provider_message_id:"image-id",attempt_count:1});
    expect(messages.find(m=>m.kind==="TEXT")).toMatchObject({status:"RETRYABLE_FAILED",attempt_count:3});
  });
  it("response loss and receipt persistence failure become UNKNOWN without restart replay",async()=>{
    for(const writeFailure of [false,true]){
      const input=await fixture(),bundle=(await repo.freeze(input))!,c=client(false,!writeFailure);
      if(writeFailure)vi.spyOn(repo,"finish").mockRejectedValueOnce(new Error("database unavailable"));
      await executeReportBundle({repo,bundle,kekBase64:key,client:c.instance,clock:()=>now});
      expect((await repo.messages(input.enterpriseId,bundle.id))[0]!.status).toBe("UNKNOWN");
      await executeReportBundle({repo:new ReportDeliveryRepository(db),bundle,kekBase64:key,client:c.instance,clock:()=>new Date(now.getTime()+120_000)});
      expect(c.sent).toEqual(["image"]);vi.restoreAllMocks();
    }
  });
  it("expired lease stays UNKNOWN and stale execution version cannot overwrite",async()=>{
    const input=await fixture(),bundle=(await repo.freeze(input))!,image=(await repo.messages(input.enterpriseId,bundle.id))[0]!;
    const claim=(await repo.claim(input.enterpriseId,image.id,now))!;
    expect(await repo.startMessageRequest(claim,now)).toBe(true);
    const later=new Date(now.getTime()+91_000);await repo.expire(input.enterpriseId,later);
    expect(await repo.claim(input.enterpriseId,image.id,later)).toBe(null);
    expect(await repo.finish(claim,{status:"SENT",providerMessageId:"late"},later)).toBe(false);
    expect((await repo.messages(input.enterpriseId,bundle.id))[0]!.status).toBe("UNKNOWN");
    expect((await repo.attempts(input.enterpriseId,bundle.id))[0]).toMatchObject({status:"UNKNOWN",message_requests:1});
  });
  it("isolates tenants and refuses text before image or sends at exclusive window end",async()=>{
    const input=await fixture(),bundle=(await repo.freeze(input))!,messages=await repo.messages(input.enterpriseId,bundle.id);
    const other=(await fixture()).enterpriseId;
    expect(await repo.messages(other,bundle.id)).toEqual([]);
    expect(await repo.claim(other,messages[0]!.id,now)).toBe(null);
    expect(await repo.claim(input.enterpriseId,messages[1]!.id,now)).toBe(null);
    const c=client();await executeReportBundle({repo,bundle,kekBase64:key,client:c.instance,clock:()=>input.windowEnd});
    expect(c.sent).toEqual([]);
    await expect(sql`UPDATE report_delivery_message SET enterprise_id=${other} WHERE id=${messages[0]!.id}`.execute(db)).rejects.toThrow();
  });
  it("missing identity is durable failure and incentive guards reserve both day and week",async()=>{
    const input=await fixture({targetUserId:undefined}),bundle=(await repo.freeze(input))!;
    expect((await repo.messages(input.enterpriseId,bundle.id))[0]).toMatchObject({status:"PERMANENT_FAILED",classification:"NO_WECOM_IDENTITY"});
    const base=await fixture({type:"TOP1",claims:["top1:day:2026-10-21","top1:week:2026-W43:winner"]});
    const outcomes=await Promise.all([repo.freeze(base),repo.freeze({...base,recipientRef:"other",claims:["top1:day:2026-10-21","top1:week:2026-W43:other"]})]);
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    expect(await repo.freeze({...base,periodKey:"different-day",claims:["top1:day:2026-10-22",`top1:week:2026-W43:${outcomes[0] ? "winner" : "other"}`]})).toBe(null);
  });
  it("legacy completion stays unverified without creating delivery facts",async()=>{
    const input=await fixture();
    await runReportDeliveryTick({db,kekBase64:key,now,enabledAt:"2026-10-19T00:00:00Z",legacyGet:async()=>"1"});
    expect(await repo.bundles(input.enterpriseId,"DAILY","2026-10-18")).toEqual([]);
    const row=await sql<{status:string}>`SELECT status FROM report_delivery_schedule WHERE enterprise_id=${input.enterpriseId} AND report_type='DAILY'`.execute(db);
    expect(row.rows[0]!.status).toBe("LEGACY_UNVERIFIED");
  });
  it("read-only preview never expires lease or decrypts credentials",async()=>{
    const input=await fixture(),bundle=(await repo.freeze(input))!,row=(await repo.messages(input.enterpriseId,bundle.id))[0]!;
    await repo.claim(input.enterpriseId,row.id,now);
    const log=vi.spyOn(console,"log").mockImplementation(()=>{});
    const preview=await runDeliveryCommand(["--enterprise",input.enterpriseId,"--type",input.type,"--period",input.periodKey,"--recipient",input.recipientRef],db);
    expect(preview.mode).toBe("PREVIEW");expect((await repo.messages(input.enterpriseId,bundle.id))[0]!.status).toBe("SENDING");
    await expect(runDeliveryCommand(["--enterprise",input.enterpriseId,"--type",input.type,"--period",input.periodKey,"--recipient",input.recipientRef,
      "--execute","--reason","verified manual retry","--preview-hash","0".repeat(64)],db)).rejects.toThrow("Preview changed");log.mockRestore();
  });
  it("manual UNKNOWN retry requires explicit acknowledgement and records immutable audit",async()=>{
    const input=await fixture(),bundle=(await repo.freeze(input))!,c=client(false,true);
    await executeReportBundle({repo,bundle,kekBase64:key,client:c.instance,clock:()=>now});
    const base=["--enterprise",input.enterpriseId,"--type",input.type,"--period",input.periodKey,"--recipient",input.recipientRef];
    const log=vi.spyOn(console,"log").mockImplementation(()=>{});
    const preview=await runDeliveryCommand(base,db);
    if(preview.mode!=="PREVIEW" || !("previewHash" in preview))throw new Error("missing preview");
    const execute=[...base,"--execute","--reason","operator verified recipient did not receive","--preview-hash",preview.previewHash];
    await expect(runDeliveryCommand(execute,db)).rejects.toThrow("UNKNOWN requires");
    vi.stubEnv("CREDENTIAL_KEK",key);
    const upload=vi.spyOn(WecomAppClient.prototype,"uploadMedia").mockResolvedValue("manual-media");
    const send=vi.spyOn(WecomAppClient.prototype,"sendReportMessage").mockResolvedValue({status:"SENT",providerMessageId:"manual-receipt"});
    await runDeliveryCommand([...execute,"--allow-unknown"],db);
    expect(send).toHaveBeenCalledTimes(2);expect(upload).toHaveBeenCalledTimes(1);
    const audit=await sql<{previous_status:string}>`SELECT previous_status FROM report_delivery_action WHERE enterprise_id=${input.enterpriseId}`.execute(db);
    expect(audit.rows.map(r=>r.previous_status).sort()).toEqual(["PENDING","UNKNOWN"]);
    const after=await runDeliveryCommand(base,db);
    if(after.mode!=="PREVIEW" || !("previewHash" in after))throw new Error("missing preview");
    await runDeliveryCommand([...base,"--execute","--reason","verify sent is skipped","--preview-hash",after.previewHash],db);
    expect(send).toHaveBeenCalledTimes(2);
    vi.restoreAllMocks();vi.unstubAllEnvs();log.mockRestore();
  });
  it("closing the window while media uploads does not start a message",async()=>{
    const input=await fixture({windowEnd:new Date(now.getTime()+30_000)}),bundle=(await repo.freeze(input))!,c=client();let at=now;
    const upload=vi.spyOn(c.instance,"uploadMedia").mockImplementation(async()=>{at=input.windowEnd;return "fresh";});
    await executeReportBundle({repo,bundle,kekBase64:key,client:c.instance,clock:()=>at});
    expect(c.sent).toEqual([]);expect(upload).toHaveBeenCalledTimes(1);
    expect((await repo.messages(input.enterpriseId,bundle.id))[0]!.classification).toBe("SEND_GUARD_CLOSED");
    vi.restoreAllMocks();
  });
  it("dirty reporting data records a durable block instead of sending an empty report",async()=>{
    const input=await fixture();
    await db.insertInto("usage_aggregate_dirty_bucket").values({enterprise_id:input.enterpriseId,bucket_granularity:"DAY",bucket_start:input.periodStart,timezone:"Asia/Shanghai"}).execute();
    await runReportDeliveryTick({db,kekBase64:key,now,enabledAt:"2026-10-19T00:00:00Z",legacyGet:async key=>key.includes(input.enterpriseId)?null:"1"});
    const row=await sql<{status:string;classification:string}>`SELECT status,classification FROM report_delivery_schedule WHERE enterprise_id=${input.enterpriseId} AND report_type='DAILY'`.execute(db);
    expect(row.rows[0]).toMatchObject({status:"BLOCKED",classification:"REPORT_DATA_DIRTY"});
    const log=vi.spyOn(console,"log").mockImplementation(()=>{});
    try {
      const preview=await runDeliveryCommand(["--enterprise",input.enterpriseId,"--type","DAILY","--period","2026-10-18",
        "--recipient",input.recipientRef,"--schedule-date","2026-10-19"],db);
      expect(preview).toMatchObject({mode:"PREVIEW",tasks:[],schedules:[{schedule_date:"2026-10-19",status:"BLOCKED",classification:"REPORT_DATA_DIRTY"}]});
    } finally { log.mockRestore(); }
    expect(await repo.bundles(input.enterpriseId,"DAILY","2026-10-18")).toEqual([]);
  });
  it("schema rollback retains actual delivery evidence and reapplies without duplicates",async()=>{
    const input=await fixture(),bundle=(await repo.freeze(input))!;
    const migrator=createMigrator(db);
    expect((await migrator.migrateDown()).error).toBeUndefined();
    expect((await repo.messages(input.enterpriseId,bundle.id))).toHaveLength(2);
    expect((await migrator.migrateToLatest()).error).toBeUndefined();
    expect((await repo.messages(input.enterpriseId,bundle.id))).toHaveLength(2);
  });

  it("expired media is re-uploaded while successful messages remain immutable",async()=>{
    const input=await fixture(),bundle=(await repo.freeze(input))!;let uploads=0,imageRequests=0,at=now;
    const fetcher:typeof fetch=async(url,init)=>{
      if(String(url).includes("gettoken"))return new Response(JSON.stringify({errcode:0,access_token:"fixture"}));
      if(String(url).includes("media/upload")){uploads++;return new Response(JSON.stringify({errcode:0,media_id:`fresh-${uploads}`}));}
      const kind=JSON.parse(String(init?.body)).msgtype;
      if(kind==="image"&&++imageRequests===1)return new Response(JSON.stringify({errcode:40007}));
      return new Response(JSON.stringify({errcode:0,msgid:`${kind}-receipt`}));
    };
    const instance=new WecomAppClient(key,fetcher);
    const run=()=>executeReportBundle({repo,bundle,kekBase64:key,client:instance,clock:()=>at});
    await run();at=new Date(now.getTime()+35_000);expect((await run()).status).toBe("SENT");await run();
    expect(uploads).toBe(2);expect(imageRequests).toBe(2);
    expect((await repo.attempts(input.enterpriseId,bundle.id))).toHaveLength(3);
  });

});
