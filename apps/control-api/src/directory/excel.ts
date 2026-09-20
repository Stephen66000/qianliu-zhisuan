import { createHash } from "node:crypto";
import ExcelJS from "exceljs";
import { TEMPLATE_COLUMNS, TEMPLATE_SHEET, TEMPLATE_VERSION, type StagedDirectoryRow } from "./contracts.js";

export const MAX_EXCEL_BYTES = 5 * 1024 * 1024;
export const MAX_EXCEL_ROWS = 1000;
const MAX_ARCHIVE_ENTRIES = 256;
const MAX_ARCHIVE_UNCOMPRESSED_BYTES = 32 * 1024 * 1024;
const ZIP_EOCD_SIGNATURE = 0x06054b50;
const ZIP_CENTRAL_SIGNATURE = 0x02014b50;
const FORBIDDEN_ARCHIVE_PATHS = [
  "xl/vbaproject", "xl/macrosheets/", "xl/dialogsheets/", "xl/activex/",
  "xl/embeddings/", "xl/externallinks/", "customui/", "connections.xml",
] as const;

export class DirectoryExcelError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = "DirectoryExcelError"; }
}

export async function buildDirectoryTemplate(): Promise<{ bytes: Buffer; sha256: string }> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "仟流智算"; workbook.created = new Date(0); workbook.modified = new Date(0);
  const sheet = workbook.addWorksheet(TEMPLATE_SHEET, { views: [{ state: "frozen", ySplit: 1 }] });
  sheet.columns = TEMPLATE_COLUMNS.map((header) => ({ header, key: header, width: header === "department_path" ? 28 : 22 }));
  sheet.getRow(1).font = { bold: true };
  sheet.addRow({ template_version: TEMPLATE_VERSION, name: "示例员工", employee_number: "E0001", department_path: "总部/研发部", email: "", mobile: "", existing_principal_id: "" });
  const bytes = Buffer.from(await workbook.xlsx.writeBuffer());
  return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
}

export async function parseDirectoryExcel(bytes: Buffer): Promise<StagedDirectoryRow[]> {
  if (bytes.length > MAX_EXCEL_BYTES) throw new DirectoryExcelError("FILE_TOO_LARGE", "Excel 文件不得超过 5 MiB");
  if (!bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) throw new DirectoryExcelError("INVALID_XLSX", "只接受标准 .xlsx 文件");
  inspectArchive(bytes);
  const workbook = new ExcelJS.Workbook();
  try { await workbook.xlsx.load(bytes as unknown as ExcelJS.Buffer); } catch { throw new DirectoryExcelError("INVALID_XLSX", "Excel 文件无法解析"); }
  if (workbook.worksheets.length !== 1 || workbook.worksheets[0]?.name !== TEMPLATE_SHEET) throw new DirectoryExcelError("INVALID_WORKBOOK", `只允许工作表「${TEMPLATE_SHEET}」`);
  const externalLinks = (workbook.model as unknown as { externalLinks?: unknown[] }).externalLinks;
  if (externalLinks?.length) throw new DirectoryExcelError("EXTERNAL_LINK", "模板不允许外部链接");
  const sheet = workbook.worksheets[0]!;
  if (sheet.state !== "visible") throw new DirectoryExcelError("HIDDEN_CONTENT", "模板工作表必须可见");
  const headers = sheet.getRow(1).values as unknown[];
  const actual = TEMPLATE_COLUMNS.map((_, index) => text(headers[index + 1]));
  if (actual.some((value, index) => value !== TEMPLATE_COLUMNS[index])) throw new DirectoryExcelError("INVALID_COLUMNS", "Excel 表头与固定模板不一致");
  if (Math.max(0, sheet.actualRowCount - 1) > MAX_EXCEL_ROWS) throw new DirectoryExcelError("TOO_MANY_ROWS", "Excel 最多 1,000 行");
  const rows: StagedDirectoryRow[] = [];
  sheet.eachRow((row, number) => {
    if (number === 1) return;
    try {
      const values = TEMPLATE_COLUMNS.map((_, index) => cellText(row.getCell(index + 1)));
      if (values.every((value) => value === "")) return;
      if (values[0] !== TEMPLATE_VERSION) throw new DirectoryExcelError("INVALID_TEMPLATE_VERSION", `第 ${number} 行模板版本不正确`);
      const name = safeText(values[1]!, 128, "姓名", number, true);
      const departmentPath = validDepartmentPath(safeText(values[3]!, 512, "部门路径", number, true), number);
      const principalId = empty(values[6]);
      if (principalId && !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(principalId)) throw new DirectoryExcelError("INVALID_PRINCIPAL_ID", `第 ${number} 行主体 ID 无效`);
      rows.push({ rowNumber: number, name, employeeNumber: empty(safeText(values[2]!, 64, "员工编号", number)), departmentPath, email: empty(safeText(values[4]!, 254, "邮箱", number)), mobile: empty(safeText(values[5]!, 32, "手机号", number)), existingPrincipalId: principalId, reasonCode: null });
    } catch (error) {
      if (!(error instanceof DirectoryExcelError)) throw error;
      rows.push({
        rowNumber: number, name: null, employeeNumber: null, departmentPath: null,
        email: null, mobile: null, existingPrincipalId: null, reasonCode: error.code,
      });
    }
  });
  return rows;
}

