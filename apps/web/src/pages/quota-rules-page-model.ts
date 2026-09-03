import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useFieldArray, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { patch, post } from "../api/client";
import { QUERY_KEYS, useBillingRules, useDispatchPolicies, useModelRoutes, usePrincipals, useProviderResources, useUnifiedModels } from "../api/hooks";
import type { BillingRule, DispatchPolicy, ModelRouteItem, UnifiedModel } from "../api/types";
import type { ArchiveTarget, PolicyActionTarget } from "../components/quota/ConfigurationActionDialogs";
import { DispatchPolicyFormSchema, buildDispatchPolicyPayload, type DispatchPolicyInput, type DispatchPolicyValues } from "../components/quota/dispatch-policy-form";
import { useRedirectOnUnauthorized } from "../components/useRedirectOnUnauthorized";
import { BillingRuleSchema, RouteSchema, UnifiedModelSchema, buildBillingRulePayload, firstQueryError, localDateTimeValue, principalList, type BillingRuleInput, type BillingRuleValues, type RouteInput, type RouteValues, type UnifiedModelValues } from "./quota-rule-contract";

export function useQuotaRulesPageModel() {
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

  return {
    error, showArchived, setShowArchived, showModelForm, setShowModelForm, modelForm, visibleModels, setSelectedModelId, archiveConfig, setDisableModelTarget, updateModel, canCreateRoute, hasActiveModels, showRouteForm, setShowRouteForm, routeForm, selectedModelId, selectedRuleRouteId, setSelectedRuleRouteId, models, resources, routes, setDisableRouteTarget, canCreateRule, showRuleForm, setShowRuleForm, ruleForm, selectedRuleType, ruleWindowFields, appendRuleWindow, removeRuleWindow, enabledRoutes, rules, updateRule, setArchiveTarget, showPolicyForm, setShowPolicyForm, editingPolicy, setEditingPolicy, policyForm, selectedPolicyAction, principalScopeMode, selectedPrincipalIds, principals, principalSearch, setPrincipalSearch, createPolicy, policies, editPolicy, setPolicyActionTarget, transitionPolicy, archiveTarget, policyActionTarget, principalById, disableModelTarget, disableRouteTarget, createModel, createRoute, updateRoute, createRule, rulesQuery, policiesQuery, modelsQuery, resourcesQuery, routesQuery
  };
}

export type QuotaRulesPageModel = ReturnType<typeof useQuotaRulesPageModel>;
