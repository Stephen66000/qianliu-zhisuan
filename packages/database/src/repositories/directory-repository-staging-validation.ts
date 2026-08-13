import type { StageDirectoryItemInput } from "./directory-repository-types.js";

export const DIRECTORY_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function cleanDirectoryValue(value: string | null | undefined): string | null {
  const result = value?.trim();
  return result ? result : null;
}

export function directoryDuplicateKeys(
  items: StageDirectoryItemInput[], field: "employeeNumber" | "externalMemberId",
): Set<string> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const value = cleanDirectoryValue(item[field])?.toLocaleLowerCase("en-US");
    if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return new Set([...counts].filter(([, count]) => count > 1).map(([key]) => key));
}

export function directoryValidationReason(
  mode: "SYNC" | "EXCEL", item: StageDirectoryItemInput,
  duplicateEmployees: Set<string>, duplicateExternalIds: Set<string>,
): string | null {
  if (item.reasonCode) return item.reasonCode;
  if (!Number.isInteger(item.rowNumber) || item.rowNumber <= 0) return "INVALID_ROW_NUMBER";
  const name = cleanDirectoryValue(item.normalizedName);
  const department = cleanDirectoryValue(item.normalizedDepartmentPath);
  const employee = cleanDirectoryValue(item.employeeNumber);
  const external = cleanDirectoryValue(item.externalMemberId);
  const email = cleanDirectoryValue(item.normalizedEmail);
  const mobile = cleanDirectoryValue(item.normalizedMobile);
  const externalDepartment = cleanDirectoryValue(item.externalDepartmentId);
  const explicitPrincipal = cleanDirectoryValue(item.existingPrincipalId);
  if (!name) return "NAME_REQUIRED";
  if (name.length > 128) return "NAME_TOO_LONG";
  if (!department) return "DEPARTMENT_REQUIRED";
  if (department.length > 512) return "DEPARTMENT_PATH_TOO_LONG";
  if (mode === "EXCEL" && !employee) return "EMPLOYEE_NUMBER_REQUIRED";
  if (mode === "SYNC" && !external) return "EXTERNAL_MEMBER_ID_REQUIRED";
  if (employee && employee.length > 64) return "EMPLOYEE_NUMBER_TOO_LONG";
  if (external && external.length > 128) return "EXTERNAL_MEMBER_ID_TOO_LONG";
  if (email && email.length > 254) return "EMAIL_TOO_LONG";
  if (mobile && mobile.length > 32) return "MOBILE_TOO_LONG";
  if (externalDepartment && externalDepartment.length > 255) return "EXTERNAL_DEPARTMENT_ID_TOO_LONG";
  if (explicitPrincipal && !DIRECTORY_UUID_PATTERN.test(explicitPrincipal)) {
    return "EXPLICIT_PRINCIPAL_INVALID";
  }
  if (employee && duplicateEmployees.has(employee.toLocaleLowerCase("en-US"))) {
    return "DUPLICATE_EMPLOYEE_NUMBER";
  }
  if (external && duplicateExternalIds.has(external.toLocaleLowerCase("en-US"))) {
    return "DUPLICATE_EXTERNAL_MEMBER_ID";
  }
  return null;
}
