import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it } from "vitest";
import { ExpandableTableRow, RowDetail } from "./ExpandableTableRow";

function Table({ rows, scope = "month-a" }: { rows: string[]; scope?: string }) {
  return <table><tbody>{rows.map((id) => <ExpandableTableRow key={`${scope}:${id}`} columns={2} label={id}
    leading={id} details={<RowDetail label="明细">{id} 精确事实</RowDetail>}><td>{id} 风险摘要</td></ExpandableTableRow>)}</tbody></table>;
}
it("键盘展开、收起与稳定业务行绑定；排序不串行，移除和月份变化清除状态", async () => {
  const user = userEvent.setup();
  const view = render(<Table rows={["甲", "乙"]} />);
  const first = screen.getByRole("button", { name: "展开甲详情" });
  first.focus(); await user.keyboard("{Enter}");
  expect(first).toHaveAttribute("aria-expanded", "true");
  expect(document.getElementById(first.getAttribute("aria-controls")!)).toBeVisible();
  expect(screen.getByRole("region", { name: "甲详情" })).toHaveTextContent("甲 精确事实");
  view.rerender(<Table rows={["乙", "甲"]} />);
  expect(screen.getByRole("button", { name: "收起甲详情" })).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByRole("button", { name: "展开乙详情" })).toHaveAttribute("aria-expanded", "false");
  view.rerender(<Table rows={["乙"]} />);
  view.rerender(<Table rows={["甲", "乙"]} />);
  expect(screen.getByRole("button", { name: "展开甲详情" })).toHaveAttribute("aria-expanded", "false");
  await user.click(screen.getByRole("button", { name: "展开甲详情" }));
  view.rerender(<Table rows={["甲", "乙"]} scope="month-b" />);
  expect(screen.queryByRole("region", { name: "甲详情" })).not.toBeInTheDocument();
  expect(screen.getByText("甲 风险摘要")).toBeVisible();
});
