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

const FEISHU_ORIGIN = "https://open.feishu.cn";
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_DEPARTMENTS = 1_000;
const MAX_PAGES = 1_000;

const FeishuConfig = z.object({
  app_id: z.string().trim().min(1).max(256),
  app_secret: z.string().min(1).max(2_048),
  root_department_name: z.string().trim().min(1).max(128).optional(),
});

interface FeishuPayload {
  code?: unknown;
  tenant_access_token?: unknown;
  data?: unknown;
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
}

function text(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function classifyFeishu(code: number, tokenRequest: boolean): DirectoryConnectorError {
  if ([99991400, 99991401].includes(code)) {
    return new DirectoryConnectorError("FEISHU_RATE_LIMITED", true);
  }
  if ([40003, 48002, 99991672].includes(code)) {
    return new DirectoryConnectorError("FEISHU_UPSTREAM_UNAVAILABLE", true);
  }
  if (tokenRequest || [10003, 10012, 99991663, 99991664, 99991668].includes(code)) {
    return new DirectoryConnectorError("FEISHU_CREDENTIAL_INVALID", false);
  }
  if ([40004, 41050, 99991679].includes(code)) {
    return new DirectoryConnectorError("FEISHU_SCOPE_DENIED", false);
  }
  return new DirectoryConnectorError("FEISHU_REQUEST_REJECTED", false);
}

function pageData(payload: FeishuPayload): {
  items: unknown[];
  hasMore: boolean;
  pageToken: string | null;
} {
  const data = object(payload.data);
  if (!data || !Array.isArray(data.items)) {
    throw new DirectoryConnectorError("FEISHU_PROTOCOL_ERROR", true);
  }
  return {
    items: data.items,
    hasMore: data.has_more === true,
    pageToken: text(data.page_token),
  };
}

export class FeishuDirectoryConnector implements DirectoryConnector {
  readonly provider = "FEISHU" as const;

  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {}

  // eslint-disable-next-line complexity -- 连接器只组合 token、部门 BFS 和成员分页三段只读流程。
  async pull(configValue: unknown, previousCursor: string | null): Promise<DirectorySnapshot> {
    const parsed = FeishuConfig.safeParse(configValue);
    if (!parsed.success) throw new DirectoryConnectorError("DIRECTORY_CONFIG_INVALID", false);
    const tokenUrl = new URL("/open-apis/auth/v3/tenant_access_token/internal", FEISHU_ORIGIN);
    const tokenPayload = await this.request(tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ app_id: parsed.data.app_id, app_secret: parsed.data.app_secret }),
    }, true);
    const token = text(tokenPayload.tenant_access_token);
    if (!token) throw new DirectoryConnectorError("FEISHU_PROTOCOL_ERROR", true);

    const departments: ExternalDirectoryDepartment[] = [{
      id: "0",
      parentId: null,
      name: parsed.data.root_department_name ?? "企业",
    }];
    const queue = ["0"];
    for (let index = 0; index < queue.length; index += 1) {
      const parentId = queue[index]!;
      const children = await this.paginate(
        `/open-apis/contact/v3/departments/${encodeURIComponent(parentId)}/children`,
        token,
        { department_id_type: "open_department_id", page_size: "100" },
      );
      for (const value of children) {
        const row = object(value);
        const id = text(row?.open_department_id) ?? text(row?.department_id);
        const name = text(row?.name);
        if (!id || !name || departments.some((department) => department.id === id)) continue;
        departments.push({
          id,
          name,
          parentId: text(row?.parent_department_id) ?? parentId,
        });
        queue.push(id);
        if (departments.length > MAX_DEPARTMENTS) {
          throw new DirectoryConnectorError("DIRECTORY_DEPARTMENT_LIMIT_EXCEEDED", false);
        }
      }
    }

    const members: ExternalDirectoryMember[] = [];
    for (const department of departments) {
      const users = await this.paginate(
        "/open-apis/contact/v3/users/find_by_department",
        token,
        {
          department_id: department.id,
          department_id_type: "open_department_id",
          user_id_type: "user_id",
          page_size: "50",
        },
      );
      for (const value of users) {
        const row = object(value);
        const id = text(row?.user_id) ?? text(row?.open_id);
        const name = text(row?.name);
        if (!id || !name) continue;
        const status = object(row?.status);
        const departmentIds = Array.isArray(row?.department_ids)
          ? row.department_ids.map(text).filter((item): item is string => item !== null)
          : [department.id];
        members.push({
          id,
          name,
          employeeNumber: text(row?.employee_no),
          departmentIds,
          primaryDepartmentId: departmentIds[0] ?? department.id,
          email: text(row?.enterprise_email) ?? text(row?.email),
          mobile: text(row?.mobile),
          active: status?.is_resigned !== true && status?.is_exited !== true,
        });
      }
    }
    return buildDirectorySnapshot({
      provider: this.provider,
      previousCursor,
      departments,
      members,
      sourceDataAt: this.now(),
    });
  }

  private async paginate(
    path: string,
    token: string,
    baseQuery: Record<string, string>,
  ): Promise<unknown[]> {
    const items: unknown[] = [];
    const seenTokens = new Set<string>();
    let pageToken: string | null = null;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const url = new URL(path, FEISHU_ORIGIN);
      for (const [key, value] of Object.entries(baseQuery)) url.searchParams.set(key, value);
      if (pageToken) url.searchParams.set("page_token", pageToken);
      const payload = await this.request(url, {
        method: "GET",
        headers: { authorization: `Bearer ${token}` },
      }, false);
      const current = pageData(payload);
      items.push(...current.items);
      if (!current.hasMore) return items;
      if (!current.pageToken || seenTokens.has(current.pageToken)) {
        throw new DirectoryConnectorError("FEISHU_PROTOCOL_ERROR", true);
      }
      seenTokens.add(current.pageToken);
      pageToken = current.pageToken;
    }
    throw new DirectoryConnectorError("FEISHU_PROTOCOL_ERROR", true);
  }

  private async request(url: URL, init: RequestInit, tokenRequest: boolean): Promise<FeishuPayload> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new DirectoryConnectorError("FEISHU_UPSTREAM_UNAVAILABLE", true);
    }
    let raw: unknown;
    try {
      raw = await readBoundedJson(response);
    } catch {
      throw new DirectoryConnectorError("FEISHU_PROTOCOL_ERROR", true);
    }
    const payload = object(raw) as FeishuPayload | null;
    if (!payload) throw new DirectoryConnectorError("FEISHU_PROTOCOL_ERROR", true);
    const code = Number(payload.code ?? (response.ok ? 0 : -1));
    if (!response.ok) {
      if (response.status === 401) throw new DirectoryConnectorError("FEISHU_CREDENTIAL_INVALID", false);
      if (response.status === 403) throw new DirectoryConnectorError("FEISHU_SCOPE_DENIED", false);
      if (isRetryableHttpStatus(response.status)) {
        throw new DirectoryConnectorError(
          response.status === 429 ? "FEISHU_RATE_LIMITED" : "FEISHU_UPSTREAM_UNAVAILABLE",
          true,
        );
      }
    }
    if (code !== 0) throw classifyFeishu(code, tokenRequest);
    return payload;
  }
}
