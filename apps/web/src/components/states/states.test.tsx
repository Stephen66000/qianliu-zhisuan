/**
 * W18 三态组件单测 —— Loading/Empty/Error 渲染断言。
 */
import { render, screen } from "@testing-library/react";
import { Inbox } from "lucide-react";
import { describe, expect, it, vi } from "vitest";

import { EmptyState } from "./EmptyState";
import { ErrorState } from "./ErrorState";
import { LoadingState } from "./LoadingState";

describe("W18 三态组件", () => {
  describe("LoadingState", () => {
    it("默认渲染 spinner + 说明文字", () => {
      render(<LoadingState />);
      expect(screen.getByRole("status")).toHaveTextContent("正在加载数据…");
      expect(screen.getByRole("status")).toHaveAttribute("aria-busy", "true");
    });

    it("rows>0 时渲染骨架屏占位而非 spinner", () => {
      const { container, queryByRole } = render(<LoadingState rows={3} />);
      expect(queryByRole("status")).toBeNull();
      expect(container.querySelectorAll(".ql-skeleton")).toHaveLength(3);
    });

    it("自定义说明文字", () => {
      render(<LoadingState label="正在加载本月看板数据…" />);
      expect(screen.getByRole("status")).toHaveTextContent("正在加载本月看板数据…");
    });
  });

  describe("EmptyState", () => {
    it("说明为什么为空 + 描述（PRD §10.4）", () => {
      render(
        <EmptyState
          description="尚未登记可用 AI 资源，无法产生模型和路由候选。"
          icon={Inbox}
          title="尚未登记厂商资源"
        />,
      );
      expect(screen.getByText("尚未登记厂商资源")).toBeInTheDocument();
      expect(screen.getByText(/无法产生模型和路由候选/)).toBeInTheDocument();
    });

    it("支持引导动作节点", () => {
      render(
        <EmptyState action={<button type="button">去登记</button>} icon={Inbox} title="空" />,
      );
      expect(screen.getByRole("button", { name: "去登记" })).toBeInTheDocument();
    });
  });

  describe("ErrorState", () => {
    it("展示失败原因与重试入口", () => {
      const onRetry = vi.fn();
      render(<ErrorState message="无法连接到服务" onRetry={onRetry} />);
      expect(screen.getByRole("alert")).toHaveTextContent("无法连接到服务");
      const retryButton = screen.getByRole("button", { name: /重试/ });
      retryButton.click();
      expect(onRetry).toHaveBeenCalledTimes(1);
    });

    it("无重试回调时不渲染重试按钮", () => {
      render(<ErrorState message="加载失败" />);
      expect(screen.queryByRole("button")).toBeNull();
    });
  });
});
