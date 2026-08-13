import { describe, expect, it } from "vitest";
import { buildDirectoryTemplate, parseDirectoryExcel } from "../directory/excel.js";
import type { DirectoryExcelError } from "../directory/excel.js";
import { budgetState } from "../department-costs/contracts.js";

describe("W20-02 固定 Excel 模板", () => {
  it("生成的模板可按固定合同解析，且带稳定摘要", async () => {
    const template = await buildDirectoryTemplate();
    expect(template.sha256).toMatch(/^[0-9a-f]{64}$/);
    const rows = await parseDirectoryExcel(template.bytes);
    expect(rows).toEqual([{ rowNumber: 2, name: "示例员工", employeeNumber: "E0001", departmentPath: "总部/研发部", email: null, mobile: null, existingPrincipalId: null, reasonCode: null }]);
  });

  it("拒绝非 xlsx 内容", async () => {
    await expect(parseDirectoryExcel(Buffer.from("not-xlsx"))).rejects.toEqual(
      expect.objectContaining<Partial<DirectoryExcelError>>({ code: "INVALID_XLSX" }),
    );
  });
});

describe("W20-06 部门预算边界", () => {
  it.each([
    ["10", null, null, "NOT_SET"],
    ["0", "0", "0.8", "NOT_SET"],
    ["79.99", "100", "0.8", "NORMAL"],
    ["80", "100", "0.8", "WARNING"],
    ["99.99", "100", "0.8", "WARNING"],
    ["100", "100", "0.8", "OVER_BUDGET"],
    ["120", "100", "0.8", "OVER_BUDGET"],
  ])("cost=%s amount=%s -> %s", (cost, amount, threshold, expected) => {
    expect(budgetState(cost, amount, threshold).status).toBe(expected);
  });
});