/**
 * C 方式开通名单：任意工作表名，读取首列非空单元格作为标识（工号/企微账号/姓名）。
 * 与模板解析共用压缩包安全检查；不允许公式与富文本单元格。
 * 首行为常见表头词（工号/姓名/企微账号等）时视为表头跳过，不计入标识与容量。
 */
const ACTIVATION_LIST_HEADER_VALUES = new Set([
  "工号", "员工编号", "员工号", "编号", "序号", "姓名", "名字", "名称",
  "企微账号", "企业微信账号", "企微id", "企微userid", "wecomid", "wecomuserid",
  "userid", "user_id", "user", "account", "账号", "id", "no",
  "手机号", "手机", "电话", "mobile", "email", "邮箱",
]);

function isActivationListHeader(value: string): boolean {
  return ACTIVATION_LIST_HEADER_VALUES.has(value.trim().toLowerCase().replaceAll(/\s+/g, ""));
}

export async function parseActivationListExcel(bytes: Buffer): Promise<string[]> {
  if (bytes.length > MAX_EXCEL_BYTES) throw new DirectoryExcelError("FILE_TOO_LARGE", "Excel 文件不得超过 5 MiB");
  if (!bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) throw new DirectoryExcelError("INVALID_XLSX", "只接受标准 .xlsx 文件");
  inspectArchive(bytes);
  const workbook = new ExcelJS.Workbook();
  try { await workbook.xlsx.load(bytes as unknown as ExcelJS.Buffer); } catch { throw new DirectoryExcelError("INVALID_XLSX", "Excel 文件无法解析"); }
  const externalLinks = (workbook.model as unknown as { externalLinks?: unknown[] }).externalLinks;
  if (externalLinks?.length) throw new DirectoryExcelError("EXTERNAL_LINK", "名单不允许外部链接");
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new DirectoryExcelError("INVALID_WORKBOOK", "名单文件没有工作表");
  if (sheet.state !== "visible") throw new DirectoryExcelError("HIDDEN_CONTENT", "名单工作表必须可见");
  const identifiers: string[] = [];
  sheet.eachRow((row, number) => {
    const value = safeText(cellText(row.getCell(1)), 128, "名单标识", number);
    if (!value) return;
    if (number === 1 && isActivationListHeader(value)) return;
    if (!identifiers.includes(value)) identifiers.push(value);
    if (identifiers.length > MAX_EXCEL_ROWS) throw new DirectoryExcelError("TOO_MANY_ROWS", "名单最多 1,000 个标识");
  });
  return identifiers;
}

