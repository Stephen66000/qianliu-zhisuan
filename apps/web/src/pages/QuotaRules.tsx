/**
 * P1-02 管理闭环：计价规则模板 + 统一模型 + Model Route。
 */
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Gauge, Plus } from "lucide-react";
import { z } from "zod";

import { patch, post } from "../api/client";
import {
  QUERY_KEYS,
  useBillingRules,
  useModelRoutes,
  useProviderResources,
  useUnifiedModels,
} from "../api/hooks";
import type { BillingRule, ModelRouteItem, UnifiedModel } from "../api/types";
import { StatusTag } from "../components/dashboard/StatusTag";
import { PageShell } from "../components/layout/PageShell";
import { QueryGate } from "../components/states/QueryGate";
import { ConfirmDialog } from "../components/writes/ConfirmDialog";
import { FormField, INPUT_CLASS } from "../components/writes/FormField";
import { useRedirectOnUnauthorized } from "../components/useRedirectOnUnauthorized";

const Decimal = z.string().regex(/^\d+(?:\.\d+)?$/, "请输入非负十进制数");

const BillingRuleSchema = z.object({
  rule_type: z.enum(["API_PRICE", "TIME_WINDOW", "MODEL_TIER", "CACHE_STATE"]),
  rule_version: z.string().min(1, "版本不能为空").max(64),
  provider_resource_id: z.string().uuid("请选择资源"),
  upstream_model: z.string().min(1, "上游模型不能为空").max(128),
  cache_hit_price: Decimal,
  cache_miss_price: Decimal,
  output_price: Decimal,
  priority: z.coerce.number().int().min(0),
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

type BillingRuleValues = z.infer<typeof BillingRuleSchema>;
type BillingRuleInput = z.input<typeof BillingRuleSchema>;
type UnifiedModelValues = z.infer<typeof UnifiedModelSchema>;
type RouteValues = z.infer<typeof RouteSchema>;
type RouteInput = z.input<typeof RouteSchema>;

export function QuotaRulesPage() {
  const queryClient = useQueryClient();
  const rulesQuery = useBillingRules();
  const modelsQuery = useUnifiedModels();
  const resourcesQuery = useProviderResources();
  useRedirectOnUnauthorized(rulesQuery.error ?? modelsQuery.error ?? resourcesQuery.error);

  const models = useMemo(() => modelsQuery.data?.models ?? [], [modelsQuery.data?.models]);
  const resources = resourcesQuery.data?.resources ?? [];
  const [showRuleForm, setShowRuleForm] = useState(false);
  const [showModelForm, setShowModelForm] = useState(false);
  const [showRouteForm, setShowRouteForm] = useState(false);
  const [selectedModelId, setSelectedModelId] = useState<string | null>(null);
  const [disableModelTarget, setDisableModelTarget] = useState<UnifiedModel | null>(null);
  const [disableRouteTarget, setDisableRouteTarget] = useState<ModelRouteItem | null>(null);
  const [editRuleTarget, setEditRuleTarget] = useState<BillingRule | null>(null);
  const [editPrice, setEditPrice] = useState("");
  const routesQuery = useModelRoutes(selectedModelId);

  useEffect(() => {
    if (selectedModelId === null && models.length > 0) {
      setSelectedModelId(models[0]!.id);
    }
  }, [models, selectedModelId]);

  const ruleForm = useForm<BillingRuleInput, unknown, BillingRuleValues>({
    resolver: zodResolver(BillingRuleSchema),
    defaultValues: {
      rule_type: "API_PRICE",
      rule_version: "v1",
      provider_resource_id: "",
      upstream_model: "",
      cache_hit_price: "0",
      cache_miss_price: "0.000001",
      output_price: "0.000002",
      priority: 100,
    },
  });
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

  const refreshRules = () =>
    queryClient.invalidateQueries({ queryKey: QUERY_KEYS.billingRules });
  const refreshModels = () =>
    queryClient.invalidateQueries({ queryKey: QUERY_KEYS.unifiedModels });
  const refreshRoutes = (modelId: string) =>
    queryClient.invalidateQueries({ queryKey: QUERY_KEYS.modelRoutes(modelId) });

  const createRule = useMutation({
    mutationFn: (values: BillingRuleValues) =>
      post("/billing-rules", {
        ...values,
        effective_from: new Date().toISOString(),
        currency: "CNY",
        source: "WEB_ADMIN",
      }),
    onSuccess: () => {
      setShowRuleForm(false);
      void refreshRules();
    },
  });
  const updateRule = useMutation({
    mutationFn: (input: { rule: BillingRule; patch: Record<string, unknown> }) =>
      patch(`/billing-rules/${input.rule.id}`, {
        expected_version: input.rule.version,
        ...input.patch,
      }),
    onSuccess: () => {
      setEditRuleTarget(null);
      void refreshRules();
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

  const rules = rulesQuery.data?.rules ?? [];
  const routes = routesQuery.data?.routes ?? [];
  const error =
    createRule.error ??
    updateRule.error ??
    createModel.error ??
    updateModel.error ??
    createRoute.error ??
    updateRoute.error;

  return (
    <PageShell
      description="配置计价规则模板、统一模型和上游路由；写入均保留版本与操作日志"
      title="额度规则"
    >
      {error ? (
        <p className="mb-4 rounded-lg bg-ql-danger-soft p-3 text-[13px] text-ql-danger" role="alert">
          {error.message}
        </p>
      ) : null}

      <ManagementSection
        actionLabel="新建规则"
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
              error={ruleForm.formState.errors.provider_resource_id?.message}
              htmlFor="rule-resource"
              label="厂商资源"
            >
              <select
                className={INPUT_CLASS}
                id="rule-resource"
                {...ruleForm.register("provider_resource_id")}
              >
                <option value="">请选择</option>
                {resources.map((resource) => (
                  <option key={resource.id} value={resource.id}>{resource.name}</option>
                ))}
              </select>
            </FormField>
            <FormField
              error={ruleForm.formState.errors.upstream_model?.message}
              htmlFor="rule-upstream-model"
              label="上游模型"
            >
              <input
                className={INPUT_CLASS}
                id="rule-upstream-model"
                {...ruleForm.register("upstream_model")}
              />
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
                <th className="p-2 text-right font-medium">输入/输出单价</th>
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
                  <td className="p-2 text-right font-mono">
                    {rule.cache_miss_price ?? "—"} / {rule.output_price ?? "—"}
                  </td>
                  <td className="p-2">
                    <StatusTag tone={rule.enabled ? "neutral" : "warning"}>
                      {rule.enabled ? "启用" : "停用"}
                    </StatusTag>
                  </td>
                  <td className="p-2 text-right">
                    <button
                      className="rounded px-2 py-1 text-ql-action hover:bg-ql-action-soft"
                      onClick={() => {
                        setEditRuleTarget(rule);
                        setEditPrice(rule.output_price ?? "0");
                      }}
                      type="button"
                    >
                      编辑价格
                    </button>
                    <button
                      className="rounded px-2 py-1 text-ql-fg-secondary hover:bg-ql-surface-muted"
                      onClick={() => updateRule.mutate({ rule, patch: { enabled: !rule.enabled } })}
                      type="button"
                    >
                      {rule.enabled ? "停用" : "启用"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </QueryGate>
      </ManagementSection>

      <ManagementSection
        actionLabel="新建统一模型"
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
              {models.map((model) => (
                <tr className="border-b border-ql-border-zone last:border-b-0" key={model.id}>
                  <td className="p-2 font-mono">{model.alias}</td>
                  <td className="p-2">{model.display_name}</td>
                  <td className="p-2">{model.status === "ACTIVE" ? "启用" : "停用"}</td>
                  <td className="p-2 text-right">
                    <button
                      className="rounded px-2 py-1 text-ql-action hover:bg-ql-action-soft"
                      onClick={() => setSelectedModelId(model.id)}
                      type="button"
                    >
                      管理路由
                    </button>
                    {model.status === "ACTIVE" ? (
                      <button
                        className="rounded px-2 py-1 text-ql-danger hover:bg-ql-danger-soft"
                        onClick={() => setDisableModelTarget(model)}
                        type="button"
                      >
                        停用
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </ManagementSection>

      <ManagementSection
        actionLabel="新建路由"
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
              onChange={(event) => setSelectedModelId(event.target.value || null)}
              value={selectedModelId ?? ""}
            >
              <option value="">请选择</option>
              {models.map((model) => (
                <option key={model.id} value={model.id}>{model.display_name}</option>
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
                {models.filter((model) => model.status === "ACTIVE").map((model) => (
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
                  <td className="p-2">{route.enabled ? "启用" : "停用"}</td>
                  <td className="p-2 text-right">
                    {route.enabled ? (
                      <button
                        className="rounded px-2 py-1 text-ql-danger hover:bg-ql-danger-soft"
                        onClick={() => setDisableRouteTarget(route)}
                        type="button"
                      >
                        停用
                      </button>
                    ) : (
                      <button
                        className="rounded px-2 py-1 text-ql-action hover:bg-ql-action-soft"
                        onClick={() => updateRoute.mutate({ route, enabled: true })}
                        type="button"
                      >
                        启用
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </ManagementSection>

      <ConfirmDialog
        confirmLabel="确认保存"
        impact={`更新规则 ${editRuleTarget?.rule_version ?? ""} 的输出 Token 单价；已结算账本不重算。`}
        loading={updateRule.isPending}
        onCancel={() => setEditRuleTarget(null)}
        onConfirm={() => {
          if (editRuleTarget && Decimal.safeParse(editPrice).success) {
            updateRule.mutate({ rule: editRuleTarget, patch: { output_price: editPrice } });
          }
        }}
        open={editRuleTarget !== null}
        title="编辑计价规则"
      >
        <FormField htmlFor="edit-output-price" label="输出单价">
          <input
            className={`${INPUT_CLASS} w-full`}
            id="edit-output-price"
            onChange={(event) => setEditPrice(event.target.value)}
            value={editPrice}
          />
        </FormField>
      </ConfirmDialog>
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
  onAction,
  children,
}: {
  title: string;
  actionLabel: string;
  onAction: () => void;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-5 rounded-xl border border-ql-border bg-ql-surface p-4">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-[14px] font-semibold text-ql-fg">{title}</h2>
        <button
          className="flex h-8 items-center gap-1 rounded-lg border border-ql-border px-3 text-[12px] font-medium text-ql-action hover:bg-ql-action-soft"
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
