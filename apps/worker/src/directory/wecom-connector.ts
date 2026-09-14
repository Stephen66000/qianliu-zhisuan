import { z } from "zod";
import {
  buildDirectorySnapshot,
  DirectoryConnectorError,
  isRetryableHttpStatus,
  readBoundedJson,
  type DirectoryConnector,
  type DirectorySnapshot,
  type ExternalDirectoryDepartment,
  type ExternalDirectoryMember,
} from "./connector.js";
import { WECOM_API_ORIGIN } from "@qianliu/config";

const WECOM_ORIGIN = WECOM_API_ORIGIN;
const REQUEST_TIMEOUT_MS = 10_000;

const WecomConfig = z.object({
  corp_id: z.string().trim().min(1).max(256),
  corp_secret: z.string().min(1).max(2_048),
  employee_number_attr: z.string().trim().min(1).max(128).optional(),
});

interface WecomPayload {
  errcode?: unknown;
  access_token?: unknown;
  department?: unknown;
  userlist?: unknown;
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
}

function text(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function classifyWecom(code: number, tokenRequest: boolean): DirectoryConnectorError {
  if (code === 45009) return new DirectoryConnectorError("WECOM_RATE_LIMITED", true);
  if ([-1, 40014, 42001].includes(code)) {
    return new DirectoryConnectorError("WECOM_UPSTREAM_UNAVAILABLE", true);
  }
  if (tokenRequest || [40001, 40013].includes(code)) {
    return new DirectoryConnectorError("WECOM_CREDENTIAL_INVALID", false);
  }
  if ([48002, 60011, 60020, 60021].includes(code)) {
    return new DirectoryConnectorError("WECOM_SCOPE_DENIED", false);
  }
  return new DirectoryConnectorError("WECOM_REQUEST_REJECTED", false);
}

function employeeNumber(row: Record<string, unknown>, attributeName: string | undefined): string | null {
  if (!attributeName) return null;
  const extattr = object(row.extattr);
  if (!Array.isArray(extattr?.attrs)) return null;
  for (const value of extattr.attrs) {
    const attribute = object(value);
    if (text(attribute?.name) === attributeName) {
      return text(attribute?.value) ?? text(object(attribute?.text)?.value);
    }
  }
  return null;
}

export class WecomDirectoryConnector implements DirectoryConnector {
  readonly provider = "WECOM" as const;

  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async pull(configValue: unknown, previousCursor: string | null): Promise<DirectorySnapshot> {
    const parsed = WecomConfig.safeParse(configValue);
    if (!parsed.success) throw new DirectoryConnectorError("DIRECTORY_CONFIG_INVALID", false);
    const tokenUrl = new URL("/cgi-bin/gettoken", WECOM_ORIGIN);
    tokenUrl.searchParams.set("corpid", parsed.data.corp_id);
    tokenUrl.searchParams.set("corpsecret", parsed.data.corp_secret);
    const tokenPayload = await this.request(tokenUrl, { method: "GET" }, true);
    const token = text(tokenPayload.access_token);
    if (!token) throw new DirectoryConnectorError("WECOM_PROTOCOL_ERROR", true);

    const departmentUrl = new URL("/cgi-bin/department/list", WECOM_ORIGIN);
    departmentUrl.searchParams.set("access_token", token);
    const departmentPayload = await this.request(departmentUrl, { method: "GET" }, false);
    const memberUrl = new URL("/cgi-bin/user/list", WECOM_ORIGIN);
    memberUrl.searchParams.set("access_token", token);
    memberUrl.searchParams.set("department_id", "1");
    memberUrl.searchParams.set("fetch_child", "1");
    const memberPayload = await this.request(memberUrl, { method: "GET" }, false);

    const departments = Array.isArray(departmentPayload.department)
      ? departmentPayload.department.map((value): ExternalDirectoryDepartment | null => {
        const row = object(value);
        const id = text(row?.id);
        const name = text(row?.name);
        if (!id || !name) return null;
        const parentId = text(row?.parentid);
        return { id, name, parentId: parentId === "0" ? null : parentId };
      }).filter((item): item is ExternalDirectoryDepartment => item !== null)
      : [];
    const members = Array.isArray(memberPayload.userlist)
      ? memberPayload.userlist.map((value): ExternalDirectoryMember | null => {
        const row = object(value);
        const id = text(row?.userid);
        const name = text(row?.name);
        if (!id || !name) return null;
        const departmentIds = Array.isArray(row?.department)
          ? row.department.map(text).filter((item): item is string => item !== null)
          : [];
        return {
          id,
          name,
          employeeNumber: employeeNumber(row!, parsed.data.employee_number_attr),
          departmentIds,
          primaryDepartmentId: text(row?.main_department),
          email: text(row?.email),
          mobile: text(row?.mobile),
          active: Number(row?.status ?? 1) !== 5,
        };
      }).filter((item): item is ExternalDirectoryMember => item !== null)
      : [];
    if (!Array.isArray(departmentPayload.department) || !Array.isArray(memberPayload.userlist)) {
      throw new DirectoryConnectorError("WECOM_PROTOCOL_ERROR", true);
    }
    return buildDirectorySnapshot({
      provider: this.provider,
      previousCursor,
      departments,
      members,
      sourceDataAt: this.now(),
    });
  }

  private async request(url: URL, init: RequestInit, tokenRequest: boolean): Promise<WecomPayload> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new DirectoryConnectorError("WECOM_UPSTREAM_UNAVAILABLE", true);
    }
    let raw: unknown;
    try {
      raw = await readBoundedJson(response);
    } catch {
      throw new DirectoryConnectorError("WECOM_PROTOCOL_ERROR", true);
    }
    const payload = object(raw) as WecomPayload | null;
    if (!payload) throw new DirectoryConnectorError("WECOM_PROTOCOL_ERROR", true);
    const code = Number(payload.errcode ?? (response.ok ? 0 : -1));
    if (!response.ok) {
      if (response.status === 401) throw new DirectoryConnectorError("WECOM_CREDENTIAL_INVALID", false);
      if (response.status === 403) throw new DirectoryConnectorError("WECOM_SCOPE_DENIED", false);
      if (isRetryableHttpStatus(response.status)) {
        throw new DirectoryConnectorError(
          response.status === 429 ? "WECOM_RATE_LIMITED" : "WECOM_UPSTREAM_UNAVAILABLE",
          true,
        );
      }
    }
    if (code !== 0) throw classifyWecom(code, tokenRequest);
    return payload;
  }
}