/** 在 ExcelJS 解压前限制 ZIP 容量，并拒绝 .xlsx 不应出现的可执行／外链部件。 */
function inspectArchive(bytes: Buffer): void {
  try {
    const minimum = Math.max(0, bytes.length - 65_557);
    let eocd = -1;
    for (let offset = bytes.length - 22; offset >= minimum; offset -= 1) {
      if (bytes.readUInt32LE(offset) === ZIP_EOCD_SIGNATURE) { eocd = offset; break; }
    }
    if (eocd < 0) throw new DirectoryExcelError("INVALID_XLSX", "Excel 压缩包结构无效");
    const disk = bytes.readUInt16LE(eocd + 4);
    const centralDisk = bytes.readUInt16LE(eocd + 6);
    const diskEntries = bytes.readUInt16LE(eocd + 8);
    const entries = bytes.readUInt16LE(eocd + 10);
    const centralSize = bytes.readUInt32LE(eocd + 12);
    const centralOffset = bytes.readUInt32LE(eocd + 16);
    if (disk !== 0 || centralDisk !== 0 || diskEntries !== entries || entries > MAX_ARCHIVE_ENTRIES) {
      throw new DirectoryExcelError("ZIP_BOMB", "Excel 压缩包超出安全限制");
    }
    if (centralOffset + centralSize > eocd) throw new DirectoryExcelError("INVALID_XLSX", "Excel 压缩包索引无效");
    let pointer = centralOffset;
    let totalUncompressed = 0;
    for (let index = 0; index < entries; index += 1) {
      if (pointer + 46 > eocd || bytes.readUInt32LE(pointer) !== ZIP_CENTRAL_SIGNATURE) {
        throw new DirectoryExcelError("INVALID_XLSX", "Excel 压缩包索引无效");
      }
      const flags = bytes.readUInt16LE(pointer + 8);
      const method = bytes.readUInt16LE(pointer + 10);
      const compressed = bytes.readUInt32LE(pointer + 20);
      const uncompressed = bytes.readUInt32LE(pointer + 24);
      const nameLength = bytes.readUInt16LE(pointer + 28);
      const extraLength = bytes.readUInt16LE(pointer + 30);
      const commentLength = bytes.readUInt16LE(pointer + 32);
      const next = pointer + 46 + nameLength + extraLength + commentLength;
      if (next > eocd || compressed === 0xffff_ffff || uncompressed === 0xffff_ffff || (flags & 1) !== 0 || ![0, 8].includes(method)) {
        throw new DirectoryExcelError("INVALID_XLSX", "Excel 压缩包包含不支持的条目");
      }
      totalUncompressed += uncompressed;
      if (totalUncompressed > MAX_ARCHIVE_UNCOMPRESSED_BYTES) {
        throw new DirectoryExcelError("ZIP_BOMB", "Excel 解压后体积超出 32 MiB");
      }
      const name = bytes.subarray(pointer + 46, pointer + 46 + nameLength).toString("utf8").replaceAll("\\", "/").toLocaleLowerCase("en-US");
      if (name.startsWith("../") || name.includes("/../")) throw new DirectoryExcelError("INVALID_XLSX", "Excel 压缩包路径无效");
      const forbidden = FORBIDDEN_ARCHIVE_PATHS.find((part) => name.includes(part));
      if (forbidden) {
        const code = forbidden === "xl/externallinks/" || forbidden === "connections.xml" ? "EXTERNAL_LINK" : "MACRO_NOT_ALLOWED";
        throw new DirectoryExcelError(code, code === "EXTERNAL_LINK" ? "模板不允许外部链接" : "模板不允许宏或嵌入执行内容");
      }
      pointer = next;
    }
    if (pointer !== centralOffset + centralSize) throw new DirectoryExcelError("INVALID_XLSX", "Excel 压缩包索引无效");
  } catch (error) {
    if (error instanceof DirectoryExcelError) throw error;
    throw new DirectoryExcelError("INVALID_XLSX", "Excel 压缩包结构无效");
  }
}

function cellText(cell: ExcelJS.Cell): string {
  if (cell.formula || cell.type === ExcelJS.ValueType.Formula) throw new DirectoryExcelError("FORMULA_NOT_ALLOWED", `第 ${cell.row} 行不允许公式`);
  const value = cell.value;
  if (value === null || value === undefined) return "";
  if (typeof value === "object") throw new DirectoryExcelError("RICH_VALUE_NOT_ALLOWED", `第 ${cell.row} 行包含不支持的单元格类型`);
  return String(value).trim();
}
function text(value: unknown): string { return value === undefined || value === null ? "" : String(value).trim(); }
function empty(value: string | undefined): string | null { return value?.trim() ? value.trim() : null; }
function bounded(value: string, max: number, label: string, row: number, required = false): string { const result = value.trim(); if (required && !result) throw new DirectoryExcelError("REQUIRED_FIELD", `第 ${row} 行${label}不能为空`); if (result.length > max) throw new DirectoryExcelError("FIELD_TOO_LONG", `第 ${row} 行${label}过长`); return result; }
function safeText(value: string, max: number, label: string, row: number, required = false): string {
  const result = bounded(value, max, label, row, required);
  if (/[\u0000-\u001f\u007f]/u.test(result)) throw new DirectoryExcelError("INVALID_CHARACTER", `第 ${row} 行${label}包含非法字符`);
  return result;
}
function validDepartmentPath(value: string, row: number): string {
  const segments = value.split("/");
  if (segments.some((segment) => !segment.trim() || segment.trim().length > 128 || segment === "." || segment === "..")) {
    throw new DirectoryExcelError("INVALID_DEPARTMENT_PATH", `第 ${row} 行部门路径无效`);
  }
  return segments.map((segment) => segment.trim()).join("/");
}
