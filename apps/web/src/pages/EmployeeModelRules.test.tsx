import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EmployeeModelRulesPage } from "./EmployeeModelRules";

const mutate = vi.fn();
const hookState = vi.hoisted(() => ({ empty: false, createError: null as Error | null }));
vi.mock("../api/employee-model-rules", () => ({
  useEmployeeRuleCatalog: () => ({
    data: hookState.empty ? undefined : {
      principals: [
        { id: "p1", name: "员工 A", department_label: "研发", ready: true, unavailable_reason: null },
        { id: "p2", name: "员工 B", department_label: null, ready: false, unavailable_reason: "员工尚无有效 Key" },
      ],
      models: [
        { unified_model_id: "m1", provider_resource_id: "r1", provider_code: "kimi", provider_name: "Kimi", resource_name: "Plan A", display_name: "Kimi High", alias: "kimi-high", upstream_model: "kimi-for-coding-highspeed", mode: "CODING_PLAN", ready: true, unavailable_reasons: [] },
        { unified_model_id: "m2", provider_resource_id: "r2", provider_code: "zhipu", provider_name: "智谱", resource_name: "Plan B", display_name: "GLM 5.2", alias: "glm-5-2", upstream_model: "glm-5.2", mode: "CODING_PLAN", ready: false, unavailable_reasons: ["Model Route 未启用"] },
      ],
    }, isLoading: false, error: null, refetch: vi.fn(),
  }),
  useEmployeeModelRules: () => ({
    data: hookState.empty ? undefined : { rules: [{
      id: "v1", rule_id: "rule1", version: 1, name: "研发规则", status: "VALIDATED",
      employee_scope: "SELECTED", principal_ids: ["p1"], model_scope: "SELECTED",
      model_targets: [{ unified_model_id: "m1", provider_resource_id: "r1" }], quota_value: "1000000",
      allow_overage: false, valid_from: "2026-08-01T00:00:00.000Z", valid_until: "2026-10-01T00:00:00.000Z",
      pool_quotas: [
        { provider_code: "kimi", quota_value: "4000000", allow_overage: true, valid_until: "2026-10-01T00:00:00.000Z" },
        { provider_code: "zhipu", quota_value: "1000000", allow_overage: false, valid_until: null },
      ],
      lock_version: 2, validation_snapshot: {
        ready: true, principal_ids: ["p1"],
        model_targets: [{ unified_model_id: "m1", provider_resource_id: "r1" }],
        principal_count: 1, model_count: 1, assignment_count: 1, issues: [],
        changes: {
          added: [{ principal_id: "p1", principal_name: "员工 A", unified_model_id: "m1", model_name: "Kimi High", provider_resource_id: "r1", resource_name: "Plan A" }],
          retained: [], removed: [],
        },
      },
      published_at: null, disabled_at: null, created_at: "2026-08-04T00:00:00Z", updated_at: "2026-08-04T00:00:00Z",
    }, {
      id: "v2", rule_id: "rule2", version: 1, name: "已发布规则", status: "PUBLISHED",
      employee_scope: "ALL", principal_ids: [], model_scope: "ALL", model_targets: [], quota_value: "200",
      allow_overage: true, valid_from: "2026-08-01T00:00:00.000Z", valid_until: "2026-09-01T00:00:00.000Z",
      pool_quotas: [{ provider_code: "kimi", quota_value: "5000000", allow_overage: false, valid_until: null }],
      lock_version: 3, validation_snapshot: { ready: true, principal_ids: ["p1"], model_targets: [],
        principal_count: 1, model_count: 0, assignment_count: 0, issues: [] },
      published_at: "2026-08-02T00:00:00Z", disabled_at: null,
      created_at: "2026-08-02T00:00:00Z", updated_at: "2026-08-02T00:00:00Z",
    }, {
      id: "v3", rule_id: "rule3", version: 1, name: "草稿规则", status: "DRAFT",
      employee_scope: "SELECTED", principal_ids: ["p1"], model_scope: "SELECTED",
      model_targets: [{ unified_model_id: "m1", provider_resource_id: "r1" }], quota_value: "300",
      allow_overage: true, valid_from: "2026-08-01T00:00:00.000Z", valid_until: null,
      lock_version: 1, validation_snapshot: null, published_at: null, disabled_at: null,
      created_at: "2026-08-03T00:00:00Z", updated_at: "2026-08-03T00:00:00Z",
    }] }, isLoading: false, error: null, refetch: vi.fn(),
  }),
  useCreateEmployeeModelRule: () => ({ mutate, isPending: false, error: hookState.createError }),
  useUpdateEmployeeModelRule: () => ({ mutate, isPending: false, error: null }),
  useValidateEmployeeModelRule: () => ({ mutate, error: null }),
  usePublishEmployeeModelRule: () => ({ mutate, error: null }),
  useDisableEmployeeModelRule: () => ({ mutate, error: null }),
  useCreateEmployeeModelRuleVersion: () => ({ mutate, error: null }),
}));

