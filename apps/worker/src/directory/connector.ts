import { createHash } from "node:crypto";
import type { StageDirectoryItemInput } from "@qianliu/database";

export type DirectoryProvider = "WECOM" | "FEISHU";

export type DirectoryConnectorErrorCode =
  | "DIRECTORY_CONFIG_INVALID"
  | "DIRECTORY_CREDENTIAL_DECRYPT_FAILED"
  | "DIRECTORY_DEPARTMENT_LIMIT_EXCEEDED"
  | "DIRECTORY_MEMBER_LIMIT_EXCEEDED"
  | "WECOM_CREDENTIAL_INVALID"
  | "WECOM_SCOPE_DENIED"
  | "WECOM_RATE_LIMITED"
  | "WECOM_UPSTREAM_UNAVAILABLE"
  | "WECOM_PROTOCOL_ERROR"
  | "WECOM_REQUEST_REJECTED"
  | "FEISHU_CREDENTIAL_INVALID"
  | "FEISHU_SCOPE_DENIED"
  | "FEISHU_RATE_LIMITED"
  | "FEISHU_UPSTREAM_UNAVAILABLE"
  | "FEISHU_PROTOCOL_ERROR"
  | "FEISHU_REQUEST_REJECTED";

export class DirectoryConnectorError extends Error {
  constructor(
    readonly code: DirectoryConnectorErrorCode,
    readonly retryable: boolean,
  ) {
    super(code);
    this.name = "DirectoryConnectorError";
  }
}

export interface ExternalDirectoryDepartment {
  id: string;
  parentId: string | null;
  name: string;
}

export interface ExternalDirectoryMember {
  id: string;
  name: string;
  employeeNumber: string | null;
  departmentIds: string[];
  primaryDepartmentId: string | null;
  email: string | null;
  mobile: string | null;
  active: boolean;
}

export interface DirectorySnapshot {
  provider: DirectoryProvider;
  snapshotId: string;
  cursor: string;
  sourceDataAt: Date;
  unchanged: boolean;
  items: StageDirectoryItemInput[];
}

export interface DirectoryConnector {
  readonly provider: DirectoryProvider;
  pull(config: unknown, previousCursor: string | null): Promise<DirectorySnapshot>;
}

const MEMBER_LIMIT = 1_000;

function clean(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function mergeMembers(members: ExternalDirectoryMember[]): ExternalDirectoryMember[] {
  const merged = new Map<string, ExternalDirectoryMember>();
  for (const member of members) {
    const id = clean(member.id);
    if (!id) continue;
    const current = merged.get(id);
    if (!current) {
      merged.set(id, {
        ...member,
        id,
        departmentIds: [...new Set(member.departmentIds.map(clean).filter((item): item is string => item !== null))],
      });
      continue;
    }
    current.departmentIds = [...new Set([...current.departmentIds, ...member.departmentIds])];
    current.primaryDepartmentId ??= member.primaryDepartmentId;
    current.employeeNumber ??= member.employeeNumber;
    current.email ??= member.email;
    current.mobile ??= member.mobile;
    current.active ||= member.active;
  }
  return [...merged.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function resolveDepartmentPath(
  id: string,
  departments: Map<string, ExternalDirectoryDepartment>,
  memo: Map<string, string | null>,
  visiting = new Set<string>(),
): string | null {
  if (memo.has(id)) return memo.get(id) ?? null;
  const department = departments.get(id);
  if (!department || visiting.has(id) || department.name.includes("/")) {
    memo.set(id, null);
    return null;
  }
  visiting.add(id);
  const parentId = clean(department.parentId);
  if (parentId === id) {
    visiting.delete(id);
    memo.set(id, null);
    return null;
  }
  const parentPath = parentId && parentId !== id
    ? resolveDepartmentPath(parentId, departments, memo, visiting)
    : "";
  visiting.delete(id);
  if (parentId && parentPath === null) {
    memo.set(id, null);
    return null;
  }
  const path = parentPath ? `${parentPath}/${department.name.trim()}` : department.name.trim();
  memo.set(id, path || null);
  return path || null;
}

function rowReason(member: ExternalDirectoryMember, departmentId: string | null, path: string | null): string | null {
  if (!clean(member.id)) return "EXTERNAL_MEMBER_ID_REQUIRED";
  if (member.id.length > 128) return "EXTERNAL_MEMBER_ID_TOO_LONG";
  if (member.employeeNumber && member.employeeNumber.length > 64) return "EMPLOYEE_NUMBER_TOO_LONG";
  if (member.email && member.email.length > 254) return "EMAIL_TOO_LONG";
  if (member.mobile && member.mobile.length > 32) return "MOBILE_TOO_LONG";
  if (!departmentId) return "DEPARTMENT_REQUIRED";
  if (departmentId.length > 255) return "EXTERNAL_DEPARTMENT_ID_TOO_LONG";
  if (!path) return "DEPARTMENT_NOT_FOUND";
  return null;
}

export function buildDirectorySnapshot(input: {
  provider: DirectoryProvider;
  previousCursor: string | null;
  departments: ExternalDirectoryDepartment[];
  members: ExternalDirectoryMember[];
  sourceDataAt?: Date;
}): DirectorySnapshot {
  const activeMembers = mergeMembers(input.members).filter((member) => member.active);
  if (activeMembers.length > MEMBER_LIMIT) {
    throw new DirectoryConnectorError("DIRECTORY_MEMBER_LIMIT_EXCEEDED", false);
  }
  const departments = new Map<string, ExternalDirectoryDepartment>();
  for (const department of input.departments) {
    const id = clean(department.id);
    const name = clean(department.name);
    if (id && name && !departments.has(id)) {
      departments.set(id, { id, name, parentId: clean(department.parentId) });
    }
  }
  const pathMemo = new Map<string, string | null>();
  const items = activeMembers.map((member, index): StageDirectoryItemInput => {
    const primary = clean(member.primaryDepartmentId)
      ?? member.departmentIds.map(clean).find((id): id is string => id !== null)
      ?? null;
    const path = primary ? resolveDepartmentPath(primary, departments, pathMemo) : null;
    return {
      rowNumber: index + 1,
      externalMemberId: clean(member.id),
      employeeNumber: clean(member.employeeNumber),
      normalizedName: clean(member.name),
      normalizedDepartmentPath: path,
      externalDepartmentId: primary,
      normalizedEmail: clean(member.email),
      normalizedMobile: clean(member.mobile),
      reasonCode: rowReason(member, primary, path),
    };
  });
  const canonical = JSON.stringify({
    departments: [...departments.values()]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map(({ id, parentId, name }) => [id, parentId, name]),
    members: activeMembers.map((member) => [
      member.id,
      member.name,
      member.employeeNumber,
      [...member.departmentIds].sort(),
      member.primaryDepartmentId,
      member.email,
      member.mobile,
    ]),
  });
  const digest = createHash("sha256").update(canonical).digest("hex");
  const cursor = `${input.provider.toLowerCase()}:${digest}`;
  return {
    provider: input.provider,
    snapshotId: cursor,
    cursor,
    sourceDataAt: input.sourceDataAt ?? new Date(),
    unchanged: input.previousCursor === cursor,
    items,
  };
}

export function isRetryableHttpStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

export async function readBoundedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > 5 * 1024 * 1024) {
    throw new Error("DIRECTORY_RESPONSE_TOO_LARGE");
  }
  const text = await response.text();
  if (text.length > 5 * 1024 * 1024) throw new Error("DIRECTORY_RESPONSE_TOO_LARGE");
  return JSON.parse(text) as unknown;
}
