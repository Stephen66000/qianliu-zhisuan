import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import {
  MoneyAmountInput,
  normalizeMoneyAmount,
  validateMoneyAmount,
} from "./MoneyAmountInput";

function Harness() {
  const [value, setValue] = useState("109.41");
  return <MoneyAmountInput id="money" onChange={setValue} value={value} />;
}

describe("POOL-019 金额输入", () => {
  it("空金额保持空白，不渲染占位小数", () => {
    render(<MoneyAmountInput id="money" onChange={vi.fn()} value="" />);
    expect(screen.getByRole("textbox")).toHaveValue("");
  });

  it("失焦固定两位并在只读态增加千分位，聚焦后保持可编辑原值", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const input = screen.getByRole("textbox");
    expect(input).toHaveValue("109.41");
    await user.click(input);
    await user.clear(input);
    await user.type(input, "1234.5");
    await user.tab();
    expect(input).toHaveValue("1,234.50");
    await user.click(input);
    expect(input).toHaveValue("1234.50");
  });

  it("明确拒绝三位小数和超范围金额，不静默截断", () => {
    expect(validateMoneyAmount("109.411")).toBe("请输入非负金额，最多保留两位小数");
    expect(validateMoneyAmount("10000000000000000.00")).toBe("金额超出系统可保存范围");
    expect(normalizeMoneyAmount("109.411")).toBe("109.411");
    expect(normalizeMoneyAmount("109")).toBe("109.00");
  });
});
