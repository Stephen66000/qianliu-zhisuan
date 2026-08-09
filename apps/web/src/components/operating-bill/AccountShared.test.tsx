import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { OperatingBillMetricTotals } from "../../api/operating-bill-accounts";
import {
  AccountCell,
  AccountFilters,
  accountCount,
  accountMoney,
  accountPercentage,
  accountQuota,
  AccountTable,
  accountTime,
  MetricGrid,
  UsageQualityTag,
} from "./AccountShared";

describe("POOL-043 账单展示口径", () => {
  it("五类质量标签与精确、估算、未知值保持语义", () => {
    render(<div>
      <UsageQualityTag quality="EXACT" />
      <UsageQualityTag quality="ESTIMATED" />
      <UsageQualityTag quality="ACCOUNT_AGGREGATED" />
      <UsageQualityTag quality="MIXED" />
      <UsageQualityTag quality="UNKNOWN" />
    </div>);
    for (const label of ["精确用量", "估算用量", "账号汇总", "混合口径", "用量未知"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    expect(accountCount("1200", "EXACT")).toBe("1,200");
    expect(accountCount("1200", "ESTIMATED")).toBe("约 1,200");
    expect(accountCount("1200", "ACCOUNT_AGGREGATED")).toBe("约 1,200");
    expect(accountCount("1200", "MIXED")).toBe("约 1,200");
    expect(accountCount("1200", "UNKNOWN")).toBe("未知");
    expect(accountCount(null, "EXACT")).toBe("未知");
    expect(accountPercentage("60.00", "EXACT")).toBe("60.00%");
    expect(accountPercentage("40.00", "ESTIMATED")).toBe("约 40.00%");
    expect(accountPercentage("40.00", "ACCOUNT_AGGREGATED")).toBe("约 40.00%");
    expect(accountPercentage("40.00", "MIXED")).toBe("约 40.00%");
    expect(accountPercentage("40.00", "UNKNOWN")).toBe("—");
    expect(accountPercentage(null, "EXACT")).toBe("—");
    expect(accountMoney(null)).toBe("未知");
    expect(accountMoney("2.5")).toBe("¥2.50");
    expect(accountQuota(null)).toBe("未知");
    expect(accountQuota("1200")).toBe("1,200");
    expect(accountTime(null)).toBe("—");
    expect(accountTime("invalid-time")).toBe("invalid-time");
    expect(accountTime("2026-08-01T16:00:01.000Z")).toBe("2026-08-02 00:00:01");
  });

  it("指标网格不把 UNKNOWN/null 伪装为精确值", () => {
    const totals: OperatingBillMetricTotals = {
      inputTokens: null,
      outputTokens: null,
      cacheTokens: null,
      reasoningTokens: null,
      totalTokens: null,
      deductedQuota: null,
      apiCost: null,
      packageAllocatedCost: null,
      totalAllocatedCost: null,
      activeDays: 0,
      requestCount: 0,
      lastUsedAt: null,
      usageQuality: "UNKNOWN",
    };
    render(<MetricGrid totals={totals} />);
    expect(screen.getAllByText("未知")).toHaveLength(8);
    expect(screen.getByText("最近 —")).toBeInTheDocument();
  });

  it("筛选和表格组件透传真实交互与对齐语义", async () => {
    const user = userEvent.setup();
    const onProviderChange = vi.fn();
    const onSearchChange = vi.fn();
    render(<>
      <AccountFilters
        onProviderChange={onProviderChange}
        onSearchChange={onSearchChange}
        providerCode=""
        providers={[{ providerCode: "deepseek", providerName: "DeepSeek" }]}
        search=""
        searchLabel="搜索主体"
      />
      <AccountTable headers={["主体", "厂商", "Token"]}>
        <tr><AccountCell>于滔</AccountCell><AccountCell>DeepSeek</AccountCell><AccountCell numeric>100</AccountCell></tr>
      </AccountTable>
    </>);
    await user.selectOptions(screen.getByLabelText("厂商"), "deepseek");
    await user.type(screen.getByLabelText("搜索主体"), "于");
    expect(screen.getByLabelText("搜索主体")).toHaveAttribute("maxlength", "255");
    expect(onProviderChange).toHaveBeenCalledWith("deepseek");
    expect(onSearchChange).toHaveBeenCalledWith("于");
    expect(screen.getByRole("columnheader", { name: "Token" })).toHaveClass("text-right");
    expect(screen.getByText("100").closest("td")).toHaveClass("text-right");
  });
});
