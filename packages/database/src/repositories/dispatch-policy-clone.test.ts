import { describe, expect, it } from "vitest";

import { nextPolicyVersion } from "./dispatch-policy-clone.js";

describe("POOL20-037 调度策略版本分配", () => {
  it("从当前数字递增并跳过企业内已有版本", () => {
    expect(nextPolicyVersion("w16-v2", new Set(["w16-v3", "w16-v4"]))).toBe("w16-v5");
    expect(nextPolicyVersion("w16-v10", new Set())).toBe("w16-v11");
  });

  it("无数字后缀时使用稳定的 -v2 起点", () => {
    expect(nextPolicyVersion("peak", new Set())).toBe("peak-v2");
  });
});
