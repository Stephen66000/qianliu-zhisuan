import { describe, expect, it } from "vitest";

import { formatMoney } from "./format";

describe("POOL-019 金额展示", () => {
  it("固定两位、千分位并以十进制半入舍入", () => {
    expect(formatMoney("109.41000000")).toBe("109.41");
    expect(formatMoney("68.00000000")).toBe("68.00");
    expect(formatMoney("1234567890123456.995")).toBe("1,234,567,890,123,457.00");
  });

  it("无效值原样保留，不伪造为零", () => {
    expect(formatMoney("未知")).toBe("未知");
  });
});
