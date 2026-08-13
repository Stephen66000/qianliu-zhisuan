import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { Sidebar } from "./Sidebar";

describe("Sidebar", () => {
  it("保留 1.0 的十个主导航入口", () => {
    render(
      <MemoryRouter initialEntries={["/employee-model-rules"]}>
        <Sidebar />
      </MemoryRouter>,
    );

    expect(screen.getByRole("img", { name: "仟流科技 Logo" })).toBeInTheDocument();
    expect(screen.getByText("仟流智算")).toBeInTheDocument();
    const entries = [
      ["首页看板", "/dashboard"],
      ["使用主体", "/principals"],
      ["批量模型授权", "/employee-model-rules"],
      ["厂商资源", "/resources"],
      ["额度规则", "/quota-rules"],
      ["用量账本", "/usage"],
      ["经营账单", "/operating-bill"],
      ["运行保障", "/runtime-assurance"],
      ["管理员", "/admins"],
      ["系统设置", "/settings"],
    ] as const;
    for (const [name, href] of entries) {
      expect(screen.getByRole("link", { name })).toHaveAttribute("href", href);
    }
  });
});
