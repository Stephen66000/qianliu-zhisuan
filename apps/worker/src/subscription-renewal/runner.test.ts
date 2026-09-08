import { describe, expect, it, vi } from "vitest";
import type { Kysely } from "kysely";
import type { Database } from "@qianliu/database";
import { runSubscriptionRenewalTick } from "./runner.js";
const run = vi.fn(async(..._args:unknown[])=>({scanned:1,created:1,failures:[]}));
vi.mock("@qianliu/database",()=>({runSubscriptionAutoRenewals:(...args:unknown[])=>run(...args)}));
describe("standing renewal worker gate",()=>{
  it.each(["OFF","DARK"])("does not write in %s mode",async(mode)=>{
    run.mockClear();
    expect(await runSubscriptionRenewalTick({db:{} as Kysely<Database>,env:{PROVIDER_FINANCE_MODE:mode}})).toMatchObject({created:0,skipped:"FINANCE_MODE_INACTIVE"});
    expect(run).not.toHaveBeenCalled();
  });
  it("ACTIVE invokes the persisted, tenant-gated renewal loop",async()=>{
    const db={} as Kysely<Database>;const now=new Date();run.mockClear();
    await runSubscriptionRenewalTick({db,now,env:{PROVIDER_FINANCE_MODE:"ACTIVE"}});
    expect(run).toHaveBeenCalledWith(db,now);
  });
});
