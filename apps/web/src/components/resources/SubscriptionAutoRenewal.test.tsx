import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SubscriptionAutoRenewal } from "./SubscriptionAutoRenewal";
const getMock=vi.fn();const postMock=vi.fn();
vi.mock("../../api/client",()=>({get:(...args:unknown[])=>getMock(...args),post:(...args:unknown[])=>postMock(...args)}));
const status={enabled:true,nextRenewalAt:"2026-09-25T16:00:00Z",cashPaidCny:"199",amount:"199",currency:"CNY",productName:"Kimi",blockedReason:null};
let client:QueryClient;
beforeEach(()=>{client=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});getMock.mockReset().mockResolvedValue(status);postMock.mockReset().mockImplementation(async()=>{getMock.mockResolvedValue({...status,enabled:false,nextRenewalAt:null});return{enabled:false};});});
afterEach(()=>client.clear());
function show(writable=true){render(<QueryClientProvider client={client}><SubscriptionAutoRenewal resourceId="resource-kimi" writable={writable}/></QueryClientProvider>);}
describe("current subscription cancellation",()=>{
  it("shows next date/amount and cancels only automatic continuation",async()=>{
    show();await screen.findByText("自动续订：已开启");
    expect(screen.getByText(/2026-09-26.*199.00/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button",{name:"取消自动续订"}));
    await waitFor(()=>expect(postMock).toHaveBeenCalledWith("/provider-resources/resource-kimi/finance/auto-renewal/cancel",{}));
    await screen.findByText("自动续订：已取消");expect(screen.getByText("本期和历史记录保留")).toBeInTheDocument();
    expect(screen.queryByRole("button",{name:"取消自动续订"})).not.toBeInTheDocument();
  });
  it("read-only finance mode cannot cancel",async()=>{show(false);expect(await screen.findByRole("button",{name:"取消自动续订"})).toBeDisabled();expect(postMock).not.toHaveBeenCalled();});
  it("failure keeps the enabled state and displays a retryable error",async()=>{
    postMock.mockRejectedValue(new Error("取消失败"));show();await userEvent.click(await screen.findByRole("button",{name:"取消自动续订"}));
    expect(await screen.findByRole("alert")).toHaveTextContent("取消失败");expect(screen.getByText("自动续订：已开启")).toBeInTheDocument();
  });
});
