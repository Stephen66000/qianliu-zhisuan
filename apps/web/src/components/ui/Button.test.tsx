import { createRef } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { Button } from "./Button";

it("保留表单类型、ref、权限属性、键盘操作；加载锁定并保留文字占位", async () => {
  const user = userEvent.setup(), click = vi.fn(), ref = createRef<HTMLButtonElement>();
  const view = render(<Button ref={ref} data-write-action type="submit" loading={false} loadingText="处理中…" onClick={click}>保存</Button>);
  expect(ref.current).toBe(screen.getByRole("button", { name: "保存" }));
  expect(ref.current).toHaveAttribute("type", "submit");
  expect(ref.current).toHaveAttribute("data-write-action");
  ref.current!.focus(); await user.keyboard(" "); expect(click).toHaveBeenCalledTimes(1);
  view.rerender(<Button ref={ref} loading loadingText="处理中…" onClick={click}>保存</Button>);
  expect(screen.getByRole("button", { name: "处理中…" })).toBeDisabled();
  expect(ref.current).toHaveAttribute("aria-busy", "true");
  expect(screen.getByText("保存")).toHaveStyle({ visibility: "hidden" });
  await user.click(ref.current!); expect(click).toHaveBeenCalledTimes(1);
});
