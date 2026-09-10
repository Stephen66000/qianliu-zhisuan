import { expect, it } from "vitest";
import { resourceModelNames } from "./ResourceTable";

it("只用显示列表隐藏存档型号，不修改登记列表", () => {
  const resource = { upstream_models: ["pro", "flash"], display_upstream_models: ["flash"] };
  expect(resourceModelNames(resource)).toBe("flash");
  expect(resource.upstream_models).toEqual(["pro", "flash"]);
});
it("全部存档时显示空状态，不回退到历史型号", () => {
  expect(resourceModelNames({ upstream_models: ["pro"], display_upstream_models: [] })).toBe("暂无未存档型号");
});
it("取消存档后重新显示型号", () => {
  expect(resourceModelNames({ upstream_models: ["pro", "flash"], display_upstream_models: ["pro", "flash"] })).toBe("pro、flash");
});
it("兼容旧接口没有显示字段的情况", () => {
  expect(resourceModelNames({ upstream_models: ["pro", "flash"] })).toBe("pro、flash");
});
it("未声明型号时保留原空状态", () => {
  expect(resourceModelNames({ upstream_models: null, display_upstream_models: null })).toBe("未声明模型");
});
