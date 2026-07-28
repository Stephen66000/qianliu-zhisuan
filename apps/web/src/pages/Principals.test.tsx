/**
 * W19 使用主体单测 —— 列表 / 创建 / 停用二次确认闭环。
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Principal } from "../api/types";
import { PrincipalsPage } from "./Principals";

const usePrincipalsMock = vi.fn();
const postMock = vi.fn();
const patchMock = vi.fn();
const invalidateMock = vi.fn();

vi.mock("../api/hooks", () => ({
  usePrincipals: () => usePrincipalsMock(),
  usePrincipalKeys: () => ({
    isLoading: false,
    error: null,
    data: { keys: [] },
    refetch: vi.fn(),
  }),
  useGrants: () => ({
    isLoading: false,
    error: null,
    data: { grants: [] },
    refetch: vi.fn(),
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
  },
}));

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as Record<string, unknown>),
    post: (...args: unknown[]) => postMock(...args),
    patch: (...args: unknown[]) => patchMock(...args),
  };
});

vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual("@tanstack/react-query");
  return {
    ...actual,
    useQueryClient: () => ({ invalidateQueries: invalidateMock }),
    useMutation: (options: {
      mutationFn: (v: unknown) => Promise<unknown>;
      onSuccess?: () => void;
    }) => ({
      mutate: async (vars: unknown) => {
        await options.mutationFn(vars);
        options.onSuccess?.();
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
    postMock.mockResolvedValue({ principal: principal() });
    patchMock.mockResolvedValue({ principal: principal({ status: "DISABLED" }) });
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
    expect(screen.getByText("sk-qianliu-unit-once")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "已安全保存，关闭" }));
    expect(screen.queryByText("sk-qianliu-unit-once")).not.toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("统一模型"), "qianliu-glm");
    await user.clear(screen.getByLabelText("Token 额度"));
    await user.type(screen.getByLabelText("Token 额度"), "88000");
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
});
