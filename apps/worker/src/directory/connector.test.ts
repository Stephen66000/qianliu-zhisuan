import { describe, expect, it, vi } from "vitest";
import { buildDirectorySnapshot } from "./connector.js";
import type { DirectoryConnectorError } from "./connector.js";
import { FeishuDirectoryConnector } from "./feishu-connector.js";
import { WecomDirectoryConnector } from "./wecom-connector.js";

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("directory connector normalization", () => {
  it("以稳定外部 ID 生成部门路径和稳定快照，不混入离职成员", () => {
    const now = new Date("2026-08-13T00:00:00Z");
    const first = buildDirectorySnapshot({
      provider: "WECOM",
      previousCursor: null,
      sourceDataAt: now,
      departments: [
        { id: "2", parentId: "1", name: "平台组" },
        { id: "1", parentId: null, name: "研发中心" },
      ],
      members: [
        {
          id: "u-2", name: "离职", employeeNumber: "E-2", departmentIds: ["2"],
          primaryDepartmentId: "2", email: null, mobile: null, active: false,
        },
        {
          id: "u-1", name: "张三", employeeNumber: "E-1", departmentIds: ["2"],
          primaryDepartmentId: "2", email: "a@example.test", mobile: null, active: true,
        },
      ],
    });
    expect(first.items).toEqual([expect.objectContaining({
      externalMemberId: "u-1",
      employeeNumber: "E-1",
      normalizedDepartmentPath: "研发中心/平台组",
      externalDepartmentId: "2",
      reasonCode: null,
    })]);
    const second = buildDirectorySnapshot({
      provider: "WECOM",
      previousCursor: first.cursor,
      sourceDataAt: new Date("2026-08-13T01:00:00Z"),
      departments: [
        { id: "1", parentId: null, name: "研发中心" },
        { id: "2", parentId: "1", name: "平台组" },
      ],
      members: [{
        id: "u-1", name: "张三", employeeNumber: "E-1", departmentIds: ["2"],
        primaryDepartmentId: "2", email: "a@example.test", mobile: null, active: true,
      }],
    });
    expect(second.snapshotId).toBe(first.snapshotId);
    expect(second.unchanged).toBe(true);
  });

  it("部门缺失时保留行并输出稳定 reason code", () => {
    const snapshot = buildDirectorySnapshot({
      provider: "FEISHU",
      previousCursor: null,
      departments: [],
      members: [{
        id: "u-1", name: "张三", employeeNumber: null, departmentIds: ["missing"],
        primaryDepartmentId: "missing", email: null, mobile: null, active: true,
      }],
    });
    expect(snapshot.items[0]).toMatchObject({ reasonCode: "DEPARTMENT_NOT_FOUND" });
  });

  it("1,000 人边界可用，1,001 人稳定拒绝且不伪装为可重试", () => {
    const departments = [{ id: "d-1", parentId: null, name: "研发" }];
    const member = (index: number) => ({
      id: `u-${index}`, name: `员工${index}`, employeeNumber: null,
      departmentIds: ["d-1"], primaryDepartmentId: "d-1",
      email: null, mobile: null, active: true,
    });
    expect(buildDirectorySnapshot({
      provider: "WECOM", previousCursor: null, departments,
      members: Array.from({ length: 1_000 }, (_, index) => member(index)),
    }).items).toHaveLength(1_000);
    expect(() => buildDirectorySnapshot({
      provider: "WECOM", previousCursor: null, departments,
      members: Array.from({ length: 1_001 }, (_, index) => member(index)),
    })).toThrow(expect.objectContaining<Partial<DirectoryConnectorError>>({
      code: "DIRECTORY_MEMBER_LIMIT_EXCEEDED", retryable: false,
    }));
  });
});

