import { z } from "zod";

export const SourceType = z.enum(["WECOM", "FEISHU"]);
export const SaveSourceBody = z.object({
  expected_version: z.number().int().nonnegative(),
  status: z.enum(["ACTIVE", "DISABLED"]).default("ACTIVE"),
  config: z.record(z.string(), z.string().min(1).max(512)),
}).superRefine((value, context) => {
  const required = "corp_id" in value.config ? ["corp_id", "corp_secret"] : ["app_id", "app_secret"];
  for (const key of required) if (!value.config[key]) context.addIssue({ code: "custom", path: ["config", key], message: `${key} 不能为空` });
});

export const MemberQuery = z.object({
  search: z.string().trim().max(128).optional(),
  department_id: z.string().uuid().optional(),
  status: z.enum(["ACTIVE", "DISABLED"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

export const RunItemsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

export const TEMPLATE_VERSION = "QL-DIRECTORY-V1";
export const TEMPLATE_SHEET = "通讯录";
export const TEMPLATE_COLUMNS = [
  "template_version", "name", "employee_number", "department_path",
  "email", "mobile", "existing_principal_id",
] as const;

export interface StagedDirectoryRow {
  rowNumber: number;
  name: string | null;
  employeeNumber: string | null;
  departmentPath: string | null;
  email: string | null;
  mobile: string | null;
  existingPrincipalId: string | null;
  reasonCode: string | null;
}
