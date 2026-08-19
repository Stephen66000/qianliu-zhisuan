/**
 * P1-02 管理闭环：计价规则模板 + 统一模型 + Model Route。
 */
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useFieldArray, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Gauge, Plus } from "lucide-react";
import { z } from "zod";

import { patch, post } from "../api/client";
import {
  QUERY_KEYS,
  useBillingRules,
  useDispatchPolicies,
  useModelRoutes,
  usePrincipals,
  useProviderResources,
  useUnifiedModels,
} from "../api/hooks";
import type { BillingRule, DispatchPolicy, ModelRouteItem, Principal, UnifiedModel } from "../api/types";
import { StatusTag } from "../components/dashboard/StatusTag";
import {
  PrincipalScopeField,
  principalScopeText,
} from "../components/quota/PrincipalScopeField";
import {
  ConfigurationActionDialogs,
  type ArchiveTarget,
  type PolicyActionTarget,
} from "../components/quota/ConfigurationActionDialogs";
import {
  DispatchPolicyFormSchema,
  buildDispatchPolicyPayload,
  type DispatchPolicyInput,
  type DispatchPolicyValues,
} from "../components/quota/dispatch-policy-form";
import { WeekdayPicker, formatDaysOfWeek, parseDaysOfWeek } from "../components/quota/WeekdayPicker";
import { DepartmentBudgetEntry } from "../components/quota/DepartmentBudgetEntry";
import { PageShell } from "../components/layout/PageShell";
import { QueryGate } from "../components/states/QueryGate";
import { ConfirmDialog } from "../components/writes/ConfirmDialog";
import { FormField, INPUT_CLASS } from "../components/writes/FormField";
import { useRedirectOnUnauthorized } from "../components/useRedirectOnUnauthorized";

const OptionalDecimal = z.string().refine(
  (value) => value === "" || /^\d+(?:\.\d+)?$/.test(value),
  "请输入非负十进制数",
);
const OptionalTime = z.string().refine(
  (value) => value === "" || /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value),
  "时间格式应为 HH:MM",
);

const BillingWindowFormSchema = z
  .object({
    timezone: z.string().min(1, "时区不能为空").max(64),
    days_of_week: z.string().refine(
      (value) =>
        value === ""
        || value.split(",").every((day) => /^[1-7]$/.test(day.trim())),
      "星期使用 1-7，以逗号分隔",
    ),
    start_time: OptionalTime,
    end_time: OptionalTime,
  })
  .superRefine((window, ctx) => {
    const complete = Boolean(window.timezone && window.start_time && window.end_time);
    if (!complete) {
      ctx.addIssue({ code: "custom", path: ["timezone"], message: "时区和起止时间必须同时填写" });
    }
    if (window.start_time && window.start_time === window.end_time) {
      ctx.addIssue({ code: "custom", path: ["end_time"], message: "起止时间不能相同" });
    }
  });

export const BillingRuleSchema = z
  .object({
    rule_type: z.enum(["API_PRICE", "TIME_WINDOW", "MODEL_TIER", "CACHE_STATE"]),
    rule_version: z.string().min(1, "版本不能为空").max(64),
    provider_resource_id: z.string().uuid("请选择资源"),
    upstream_model: z.string().min(1, "上游模型不能为空").max(128),
    effective_from: z.string().min(1, "生效时间不能为空"),
    effective_to: z.string(),
    windows: z.array(BillingWindowFormSchema).max(32, "最多配置 32 个时间窗"),
    multiplier: OptionalDecimal,
    cache_hit_price: OptionalDecimal,
    cache_miss_price: OptionalDecimal,
    output_price: OptionalDecimal,
    priority: z.coerce.number().int().min(0),
  })
  .superRefine((input, ctx) => {
    const configuredWindows = input.windows.filter(
      (window) => window.timezone && window.start_time && window.end_time,
    );
    if (input.effective_to && new Date(input.effective_to) <= new Date(input.effective_from)) {
      ctx.addIssue({ code: "custom", path: ["effective_to"], message: "失效时间必须晚于生效时间" });
    }
    if (input.rule_type === "API_PRICE") {
      if (input.multiplier) {
        ctx.addIssue({ code: "custom", path: ["multiplier"], message: "API 价格规则不使用额度倍率" });
      }
      if (!input.cache_hit_price && !input.cache_miss_price && !input.output_price) {
        ctx.addIssue({ code: "custom", path: ["cache_miss_price"], message: "至少填写一个单价" });
      }
    }
    if (input.rule_type === "TIME_WINDOW" || input.rule_type === "MODEL_TIER") {
      if (!input.multiplier) {
        ctx.addIssue({ code: "custom", path: ["multiplier"], message: "额度规则必须填写倍率" });
      }
      if (input.cache_hit_price || input.cache_miss_price || input.output_price) {
        ctx.addIssue({ code: "custom", path: ["cache_miss_price"], message: "额度倍率规则不使用 API 单价" });
      }
    }
    if (input.rule_type === "TIME_WINDOW" && configuredWindows.length === 0) {
      ctx.addIssue({ code: "custom", path: ["windows"], message: "时段倍率至少配置一个时间窗" });
    }
    if (input.rule_type === "MODEL_TIER" && configuredWindows.length > 0) {
      ctx.addIssue({ code: "custom", path: ["windows"], message: "模型档位不使用时间窗" });
    }
  });

const UnifiedModelSchema = z.object({
  alias: z.string().min(1, "别名不能为空").max(64),
  display_name: z.string().min(1, "显示名称不能为空").max(128),
});

const RouteSchema = z.object({
  unified_model_id: z.string().uuid("请选择统一模型"),
  provider_resource_id: z.string().uuid("请选择资源"),
  upstream_model: z.string().min(1, "上游模型不能为空").max(128),
  priority: z.coerce.number().int(),
  weight: z.coerce.number().int().positive(),
});

export type BillingRuleValues = z.infer<typeof BillingRuleSchema>;
type BillingRuleInput = z.input<typeof BillingRuleSchema>;
type BillingWindowForm = z.infer<typeof BillingWindowFormSchema>;
type UnifiedModelValues = z.infer<typeof UnifiedModelSchema>;
type RouteValues = z.infer<typeof RouteSchema>;
type RouteInput = z.input<typeof RouteSchema>;

function localDateTimeValue(date = new Date()): string {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function formatLifecycle(at: string, adminId: string | null): string {
  const time = new Date(at).toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour12: false,
  });
  return `${time} · ${adminId ? `操作人 ${adminId.slice(0, 8)}` : "操作人未知（历史数据）"}`;
}

function editableWindows(rule: BillingRule): BillingWindowForm[] {
  const windows = rule.time_windows
    ?? (
      rule.timezone && rule.start_time && rule.end_time
        ? [{
            timezone: rule.timezone,
            days_of_week: rule.days_of_week,
            start_time: rule.start_time,
            end_time: rule.end_time,
          }]
        : []
    );
  return windows.map((window) => ({
    timezone: window.timezone,
    days_of_week: window.days_of_week?.join(",") ?? "",
    start_time: window.start_time.slice(0, 5),
    end_time: window.end_time.slice(0, 5),
  }));
}