describe("POOL-029 批量模型授权页面", () => {
  beforeEach(() => {
    mutate.mockReset();
    hookState.empty = false;
    hookState.createError = null;
  });

  it("空目录和普通错误保持可理解的空态与错误提示", () => {
    hookState.empty = true;
    hookState.createError = new Error("保存失败");
    render(<MemoryRouter><EmployeeModelRulesPage /></MemoryRouter>);
    expect(screen.getByRole("alert")).toHaveTextContent("保存失败");
    expect(screen.getByText("暂无批量授权规则")).toBeInTheDocument();
  });

  it("按员工和厂商模型展示就绪原因、权限变更预览、版本历史和显式发布入口", async () => {
    render(<MemoryRouter><EmployeeModelRulesPage /></MemoryRouter>);
    expect(screen.getByRole("heading", { name: "批量模型授权" })).toBeInTheDocument();
    expect(screen.getByText("员工 A · 研发")).toBeInTheDocument();
    expect(screen.getByText("员工尚无有效 Key")).toBeInTheDocument();
    expect(screen.getByText("Kimi High · Plan A")).toBeInTheDocument();
    expect(screen.getByText("Model Route 未启用")).toBeInTheDocument();
    expect(screen.getByText("1 人 × 1 模型 = 1 项")).toBeInTheDocument();
    expect(screen.getByText("新增 1 / 保留 0 / 撤销 0")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "发布" })).toBeInTheDocument();
    screen.getAllByRole("button", { name: "历史" })[0]!.click();
    const history = await screen.findByRole("region", { name: "规则版本历史" });
    expect(history).toBeInTheDocument();
    expect(history).toHaveTextContent("v1");
  });

  it("创建、编辑、校验、发布、停用与新版本操作都调用对应 mutation", async () => {
    const user = userEvent.setup();
    mutate.mockImplementationOnce((_payload, options) => options?.onSuccess?.());
    vi.stubGlobal("scrollTo", vi.fn());
    render(<MemoryRouter><EmployeeModelRulesPage /></MemoryRouter>);
    await user.type(screen.getByPlaceholderText("搜索员工或部门"), "员工 A");
    await user.type(screen.getByPlaceholderText("搜索厂商、资源或模型"), "Kimi");
    await user.click(screen.getByText("员工 A · 研发").closest("label")!.querySelector("input")!);
    await user.click(screen.getByText("员工 A · 研发").closest("label")!.querySelector("input")!);
    await user.click(screen.getByText("员工 A · 研发").closest("label")!.querySelector("input")!);
    await user.click(screen.getByText("Kimi High · Plan A").closest("label")!.querySelector("input")!);
    await user.click(screen.getByText("Kimi High · Plan A").closest("label")!.querySelector("input")!);
    await user.click(screen.getByText("Kimi High · Plan A").closest("label")!.querySelector("input")!);
    await user.type(screen.getByLabelText("规则名称"), "新规则");
    await user.clear(screen.getByLabelText("Token 额度"));
    await user.type(screen.getByLabelText("Token 额度"), "2000000");
    await user.type(screen.getByLabelText("失效时间（可选）"), "2026-09-01T00:00");
    await user.clear(screen.getByLabelText("生效时间"));
    await user.type(screen.getByLabelText("生效时间"), "2026-08-02T00:00");
    await user.click(screen.getByLabelText("当前全部员工"));
    await user.click(screen.getByLabelText("指定员工"));
    await user.click(screen.getByLabelText("当前全部就绪模型"));
    await user.click(screen.getByLabelText("指定模型"));
    await user.click(screen.getByLabelText("允许超额使用"));
    await user.click(screen.getByRole("button", { name: "创建草稿" }));
    expect(mutate).toHaveBeenCalled();

    await user.click(screen.getAllByRole("button", { name: "编辑" })[0]!);
    expect(screen.getByRole("heading", { name: /编辑/ })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "保存草稿" }));
    await user.click(screen.getByRole("button", { name: "取消编辑" }));
    await user.click(screen.getAllByRole("button", { name: "编辑" })[1]!);
    await user.click(screen.getByRole("button", { name: "取消编辑" }));
    await user.click(screen.getAllByRole("button", { name: "校验" })[0]!);
    await user.selectOptions(screen.getByLabelText("池额度方式"), "ADD");
    await user.click(screen.getByRole("button", { name: "发布" }));
    await user.click(screen.getByRole("button", { name: "新建版本" }));
    await user.click(screen.getByRole("button", { name: "停用" }));
    expect(mutate.mock.calls.length).toBeGreaterThanOrEqual(6);

    await user.click(screen.getAllByRole("button", { name: "历史" })[0]!);
    await user.click(screen.getByRole("button", { name: "关闭" }));
    expect(screen.queryByRole("region", { name: "规则版本历史" })).not.toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it("POOL-035 勾选厂商型号后展开厂商级额度输入并随 payload 提交，旧版本回退展示版本级额度", async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><EmployeeModelRulesPage /></MemoryRouter>);

    // 已发布规则 v2 带 pool_quotas（Kimi 500 万），额度列按厂商展示而非版本级单值。
    expect(screen.getByText("Kimi 5,000,000 Token")).toBeInTheDocument();

    // 勾选 Kimi 型号后厂商级额度块出现该厂商输入。
    await user.type(screen.getByPlaceholderText("搜索厂商、资源或模型"), "Kimi");
    await user.click(screen.getByText("Kimi High · Plan A").closest("label")!.querySelector("input")!);
    await screen.findByText("厂商级池额度（可选）");
    const kimiQuota = screen.getByLabelText("池额度");
    await user.type(screen.getByLabelText("Kimi 池失效时间"), "2026-10-01T00:00");
    await user.click(screen.getByLabelText("允许超额"));
    await user.clear(kimiQuota);
    await user.type(kimiQuota, "300000000");
    await user.type(screen.getByLabelText("规则名称"), "厂商规则");
    await user.click(screen.getByRole("button", { name: "创建草稿" }));

    const payload = mutate.mock.calls[0]?.[0] as { pool_quotas?: Array<{
      provider_code: string; quota_value: string; allow_overage: boolean; valid_until: string | null;
    }> };
    expect(payload?.pool_quotas).toEqual([
      expect.objectContaining({
        provider_code: "kimi", quota_value: "300000000", allow_overage: true,
        valid_until: new Date("2026-10-01T00:00").toISOString(),
      }),
    ]);
  });
});
