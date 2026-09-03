import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AccessConfiguration } from "../../api/types";
import { PrincipalAccessConfigPanel } from "./PrincipalAccessConfigPanel";

const putMock = vi.fn();
const invalidateMock = vi.fn();
const useAccessConfigurationMock = vi.fn();

vi.mock("../../api/client", () => ({
  put: (...args: unknown[]) => putMock(...args),
}));

vi.mock("../../api/hooks", () => ({
  useAccessConfiguration: () => useAccessConfigurationMock(),
  QUERY_KEYS: {
    principals: ["principals"],
    grants: (id: string) => ["principals", id, "grants"],
    dashboard: ["dashboard"],
  },
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: invalidateMock }),
  useMutation: (options: {
    mutationFn: (value: unknown) => Promise<unknown>;
    onSuccess?: (value: unknown) => void;
    onError?: (error: unknown) => void;
  }) => ({
    isPending: false,
    mutate: (value: unknown) => {
      void options.mutationFn(value).then(
        (result) => options.onSuccess?.(result),
        (error) => options.onError?.(error),
      );
    },
  }),
}));

function configuration(): AccessConfiguration {
  return {
    principal: { id: "compass", name: "compass", status: "ACTIVE", department_label: null },
    key: {
      key_prefix: "sk-ql",
      status: "ACTIVE",
      created_at: "2026-08-31T00:00:00.000Z",
      authorization_status: "AUTHORIZED",
    },
    providers: [{
      provider_code: "deepseek",
      provider_name: "DeepSeek",
      pool: {
        grant_id: "grant-deepseek",
        quota_value: "300000000",
        quota_used: "300000000",
        allow_overage: false,
        valid_until: null,
        source: "MANAGED_SINGLE",
        over_limit: false,
      },
      models: [{
        unified_model_id: "model-deepseek",
        display_name: "DeepSeek V3",
        alias: "ql-deepseek-v3",
        provider_resource_id: "resource-deepseek",
        resource_name: "DeepSeek 套餐",
        resource_mode: "CODING_PLAN",
        ready: false,
        unavailable_reasons: ["厂商资源不可服务"],
        enabled: true,
      }],
    }, {
      provider_code: "kimi",
      provider_name: "Kimi",
      pool: null,
      models: [{
        unified_model_id: "model-k3",
        display_name: "K3",
        alias: "ql-k3",
        provider_resource_id: "resource-kimi",
        resource_name: "Kimi K3",
        resource_mode: "CODING_PLAN",
        ready: true,
        unavailable_reasons: [],
        enabled: false,
      }],
    }],
    summary: { total_quota: "300000000", provider_count: 1, model_count: 1 },
    manual_pending_takeover: [],
    config_version: 8,
  };
}

describe("接入配置暂不可用存量授权", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAccessConfigurationMock.mockReturnValue({
      isLoading: false,
      isError: false,
      error: null,
      data: configuration(),
    });
    putMock.mockResolvedValue({ config_version: 9, changes: {}, takeover: {} });
  });

  it("保存 K3 时原样携带已配置但耗尽的 DeepSeek 型号", async () => {
    const user = userEvent.setup();
    render(<PrincipalAccessConfigPanel principalId="compass" />);

    expect(screen.getByRole("checkbox", { name: "DeepSeek开通" })).toBeChecked();
    await user.click(screen.getByText("DeepSeek"));
    expect(screen.getByRole("checkbox", { name: "DeepSeek V3（暂不可用）" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "DeepSeek V3（暂不可用）" })).toBeDisabled();

    await user.click(screen.getByRole("checkbox", { name: "Kimi开通" }));
    await user.type(screen.getByRole("textbox", { name: "Kimi Token 额度" }), "50000000");
    await user.click(screen.getByRole("button", { name: "保存并生效" }));

    await waitFor(() => expect(putMock).toHaveBeenCalledWith(
      "/principals/compass/access-configuration",
      expect.objectContaining({
        expected_version: 8,
        providers: expect.arrayContaining([
          expect.objectContaining({
            provider_code: "deepseek",
            quota_value: "300000000",
            enabled_model_ids: ["model-deepseek"],
          }),
          expect.objectContaining({
            provider_code: "kimi",
            quota_value: "50000000",
            enabled_model_ids: ["model-k3"],
          }),
        ]),
      }),
    ));
  });

  it("保存失败时明确报错并恢复上次生效状态", async () => {
    putMock.mockRejectedValue(new Error("厂商 deepseek 给了额度但未勾选任何型号"));
    const user = userEvent.setup();
    render(<PrincipalAccessConfigPanel principalId="compass" />);

    await user.click(screen.getByRole("checkbox", { name: "Kimi开通" }));
    expect(screen.getByRole("checkbox", { name: "Kimi开通" })).toBeChecked();
    await user.click(screen.getByRole("button", { name: "保存并生效" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "保存失败：厂商 deepseek 给了额度但未勾选任何型号。页面已恢复为上次生效的配置。",
    );
    expect(screen.getByRole("checkbox", { name: "Kimi开通" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "DeepSeek开通" })).toBeChecked();
  });
});
