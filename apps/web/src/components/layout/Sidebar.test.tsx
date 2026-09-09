import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { Sidebar } from "./Sidebar";
import { AccessContext } from "../../permissions";

describe("Sidebar", () => {
  it("批量授权收入使用主体，不再占用主导航", () => {
    render(
      <MemoryRouter initialEntries={["/employee-model-rules"]}>
        <AccessContext.Provider value={{ roleCode: "SUPER_ADMIN" }}><Sidebar /></AccessContext.Provider>
      </MemoryRouter>,
    );

    expect(screen.getByRole("img", { name: "仟流科技 Logo" })).toBeInTheDocument();
    expect(screen.getByText("仟流智算")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "返回首页看板" })).toHaveAttribute("href", "/dashboard");
    const entries = [
      ["首页看板", "/dashboard"],
      ["使用主体", "/principals"],
      ["厂商资源", "/resources"],
      ["额度规则", "/quota-rules"],
      ["用量账本", "/usage"],
      ["经营账单", "/operating-bill"],
      ["运行保障", "/runtime-assurance"],
      ["系统设置", "/settings"],
    ] as const;
    for (const [name, href] of entries) {
      expect(screen.getByRole("link", { name })).toHaveAttribute("href", href);
    }
    expect(screen.queryByRole("link", { name: "批量模型授权" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "管理员" })).not.toBeInTheDocument();
  });
  it("自定义成员只看得到已授权模块", () => {
    render(<MemoryRouter><AccessContext.Provider value={{ roleCode: "CUSTOM", permissions: { usage: { view: true, operate: false } } }}><Sidebar/></AccessContext.Provider></MemoryRouter>);
    expect(screen.getByRole("link", { name: "用量账本" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "厂商资源" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "系统设置" })).not.toBeInTheDocument();
  });
});
