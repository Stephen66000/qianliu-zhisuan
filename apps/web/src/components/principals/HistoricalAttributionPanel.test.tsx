import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, expect, it, vi } from "vitest";
import { HistoricalAttributionPanel } from "./HistoricalAttributionPanel";
const send=vi.hoisted(()=>vi.fn());
vi.mock("../../api/client",()=>({post:(...args:unknown[])=>send(...args)}));
beforeEach(()=>send.mockReset());
function show() { render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><HistoricalAttributionPanel principalId="project-1" departments={[{id:"dept-1",name:"研发部"}]} suggestedDepartmentId="dept-1"/></QueryClientProvider>); }
it("现有负责人部门仅作建议，预览后才能提交确认并保留审核依据",async()=>{
  send.mockResolvedValueOnce({principalName:"compass",departmentName:"研发部",requestCount:3,fingerprint:"a".repeat(64)}).mockResolvedValueOnce({confirmedCount:3});
  show();await userEvent.click(screen.getByRole("button",{name:"补齐历史归属"}));
  expect(screen.getByRole("combobox",{name:"历史所属部门"})).toHaveValue("dept-1");
  expect(screen.queryByRole("button",{name:"确认补齐历史归属"})).not.toBeInTheDocument();
  await userEvent.type(screen.getByRole("textbox",{name:"历史归属确认依据"}),"确认项目期间归研发部");
  await userEvent.click(screen.getByRole("button",{name:"预览待补齐记录"}));
  await userEvent.click(await screen.findByRole("button",{name:"确认补齐历史归属"}));
  expect(await screen.findByRole("status")).toHaveTextContent("已补齐 3 条");
  expect(send).toHaveBeenLastCalledWith("/principals/project-1/attribution-backfill",expect.objectContaining({department_id:"dept-1",reason:"确认项目期间归研发部",fingerprint:"a".repeat(64)}));
});
it("编辑预览条件会使确认失效，零条记录不能确认",async()=>{
  send.mockResolvedValue({principalName:"员工",departmentName:"研发部",requestCount:0,fingerprint:"a".repeat(64)});
  show();await userEvent.click(screen.getByRole("button",{name:"补齐历史归属"}));
  await userEvent.type(screen.getByRole("textbox",{name:"历史归属确认依据"}),"确认");
  await userEvent.click(screen.getByRole("button",{name:"预览待补齐记录"}));
  expect(await screen.findByRole("button",{name:"确认补齐历史归属"})).toBeDisabled();
  await userEvent.type(screen.getByRole("textbox",{name:"历史归属确认依据"}),"部门");
  expect(screen.queryByRole("button",{name:"确认补齐历史归属"})).not.toBeInTheDocument();
});
