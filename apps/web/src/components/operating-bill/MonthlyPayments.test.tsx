import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MonthlyPayments } from "./MonthlyPayments";
import type { OperatingBill } from "../../api/operating-bills";
import type { AnalysisPayment } from "../../api/operating-analysis";
vi.mock("../../api/operating-bill-payments",()=>({useOperatingBillPayments:()=>({data:[],isLoading:false,error:null})}));
const bill = {month:"2026-09",providers:[]} as unknown as OperatingBill;
const payment:AnalysisPayment = {id:"renewal",providerResourceId:"kimi-resource",providerName:"Kimi",resourceName:"Kimi",eventType:"CODING_PLAN_RENEWAL",cashPaidCny:"199",occurredAt:"2026-09-01T00:00:00Z",externalReference:null,description:null,source:"ADMIN"};
describe("本月采购按付款记录联动",()=>{
  it.each(["ADMIN", "IMPORT"])("人工续订来源%s以同行小字呈现，保留实际日期、厂商和金额",(source)=>{
    render(<MonthlyPayments bill={bill} payments={[{...payment, source}]}/>);
    expect(screen.getByRole("heading",{name:"本月采购"})).toBeInTheDocument();
    expect(screen.queryByText("本月买了什么")).not.toBeInTheDocument();
    expect(screen.getByText("人工续订").parentElement).toHaveClass("whitespace-nowrap");
    expect(screen.getByText("人工续订")).toHaveClass("text-[11px]");
    expect(screen.getByText("Kimi ¥199.00")).toBeInTheDocument();
    expect(screen.getByText("2026-09-01 08:00:00")).toBeInTheDocument();
  });
  it("只有明确系统来源才标系统续订，导入数据保留来源区别",()=>{
    render(<MonthlyPayments bill={bill} payments={[{...payment,id:"system",source:"PROVIDER_SYNC"},{...payment,id:"history",source:"MIGRATION"}]}/>);
    expect(screen.getByText("系统续订")).toBeInTheDocument();
    expect(screen.getByText("历史续订")).toBeInTheDocument();
  });
});
