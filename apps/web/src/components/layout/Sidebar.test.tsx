import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { Sidebar } from "./Sidebar";

describe("Sidebar", () => {
  it("展示仟流科技 Logo 和产品名称", () => {
    render(
      <MemoryRouter>
        <Sidebar />
      </MemoryRouter>,
    );

    expect(screen.getByRole("img", { name: "仟流科技 Logo" })).toBeInTheDocument();
    expect(screen.getByText("仟流智算")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "运行保障" })).toHaveAttribute("href", "/runtime-assurance");
  });
});
