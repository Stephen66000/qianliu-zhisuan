import { describe, expect, it, vi } from "vitest";
import { dueReportTypes, reportScheduleActive } from "../delivery-scheduler.js";
import { runScheduledOperationalTasks } from "../../runtime-assurance/scheduled-tasks.js";
import { parseDeliveryCommand } from "../delivery-cli.js";

describe("Beijing delivery windows and independent dispatch",()=>{
  it.each([
    ["2026-10-19T00:59:59Z",[]],
    ["2026-10-19T01:00:00Z",["DAILY","COMPANY_WEEKLY","PERSONAL_WEEKLY"]],
    ["2026-10-19T01:30:00Z",[]],
    ["2026-11-01T01:00:00Z",["DAILY","COMPANY_MONTHLY","PERSONAL_MONTHLY"]],
    ["2026-10-21T01:29:59Z",["DAILY"]],
    ["2026-10-21T01:30:00Z",["TOP1","OVER50"]],
    ["2026-10-21T02:00:00Z",[]],
  ])("%s selects the unchanged trigger set",(at,expected)=>expect(dueReportTypes(new Date(at as string))).toEqual(expected));
  it("requires explicit activation and honors report-only pause",()=>{
    const now=new Date("2026-10-19T01:00:00Z");
    expect(reportScheduleActive(now)).toBe(false);
    expect(reportScheduleActive(now,"invalid")).toBe(false);
    expect(reportScheduleActive(now,"2026-10-20T00:00:00Z")).toBe(false);
    expect(reportScheduleActive(now,"2026-10-19T00:00:00Z")).toBe(true);
    expect(reportScheduleActive(now,"2026-10-19T00:00:00Z","1")).toBe(false);
  });
  it("still reaches reporting after aggregate or core failure",async()=>{
    for(const stage of ["core","aggregate","renewals"]) {
      const reports=vi.fn(async()=>{}), onAggregateError=vi.fn();
      const task=async(name:string)=>{if(stage===name)throw new Error("injected failure");return name;};
      const round=runScheduledOperationalTasks({core:()=>task("core"),aggregate:()=>task("aggregate"),renewals:()=>task("renewals"),reports,onAggregateError});
      if(stage==="aggregate")await round;else await expect(round).rejects.toThrow("injected failure");
      expect(reports).toHaveBeenCalledTimes(1);
    }
  });
});
describe("controlled resend inputs",()=>{
  const base=["--enterprise","00000000-0000-4000-8000-000000000001","--type","PERSONAL_WEEKLY","--period","2026-10-11T16:00:00.000Z","--recipient","principal-ref"];
  it("defaults to preview and requires all four scope fields",()=>{
    expect(parseDeliveryCommand(base).execute).toBe(false);
    for(let i=0;i<base.length;i+=2)expect(()=>parseDeliveryCommand(base.filter((_,idx)=>idx!==i&&idx!==i+1))).toThrow();
  });
  it("execution requires a fresh hash and explicit audit reason",()=>{
    expect(()=>parseDeliveryCommand([...base,"--execute"])).toThrow();
    expect(parseDeliveryCommand([...base,"--execute","--preview-hash","a".repeat(64),"--reason","receipt manually verified","--allow-unknown"])).toMatchObject({execute:true,allowUnknown:true});
    expect(()=>parseDeliveryCommand([...base,"--recipient","another"])).toThrow();
  });
  it("accepts a read-only schedule filter and rejects impossible calendar dates",()=>{
    expect(parseDeliveryCommand([...base,"--schedule-date","2026-10-19"])).toMatchObject({execute:false,scheduleDate:"2026-10-19"});
    for(const value of ["2026-02-30","2026-13-01","2026-1-01","not-a-date"])
      expect(()=>parseDeliveryCommand([...base,"--schedule-date",value])).toThrow("Invalid --schedule-date");
  });

});
