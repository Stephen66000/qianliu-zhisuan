import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";

import { TEMPLATE_COLUMNS, TEMPLATE_SHEET, TEMPLATE_VERSION } from "./contracts.js";
import {
  buildDirectoryTemplate,
  DirectoryExcelError,
  MAX_EXCEL_BYTES,
  MAX_EXCEL_ROWS,
  parseDirectoryExcel,
} from "./excel.js";

async function workbookBytes(
  rows: Array<Array<string | { formula: string; result: string }>>,
  state: "visible" | "hidden" = "visible",
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(TEMPLATE_SHEET, { state });
  sheet.addRow([...TEMPLATE_COLUMNS]);
  rows.forEach((row) => sheet.addRow(row));
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function unsafeArchiveEntry(name: string, uncompressed = 0): Buffer {
  const encodedName = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 8);
  local.writeUInt32LE(uncompressed, 22);
  local.writeUInt16LE(encodedName.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 10);
  central.writeUInt32LE(uncompressed, 24);
  central.writeUInt16LE(encodedName.length, 28);
  const centralOffset = local.length + encodedName.length;
  const centralSize = central.length + encodedName.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([local, encodedName, central, encodedName, eocd]);
}

function code(error: unknown): string | undefined {
  return error instanceof DirectoryExcelError ? error.code : undefined;
}

describe("W20-02 Excel 安全与行级验证", () => {
  it("依赖覆盖后仍可生成并回读需要 UUID 的条件格式", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("uuid-smoke");
    sheet.addRows([[1], [2]]);
    sheet.addConditionalFormatting({
      ref: "A1:A2",
      rules: [{
        type: "dataBar",
        priority: 1,
        gradient: false,
        cfvo: [{ type: "min" }, { type: "max" }],
      }],
    });

    const bytes = Buffer.from(await workbook.xlsx.writeBuffer());
    expect(bytes.byteLength).toBeGreaterThan(0);
    const reloaded = new ExcelJS.Workbook();
    await expect(reloaded.xlsx.load(bytes as unknown as ExcelJS.Buffer)).resolves.toBeDefined();
    expect(reloaded.getWorksheet("uuid-smoke")?.getCell("A2").value).toBe(2);
  });

  it("固定模板可回读，1,000 行边界可用且 1,001 行稳定拒绝", async () => {
    const template = await buildDirectoryTemplate();
    await expect(parseDirectoryExcel(template.bytes)).resolves.toHaveLength(1);

    const rows = Array.from({ length: MAX_EXCEL_ROWS }, (_, index) => [
      TEMPLATE_VERSION, `员工${index}`, `E-${index}`, "总部/研发部", "", "", "",
    ]);
    await expect(parseDirectoryExcel(await workbookBytes(rows))).resolves.toHaveLength(MAX_EXCEL_ROWS);
    await expect(parseDirectoryExcel(await workbookBytes([...rows, [
      TEMPLATE_VERSION, "超限员工", "E-X", "总部/研发部", "", "", "",
    ]]))).rejects.toSatisfy((error: unknown) => code(error) === "TOO_MANY_ROWS");
  }, 30_000);

  it("5 MiB 上限在解析前稳定拒绝", async () => {
    await expect(parseDirectoryExcel(Buffer.alloc(MAX_EXCEL_BYTES)))
      .rejects.toSatisfy((error: unknown) => code(error) === "INVALID_XLSX");
    await expect(parseDirectoryExcel(Buffer.alloc(MAX_EXCEL_BYTES + 1)))
      .rejects.toSatisfy((error: unknown) => code(error) === "FILE_TOO_LARGE");
  });

  it("拒绝伪装文件、错误工作表和错误表头", async () => {
    await expect(parseDirectoryExcel(Buffer.from("not-xlsx")))
      .rejects.toSatisfy((error: unknown) => code(error) === "INVALID_XLSX");

    const wrongSheet = new ExcelJS.Workbook();
    wrongSheet.addWorksheet("错误工作表").addRow([...TEMPLATE_COLUMNS]);
    await expect(parseDirectoryExcel(Buffer.from(await wrongSheet.xlsx.writeBuffer())))
      .rejects.toSatisfy((error: unknown) => code(error) === "INVALID_WORKBOOK");

    const wrongColumns = new ExcelJS.Workbook();
    wrongColumns.addWorksheet(TEMPLATE_SHEET).addRow(["wrong", ...TEMPLATE_COLUMNS.slice(1)]);
    await expect(parseDirectoryExcel(Buffer.from(await wrongColumns.xlsx.writeBuffer())))
      .rejects.toSatisfy((error: unknown) => code(error) === "INVALID_COLUMNS");

  });

  it("公式、必填缺失和非法部门只标记对应行，正常行仍可 staging", async () => {
    const bytes = await workbookBytes([
      [TEMPLATE_VERSION, "正常员工", "E-1", "总部/研发", "", "", ""],
      [TEMPLATE_VERSION, { formula: "1+1", result: "2" }, "E-2", "总部/研发", "", "", ""],
      [TEMPLATE_VERSION, "", "E-3", "总部/研发", "", "", ""],
      [TEMPLATE_VERSION, "部门错误", "E-4", "总部//研发", "", "", ""],
    ]);
    const rows = await parseDirectoryExcel(bytes);
    expect(rows.map((row) => row.reasonCode)).toEqual([
      null, "FORMULA_NOT_ALLOWED", "REQUIRED_FIELD", "INVALID_DEPARTMENT_PATH",
    ]);
  });

  it.each([
    ["xl/vbaProject.bin", "MACRO_NOT_ALLOWED"],
    ["xl/externalLinks/externalLink1.xml", "EXTERNAL_LINK"],
    ["xl/worksheets/sheet1.xml", "ZIP_BOMB", 33 * 1024 * 1024],
  ])("压缩包条目 %s 拒绝为 %s", async (entry, expected, uncompressed = 0) => {
    await expect(parseDirectoryExcel(unsafeArchiveEntry(entry, uncompressed)))
      .rejects.toSatisfy((error: unknown) => code(error) === expected);
  });

  it("拒绝隐藏工作表", async () => {
    const bytes = await workbookBytes([
      [TEMPLATE_VERSION, "员工", "E-1", "总部", "", "", ""],
    ], "hidden");
    await expect(parseDirectoryExcel(bytes)).rejects.toSatisfy((error: unknown) => code(error) === "HIDDEN_CONTENT");
  });
});
