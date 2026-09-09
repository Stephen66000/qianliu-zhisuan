import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { AlertHandlingForm } from "./AlertHandlingForm";
import { fault } from "./__tests__/fixture";
it("cancel and no selection never submit; whitespace fails; errors retain the entered explanation", () => {
  const handle = vi.fn();
  const props = {
    alert: fault(),
    startHandling: false,
    handledPending: false,
    handledError: false,
    onHandle: handle,
  };
  const { rerender } = render(<AlertHandlingForm {...props} />);
  expect(screen.queryByLabelText("处理说明")).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("详情是否处理"), {
    target: { value: "yes" },
  });
  expect(screen.getByLabelText("处理说明")).toHaveFocus();
  fireEvent.change(screen.getByLabelText("处理说明"), {
    target: { value: "   " },
  });
  expect(screen.getByRole("button", { name: "保存处理说明" })).toBeDisabled();
  fireEvent.submit(screen.getByLabelText("处理说明").closest("form")!);
  expect(handle).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("处理说明"), {
    target: { value: "  原因与处理措施  " },
  });
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  expect(handle).not.toHaveBeenCalled();
  expect(screen.queryByLabelText("处理说明")).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("详情是否处理"), {
    target: { value: "yes" },
  });
  expect(screen.getByLabelText("处理说明")).toHaveValue("  原因与处理措施  ");
  fireEvent.submit(screen.getByLabelText("处理说明").closest("form")!);
  expect(handle).toHaveBeenCalledExactlyOnceWith("  原因与处理措施  ");
  rerender(<AlertHandlingForm {...props} handledError />);
  expect(screen.getByRole("alert")).toHaveTextContent(
    "保存失败，说明已保留，请重试。",
  );
  expect(screen.getByLabelText("处理说明")).toHaveValue("  原因与处理措施  ");
  rerender(<AlertHandlingForm {...props} handledPending />);
  expect(screen.getByLabelText("详情是否处理")).toBeDisabled();
  expect(screen.getByRole("button", { name: "取消" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "保存中…" })).toBeDisabled();
});
it.each(["RESOLVED", "IGNORED"] as const)(
  "historical %s requires missing notes but locks complete notes",
  (status) => {
    const { rerender } = render(
      <AlertHandlingForm
        alert={fault({ status })}
        startHandling={false}
        handledPending={false}
        handledError={false}
        onHandle={vi.fn()}
      />,
    );
    expect(screen.getByLabelText("处理说明")).toBeInTheDocument();
    expect(screen.getByText(/处理人：未记录/)).toBeInTheDocument();
    rerender(
      <AlertHandlingForm
        alert={fault({ status, resolutionNote: "已处理", resolvedBy: "actor" })}
        startHandling={false}
        handledPending={false}
        handledError={false}
        onHandle={vi.fn()}
      />,
    );
    expect(screen.getByLabelText("详情是否处理")).toBeDisabled();
    expect(screen.queryByLabelText("处理说明")).not.toBeInTheDocument();
    expect(screen.getByText(/处理人：actor/)).toBeInTheDocument();
  },
);
