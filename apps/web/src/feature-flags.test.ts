import { describe, expect, it } from "vitest";
import { DEFAULT_FEATURE_FLAGS, DISABLED_FEATURE_FLAGS } from "./feature-flags";

describe("2.0 Feature Flag 默认值", () => {
  it("仅测试环境默认开启，缺少服务端值时可使用全关闭值", () => {
    expect(Object.values(DEFAULT_FEATURE_FLAGS)).toEqual([true, true, true, true, true]);
    expect(Object.values(DISABLED_FEATURE_FLAGS)).toEqual([false, false, false, false, false]);
  });
});
