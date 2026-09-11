/**
 * W19 使用主体单测 —— 列表 / 创建 / 停用二次确认闭环。
 */
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Principal } from "../api/types";
import { PrincipalsPage } from "./Principals";

vi.mock("./EmployeeModelRules", () => ({
  EmployeeModelRulesPage: ({ embedded }: { embedded?: boolean }) => (
    <section aria-label="批量模型授权面板">{embedded ? "内嵌批量模型授权" : "独立批量模型授权"}</section>
  ),
}));

const usePrincipalsMock = vi.fn();
const usePrincipalKeysMock = vi.fn();
const useGrantsMock = vi.fn();
const useAccessConfigurationMock = vi.fn();
const usePrincipalAgentUsageMock = vi.fn();
const getMock = vi.fn();
const postMock = vi.fn();
const patchMock = vi.fn();
const delMock = vi.fn();
const invalidateMock = vi.fn();

vi.mock("../api/hooks", () => ({
  usePrincipals: (...args: unknown[]) => usePrincipalsMock(...args),
  usePrincipalKeys: () => usePrincipalKeysMock(),
  useGrants: () => useGrantsMock(),
  useAccessConfiguration: () => useAccessConfigurationMock(),
  usePrincipalAgentUsage: () => usePrincipalAgentUsageMock(),
  useUnifiedModels: () => ({
    isLoading: false,
    error: null,
    data: {
      models: [
        {
          id: "m1",
          alias: "qianliu-glm",
          display_name: "仟流 GLM",
          status: "ACTIVE",
        },
      ],
    },
    refetch: vi.fn(),
  }),
  QUERY_KEYS: {
    principals: ["principals"],
    principalKeys: (id: string) => ["principals", id, "keys"],
    grants: (id: string) => ["principals", id, "grants"],
    accessConfiguration: (id: string) => ["principals", id, "access-configuration"],
    principalAgentUsage: (id: string) => ["principals", id, "agent-usage"],
  },
}));

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as Record<string, unknown>),
    get: (...args: unknown[]) => getMock(...args),
    post: (...args: unknown[]) => postMock(...args),
    patch: (...args: unknown[]) => patchMock(...args),
    del: (...args: unknown[]) => delMock(...args),
  };
});

vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual("@tanstack/react-query");
  return {
    ...actual,
    useQueryClient: () => ({ invalidateQueries: invalidateMock }),
    useMutation: (options: {
      mutationFn: (v: unknown) => Promise<unknown>;
      onSuccess?: (result: unknown, variables: unknown) => void;
    }) => ({
      mutate: async (vars: unknown) => {
        const result = await options.mutationFn(vars);
        options.onSuccess?.(result, vars);
      },
      isPending: false,
      error: null,
    }),
  };
});

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    id: "p1",
    enterprise_id: "e1",
    type: "EMPLOYEE",
    name: "张三",
    department_label: "研发部",
    status: "ACTIVE",
    archived_at: null,
    version: 1,
    created_at: "2026-07-28T02:00:00.000Z",
    updated_at: "2026-07-28T02:00:00.000Z",
    ...overrides,
  };
}

function renderPage(initialEntry = "/principals") {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <PrincipalsPage />
    </MemoryRouter>,
  );
}