function serializeWindows(windows: BillingWindowForm[]) {
  return windows.map((window) => ({
    timezone: window.timezone,
    days_of_week: window.days_of_week
      ? window.days_of_week.split(",").map((day) => Number(day.trim()))
      : null,
    start_time: window.start_time,
    end_time: window.end_time,
  }));
}

export function buildBillingRulePayload(values: BillingRuleValues) {
  return {
    rule_type: values.rule_type,
    rule_version: values.rule_version,
    provider_resource_id: values.provider_resource_id,
    upstream_model: values.upstream_model,
    effective_from: new Date(values.effective_from).toISOString(),
    effective_to: values.effective_to ? new Date(values.effective_to).toISOString() : null,
    windows: values.windows.length > 0 ? serializeWindows(values.windows) : null,
    multiplier: values.multiplier || null,
    cache_hit_price: values.cache_hit_price || null,
    cache_miss_price: values.cache_miss_price || null,
    output_price: values.output_price || null,
    priority: values.priority,
    currency: "CNY",
    source: "WEB_ADMIN",
  };
}

function principalList(data: { principals: Principal[] } | undefined): Principal[] {
  return data?.principals ?? [];
}

function firstQueryError(errors: Array<Error | null>): Error | null {
  return errors.find((error) => error !== null && error !== undefined) ?? null;
}

export { buildDispatchPolicyPayload } from "../components/quota/dispatch-policy-form";

