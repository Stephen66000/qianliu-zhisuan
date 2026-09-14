import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type {
  OperatingBillEmployeeRow,
  OperatingBillMetricTotals,
} from "../../api/operating-bill-accounts";
import { SubjectUsageCells, subjectUsageHeaders } from "./SubjectUsageCells";

const totals: OperatingBillMetricTotals = {
  inputTokens: "800",
  outputTokens: "100",
  cacheTokens: "50",
  reasoningTokens: "0",
  totalTokens: "900",
  deductedQuota: "999",
  apiCost: "12.50",
  packageAllocatedCost: "199",
  totalAllocatedCost: "211.50",
  activeDays: 3,
  requestCount: 7,
  lastUsedAt: "2026-09-02T01:00:00Z",
  usageQuality: "EXACT",
};
function show(providers: OperatingBillEmployeeRow["providers"]) {
  const row: OperatingBillEmployeeRow = {
    subjectId: "a",
    subjectName: "员工 A",
    isUnassigned: false,
    projectOwner: null,
    projectDepartments: [],
    totals,
    providers,
  };
  render(
    <table>
      <thead>
        <tr>
          {subjectUsageHeaders.map((label) => (
            <th key={label}>{label}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        <tr data-testid="subject">
          <SubjectUsageCells row={row} />
        </tr>
      </tbody>
    </table>,
  );
  return Object.fromEntries(
    Array.from(screen.getByTestId("subject").children).map((cell, i) => [
      subjectUsageHeaders[i],
      cell.textContent,
    ]),
  );
}

describe("主体账按厂商分列", () => {
  it("每列一个数，订阅列显示后端分配金额，不重复展示整份套餐价格", () => {
    const cells = show([
      {
        providerCode: "deepseek",
        providerName: "DeepSeek",
        totals: { ...totals, totalTokens: "100" },
      },
      {
        providerCode: "zhipu",
        providerName: "智谱",
        totals: {
          ...totals,
          totalTokens: "200",
          apiCost: "0",
          packageAllocatedCost: "79.60",
        },
      },
      {
        providerCode: "kimi",
        providerName: "Kimi",
        totals: {
          ...totals,
          totalTokens: "600",
          apiCost: "0",
          packageAllocatedCost: "119.40",
        },
      },
    ]);
    expect(cells).toMatchObject({
      "本月分配额度": "不限",
      "本月token使用量": "900",
      "token使用率": "—",
      "本月剩余额度": "不限",
      "输入 Token": "800",
      "输出 Token": "100",
      "缓存命中 Token": "50",
      "DeepSeek Token": "100",
      "DeepSeek API 消费": "¥12.50",
      "智谱 Token": "200",
      智谱订阅金额: "¥79.60",
      "Kimi Token": "600",
      "Kimi 订阅金额": "¥119.40",
      "API 消费合计": "¥12.50",
      活跃天数: "3",
      请求次数: "7",
    });
    expect(screen.queryByRole("columnheader", { name: "套餐分摊" })).toBeNull();
    expect(screen.queryByRole("columnheader", { name: "归集成本" })).toBeNull();
    expect(screen.queryByRole("columnheader", { name: "用量口径" })).toBeNull();
  });

  it("未使用厂商显示零，旧接口缺少厂商明细时保持未知", () => {
    const cells = show([{ providerCode: "kimi", providerName: "Kimi" }]);
    expect(cells["DeepSeek Token"]).toBe("0");
    expect(cells["DeepSeek API 消费"]).toBe("¥0.00");
    expect(cells["Kimi Token"]).toBe("未知");
    expect(cells["Kimi 订阅金额"]).toBe("未知");
  });
});