describe("W19 使用主体", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    usePrincipalsMock.mockReturnValue({
      isLoading: false,
      error: null,
      data: { principals: [principal()] },
      refetch: vi.fn(),
    });
    usePrincipalKeysMock.mockReturnValue({
      isLoading: false,
      error: null,
      data: { keys: [] },
      refetch: vi.fn(),
    });
    useGrantsMock.mockReturnValue({
      isLoading: false,
      error: null,
      data: { grants: [] },
      refetch: vi.fn(),
    });
    useAccessConfigurationMock.mockReturnValue({
      isLoading: false,
      error: null,
      data: {
        principal: { id: "p1", name: "测试员工", status: "ACTIVE", department_label: null },
        key: null,
        providers: [{
          provider_code: "zhipu",
          provider_name: "智谱",
          pool: {
            grant_id: "g1",
            quota_value: "50000000",
            quota_used: "0",
            allow_overage: false,
            valid_until: null,
            source: "MANAGED_SINGLE",
            over_limit: false,
          },
          models: [{
            unified_model_id: "m1",
            display_name: "仟流 GLM",
            alias: "qianliu-glm",
            provider_resource_id: "r1",
            resource_name: "智谱 API",
            resource_mode: "API",
            ready: true,
            unavailable_reasons: [],
            enabled: true,
          }],
        }],
        summary: { total_quota: "50000000", provider_count: 1, model_count: 1 },
        manual_pending_takeover: [],
        config_version: 1,
      },
      refetch: vi.fn(),
    });
    usePrincipalAgentUsageMock.mockReturnValue({
      isLoading: false,
      error: null,
      data: { expectedAgentFamilies: ["CODEX"], agents: [{
        agentFamily: "CODEX", latestVersion: "0.146.0", identitySource: "DECLARED_HEADER",
        identitySources: ["DECLARED_HEADER"], identityConfidence: "DECLARED",
        firstUsedAt: "2026-08-03T01:00:00.000Z",
        lastUsedAt: "2026-08-03T02:00:00.000Z", requestCount: "2", totalTokens: "300",
        totalApiCost: "1.20", models: ["qianliu-glm"],
      }] },
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
    postMock.mockResolvedValue({ principal: principal() });
    patchMock.mockResolvedValue({ principal: principal({ status: "DISABLED" }) });
    delMock.mockResolvedValue({ deleted: true });
    getMock.mockResolvedValue({
      preview: {
        keyCount: 0,
        activeKeyCount: 0,
        grantCount: 0,
        activeGrantCount: 0,
        requestCount: 0,
        usageCount: 0,
        ledgerCount: 0,
        employeeLoginCount: 0,
        canDelete: true,
      },
    });
  });

  it("列表渲染主体与状态", () => {
    renderPage();
    expect(screen.getByText("张三")).toBeInTheDocument();
    expect(screen.getByText("员工")).toBeInTheDocument();
    expect(screen.getByText("启用中")).toBeInTheDocument();
  });

  it("POOL20-046：使用主体提供第三个批量授权 Tab，并支持直达 URL", async () => {
    const user = userEvent.setup();
    renderPage();
    expect(screen.getByRole("button", { name: "使用主体" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "组织通讯录" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "批量模型授权" }));
    expect(screen.getByRole("region", { name: "批量模型授权面板" })).toHaveTextContent("内嵌批量模型授权");
  });

  it("POOL20-046：查询参数可直接打开批量授权 Tab", () => {
    renderPage("/principals?tab=batch-authorization");
    expect(screen.getByRole("region", { name: "批量模型授权面板" })).toBeInTheDocument();
    expect(screen.queryByText("张三")).not.toBeInTheDocument();
  });

  it("显示范围默认在用，并独立查询停用与归档主体", async () => {
    const user = userEvent.setup();
    renderPage();
    expect(screen.getByLabelText("显示范围")).toHaveValue("active");
    expect(usePrincipalsMock).toHaveBeenLastCalledWith("exclude", "ACTIVE");
    await user.selectOptions(screen.getByLabelText("显示范围"), "disabled");
    expect(usePrincipalsMock).toHaveBeenLastCalledWith("exclude", "DISABLED");
    await user.selectOptions(screen.getByLabelText("显示范围"), "archived");
    expect(usePrincipalsMock).toHaveBeenLastCalledWith("only", undefined);
  });

  it("创建主体：提交调用 POST /principals 并刷新缓存", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("button", { name: /新建主体/ }));
    await user.type(screen.getByLabelText("名称"), "李四");
    await user.click(screen.getByRole("button", { name: "创建" }));
    await waitFor(() => {
      expect(postMock).toHaveBeenCalledWith(
        "/principals",
        expect.objectContaining({ name: "李四", type: "EMPLOYEE" }),
      );
    });
    await waitFor(() => {
      expect(invalidateMock).toHaveBeenCalledWith({ queryKey: ["principals"] });
    });
  });

  it("B 方式：员工主体联想点选企微候选人，自动带出部门并绑定 person_id 提交（Scenario 3.1/3.2）", async () => {
    const candidate = {
      person_id: "20000000-0000-4000-8000-000000000002",
      principal_id: null,
      name: "李四",
      employee_number: "E-004",
      department_id: null,
      department_name: "技术部/架构组",
      source_type: "WECOM" as const,
      external_member_id: "lisi",
      person_status: "ACTIVE",
      principal_status: null,
      access_config_status: "MISSING" as const,
    };
    getMock.mockImplementation((path: string) => {
      if (typeof path === "string" && path.startsWith("/directory-members")) {
        return Promise.resolve({ items: [candidate] });
      }
      return Promise.resolve({
        preview: { keyCount: 0, activeKeyCount: 0, grantCount: 0, activeGrantCount: 0, requestCount: 0, usageCount: 0, ledgerCount: 0, employeeLoginCount: 0, canDelete: true },
      });
    });
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("button", { name: /新建主体/ }));
    const nameInput = screen.getByLabelText(/名称/);
    await user.type(nameInput, "李");
    await waitFor(() => {
      expect(getMock).toHaveBeenCalledWith(expect.stringContaining("/directory-members?search="));
    }, { timeout: 3000 });
    const listbox = await screen.findByRole("listbox", undefined, { timeout: 3000 });
    const option = within(listbox).getAllByRole("option")[0]!;
    expect(option).toHaveTextContent("李四");
    expect(option).toHaveTextContent("技术部/架构组");
    expect(option).toHaveTextContent("企微账号: lisi");

    await user.click(within(option).getByRole("button"));
    expect(nameInput).toHaveValue("李四");
    expect(screen.getByLabelText(/部门\/标签（可选）/)).toHaveValue("技术部/架构组");
    expect(screen.getByText(/已绑定企微候选人「李四」/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "创建" }));
    await waitFor(() => {
      expect(postMock).toHaveBeenCalledWith("/principals", expect.objectContaining({
        type: "EMPLOYEE",
        name: "李四",
        department_label: "技术部/架构组",
        person_id: candidate.person_id,
      }));
    });
  });

  it("B 方式：点选后手动修改名称会解除自然人绑定", async () => {
    const candidate = {
      person_id: "20000000-0000-4000-8000-000000000003",
      principal_id: null,
      name: "王五",
      employee_number: null,
      department_id: null,
      department_name: null,
      source_type: "WECOM" as const,
      external_member_id: "wangwu",
      person_status: "ACTIVE",
      principal_status: null,
      access_config_status: "MISSING" as const,
    };
    getMock.mockImplementation((path: string) => {
      if (typeof path === "string" && path.startsWith("/directory-members")) {
        return Promise.resolve({ items: [candidate] });
      }
      return Promise.resolve({
        preview: { keyCount: 0, activeKeyCount: 0, grantCount: 0, activeGrantCount: 0, requestCount: 0, usageCount: 0, ledgerCount: 0, employeeLoginCount: 0, canDelete: true },
      });
    });
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("button", { name: /新建主体/ }));
    const nameInput = screen.getByLabelText(/名称/);
    await user.type(nameInput, "王");
    const listbox = await screen.findByRole("listbox", undefined, { timeout: 3000 });
    await user.click(within(within(listbox).getAllByRole("option")[0]!).getByRole("button"));
    expect(screen.getByText(/已绑定企微候选人「王五」/)).toBeInTheDocument();
    await user.type(nameInput, "五2");
    await waitFor(() => expect(screen.queryByText(/已绑定企微候选人/)).not.toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "创建" }));
    await waitFor(() => {
      expect(postMock).toHaveBeenCalledWith("/principals", expect.objectContaining({
        name: "王五五2",
        person_id: null,
      }));
    });
  });

  it("停用主体：二次确认 → PATCH DISABLED → 说明级联撤销 Key", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("button", { name: "停用" }));
    // 二次确认对话框出现，说明影响对象
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText(/全部有效 Key 将被同步撤销/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "确认停用" }));
    await waitFor(() => {
      expect(patchMock).toHaveBeenCalledWith("/principals/p1", { status: "DISABLED" });
    });
  });

  it("停用可取消：取消后不调用 API", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("button", { name: "停用" }));
    await user.click(screen.getByRole("button", { name: "取消" }));
    expect(patchMock).not.toHaveBeenCalled();
  });

  it("编辑主体：允许修改名称和部门/标签", async () => {
    patchMock.mockResolvedValue({
      principal: principal({ name: "张三（平台）", department_label: "平台部" }),
    });
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("button", { name: "编辑" }));
    await user.clear(screen.getByLabelText("名称"));
    await user.type(screen.getByLabelText("名称"), "张三（平台）");
    await user.clear(screen.getByLabelText("部门/标签（可选）"));
    await user.type(screen.getByLabelText("部门/标签（可选）"), "平台部");
    await user.click(screen.getByRole("button", { name: "保存修改" }));
    await waitFor(() => {
      expect(patchMock).toHaveBeenCalledWith("/principals/p1", {
        name: "张三（平台）",
        department_label: "平台部",
      });
    });
  });

  it("无历史主体：清理预览后二次确认物理删除", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("button", { name: "清理" }));
    expect(await screen.findByText(/没有请求、Usage 或账本历史/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "确认删除" }));
    await waitFor(() => {
      expect(delMock).toHaveBeenCalledWith("/principals/p1");
    });
  });

  it("有历史主体：只允许归档并明确保留历史", async () => {
    getMock.mockResolvedValue({
      preview: {
        keyCount: 1,
        activeKeyCount: 1,
        grantCount: 1,
        activeGrantCount: 1,
        requestCount: 2,
        usageCount: 2,
        ledgerCount: 2,
        employeeLoginCount: 0,
        canDelete: false,
      },
    });
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("button", { name: "清理" }));
    expect(await screen.findByText(/历史数据继续保留/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "确认归档" }));
    await waitFor(() => {
      expect(postMock).toHaveBeenCalledWith("/principals/p1/archive");
      expect(delMock).not.toHaveBeenCalled();
    });
  });

  it("接入配置：Key 一次展示并创建模型额度 Grant", async () => {
    postMock.mockImplementation((path: string) => {
      if (path === "/principals/p1/key") {
        return Promise.resolve({ key: "sk-qianliu-unit-once" });
      }
      return Promise.resolve({ grant: { id: "g1" } });
    });
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("button", { name: "接入配置" }));
    await user.click(screen.getByRole("button", { name: "生成 Key" }));
    expect(postMock).toHaveBeenCalledWith("/principals/p1/key", {
      allowed_model_ids: [],
    });
    expect(screen.getAllByText("sk-qianliu-unit-once")).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: "继续配置" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByText("sk-qianliu-unit-once")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "清除一次性 Key" }));
    expect(screen.queryByText("sk-qianliu-unit-once")).not.toBeInTheDocument();
  });

  it("一次性复制接入信息包含完整 Key、Base URL 与有效授权模型", async () => {
    useGrantsMock.mockReturnValue({
      isLoading: false,
      error: null,
      data: {
        grants: [{
          id: "g1",
          principal_id: "p1",
          provider: "zhipu",
          model_alias: "qianliu-glm",
          quota_unit: "TOKEN",
          quota_value: "88000",
          allow_overage: false,
          valid_until: null,
          status: "ACTIVE",
          version: 1,
          created_at: "2026-07-28T02:00:00.000Z",
          updated_at: "2026-07-28T02:00:00.000Z",
        }],
      },
      refetch: vi.fn(),
    });
    postMock.mockResolvedValue({ key: "sk-qianliu-copy-once" });
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("button", { name: "接入配置" }));
    await user.click(screen.getByRole("button", { name: "生成 Key" }));
    await user.click(screen.getByRole("button", { name: "复制完整接入信息" }));
    const copied = await navigator.clipboard.readText();
    expect(copied).toContain("API Key: sk-qianliu-copy-once");
    expect(copied).toContain("Gateway Base URL: http://127.0.0.1:8787/v1");
    expect(copied).toContain("Models: qianliu-glm");
    expect(copied).not.toContain("••••");
  });

  it("共享额度展示业务语义和真实型号，已停用授权可手工归档", async () => {
    useGrantsMock.mockReturnValue({
      isLoading: false,
      error: null,
      data: { grants: [{
        id: "00000000-0000-4000-8000-000000000091",
        principal_id: "p1",
        provider: "zhipu",
        model_alias: "*",
        quota_unit: "TOKEN",
        quota_value: "88000",
        allow_overage: false,
        valid_until: null,
        status: "DISABLED",
        version: 2,
        created_at: "2026-07-28T02:00:00.000Z",
        updated_at: "2026-08-03T02:00:00.000Z",
      }] },
      refetch: vi.fn(),
    });
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("button", { name: "接入配置" }));
    expect(screen.getByText("该厂商共享额度")).toBeInTheDocument();
    expect(screen.getByText("已授权 1 个型号：仟流 GLM")).toBeInTheDocument();
    expect(screen.queryByText("*")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "归档" }));
    expect(screen.getByText(/额度、请求、账本、审计和历史关联继续保留/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "确认归档" }));
    await waitFor(() => {
      expect(postMock).toHaveBeenCalledWith(
        "/grants/00000000-0000-4000-8000-000000000091/archive",
      );
    });
  });

  it("明确区分管理员预期与实际观测，并支持 Unknown 请求下钻", async () => {
    usePrincipalAgentUsageMock.mockReturnValue({
      isLoading: false,
      error: null,
      data: { expectedAgentFamilies: ["CODEX"], agents: [{
        agentFamily: "UNKNOWN",
        latestVersion: null,
        identitySource: "NONE",
        identitySources: ["NONE"],
        identityConfidence: "UNKNOWN",
        firstUsedAt: "2026-08-01T01:00:00.000Z",
        lastUsedAt: "2026-08-03T02:00:00.000Z",
        requestCount: "3",
        totalTokens: "0",
        totalApiCost: "0",
        models: ["legacy-model"],
      }] },
    });
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("button", { name: "接入配置" }));
    expect(screen.getByText("计划／预期 Agent")).toBeInTheDocument();
    expect(screen.getByText(/由管理员手工维护/)).toBeInTheDocument();
    expect(screen.getByText("实际观测 Agent")).toBeInTheDocument();
    expect(screen.getByText(/Other 表示有客户端标识/)).toBeInTheDocument();
    expect(screen.getByText("Unknown")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "查看请求" })).toHaveAttribute(
      "href",
      "/usage?principal_id=p1&agent_family=UNKNOWN",
    );
  });

  it("切换主体后不展示上一主体延迟返回的一次性 Key 明文", async () => {
    usePrincipalsMock.mockReturnValue({
      isLoading: false,
      error: null,
      data: {
        principals: [
          principal({ id: "p1", name: "主体 A" }),
          principal({ id: "p2", name: "主体 B" }),
        ],
      },
      refetch: vi.fn(),
    });
    let resolveKey!: (value: { key: string }) => void;
    const delayedKey = new Promise<{ key: string }>((resolve) => {
      resolveKey = resolve;
    });
    postMock.mockImplementation((path: string) =>
      path === "/principals/p1/key"
        ? delayedKey
        : Promise.resolve({ key: "sk-qianliu-b" })
    );
    const user = userEvent.setup();
    renderPage();

    await user.click(pageRow("主体 A").getByRole("button", { name: "接入配置" }));
    await user.click(screen.getByRole("button", { name: "生成 Key" }));
    await user.click(pageRow("主体 B").getByRole("button", { name: "接入配置" }));

    await act(async () => {
      resolveKey({ key: "sk-qianliu-a-sensitive-once" });
      await delayedKey;
    });
    expect(screen.queryByText("sk-qianliu-a-sensitive-once")).not.toBeInTheDocument();
    expect(screen.getByText("主体 B · 接入配置")).toBeInTheDocument();
  });
});

function pageRow(name: string) {
  return within(screen.getByRole("row", { name: new RegExp(name) }));
}
