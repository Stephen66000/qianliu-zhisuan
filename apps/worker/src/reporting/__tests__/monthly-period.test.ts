import { describe, expect, it, vi } from "vitest";
import type { Kysely } from "kysely";
import type { Database } from "@qianliu/database";
import { completedReportMonth, monthlyReportDue } from "../monthly-period.js";
import { runMonthlyReportTick, type MonthlyReportStore } from "../monthly-scheduler.js";

describe("completed Beijing reporting months", () => {
  it.each([["2026-01-01T01:00:00Z", "2025-12",31],["2024-03-01T01:00:00Z","2024-02",29],
    ["2026-03-01T01:00:00Z","2026-02",28],["2026-10-03T01:00:00Z","2026-09",30]] as const)("%s reports %s", (at, month, days) => {
    expect(completedReportMonth(undefined,new Date(at))).toMatchObject({month,days});
  });
  it("uses an exclusive next-month boundary and rejects unfinished periods", () => {
    const now=new Date("2026-10-03T00:00:00Z");
    const month=completedReportMonth("2026-09",now);
    expect(month.start.toISOString()).toBe("2026-08-31T16:00:00.000Z");
    expect(month.end.toISOString()).toBe("2026-09-30T16:00:00.000Z");
    for(const value of ["2026-10","2026-11","2026-13","2026-9"]) expect(()=>completedReportMonth(value,now)).toThrow();
  });
  it.each([["2026-10-01T00:59:59Z",false],["2026-10-01T01:00:00Z",true],
    ["2026-10-01T01:29:59Z",true],["2026-10-01T01:30:00Z",false],["2026-10-02T01:00:00Z",false]])("only runs the first-day 09:00 window: %s",(at,due)=>{
    expect(monthlyReportDue(new Date(at))).toBe(due);
  });
});

class Store implements MonthlyReportStore {
  done=new Set<string>(); locks=new Map<string,string>();
  async has(key:string){return this.done.has(key);}
  async mark(key:string){this.done.add(key);}
  async acquire(key:string,token:string){if(this.locks.has(key))return false;this.locks.set(key,token);return true;}
  async release(key:string,token:string){if(this.locks.get(key)===token)this.locks.delete(key);}
}
describe("monthly delivery restart receipts",()=>{
  const base={db:{} as Kysely<Database>,enterpriseId:"tenant",kekBase64:"unused",now:new Date("2026-10-01T01:00:00Z")};
  it("retries a failed personal delivery without sending the team or completed person again",async()=>{
    const store=new Store();
    const company=vi.fn(async()=>({status:"SENT" as const,enterpriseName:"Team",dateRange:"Sep",totalTokens:0,requestCount:0,activeEmployees:2,recipients:["admin"]}));
    const sent:string[]=[];let fail=true;
    const personal=vi.fn(async(options:Parameters<NonNullable<Parameters<typeof runMonthlyReportTick>[0]["personal"]>>[0])=>{
      for(const id of ["a","b"]){if(!await options.shouldSend!(id))continue;if(id==="b"&&fail){fail=false;throw new Error("delivery failed");}sent.push(id);await options.onSent!(id);}
      return [];
    });
    await expect(runMonthlyReportTick({...base,store,company,personal})).rejects.toThrow("delivery failed");
    expect(await runMonthlyReportTick({...base,store,company,personal})).toMatchObject({status:"SENT",month:"2026-09"});
    expect(await runMonthlyReportTick({...base,store,company,personal})).toMatchObject({status:"ALREADY_SENT"});
    expect(company).toHaveBeenCalledTimes(1);expect(sent).toEqual(["a","b"]);
  });
  it("sends nothing without durable storage or outside the delivery window",async()=>{
    const company=vi.fn();const personal=vi.fn();
    expect(await runMonthlyReportTick({...base,store:null,company,personal})).toMatchObject({status:"NO_DURABLE_STORE"});
    expect(await runMonthlyReportTick({...base,now:new Date("2026-10-03T01:00:00Z"),store:new Store(),company,personal})).toMatchObject({status:"OUTSIDE_WINDOW"});
    expect(company).not.toHaveBeenCalled();expect(personal).not.toHaveBeenCalled();
  });
});
