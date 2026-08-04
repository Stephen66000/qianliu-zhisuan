import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";

import {
  IntegerAmountInput,
  POSTGRES_BIGINT_MAX,
  formatIntegerAmountInput,
  normalizeIntegerAmountInput,
  validateIntegerAmount,
} from "./IntegerAmountInput";

function Harness() {
  const [value, setValue] = useState("");
  return <IntegerAmountInput id="quota" onChange={setValue} value={value} />;
}

describe("IntegerAmountInput", () => {
  it("键入与粘贴后显示千分位但保留原始整数值", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const input = screen.getByRole("textbox") as HTMLInputElement;
    await user.type(input, "30000000");
    expect(input).toHaveValue("30,000,000");
    await user.clear(input);
    await user.paste("9,223,372,036,854,775,807");
    expect(input).toHaveValue("9,223,372,036,854,775,807");
  });

  it("使用字符串校验非法格式与数据库边界", () => {
    expect(normalizeIntegerAmountInput("30,000,000")).toBe("30000000");
    expect(formatIntegerAmountInput("30000000")).toBe("30,000,000");
    expect(validateIntegerAmount("-1", POSTGRES_BIGINT_MAX)).toMatch(/非负整数/);
    expect(validateIntegerAmount("1.2", POSTGRES_BIGINT_MAX)).toMatch(/非负整数/);
    expect(validateIntegerAmount("12,,000", POSTGRES_BIGINT_MAX)).toMatch(/非负整数/);
    expect(validateIntegerAmount("9223372036854775808", POSTGRES_BIGINT_MAX)).toMatch(/不能超过/);
    expect(validateIntegerAmount(POSTGRES_BIGINT_MAX, POSTGRES_BIGINT_MAX)).toBeNull();
  });
});
