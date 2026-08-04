import { describe, expect, it } from "vitest";
import { classifyPermissionKeys, mergeDeclaredModelIds } from "./employee-model-authorization-policy.js";

describe("员工模型授权纯规则", () => {
  it("合并手工与受管模型并稳定去重排序", () => {
    expect(mergeDeclaredModelIds(["manual", "shared"], ["managed", "shared"]))
      .toEqual(["managed", "manual", "shared"]);
  });

  it("按发布前后最终集合区分新增、保留与真正撤销", () => {
    expect(classifyPermissionKeys({
      proposed: ["employee:new", "employee:shared"],
      before: ["employee:old", "employee:shared"],
      after: ["employee:new", "employee:shared"],
      previousRule: ["employee:old", "employee:shared"],
    })).toEqual({
      added: ["employee:new"],
      retained: ["employee:shared"],
      removed: ["employee:old"],
    });
  });

  it("手工或其他规则仍保留的旧目标不显示为撤销", () => {
    expect(classifyPermissionKeys({
      proposed: [],
      before: ["employee:shared"],
      after: ["employee:shared"],
      previousRule: ["employee:shared"],
    })).toEqual({ added: [], retained: [], removed: [] });
  });

  it("权限变更结果按稳定顺序输出，避免预览随数据库返回顺序抖动", () => {
    expect(classifyPermissionKeys({
      proposed: ["employee:z", "employee:a"],
      before: ["employee:y", "employee:b"],
      after: ["employee:z", "employee:a"],
      previousRule: ["employee:y", "employee:b"],
    })).toEqual({
      added: ["employee:a", "employee:z"],
      retained: [],
      removed: ["employee:b", "employee:y"],
    });
  });
});