export function QuotaRulesPage() {
  const queryClient = useQueryClient();
  const rulesQuery = useBillingRules("all");
  const policiesQuery = useDispatchPolicies();
  const modelsQuery = useUnifiedModels("all");
  const resourcesQuery = useProviderResources();
  const principalsQuery = usePrincipals("all");
  useRedirectOnUnauthorized(firstQueryError([
    rulesQuery.error,
    policiesQuery.error,
    modelsQuery.error,
    resourcesQuery.error,
    principalsQuery.error,
  ]));

  const models = useMemo(() => modelsQuery.data?.models ?? [], [modelsQuery.data?.models]);
  const resources = resourcesQuery.data?.resources ?? [];
  const principals = useMemo(() => principalList(principalsQuery.data), [principalsQuery.data]);
  const [showRuleForm, setShowRuleForm] = useState(false);
  const [showPolicyForm, setShowPolicyForm] = useState(false);
  const [showModelForm, setShowModelForm] = useState(false);
  const [showRouteForm, setShowRouteForm] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [selectedRuleRouteId, setSelectedRuleRouteId] = useState("");
  const [selectedModelId, setSelectedModelId] = useState<string | null>(null);
  const [disableModelTarget, setDisableModelTarget] = useState<UnifiedModel | null>(null);
  const [disableRouteTarget, setDisableRouteTarget] = useState<ModelRouteItem | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<ArchiveTarget | null>(null);
  const [policyActionTarget, setPolicyActionTarget] = useState<PolicyActionTarget | null>(null);
  const [editingPolicy, setEditingPolicy] = useState<DispatchPolicy | null>(null);
  const [principalSearch, setPrincipalSearch] = useState("");
  const routesQuery = useModelRoutes(selectedModelId, "all");

  useEffect(() => {
    if (models.length > 0 && !models.some((model) => model.id === selectedModelId)) {
      setSelectedModelId(models.find((model) => !model.archived_at)?.id ?? models[0]!.id);
    }
  }, [models, selectedModelId]);

  const ruleForm = useForm<BillingRuleInput, unknown, BillingRuleValues>({
    resolver: zodResolver(BillingRuleSchema),
    defaultValues: {
      rule_type: "API_PRICE",
      rule_version: "v1",
      provider_resource_id: "",
      upstream_model: "",
      effective_from: localDateTimeValue(),
      effective_to: "",
      windows: [],
      multiplier: "",
      cache_hit_price: "0",
      cache_miss_price: "0.000001",
      output_price: "0.000002",
      priority: 100,
    },
  });
  const {
    fields: ruleWindowFields,
    append: appendRuleWindow,
    remove: removeRuleWindow,
    replace: replaceRuleWindows,
  } = useFieldArray({ control: ruleForm.control, name: "windows" });
  const selectedRuleType = ruleForm.watch("rule_type");
  const modelForm = useForm<UnifiedModelValues, unknown, UnifiedModelValues>({
    resolver: zodResolver(UnifiedModelSchema),
    defaultValues: { alias: "", display_name: "" },
  });
  const routeForm = useForm<RouteInput, unknown, RouteValues>({
    resolver: zodResolver(RouteSchema),
    defaultValues: {
      unified_model_id: "",
      provider_resource_id: "",
      upstream_model: "",
      priority: 100,
      weight: 1,
    },
  });
  const policyForm = useForm<DispatchPolicyInput, unknown, DispatchPolicyValues>({
    resolver: zodResolver(DispatchPolicyFormSchema),
    defaultValues: {
      match_unified_model: "",
      match_resource_mode: "",
      match_provider_resource_id: "",
      match_timezone: "Asia/Shanghai",
      match_days_of_week: "1,2,3,4,5,6,7",
      match_start_time: "14:00",
      match_end_time: "18:00",
      match_price_multiplier_min: "",
      match_remaining_quota_ratio_max: "",
      match_forecast_exhaust_risk: false,
      match_principal_scope_mode: "ALL",
      match_principal_scope: [],
      action: "REJECT",
      switch_equivalent_group: "",
      rate_limit_per_minute: "",
      policy_version: "v1",
      priority: 100,
      description: "",
    },
  });
  const selectedPolicyAction = policyForm.watch("action");
  const principalScopeMode = policyForm.watch("match_principal_scope_mode");
  const selectedPrincipalIds = policyForm.watch("match_principal_scope");

  useEffect(() => {
    if (selectedRuleType === "API_PRICE") {
      ruleForm.setValue("multiplier", "");
      return;
    }
    if (selectedRuleType === "TIME_WINDOW" || selectedRuleType === "MODEL_TIER") {
      ruleForm.setValue("cache_hit_price", "");
      ruleForm.setValue("cache_miss_price", "");
      ruleForm.setValue("output_price", "");
      if (!ruleForm.getValues("multiplier")) ruleForm.setValue("multiplier", "1");
    }
    if (selectedRuleType === "MODEL_TIER") {
      replaceRuleWindows([]);
    }
  }, [replaceRuleWindows, ruleForm, selectedRuleType]);

  const refreshRules = () =>
    queryClient.invalidateQueries({ queryKey: QUERY_KEYS.billingRules });
  const refreshPolicies = () =>
    queryClient.invalidateQueries({ queryKey: QUERY_KEYS.dispatchPolicies });
  const refreshModels = () =>
    queryClient.invalidateQueries({ queryKey: QUERY_KEYS.unifiedModels });
  const refreshRoutes = (modelId: string) =>
    queryClient.invalidateQueries({ queryKey: QUERY_KEYS.modelRoutes(modelId) });

  const createRule = useMutation({
    mutationFn: (values: BillingRuleValues) =>
      post("/billing-rules", buildBillingRulePayload(values)),
    onSuccess: () => {
      setShowRuleForm(false);
      setSelectedRuleRouteId("");
      ruleForm.reset();
      void refreshRules();
    },
  });
  const updateRule = useMutation({
    mutationFn: (input: { rule: BillingRule; patch: Record<string, unknown> }) =>
      patch(`/billing-rules/${input.rule.id}`, {
        expected_version: input.rule.version,
        ...input.patch,
      }),
    onSuccess: () => void refreshRules(),
  });
  const createPolicy = useMutation({
    mutationFn: (values: DispatchPolicyValues) =>
      editingPolicy
        ? patch(`/dispatch-policies/${editingPolicy.id}`, buildDispatchPolicyPayload(values))
        : post("/dispatch-policies", buildDispatchPolicyPayload(values)),
    onSuccess: () => {
      setShowPolicyForm(false);
      setEditingPolicy(null);
      policyForm.reset();
      void refreshPolicies();
    },
  });
  const transitionPolicy = useMutation({
    mutationFn: (input: {
      policy: DispatchPolicy;
      action: "validate" | "publish" | "retire" | "copy" | "restore";
    }) => post(`/dispatch-policies/${input.policy.id}/${input.action}`),
    onSuccess: () => {
      setPolicyActionTarget(null);
      void refreshPolicies();
    },
  });
  const createModel = useMutation({
    mutationFn: (values: UnifiedModelValues) => post("/unified-models", values),
    onSuccess: () => {
      setShowModelForm(false);
      modelForm.reset();
      void refreshModels();
    },
  });
  const updateModel = useMutation({
    mutationFn: (input: { model: UnifiedModel; status: "ACTIVE" | "DISABLED" }) =>
      patch(`/unified-models/${input.model.id}`, {
        expected_version: input.model.version,
        status: input.status,
      }),
    onSuccess: () => {
      setDisableModelTarget(null);
      void refreshModels();
    },
  });
  const createRoute = useMutation({
    mutationFn: (values: RouteValues) =>
      post("/model-routes", { ...values, enabled: true }),
    onSuccess: (_data, values) => {
      setShowRouteForm(false);
      setSelectedModelId(values.unified_model_id);
      routeForm.reset({ ...routeForm.getValues(), unified_model_id: values.unified_model_id });
      void refreshRoutes(values.unified_model_id);
    },
  });
  const updateRoute = useMutation({
    mutationFn: (input: { route: ModelRouteItem; enabled: boolean }) =>
      patch(`/model-routes/${input.route.id}`, {
        expected_version: input.route.version,
        enabled: input.enabled,
      }),
    onSuccess: (_data, input) => {
      setDisableRouteTarget(null);
      void refreshRoutes(input.route.unified_model_id);
    },
  });
  const archiveConfig = useMutation({
    mutationFn: (input:
      | { kind: "model"; item: UnifiedModel; archive: boolean }
      | { kind: "route"; item: ModelRouteItem; archive: boolean }
      | { kind: "rule"; item: BillingRule; archive: boolean }) => {
      const base = input.kind === "model"
        ? "unified-models"
        : input.kind === "route"
          ? "model-routes"
          : "billing-rules";
      return post(`/${base}/${input.item.id}/${input.archive ? "archive" : "unarchive"}`, {
        expected_version: input.item.version,
      });
    },
    onSuccess: () => {
      setArchiveTarget(null);
      void refreshModels();
      void refreshRules();
      if (selectedModelId) void refreshRoutes(selectedModelId);
    },
  });

  const allRules = rulesQuery.data?.rules ?? [];
  const policies = policiesQuery.data?.policies ?? [];
  const allRoutes = routesQuery.data?.routes ?? [];
  const visibleModels = models.filter((model) => showArchived === Boolean(model.archived_at));
  const rules = allRules.filter((rule) => showArchived === Boolean(rule.archived_at));
  const routes = allRoutes.filter((route) => showArchived === Boolean(route.archived_at));
  const hasActiveModels = models.some((model) => model.status === "ACTIVE" && !model.archived_at);
  const canCreateRoute = hasActiveModels && resources.length > 0;
  const enabledRoutes = allRoutes.filter((route) => route.enabled && !route.archived_at);
  const canCreateRule = canCreateRoute && enabledRoutes.length > 0;
  const principalById = new Map(principals.map((principal) => [principal.id, principal]));

  const editPolicy = (policy: DispatchPolicy) => {
    const scope = policy.matchPrincipalScope ?? [];
    setEditingPolicy(policy);
    setShowPolicyForm(true);
    policyForm.reset({
      match_unified_model: policy.matchUnifiedModel ?? "",
      match_resource_mode: (policy.matchResourceMode as "" | "API" | "CODING_PLAN") ?? "",
      match_provider_resource_id: policy.matchProviderResourceId ?? "",
      match_timezone: policy.matchTimezone ?? "",
      match_days_of_week: policy.matchDaysOfWeek?.join(",") ?? "",
      match_start_time: policy.matchStartTime?.slice(0, 5) ?? "",
      match_end_time: policy.matchEndTime?.slice(0, 5) ?? "",
      match_price_multiplier_min: policy.matchPriceMultiplierMin ?? "",
      match_remaining_quota_ratio_max: policy.matchRemainingQuotaRatioMax ?? "",
      match_forecast_exhaust_risk: policy.matchForecastExhaustRisk ?? false,
      match_principal_scope_mode: scope.length > 0 ? "SELECTED" : "ALL",
      match_principal_scope: scope,
      action: policy.action,
      switch_equivalent_group: policy.switchEquivalentGroup.join(","),
      rate_limit_per_minute: policy.rateLimitPerMinute?.toString() ?? "",
      policy_version: policy.policyVersion,
      priority: policy.priority,
      description: policy.description ?? "",
    });
  };
  const error =
    createRule.error ??
    updateRule.error ??
    createPolicy.error ??
    transitionPolicy.error ??
    createModel.error ??
    updateModel.error ??
    createRoute.error ??
    updateRoute.error ??
    archiveConfig.error;

  return (
    <PageShell
      description="按统一模型、Model Route、计价规则模板、调度策略的依赖顺序配置"
      title="额度规则"
    >
      {error ? (
        <p className="mb-4 rounded-lg bg-ql-danger-soft p-3 text-[13px] text-ql-danger" role="alert">
          {error.message}
        </p>
      ) : null}

      <DepartmentBudgetEntry />
      <label className="mb-4 inline-flex items-center gap-2 text-[12px] text-ql-fg-secondary">
        <input checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} type="checkbox" />
        查看已归档配置（历史、快照和审计仍保留）
      </label>

      <ManagementSection
        actionLabel="新建统一模型"
        hint="第 1 步：先定义对客户端稳定暴露的统一模型；创建后继续配置 Model Route。"
        onAction={() => setShowModelForm((value) => !value)}
        title="统一模型"
      >
        {showModelForm ? (
          <form
            className="mb-4 grid grid-cols-1 gap-3 rounded-lg border border-ql-border-zone bg-ql-surface-subtle p-4 sm:grid-cols-2"
            onSubmit={modelForm.handleSubmit((values) => createModel.mutate(values))}
          >
            <FormField error={modelForm.formState.errors.alias?.message} htmlFor="model-alias" label="模型别名">
              <input className={INPUT_CLASS} id="model-alias" {...modelForm.register("alias")} />
            </FormField>
            <FormField
              error={modelForm.formState.errors.display_name?.message}
              htmlFor="model-display-name"
              label="显示名称"
            >
              <input className={INPUT_CLASS} id="model-display-name" {...modelForm.register("display_name")} />
            </FormField>
            <div className="sm:col-span-2 flex justify-end">
              <button className="h-9 rounded-lg bg-ql-action px-4 text-[13px] font-medium text-white" type="submit">
                创建模型
              </button>
            </div>
          </form>
        ) : null}
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-[12px]">
            <thead>
              <tr className="border-b border-ql-border text-ql-fg-tertiary">
                <th className="p-2 font-medium">别名</th>
                <th className="p-2 font-medium">名称</th>
                <th className="p-2 font-medium">状态</th>
                <th className="p-2 text-right font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {visibleModels.map((model) => (
                <tr className="border-b border-ql-border-zone last:border-b-0" key={model.id}>
                  <td className="p-2 font-mono">{model.alias}</td>
                  <td className="p-2">{model.display_name}</td>
                  <td className="p-2">{model.archived_at ? "已归档" : model.status === "ACTIVE" ? "启用" : "停用"}</td>
                  <td className="p-2 text-right">
                    <button
                      className="rounded px-2 py-1 text-ql-action hover:bg-ql-action-soft"
                      onClick={() => setSelectedModelId(model.id)}
                      type="button"
                    >
                      管理路由
                    </button>
                    {model.archived_at ? (
                      <button
                        className="rounded px-2 py-1 text-ql-action hover:bg-ql-action-soft"
                        onClick={() => archiveConfig.mutate({ kind: "model", item: model, archive: false })}
                        type="button"
                      >
                        取消归档
                      </button>
                    ) : model.status === "ACTIVE" ? (
                      <button
                        className="rounded px-2 py-1 text-ql-danger hover:bg-ql-danger-soft"
                        onClick={() => setDisableModelTarget(model)}
                        type="button"
                      >
                        停用
                      </button>
                    ) : (
                      <button
                        className="rounded px-2 py-1 text-ql-fg-secondary hover:bg-ql-surface-muted"
                        onClick={() => setArchiveTarget({ kind: "model", item: model })}
                        type="button"
                      >
                        归档
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </ManagementSection>

      <ManagementSection
        actionLabel="新建路由"
        actionDisabled={!canCreateRoute}
        hint={
          canCreateRoute
            ? "第 2 步：为统一模型绑定可调用的厂商资源；启用路由后继续配置计价规则。"
            : hasActiveModels
              ? "前置条件：尚未登记厂商资源，请先到「厂商资源」页面登记。"
              : "前置条件：先在上方创建并启用统一模型，才能新建 Model Route。"
        }
        onAction={() => {
          setShowRouteForm((value) => !value);
          routeForm.setValue("unified_model_id", selectedModelId ?? "");
        }}
        title="Model Route"
      >
        <div className="mb-3 max-w-sm">
          <FormField htmlFor="route-model-filter" label="查看统一模型">
            <select
              className={`${INPUT_CLASS} w-full`}
              id="route-model-filter"
              onChange={(event) => {
                setSelectedModelId(event.target.value || null);
                setSelectedRuleRouteId("");
                ruleForm.setValue("provider_resource_id", "");
                ruleForm.setValue("upstream_model", "");
              }}
              value={selectedModelId ?? ""}
            >
              <option value="">请选择</option>
              {models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.display_name}{model.archived_at ? "（已归档）" : ""}
                </option>
              ))}
            </select>
          </FormField>
        </div>
        {showRouteForm ? (
          <form
            className="mb-4 grid grid-cols-1 gap-3 rounded-lg border border-ql-border-zone bg-ql-surface-subtle p-4 md:grid-cols-5"
            onSubmit={routeForm.handleSubmit((values) => createRoute.mutate(values))}
          >
            <FormField
              error={routeForm.formState.errors.unified_model_id?.message}
              htmlFor="route-model"
              label="统一模型"
            >
              <select className={INPUT_CLASS} id="route-model" {...routeForm.register("unified_model_id")}>
                <option value="">请选择</option>
                {models.filter((model) => model.status === "ACTIVE" && !model.archived_at).map((model) => (
                  <option key={model.id} value={model.id}>{model.display_name}</option>
                ))}
              </select>
            </FormField>
            <FormField
              error={routeForm.formState.errors.provider_resource_id?.message}
              htmlFor="route-resource"
              label="厂商资源"
            >
              <select
                className={INPUT_CLASS}
                id="route-resource"
                {...routeForm.register("provider_resource_id")}
              >
                <option value="">请选择</option>
                {resources.map((resource) => (
                  <option key={resource.id} value={resource.id}>{resource.name}</option>
                ))}
              </select>
            </FormField>
            <FormField
              error={routeForm.formState.errors.upstream_model?.message}
              htmlFor="route-upstream"
              label="上游模型"
            >
              <input className={INPUT_CLASS} id="route-upstream" {...routeForm.register("upstream_model")} />
            </FormField>
            <FormField error={routeForm.formState.errors.priority?.message} htmlFor="route-priority" label="优先级">
              <input className={INPUT_CLASS} id="route-priority" type="number" {...routeForm.register("priority")} />
            </FormField>
            <FormField error={routeForm.formState.errors.weight?.message} htmlFor="route-weight" label="权重">
              <input className={INPUT_CLASS} id="route-weight" type="number" {...routeForm.register("weight")} />
            </FormField>
            <div className="md:col-span-5 flex justify-end">
              <button className="h-9 rounded-lg bg-ql-action px-4 text-[13px] font-medium text-white" type="submit">
                创建路由
              </button>
            </div>
          </form>
        ) : null}
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-[12px]">
            <thead>
              <tr className="border-b border-ql-border text-ql-fg-tertiary">
                <th className="p-2 font-medium">上游模型</th>
                <th className="p-2 font-medium">资源</th>
                <th className="p-2 text-right font-medium">优先级</th>
                <th className="p-2 text-right font-medium">权重</th>
                <th className="p-2 font-medium">状态</th>
                <th className="p-2 text-right font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {routes.map((route) => (
                <tr className="border-b border-ql-border-zone last:border-b-0" key={route.id}>
                  <td className="p-2 font-mono">{route.upstream_model}</td>
                  <td className="p-2">
                    {resources.find((resource) => resource.id === route.provider_resource_id)?.name ??
                      route.provider_resource_id}
                  </td>
                  <td className="p-2 text-right">{route.priority}</td>
                  <td className="p-2 text-right">{route.weight}</td>
                  <td className="p-2">{route.archived_at ? "已归档" : route.enabled ? "启用" : "停用"}</td>
                  <td className="p-2 text-right">
                    {route.archived_at ? (
                      <button
                        className="rounded px-2 py-1 text-ql-action hover:bg-ql-action-soft"
                        onClick={() => archiveConfig.mutate({ kind: "route", item: route, archive: false })}
                        type="button"
                      >
                        取消归档
                      </button>
                    ) : route.enabled ? (
                      <button
                        className="rounded px-2 py-1 text-ql-danger hover:bg-ql-danger-soft"
                        onClick={() => setDisableRouteTarget(route)}
                        type="button"
                      >
                        停用
                      </button>
                    ) : <>
                      <button className="rounded px-2 py-1 text-ql-action hover:bg-ql-action-soft"
                        onClick={() => updateRoute.mutate({ route, enabled: true })} type="button">启用</button>
                      <button className="rounded px-2 py-1 text-ql-fg-secondary hover:bg-ql-surface-muted"
                        onClick={() => setArchiveTarget({ kind: "route", item: route })} type="button">归档</button>
                    </>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </ManagementSection>

      <ManagementSection
        actionLabel="新建规则"
        actionDisabled={!canCreateRule}
        hint={
          canCreateRule
            ? "前置条件已满足。创建计价规则后，继续检查下方调度策略。"
            : "前置条件：先创建统一模型、登记厂商资源，并至少启用一条 Model Route。"
        }
        onAction={() => setShowRuleForm((value) => !value)}
        title="计价规则模板"
      >
        {showRuleForm ? (
          <form
            className="mb-4 grid grid-cols-1 gap-3 rounded-lg border border-ql-border-zone bg-ql-surface-subtle p-4 md:grid-cols-4"
            onSubmit={ruleForm.handleSubmit((values) => createRule.mutate(values))}
          >
            <FormField
              error={ruleForm.formState.errors.rule_type?.message}
              htmlFor="rule-type"
              label="规则类型"
            >
              <select className={INPUT_CLASS} id="rule-type" {...ruleForm.register("rule_type")}>
                <option value="API_PRICE">API Token 计价</option>
                <option value="TIME_WINDOW">时段倍率</option>
                <option value="MODEL_TIER">模型分层</option>
                <option value="CACHE_STATE">缓存状态</option>
              </select>
            </FormField>
            <FormField
              error={ruleForm.formState.errors.rule_version?.message}
              htmlFor="rule-version"
              label="规则版本"
            >
              <input className={INPUT_CLASS} id="rule-version" {...ruleForm.register("rule_version")} />
            </FormField>
            <FormField
              error={
                ruleForm.formState.errors.provider_resource_id?.message ??
                ruleForm.formState.errors.upstream_model?.message
              }
              htmlFor="rule-resource"
              label="启用 Model Route"
            >
              <select
                className={INPUT_CLASS}
                id="rule-resource"
                onChange={(event) => {
                  const route = enabledRoutes.find((item) => item.id === event.target.value);
                  setSelectedRuleRouteId(event.target.value);
                  ruleForm.setValue(
                    "provider_resource_id",
                    route?.provider_resource_id ?? "",
                    { shouldValidate: true },
                  );
                  ruleForm.setValue("upstream_model", route?.upstream_model ?? "", {
                    shouldValidate: true,
                  });
                }}
                value={selectedRuleRouteId}
              >
                <option value="">请选择</option>
                {enabledRoutes.map((route) => (
                  <option key={route.id} value={route.id}>
                    {resources.find((resource) => resource.id === route.provider_resource_id)?.name ??
                      route.provider_resource_id}
                    {" · "}
                    {route.upstream_model}
                  </option>
                ))}
              </select>
              <input type="hidden" {...ruleForm.register("provider_resource_id")} />
              <input type="hidden" {...ruleForm.register("upstream_model")} />
            </FormField>
            <FormField
              error={ruleForm.formState.errors.effective_from?.message}
              htmlFor="rule-effective-from"
              label="生效时间"
            >
              <input
                className={INPUT_CLASS}
                id="rule-effective-from"
                type="datetime-local"
                {...ruleForm.register("effective_from")}
              />
            </FormField>
            <FormField
              error={ruleForm.formState.errors.effective_to?.message}
              htmlFor="rule-effective-to"
              label="失效时间（可空）"
            >
              <input
                className={INPUT_CLASS}
                id="rule-effective-to"
                type="datetime-local"
                {...ruleForm.register("effective_to")}
              />
            </FormField>
            {selectedRuleType !== "MODEL_TIER" ? (
              <div className="md:col-span-4 rounded-lg border border-ql-border-zone p-3">
                <div className="mb-2 flex items-center justify-between">
                  <div>
                    <p className="text-[12px] font-medium text-ql-fg">时间窗口</p>
                    <p className="text-[11px] text-ql-fg-tertiary">可配置多段；开始含、结束不含。</p>
                  </div>
                  <button
                    className="rounded px-2 py-1 text-[12px] text-ql-action hover:bg-ql-action-soft"
                    onClick={() => appendRuleWindow({
                      timezone: "Asia/Shanghai",
                      days_of_week: "1,2,3,4,5,6,7",
                      start_time: "09:00",
                      end_time: "12:00",
                    })}
                    type="button"
                  >
                    添加窗口
                  </button>
                </div>
                {(ruleForm.formState.errors.windows as { message?: string } | undefined)?.message ? (
                  <p className="mb-2 text-[11px] text-ql-danger">
                    {(ruleForm.formState.errors.windows as { message?: string }).message}
                  </p>
                ) : null}
                <div className="flex flex-col gap-2">
                  {ruleWindowFields.map((field, index) => (
                    <div
                      className="grid grid-cols-1 gap-2 rounded border border-ql-border-zone p-2 md:grid-cols-5"
                      key={field.id}
                    >
                      <FormField
                        error={ruleForm.formState.errors.windows?.[index]?.timezone?.message}
                        htmlFor={`rule-window-${index}-timezone`}
                        label="IANA 时区"
                      >
                        <input
                          className={INPUT_CLASS}
                          id={`rule-window-${index}-timezone`}
                          {...ruleForm.register(`windows.${index}.timezone`)}
                        />
                      </FormField>
                      <FormField
                        error={ruleForm.formState.errors.windows?.[index]?.days_of_week?.message}
                        htmlFor={`rule-window-${index}-days`}
                        label="星期"
                      >
                        <WeekdayPicker
                          value={ruleForm.watch(`windows.${index}.days_of_week`) ?? ""}
                          onChange={(next) =>
                            ruleForm.setValue(`windows.${index}.days_of_week`, next, { shouldValidate: true })
                          }
                        />
                      </FormField>
                      <FormField
                        error={ruleForm.formState.errors.windows?.[index]?.start_time?.message}
                        htmlFor={`rule-window-${index}-start`}
                        label="开始（含）"
                      >
                        <input
                          className={INPUT_CLASS}
                          id={`rule-window-${index}-start`}
                          type="time"
                          {...ruleForm.register(`windows.${index}.start_time`)}
                        />
                      </FormField>
                      <FormField
                        error={ruleForm.formState.errors.windows?.[index]?.end_time?.message}
                        htmlFor={`rule-window-${index}-end`}
                        label="结束（不含）"
                      >
                        <input
                          className={INPUT_CLASS}
                          id={`rule-window-${index}-end`}
                          type="time"
                          {...ruleForm.register(`windows.${index}.end_time`)}
                        />
                      </FormField>
                      <div className="flex items-end">
                        <button
                          className="h-9 rounded px-2 text-[12px] text-ql-danger hover:bg-ql-danger-soft"
                          onClick={() => removeRuleWindow(index)}
                          type="button"
                        >
                          删除
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
            <FormField
              error={ruleForm.formState.errors.multiplier?.message}
              htmlFor="rule-multiplier"
              label="套餐用量倍率"
            >
              <input className={INPUT_CLASS} id="rule-multiplier" {...ruleForm.register("multiplier")} />
            </FormField>
            <FormField
              error={ruleForm.formState.errors.cache_hit_price?.message}
              htmlFor="rule-cache-hit"
              label="缓存命中单价"
            >
              <input className={INPUT_CLASS} id="rule-cache-hit" {...ruleForm.register("cache_hit_price")} />
            </FormField>
            <FormField
              error={ruleForm.formState.errors.cache_miss_price?.message}
              htmlFor="rule-cache-miss"
              label="输入单价"
            >
              <input className={INPUT_CLASS} id="rule-cache-miss" {...ruleForm.register("cache_miss_price")} />
            </FormField>
            <FormField
              error={ruleForm.formState.errors.output_price?.message}
              htmlFor="rule-output"
              label="输出单价"
            >
              <input className={INPUT_CLASS} id="rule-output" {...ruleForm.register("output_price")} />
            </FormField>
            <FormField
              error={ruleForm.formState.errors.priority?.message}
              htmlFor="rule-priority"
              label="优先级"
            >
              <input className={INPUT_CLASS} id="rule-priority" type="number" {...ruleForm.register("priority")} />
            </FormField>
            <div className="md:col-span-4 flex justify-end">
              <button
                className="h-9 rounded-lg bg-ql-action px-4 text-[13px] font-medium text-white disabled:opacity-60"
                disabled={createRule.isPending}
                type="submit"
              >
                创建规则
              </button>
            </div>
          </form>
        ) : null}
        <p className="mb-3 text-[11px] text-ql-fg-tertiary">
          价格、倍率、时间窗和优先级属于规则版本，不可原地改写；变更时请新建
          rule_version，并用生效/失效时间完成切换。
        </p>
        <QueryGate
          emptyDescription="先登记厂商资源，再创建用于账本结算的计价规则模板。"
          emptyIcon={Gauge}
          emptyTitle="尚未配置计价规则"
          error={rulesQuery.error}
          isEmpty={rules.length === 0}
          isLoading={rulesQuery.isLoading}
          onRetry={() => void rulesQuery.refetch()}
        >
          <table className="w-full border-collapse text-left text-[12px]">
            <thead>
              <tr className="border-b border-ql-border text-ql-fg-tertiary">
                <th className="p-2 font-medium">版本</th>
                <th className="p-2 font-medium">类型</th>
                <th className="p-2 font-medium">上游模型</th>
                <th className="p-2 font-medium">时段 [开始,结束)</th>
                <th className="p-2 text-right font-medium">单价 / 倍率</th>
                <th className="p-2 font-medium">状态</th>
                <th className="p-2 text-right font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {rules.map((rule) => (
                <tr className="border-b border-ql-border-zone last:border-b-0" key={rule.id}>
                  <td className="p-2 font-mono">{rule.rule_version}</td>
                  <td className="p-2">{rule.rule_type}</td>
                  <td className="p-2">{rule.upstream_model ?? "全部"}</td>
                  <td className="p-2 font-mono">
                    {editableWindows(rule).length > 0
                      ? editableWindows(rule)
                          .map((window) =>
                            `${formatDaysOfWeek(parseDaysOfWeek(window.days_of_week))} ${window.timezone} ${window.start_time}–${window.end_time}`)
                          .join("；")
                      : "基础规则（全天）"}
                  </td>
                  <td className="p-2 text-right font-mono">
                    {rule.rule_type === "API_PRICE"
                      ? `${rule.cache_hit_price ?? "—"} / ${rule.cache_miss_price ?? "—"} / ${rule.output_price ?? "—"}`
                      : `×${rule.multiplier ?? "—"}`}
                  </td>
                  <td className="p-2">
                    <StatusTag tone={rule.enabled ? "neutral" : "warning"}>
                      {rule.archived_at ? "已归档" : rule.enabled ? "启用" : "停用"}
                    </StatusTag>
                  </td>
                  <td className="p-2 text-right">
                    {rule.archived_at ? (
                      <button className="rounded px-2 py-1 text-ql-action hover:bg-ql-action-soft"
                        onClick={() => archiveConfig.mutate({ kind: "rule", item: rule, archive: false })}
                        type="button">取消归档</button>
                    ) : <>
                      <button className="rounded px-2 py-1 text-ql-fg-secondary hover:bg-ql-surface-muted"
                        onClick={() => updateRule.mutate({ rule, patch: { enabled: !rule.enabled } })}
                        type="button">{rule.enabled ? "停用" : "启用"}</button>
                      {!rule.enabled ? <button className="rounded px-2 py-1 text-ql-fg-secondary hover:bg-ql-surface-muted"
                        onClick={() => setArchiveTarget({ kind: "rule", item: rule })}
                        type="button">归档</button> : null}
                    </>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </QueryGate>
      </ManagementSection>

      <ManagementSection
        actionLabel="新建调度策略"
        hint="第 4 步：计价规则准备完成后，已发布策略才会参与请求调度；策略版本和历史决策保持不变。"
        onAction={() => {
          setEditingPolicy(null);
          policyForm.reset();
          setShowPolicyForm((value) => !value);
        }}
        title="调度策略"
      >
        {showPolicyForm ? (
          <form
            className="mb-4 grid grid-cols-1 gap-3 rounded-lg border border-ql-border-zone bg-ql-surface-subtle p-4 md:grid-cols-4"
            onSubmit={policyForm.handleSubmit((values) => createPolicy.mutate(values))}
          >
            <FormField
              error={policyForm.formState.errors.policy_version?.message}
              htmlFor="policy-version"
              label="策略版本"
            >
              <input className={INPUT_CLASS} id="policy-version" {...policyForm.register("policy_version")} />
            </FormField>
            <FormField
              error={policyForm.formState.errors.priority?.message}
              htmlFor="policy-priority"
              label="优先级（小值优先）"
            >
              <input className={INPUT_CLASS} id="policy-priority" type="number" {...policyForm.register("priority")} />
            </FormField>
            <FormField
              error={policyForm.formState.errors.match_unified_model?.message}
              htmlFor="policy-model"
              label="统一模型"
            >
              <select className={INPUT_CLASS} id="policy-model" {...policyForm.register("match_unified_model")}>
                <option value="">不限模型</option>
                {models.filter((model) => model.status === "ACTIVE").map((model) => (
                  <option key={model.id} value={model.alias}>{model.display_name}（{model.alias}）</option>
                ))}
              </select>
            </FormField>
            <FormField
              error={policyForm.formState.errors.match_provider_resource_id?.message}
              htmlFor="policy-resource"
              label="厂商资源"
            >
              <select
                className={INPUT_CLASS}
                id="policy-resource"
                {...policyForm.register("match_provider_resource_id")}
              >
                <option value="">不限资源</option>
                {resources.map((resource) => (
                  <option key={resource.id} value={resource.id}>{resource.name}</option>
                ))}
              </select>
            </FormField>
            <FormField
              error={policyForm.formState.errors.match_resource_mode?.message}
              htmlFor="policy-mode"
              label="资源模式"
            >
              <select className={INPUT_CLASS} id="policy-mode" {...policyForm.register("match_resource_mode")}>
                <option value="">不限模式</option>
                <option value="API">API</option>
                <option value="CODING_PLAN">套餐</option>
              </select>
            </FormField>
            <FormField
              error={policyForm.formState.errors.match_timezone?.message}
              htmlFor="policy-timezone"
              label="IANA 时区"
            >
              <input className={INPUT_CLASS} id="policy-timezone" {...policyForm.register("match_timezone")} />
            </FormField>
            <FormField
              error={policyForm.formState.errors.match_days_of_week?.message}
              htmlFor="policy-days"
              label="星期"
            >
              <WeekdayPicker
                value={policyForm.watch("match_days_of_week") ?? ""}
                onChange={(next) => policyForm.setValue("match_days_of_week", next, { shouldValidate: true })}
              />
            </FormField>
            <FormField
              error={policyForm.formState.errors.match_start_time?.message}
              htmlFor="policy-start"
              label="开始（含）"
            >
              <input className={INPUT_CLASS} id="policy-start" type="time" {...policyForm.register("match_start_time")} />
            </FormField>
            <FormField
              error={policyForm.formState.errors.match_end_time?.message}
              htmlFor="policy-end"
              label="结束（不含）"
            >
              <input className={INPUT_CLASS} id="policy-end" type="time" {...policyForm.register("match_end_time")} />
            </FormField>
            <FormField
              error={policyForm.formState.errors.action?.message}
              htmlFor="policy-action"
              label="动作"
            >
              <select className={INPUT_CLASS} id="policy-action" {...policyForm.register("action")}>
                <option value="REJECT">REJECT（硬拒绝）</option>
                <option value="SWITCH">SWITCH（切换）</option>
                <option value="RATE_LIMIT">RATE_LIMIT（限流）</option>
                <option value="ALLOW">ALLOW（允许）</option>
                <option value="ALLOW_OVERAGE">ALLOW_OVERAGE（允许超额）</option>
              </select>
            </FormField>
            {selectedPolicyAction === "SWITCH" ? (
              <FormField
                error={policyForm.formState.errors.switch_equivalent_group?.message}
                hint="至少两个资源 ID，用英文逗号分隔"
                htmlFor="policy-switch-group"
                label="等价资源组"
              >
                <input className={INPUT_CLASS} id="policy-switch-group" {...policyForm.register("switch_equivalent_group")} />
              </FormField>
            ) : null}
            {selectedPolicyAction === "RATE_LIMIT" ? (
              <FormField
                error={policyForm.formState.errors.rate_limit_per_minute?.message}
                htmlFor="policy-rate-limit"
                label="每分钟请求数"
              >
                <input
                  className={INPUT_CLASS}
                  id="policy-rate-limit"
                  inputMode="numeric"
                  {...policyForm.register("rate_limit_per_minute")}
                />
              </FormField>
            ) : null}
            <FormField
              error={policyForm.formState.errors.match_price_multiplier_min?.message}
              htmlFor="policy-price-multiplier"
              label="最低价格倍率（可空）"
            >
              <input className={INPUT_CLASS} id="policy-price-multiplier" {...policyForm.register("match_price_multiplier_min")} />
            </FormField>
            <FormField
              error={policyForm.formState.errors.match_remaining_quota_ratio_max?.message}
              htmlFor="policy-quota-ratio"
              label="最大剩余额度比例（可空）"
            >
              <input className={INPUT_CLASS} id="policy-quota-ratio" {...policyForm.register("match_remaining_quota_ratio_max")} />
            </FormField>
            <PrincipalScopeField
              error={policyForm.formState.errors.match_principal_scope?.message}
              mode={principalScopeMode}
              onModeChange={(mode) => {
                policyForm.setValue("match_principal_scope_mode", mode, { shouldValidate: true });
                policyForm.setValue("match_principal_scope", [], { shouldValidate: true });
              }}
              onSearch={setPrincipalSearch}
              onSelectedIdsChange={(ids) =>
                policyForm.setValue("match_principal_scope", ids, { shouldValidate: true })
              }
              principals={principals}
              search={principalSearch}
              selectedIds={selectedPrincipalIds}
            />
            <label className="flex items-center gap-2 self-end pb-2 text-[12px] text-ql-fg">
              <input type="checkbox" {...policyForm.register("match_forecast_exhaust_risk")} />
              仅预计耗尽时命中
            </label>
            <FormField
              error={policyForm.formState.errors.description?.message}
              htmlFor="policy-description"
              label="说明"
            >
              <input className={INPUT_CLASS} id="policy-description" {...policyForm.register("description")} />
            </FormField>
            <div className="md:col-span-4 flex justify-end">
              <button
                className="h-9 rounded-lg bg-ql-action px-4 text-[13px] font-medium text-white disabled:opacity-60"
                disabled={createPolicy.isPending}
                type="submit"
              >
                {editingPolicy ? "保存草稿" : "创建草稿"}
              </button>
            </div>
          </form>
        ) : null}
        <p className="mb-3 text-[11px] leading-5 text-ql-fg-tertiary">
          生命周期：草稿 → 校验通过 → 发布 → 停用。只有已发布策略进入 Gateway 热路径；
          调度先于计价执行，REJECT 不进入上游、Attempt、Usage 或计量。调度优先级与计价优先级分别只在各自体系内比较。
        </p>
        <QueryGate
          emptyDescription="创建策略草稿，校验引用后再发布；未发布策略不会影响请求。"
          emptyIcon={Gauge}
          emptyTitle="尚未配置调度策略"
          error={policiesQuery.error}
          isEmpty={policies.length === 0}
          isLoading={policiesQuery.isLoading}
          onRetry={() => void policiesQuery.refetch()}
        >
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-[12px]">
              <thead>
                <tr className="border-b border-ql-border text-ql-fg-tertiary">
                  <th className="p-2 font-medium">版本</th>
                  <th className="p-2 font-medium">模型 / 资源</th>
                  <th className="p-2 font-medium">时段</th>
                  <th className="p-2 font-medium">动作</th>
                  <th className="p-2 font-medium">主体范围</th>
                  <th className="p-2 text-right font-medium">优先级</th>
                  <th className="p-2 font-medium">状态</th>
                  <th className="p-2 font-medium">时间线 / 操作人</th>
                  <th className="p-2 text-right font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {policies.map((policy) => (
                  <tr className="border-b border-ql-border-zone last:border-b-0" key={policy.id}>
                    <td className="p-2 font-mono">{policy.policyVersion}</td>
                    <td className="p-2">
                      {policy.matchUnifiedModel ?? "全部模型"}
                      <span className="block text-ql-fg-tertiary">
                        {resources.find((resource) => resource.id === policy.matchProviderResourceId)?.name
                          ?? (policy.matchProviderResourceId ? "指定资源" : "全部资源")}
                      </span>
                    </td>
                    <td className="p-2 font-mono">
                      {policy.matchTimezone && policy.matchStartTime && policy.matchEndTime
                        ? `${formatDaysOfWeek(policy.matchDaysOfWeek)} ${policy.matchTimezone} ${policy.matchStartTime}–${policy.matchEndTime}`
                        : "全天"}
                    </td>
                    <td className="p-2 font-mono">{policy.action}</td>
                    <td className="p-2">
                      {principalScopeText(policy.matchPrincipalScope, principalById)}
                    </td>
                    <td className="p-2 text-right">{policy.priority}</td>
                    <td className="p-2">
                      <StatusTag tone={policy.status === "PUBLISHED" ? "neutral" : "warning"}>
                        {policy.status}
                      </StatusTag>
                    </td>
                    <td className="min-w-64 p-2 text-[11px] leading-5 text-ql-fg-tertiary">
                      <span className="block">创建 {formatLifecycle(policy.createdAt, policy.createdByAdminId)}</span>
                      {policy.validatedAt ? <span className="block">校验 {formatLifecycle(policy.validatedAt, policy.validatedByAdminId)}</span> : null}
                      {policy.publishedAt ? <span className="block">发布 {formatLifecycle(policy.publishedAt, policy.publishedByAdminId)}</span> : null}
                      {policy.effectiveAt ? <span className="block">生效 {formatLifecycle(policy.effectiveAt, policy.publishedByAdminId)}</span> : null}
                      {policy.retiredAt ? <span className="block">停用 {formatLifecycle(policy.retiredAt, policy.retiredByAdminId)}</span> : null}
                    </td>
                    <td className="p-2 text-right">
                      {policy.status === "DRAFT" ? (
                        <>
                          <button
                            className="rounded px-2 py-1 text-ql-action hover:bg-ql-action-soft"
                            onClick={() => editPolicy(policy)}
                            type="button"
                          >
                            编辑
                          </button>
                          <button
                            className="rounded px-2 py-1 text-ql-action hover:bg-ql-action-soft"
                            onClick={() => transitionPolicy.mutate({ policy, action: "validate" })}
                            type="button"
                          >
                            校验
                          </button>
                        </>
                      ) : null}
                      {policy.status === "VALIDATED" ? (
                        <button
                          className="rounded px-2 py-1 text-ql-action hover:bg-ql-action-soft"
                          onClick={() => setPolicyActionTarget({ policy, action: "publish" })}
                          type="button"
                        >
                          发布
                        </button>
                      ) : null}
                      {policy.status === "PUBLISHED" ? (
                        <button
                          className="rounded px-2 py-1 text-ql-danger hover:bg-ql-danger-soft"
                          onClick={() => setPolicyActionTarget({ policy, action: "retire" })}
                          type="button"
                        >
                          停用
                        </button>
                      ) : null}
                      {policy.status === "RETIRED" ? (
                        <>
                          <button
                            className="rounded px-2 py-1 text-ql-action hover:bg-ql-action-soft"
                            onClick={() => setPolicyActionTarget({ policy, action: "restore" })}
                            type="button"
                          >
                            恢复原配置
                          </button>
                          <button
                            className="rounded px-2 py-1 text-ql-action hover:bg-ql-action-soft"
                            onClick={() => transitionPolicy.mutate({ policy, action: "copy" })}
                            type="button"
                          >
                            复制为新版本
                          </button>
                        </>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </QueryGate>
      </ManagementSection>

      <ConfigurationActionDialogs archiveLoading={archiveConfig.isPending} archiveTarget={archiveTarget}
        onArchiveCancel={() => setArchiveTarget(null)} onArchiveConfirm={target => archiveConfig.mutate({ ...target, archive: true } as Parameters<typeof archiveConfig.mutate>[0])}
        onPolicyCancel={() => setPolicyActionTarget(null)} onPolicyConfirm={target => transitionPolicy.mutate(target)} policyLoading={transitionPolicy.isPending} policyTarget={policyActionTarget} principalById={principalById} />
      <ConfirmDialog
        danger
        confirmLabel="确认停用"
        impact={`停用统一模型「${disableModelTarget?.display_name ?? ""}」后，新请求不能再选择该模型。`}
        loading={updateModel.isPending}
        onCancel={() => setDisableModelTarget(null)}
        onConfirm={() =>
          disableModelTarget &&
          updateModel.mutate({ model: disableModelTarget, status: "DISABLED" })
        }
        open={disableModelTarget !== null}
        title="停用统一模型"
      />
      <ConfirmDialog
        danger
        confirmLabel="确认停用"
        impact={`停用路由 ${disableRouteTarget?.upstream_model ?? ""} 后，调度不再选择该候选。`}
        loading={updateRoute.isPending}
        onCancel={() => setDisableRouteTarget(null)}
        onConfirm={() =>
          disableRouteTarget && updateRoute.mutate({ route: disableRouteTarget, enabled: false })
        }
        open={disableRouteTarget !== null}
        title="停用 Model Route"
      />
    </PageShell>
  );
}

function ManagementSection({
  title,
  actionLabel,
  actionDisabled = false,
  hint,
  onAction,
  children,
}: {
  title: string;
  actionLabel: string;
  actionDisabled?: boolean;
  hint: string;
  onAction: () => void;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-5 rounded-xl border border-ql-border bg-ql-surface p-4">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-[14px] font-semibold text-ql-fg">{title}</h2>
          <p className="mt-1 text-[12px] leading-5 text-ql-fg-secondary">{hint}</p>
        </div>
        <button
          className="flex h-8 shrink-0 items-center gap-1 rounded-lg border border-ql-border px-3 text-[12px] font-medium text-ql-action hover:bg-ql-action-soft disabled:cursor-not-allowed disabled:opacity-50"
          disabled={actionDisabled}
          onClick={onAction}
          type="button"
        >
          <Plus aria-hidden className="h-3.5 w-3.5" />
          {actionLabel}
        </button>
      </div>
      {children}
    </section>
  );
}
