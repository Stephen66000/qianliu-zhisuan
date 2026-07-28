// W18 前端测试全局设置：jest-dom 断言扩展 + 每个用例后卸载组件（globals: false 时需手动注册）。
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => {
  cleanup();
});
