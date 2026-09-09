import { fireEvent, render, screen, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { AlertDetailDrawer } from "./AlertDetailDrawer";
import { AlertRow, AlertFilters } from "./AlertTableParts";
import { fault } from "./__tests__/fixture";
import type { AlertItem } from "../../api/types";
vi.mock("../RequestDrilldown", () => ({
  RequestDrilldown: ({ requestId }: { requestId: string }) => (
    <div data-testid="request">{requestId}</div>
  ),
}));
const variants: Array<[string, Partial<AlertItem>]> = [
  ["new", {}],
  [
    "verified",
    {
      status: "RESOLVED",
      severity: "MEDIUM",
      resolutionNote: "已换凭证并核对",
      handledBy: "管理员A",
      resolvedBy: "admin",
      resolvedAt: "2026-09-03T03:00:00Z",
      sourceClearedAt: "2026-09-03T02:00:00Z",
      model: "模型A",
      aiRequestId: "request-A",
      recoveryEvidence: {
        kind: "SUCCESSFUL_REQUEST",
        summary: "同一资源后续成功",
        verifiedAt: "2026-09-03T02:00:00Z",
        referenceId: "attempt-A",
      },
    },
  ],
  [
    "legacy",
    {
      status: "IGNORED",
      severity: "LOW",
      resolutionNote: " ",
      resolvedBy: "admin-old",
    },
  ],
  [
    "request",
    {
      signal: "request_failure",
      resourceId: null,
      principalId: null,
      detail: "请求已失败",
    },
  ],
];
it.each(variants)(
  "preserves all seven detail sections, state semantics and approved layout: %s",
  (name, overrides) => {
    const close = vi.fn(),
      handle = vi.fn();
    render(
      <AlertDetailDrawer
        alert={fault(overrides)}
        principalName={name === "verified" ? "人员A" : undefined}
        providerName={name === "verified" ? "厂商A" : undefined}
        resourceName={name === "verified" ? "资源A" : undefined}
        startHandling={name === "new"}
        handledPending={false}
        onClose={close}
        onHandle={handle}
      />,
    );
    const dialog = screen.getByRole("dialog", { name: "异常详情" });
    expect(
      within(dialog)
        .getAllByRole("heading", { level: 3 })
        .map((el) => el.textContent),
    ).toEqual([
      "基本信息",
      "异常原因",
      "影响范围",
      "处理建议",
      "处理情况",
      "恢复依据",
      "关联请求与事件记录",
    ]);
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveClass("overflow-y-auto");
    if (name === "new") {
      expect(screen.getByLabelText("处理说明")).toHaveFocus();
      expect(
        screen.getByRole("button", { name: "保存处理说明" }),
      ).toBeDisabled();
    }
    if (name === "verified") {
      expect(screen.getByTestId("request")).toHaveTextContent("request-A");
      expect(screen.getByText("证据编号：attempt-A")).toBeInTheDocument();
      expect(screen.getByText("已自动恢复")).toBeInTheDocument();
    }
    if (name === "legacy")
      expect(
        screen.getByText("这条历史处理记录缺少说明，请补充。"),
      ).toBeInTheDocument();
    if (name === "request")
      expect(
        screen.getByText(/后续新请求成功不会改写本次结果/),
      ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "关闭异常详情" }));
    expect(close).toHaveBeenCalledOnce();
    expect(handle).not.toHaveBeenCalled();
  },
);
it("shows only validated recovery evidence and supports a verified proof without optional reference/time fields", () => {
  const item = fault({
    recoveryEvidence: {
      kind: "SERVICE_HEALTHY",
      summary: "探针通过",
      verifiedAt: "2026-09-03T00:00:00Z",
    },
  });
  const { rerender } = render(
    <AlertDetailDrawer
      alert={item}
      handledPending={false}
      onClose={vi.fn()}
      onHandle={vi.fn()}
    />,
  );
  expect(screen.getByText(/探针通过/)).toBeInTheDocument();
  expect(screen.queryByText(/证据编号/)).not.toBeInTheDocument();
  rerender(
    <AlertDetailDrawer
      alert={fault({
        status: "AUTO_RESOLVED",
        recoveryEvidence: {
          kind: "UNKNOWN",
          summary: "不可信",
          verifiedAt: "invalid",
        },
      })}
      handledPending={false}
      onClose={vi.fn()}
      onHandle={vi.fn()}
    />,
  );
  expect(screen.queryByText("已自动恢复")).not.toBeInTheDocument();
  expect(screen.getByText(/尚无可靠恢复证据/)).toBeInTheDocument();
});
it.each([false, true])(
  "row handles yes only, respects pending=%s and keeps manual state separate from proof",
  (pending) => {
    const handle = vi.fn(),
      view = vi.fn();
    const { rerender } = render(
      <table>
        <tbody>
          <AlertRow
            alert={fault()}
            pending={pending}
            onHandle={handle}
            onView={view}
          />
        </tbody>
      </table>,
    );
    const select = screen.getByLabelText("上游调用失败 是否处理");
    expect(select).toHaveValue("no");
    if (pending) expect(select).toBeDisabled();
    else expect(select).toBeEnabled();
    fireEvent.change(select, { target: { value: "no" } });
    expect(handle).not.toHaveBeenCalled();
    if (!pending) {
      fireEvent.change(select, { target: { value: "yes" } });
      expect(handle).toHaveBeenCalledOnce();
    }
    fireEvent.click(screen.getByRole("button", { name: "查看" }));
    expect(view).toHaveBeenCalledOnce();

    rerender(
      <table>
        <tbody>
          <AlertRow
            alert={fault({ status: "RESOLVED", resolutionNote: "已核对" })}
            pending={false}
            onHandle={handle}
            onView={view}
          />
        </tbody>
      </table>,
    );
    expect(screen.getByLabelText("上游调用失败 是否处理")).toBeDisabled();
    expect(screen.getByText("等待恢复验证")).toBeInTheDocument();
  },
);
it("filters pass the actual selected values and reflect lookup-disabled state", () => {
  const month = vi.fn(),
    principal = vi.fn(),
    provider = vi.fn(),
    search = vi.fn();
  render(
    <AlertFilters
      month="2026-09"
      principalId=""
      providerId=""
      search=""
      principals={[{ id: "p", name: "人员" }]}
      providers={[{ id: "v", name: "厂商" }]}
      principalDisabled={false}
      providerDisabled={false}
      onMonth={month}
      onPrincipal={principal}
      onProvider={provider}
      onSearch={search}
    />,
  );
  fireEvent.change(screen.getByLabelText("异常月份"), {
    target: { value: "2026-08" },
  });
  fireEvent.change(screen.getByLabelText("异常使用主体"), {
    target: { value: "p" },
  });
  fireEvent.change(screen.getByLabelText("异常厂商"), {
    target: { value: "v" },
  });
  fireEvent.change(screen.getByLabelText("搜索异常"), {
    target: { value: "req-A" },
  });
  expect(month).toHaveBeenCalledExactlyOnceWith("2026-08");
  expect(principal).toHaveBeenCalledExactlyOnceWith("p");
  expect(provider).toHaveBeenCalledExactlyOnceWith("v");
  expect(search).toHaveBeenCalledExactlyOnceWith("req-A");
});
