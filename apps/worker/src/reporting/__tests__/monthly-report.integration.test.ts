import { randomUUID } from "node:crypto";
import { Image } from "@napi-rs/canvas";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createKysely, migrateToLatest } from "@qianliu/database";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";
import { runCompanyMonthlyReport, runPersonalMonthlyReports } from "../monthly-reports.js";
import { renderSvgToPng } from "../render-png.js";
import { WecomAppClient } from "../../runtime-assurance/wecom-client.js";

let pg:PostgresTestInstance;let db:ReturnType<typeof createKysely>;let enterpriseId:string;let personId:string;
beforeAll(async()=>{
  pg=await startPostgresContainer("monthly_report");db=createKysely(pg.connectionString);await migrateToLatest(db);
  enterpriseId=(await db.insertInto("enterprise").values({name:"合成企业",timezone:"UTC"}).returning("id").executeTakeFirstOrThrow()).id;
  personId=(await db.insertInto("person").values({enterprise_id:enterpriseId,name:"测试成员",department_label:"技术部"}).returning("id").executeTakeFirstOrThrow()).id;
  await db.insertInto("person_external_identity").values({enterprise_id:enterpriseId,person_id:personId,provider:"WECOM",provider_user_id:"synthetic-member",status:"ACTIVE"}).execute();
  const principal=(await db.insertInto("principal").values({enterprise_id:enterpriseId,person_id:personId,type:"EMPLOYEE",name:"测试成员"}).returning("id").executeTakeFirstOrThrow()).id;
  const grant=(await db.insertInto("principal_grant").values({enterprise_id:enterpriseId,principal_id:principal,provider:"zhipu",model_alias:"GLM",quota_value:200000n,status:"ACTIVE",valid_from:new Date("2026-08-01T00:00:00Z"),created_at:new Date("2026-08-01T00:00:00Z"),updated_at:new Date("2026-08-01T00:00:00Z")}).returning("id").executeTakeFirstOrThrow()).id;
  await db.insertInto("quota_counter").values({grant_id:grant,used_value:199999n,period_anchor:new Date("2026-10-01T00:00:00+08:00")}).execute();
  await db.insertInto("principal_grant").values({enterprise_id:enterpriseId,principal_id:principal,provider:"kimi",model_alias:"K3",quota_value:9999999n,status:"ACTIVE",valid_from:new Date("2026-10-01T00:00:00+08:00"),created_at:new Date("2026-10-01T00:00:00+08:00"),updated_at:new Date("2026-10-01T00:00:00+08:00")}).execute();
  const key=(await db.insertInto("principal_key").values({enterprise_id:enterpriseId,principal_id:principal,key_prefix:"monthly",key_digest:randomUUID()}).returning("id").executeTakeFirstOrThrow()).id;
  for(const [at,tokens] of [["2026-09-01T00:00:00+08:00",60000n],["2026-09-30T23:59:59.999+08:00",90000n],["2026-10-01T00:00:00+08:00",99999999n]] as const){
    const id=randomUUID();await db.insertInto("ai_request").values({id,enterprise_id:enterpriseId,principal_id:principal,principal_key_id:key,protocol:"OPENAI_CHAT",unified_model:"GLM-5",status:"SUCCEEDED",started_at:new Date(at),finished_at:new Date(at)}).execute();
    await db.insertInto("ledger_transaction").values({enterprise_id:enterpriseId,ai_request_id:id,principal_id:principal,total_input_tokens:tokens,total_output_tokens:0n,total_deducted_quota:tokens,total_api_cost:"0",api_cost_status:"NOT_APPLICABLE",usage_quality:"UPSTREAM_REPORTED",attempt_count:1,status:"SETTLED",created_at:new Date(at)}).execute();
  }
  await db.insertInto("notification_endpoint").values({provider:"WECOM_APP",corp_id:"synthetic-corp",agent_id:"1",secret_ciphertext:"unused",secret_fingerprint:"unused",status:"ACTIVE"}).execute();
},120000);
afterAll(async()=>{vi.restoreAllMocks();await db?.destroy();await pg?.stop();},60000);

describe("closed-month reports share the weekly high-resolution layout",()=>{
  it("includes both September boundaries and excludes October usage and its mutable quota",async()=>{
    const sizes:Array<[number,number]>=[];const decode=Image.prototype.decode;
    const spy=vi.spyOn(Image.prototype,"decode").mockImplementation(async function(this:Image){await decode.call(this);sizes.push([this.width,this.height]);});
    try{
      const result=await runCompanyMonthlyReport({db,enterpriseId,kekBase64:"unused",month:"2026-09",dryRun:true});
      expect(result).toMatchObject({status:"DRY_RUN",totalTokens:150000,requestCount:2});
      expect(result.svg).toContain("全员用量月报");expect(result.svg).toContain("2026 年 9 月 · 9.1 - 9.30");
      expect(result.svg).toContain("20.0");expect(result.svg).toContain("5.0");
      expect(result.svg!.replace(/<!--[\s\S]*?-->/g," ")).not.toContain("全周");expect(result.svg!.replace(/<!--[\s\S]*?-->/g," ")).not.toContain("7天");expect(result.svg).toContain('viewBox="0 0 540 760"');
      expect([result.pngBuffer!.readUInt32BE(16),result.pngBuffer!.readUInt32BE(20)]).toEqual([1080,1520]);expect(sizes[0]).toEqual([1080,1520]);
    }finally{spy.mockRestore();}
  });
  it("renders and delivers a personal month card using the existing font, crop and recipient",async()=>{
    const preview=await runPersonalMonthlyReports({db,enterpriseId,kekBase64:"unused",month:"2026-09",userPersonId:personId,dryRun:true});
    expect(preview[0]).toMatchObject({totalTokens:150000,requestCount:2,status:"DRY_RUN"});
    expect(preview[0]!.svg).toContain("月度小结 2026 年 9 月");expect(preview[0]!.svg).toContain("月消耗 Token 总量");
    expect(preview[0]!.svg).toContain("0.5 万 /天");expect(preview[0]!.svg).toContain("5.0 万");
    const png=await renderSvgToPng(preview[0]!.svg!,{fitWidth:1080});expect([png.readUInt32BE(16),png.readUInt32BE(20)]).toEqual([1080,1538]);
    const upload=vi.spyOn(WecomAppClient.prototype,"uploadMedia").mockResolvedValue("synthetic-media");
    const image=vi.spyOn(WecomAppClient.prototype,"sendImageMessage").mockResolvedValue({status:"SENT"});
    vi.spyOn(WecomAppClient.prototype,"sendTextMessage").mockResolvedValue({status:"SENT"});
    const sent=vi.fn();await runPersonalMonthlyReports({db,enterpriseId,kekBase64:"unused",month:"2026-09",userPersonId:personId,onSent:sent});
    expect(upload.mock.calls[0]![2]).toBe("monthly_synthetic-member.png");expect(image.mock.calls[0]![1]).toEqual(["synthetic-member"]);expect(sent).toHaveBeenCalledTimes(1);
  });
  it("does not invent a historical allocation after the grant has been edited",async()=>{
    await db.updateTable("principal_grant").set({updated_at:new Date("2026-10-02T00:00:00+08:00"),quota_value:999999999n})
      .where("enterprise_id","=",enterpriseId).where("provider","=","zhipu").execute();
    const result=await runCompanyMonthlyReport({db,enterpriseId,kekBase64:"unused",month:"2026-09",dryRun:true});
    expect(result.totalTokens).toBe(150000);expect(result.svg).toContain("未留存");expect(result.svg).not.toContain("99999");
  });
});
