/**
 * W19 使用主体单测 —— 列表 / 创建 / 停用二次确认闭环。
 */
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Principal } from "../api/types";
import { PrincipalsPage } from "./Principals";

const usePrincipalsMock = vi.fn();
const usePrincipalKeysMock = vi.fn();
const useGrantsMock = vi.fn();
const getMock = vi.fn();
const postMock = vi.fn();
const patchMock = vi.fn();
const delMock = vi.fn();
const invalidateMock = vi.fn();

vi.mock("../api/hooks", () => ({
  usePrincipals: () => usePrincipalsMock(),
  usePrincipalKeys: () => usePrincipalKeysMock(),
  useGrants: () => useGrantsMock(),
  usePrincipalAgentUsage: () => ({
    isLoading: false,
    error: null,
    data: { expectedAgentFamilies: ["CODEX"], agents: [{
      agentFamily: "CODEX", latestVersion: "0.146.0", identitySource: "DECLARED_HEADER",
      identityConfidence: "DECLARED", firstUsedAt: "2026-08-03T01:00:00.000Z",
      lastUsedAt: "2026-08-03T02:00:00.000Z", requestCount: "2", totalTokens: "300",
      totalApiCost: "1.20", models: ["qianliu-glm"],
    }] },
  }),
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
    created_at: "2026-07-28T02:00:00.000Z",
    updated_at: "2026-07-28T02:00:00.000Z",
    ...overrides,
  };
}

function renderPage() {
  return render(
    <MemoryRouter>
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
    await user.click(screen.getByRole("checkbox", { name: /仟流 GLM/ }));
    await user.click(screen.getByRole("button", { name: "生成 Key" }));
    expect(postMock).toHaveBeenCalledWith("/principals/p1/key", {
      allowed_model_ids: ["m1"],
    });
    expect(screen.getAllByText("sk-qianliu-unit-once")).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: "继续配置" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByText("sk-qianliu-unit-once")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "清除一次性 Key" }));
    expect(screen.queryByText("sk-qianliu-unit-once")).not.toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("统一模型"), "qianliu-glm");
    await user.clear(screen.getByLabelText("Token 额度"));
    await user.type(screen.getByLabelText("Token 额度"), "88000");
    expect(screen.getByLabelText("Token 额度")).toHaveValue("88,000");
    await user.click(screen.getByRole("button", { name: "分配" }));
    await waitFor(() => {
      expect(postMock).toHaveBeenCalledWith(
        "/principals/p1/grants",
        expect.objectContaining({
          model_alias: "qianliu-glm",
          quota_value: "88000",
        }),
      );
    });
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
    await user.click(screen.getByRole("checkbox", { name: /仟流 GLM/ }));
    await user.click(screen.getByRole("button", { name: "生成 Key" }));
    await user.click(screen.getByRole("button", { name: "复制完整接入信息" }));
    const copied = await navigator.clipboard.readText();
    expect(copied).toContain("API Key: sk-qianliu-copy-once");
    expect(copied).toContain("Gateway Base URL: http://127.0.0.1:8787/v1");
    expect(copied).toContain("Models: qianliu-glm");
    expect(copied).not.toContain("••••");
  });

  it("现有 Key 可更新模型权限，重置明确继承原限制", async () => {
    usePrincipalKeysMock.mockReturnValue({
      isLoading: false,
      error: null,
      data: {
        keys: [
          {
            id: "k1",
            key_prefix: "sk-qianliu-abcd",
            status: "ACTIVE",
            allowed_model_ids: [],
            created_at: "2026-07-28T02:00:00.000Z",
            revoked_at: null,
            last_used_at: null,
            expires_at: null,
          },
        ],
      },
      refetch: vi.fn(),
    });
    postMock.mockResolvedValue({ key: "sk-qianliu-reset-once" });
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("button", { name: "接入配置" }));

    await user.click(screen.getByRole("checkbox", { name: /仟流 GLM/ }));
    await user.click(screen.getByRole("button", { name: "保存模型权限" }));
    await waitFor(() => {
      expect(patchMock).toHaveBeenCalledWith("/principals/p1/key", {
        allowed_model_ids: ["m1"],
      });
    });

    await user.click(screen.getByRole("button", { name: "重置 Key" }));
    expect(screen.getByText(/完整继承模型、IP、有效期和限额/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "确认重置" }));
    await waitFor(() => {
      expect(postMock).toHaveBeenCalledWith("/principals/p1/key/reset");
    });
  });

  it("切换主体时清空未保存的模型权限选择", async () => {
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
    const user = userEvent.setup();
    renderPage();

    await user.click(pageRow("主体 A").getByRole("button", { name: "接入配置" }));
    const modelPermission = screen.getByRole("checkbox", { name: /仟流 GLM/ });
    await user.click(modelPermission);
    expect(modelPermission).toBeChecked();

    await user.click(pageRow("主体 B").getByRole("button", { name: "接入配置" }));
    await waitFor(() => {
      expect(screen.getByRole("checkbox", { name: /仟流 GLM/ })).not.toBeChecked();
    });
    await user.click(screen.getByRole("button", { name: "生成 Key" }));
    expect(postMock).toHaveBeenCalledWith("/principals/p2/key", {
      allowed_model_ids: [],
    });
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