describe("WecomDirectoryConnector", () => {
  it("只调用企微读取端点并标准化成员", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/cgi-bin/gettoken") {
        expect(url.searchParams.get("corpid")).toBe("corp-1");
        expect(url.searchParams.get("corpsecret")).toBe("secret-1");
        return response({ errcode: 0, access_token: "token-1" });
      }
      if (url.pathname === "/cgi-bin/department/list") {
        return response({
          errcode: 0,
          department: [
            { id: 1, parentid: 0, name: "公司" },
            { id: 2, parentid: 1, name: "研发" },
          ],
        });
      }
      if (url.pathname === "/cgi-bin/user/list") {
        return response({
          errcode: 0,
          userlist: [{
            userid: "wx-1", name: "张三", department: [2], main_department: 2,
            email: "a@example.test", mobile: "13000000000", status: 1,
            extattr: { attrs: [{ name: "员工编号", value: "E-001" }] },
          }],
        });
      }
      throw new Error("unexpected url");
    });
    const connector = new WecomDirectoryConnector(fetchMock, () => new Date("2026-08-13T00:00:00Z"));
    const snapshot = await connector.pull({
      corp_id: "corp-1",
      corp_secret: "secret-1",
      employee_number_attr: "员工编号",
    }, null);
    expect(snapshot.items).toEqual([expect.objectContaining({
      externalMemberId: "wx-1",
      employeeNumber: "E-001",
      normalizedDepartmentPath: "公司/研发",
    })]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
  });

  it("限流输出可重试的稳定错误码", async () => {
    const connector = new WecomDirectoryConnector(vi.fn<typeof fetch>(async () => response({ errcode: 45009 })));
    await expect(connector.pull({ corp_id: "corp-1", corp_secret: "secret-1" }, null))
      .rejects.toEqual(expect.objectContaining<Partial<DirectoryConnectorError>>({
        code: "WECOM_RATE_LIMITED",
        retryable: true,
      }));
  });

  it("HTTP 401 与畸形响应分别 fail-closed", async () => {
    const unauthorized = new WecomDirectoryConnector(vi.fn<typeof fetch>(async () => response({}, 401)));
    await expect(unauthorized.pull({ corp_id: "corp-1", corp_secret: "secret-1" }, null))
      .rejects.toMatchObject({ code: "WECOM_CREDENTIAL_INVALID", retryable: false });
    const malformed = new WecomDirectoryConnector(vi.fn<typeof fetch>(async () => new Response("not-json")));
    await expect(malformed.pull({ corp_id: "corp-1", corp_secret: "secret-1" }, null))
      .rejects.toMatchObject({ code: "WECOM_PROTOCOL_ERROR", retryable: true });
  });

  it("HTTP 403、500 与网络失败不泄漏上游响应且保持重试语义", async () => {
    const forbidden = new WecomDirectoryConnector(vi.fn<typeof fetch>(async () => response({}, 403)));
    await expect(forbidden.pull({ corp_id: "corp-1", corp_secret: "secret-1" }, null))
      .rejects.toMatchObject({ code: "WECOM_SCOPE_DENIED", retryable: false });
    const unavailable = new WecomDirectoryConnector(vi.fn<typeof fetch>(async () => response({}, 500)));
    await expect(unavailable.pull({ corp_id: "corp-1", corp_secret: "secret-1" }, null))
      .rejects.toMatchObject({ code: "WECOM_UPSTREAM_UNAVAILABLE", retryable: true });
    const network = new WecomDirectoryConnector(vi.fn<typeof fetch>(async () => { throw new Error("secret-body"); }));
    await expect(network.pull({ corp_id: "corp-1", corp_secret: "secret-1" }, null))
      .rejects.toMatchObject({ code: "WECOM_UPSTREAM_UNAVAILABLE", retryable: true });
  });
});

describe("FeishuDirectoryConnector", () => {
  it("递归读取部门、分页读取成员并按 user_id 去重", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/tenant_access_token/internal")) {
        expect(JSON.parse(String(init?.body))).toEqual({ app_id: "app-1", app_secret: "secret-1" });
        return response({ code: 0, tenant_access_token: "tenant-token" });
      }
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer tenant-token");
      if (url.pathname === "/open-apis/contact/v3/departments/0/children") {
        return response({ code: 0, data: { items: [
          { open_department_id: "od-1", parent_department_id: "0", name: "研发" },
        ], has_more: false } });
      }
      if (url.pathname === "/open-apis/contact/v3/departments/od-1/children") {
        return response({ code: 0, data: { items: [], has_more: false } });
      }
      if (url.pathname === "/open-apis/contact/v3/users/find_by_department") {
        if (url.searchParams.get("department_id") === "0") {
          return response({ code: 0, data: { items: [], has_more: false } });
        }
        const pageToken = url.searchParams.get("page_token");
        return pageToken
          ? response({ code: 0, data: { items: [{
            user_id: "fs-2", name: "李四", employee_no: "E-2", department_ids: ["od-1"], status: {},
          }], has_more: false } })
          : response({ code: 0, data: { items: [{
            user_id: "fs-1", name: "张三", employee_no: "E-1", department_ids: ["od-1"], status: {},
          }], has_more: true, page_token: "next-1" } });
      }
      throw new Error(`unexpected path ${url.pathname}`);
    });
    const connector = new FeishuDirectoryConnector(fetchMock, () => new Date("2026-08-13T00:00:00Z"));
    const snapshot = await connector.pull({
      app_id: "app-1", app_secret: "secret-1", root_department_name: "公司",
    }, null);
    expect(snapshot.items.map((item) => [
      item.externalMemberId, item.employeeNumber, item.normalizedDepartmentPath,
    ])).toEqual([
      ["fs-1", "E-1", "公司/研发"],
      ["fs-2", "E-2", "公司/研发"],
    ]);
    expect(fetchMock.mock.calls.every(([input]) => new URL(String(input)).origin === "https://open.feishu.cn")).toBe(true);
  });

  it("权限错误输出不可重试的稳定错误码", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      return url.pathname.endsWith("/tenant_access_token/internal")
        ? response({ code: 0, tenant_access_token: "tenant-token" })
        : response({ code: 40004, msg: "forbidden" }, 403);
    });
    const connector = new FeishuDirectoryConnector(fetchMock);
    await expect(connector.pull({ app_id: "app-1", app_secret: "secret-1" }, null))
      .rejects.toEqual(expect.objectContaining<Partial<DirectoryConnectorError>>({
        code: "FEISHU_SCOPE_DENIED",
        retryable: false,
      }));
  });

  it("HTTP 429 与畸形响应分别保持稳定错误语义", async () => {
    const tokenThen = (next: () => Response) => {
      let count = 0;
      return vi.fn<typeof fetch>(async () => count++ === 0
        ? response({ code: 0, tenant_access_token: "tenant-token" })
        : next());
    };
    const limited = new FeishuDirectoryConnector(tokenThen(() => response({}, 429)));
    await expect(limited.pull({ app_id: "app-1", app_secret: "secret-1" }, null))
      .rejects.toMatchObject({ code: "FEISHU_RATE_LIMITED", retryable: true });
    const malformed = new FeishuDirectoryConnector(tokenThen(() => new Response("not-json")));
    await expect(malformed.pull({ app_id: "app-1", app_secret: "secret-1" }, null))
      .rejects.toMatchObject({ code: "FEISHU_PROTOCOL_ERROR", retryable: true });
  });

  it("HTTP 401、500 与网络失败保持凭证/可重试边界", async () => {
    const credential = new FeishuDirectoryConnector(vi.fn<typeof fetch>(async () => response({}, 401)));
    await expect(credential.pull({ app_id: "app-1", app_secret: "secret-1" }, null))
      .rejects.toMatchObject({ code: "FEISHU_CREDENTIAL_INVALID", retryable: false });
    const unavailable = new FeishuDirectoryConnector(vi.fn<typeof fetch>(async () => response({}, 500)));
    await expect(unavailable.pull({ app_id: "app-1", app_secret: "secret-1" }, null))
      .rejects.toMatchObject({ code: "FEISHU_UPSTREAM_UNAVAILABLE", retryable: true });
    const network = new FeishuDirectoryConnector(vi.fn<typeof fetch>(async () => { throw new Error("secret-body"); }));
    await expect(network.pull({ app_id: "app-1", app_secret: "secret-1" }, null))
      .rejects.toMatchObject({ code: "FEISHU_UPSTREAM_UNAVAILABLE", retryable: true });
  });
});
