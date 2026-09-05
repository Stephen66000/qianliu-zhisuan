import { useState } from "react";
import { useForm } from "react-hook-form";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { zodResolver } from "@hookform/resolvers/zod";

import { patch, post } from "../api/client";
import { QUERY_KEYS, useProviderResources, useProviders, useSupplyForecasts } from "../api/hooks";
import type { ProviderResourceItem, ProviderResourceOperatingSnapshot } from "../api/types";
import { useRedirectOnUnauthorized } from "../components/useRedirectOnUnauthorized";
import { useFeatureFlags, useProviderFinanceMode } from "../feature-flags";
import { useResourceTab } from "../components/resources/ResourceTabs";
import type { ModelDiscoveryResponse } from "../components/resources/ResourceModelDiscovery";
import {
  CreateResourceSchema, EMPTY_OPERATING_DRAFT, EditResourceSchema, operatingPayload,
  type CreateResourceValues, type EditResourceValues,
} from "../components/resources/resource-form-contract";

export function useResourcesPageModel() {
  const featureFlags = useFeatureFlags();
  const providerFinanceMode = useProviderFinanceMode();
  const { activeTab, selectTab } = useResourceTab(providerFinanceMode !== "OFF");
  const query = useProviderResources();
  const providersQuery = useProviders();
  const forecastsQuery = useSupplyForecasts(activeTab === "supply-health");
  useRedirectOnUnauthorized(query.error ?? providersQuery.error ?? forecastsQuery.error);
  const queryClient = useQueryClient();

  const [showCreate, setShowCreate] = useState(false);
  const [showNewProvider, setShowNewProvider] = useState(false);
  const [recoverTarget, setRecoverTarget] = useState<ProviderResourceItem | null>(null);
  const [editTarget, setEditTarget] = useState<ProviderResourceItem | null>(null);
  const [rotateCredential, setRotateCredential] = useState(false);
  const [newCredential, setNewCredential] = useState("");
  const [discovery, setDiscovery] = useState<ModelDiscoveryResponse | null>(null);
  const [selectedModelIds, setSelectedModelIds] = useState<string[]>([]);
  const [createValidationError, setCreateValidationError] = useState("");
  const [onboardingKey, setOnboardingKey] = useState(() => crypto.randomUUID());
  const [syncTarget, setSyncTarget] = useState<ProviderResourceItem | null>(null);

  const createMutation = useMutation({
    mutationFn: (values: CreateResourceValues) => {
      const {
        currency, recharge_amount, current_balance, current_period_cost,
        cumulative_cost, balance_updated_at, cost_period_start, cost_period_end,
        package_name, package_cost, total_quota, quota_unit, effective_from,
        effective_until, reset_cycle, reset_anchor_at, ...resource
      } = values;
      const hasOperating = resource.mode === "CODING_PLAN"
        ? [package_name, total_quota]
            .some(Boolean)
        : false;
      const draft = {
        currency, recharge_amount, current_balance, current_period_cost,
        cumulative_cost, balance_updated_at, cost_period_start, cost_period_end,
        package_name, package_cost, total_quota, quota_unit, effective_from,
        effective_until, reset_cycle, reset_anchor_at,
      };
      return post<{ result: { resourceId: string } }>("/provider-resources/onboard", {
        ...resource,
        idempotency_key: onboardingKey,
        selected_model_ids: selectedModelIds,
        concurrency_limit: resource.concurrency_limit
          ? Number(resource.concurrency_limit)
          : undefined,
        operating_snapshot: hasOperating ? operatingPayload(draft, resource.mode) : undefined,
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.providerResources });
      setShowCreate(false);
      reset();
      setDiscovery(null);
      setSelectedModelIds([]);
      setCreateValidationError("");
      setOnboardingKey(crypto.randomUUID());
    },
  });

  const createProviderMutation = useMutation({
    mutationFn: (values: { code: string; name: string }) =>
      post<{ provider: { id: string } }>("/providers", {
        code: values.code,
        name: values.name,
        adapter_type: values.code,
      }),
    onSuccess: async (data) => {
      await queryClient.invalidateQueries({ queryKey: QUERY_KEYS.providers });
      setShowNewProvider(false);
      // 新建后自动选中
      setValue("provider_id", data.provider.id);
    },
  });

  const [newProviderName, setNewProviderName] = useState("");
  const [newProviderCode, setNewProviderCode] = useState("zhipu");
  const [operatingTarget, setOperatingTarget] = useState<ProviderResourceItem | null>(null);
  const [operatingDraft, setOperatingDraft] =
    useState<Record<string, string>>(EMPTY_OPERATING_DRAFT);
  const [operatingValidationError, setOperatingValidationError] = useState("");
  const [operatingHistory, setOperatingHistory] =
    useState<ProviderResourceOperatingSnapshot[]>([]);

  const operatingMutation = useMutation({
    mutationFn: (target: ProviderResourceItem) =>
      patch<{ resource: ProviderResourceItem }>(`/provider-resources/${target.id}`, {
        expected_version: target.version,
        operating_snapshot: operatingPayload(operatingDraft, target.mode),
      }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: QUERY_KEYS.providerResources }),
        queryClient.invalidateQueries({ queryKey: QUERY_KEYS.dashboard }),
        queryClient.invalidateQueries({ queryKey: QUERY_KEYS.resourceUsageOverview }),
        queryClient.invalidateQueries({ queryKey: QUERY_KEYS.supplyForecasts }),
        queryClient.invalidateQueries({ queryKey: ["resource-utilization"] }),
        queryClient.invalidateQueries({ queryKey: ["provider-finance"] }),
      ]);
      setOperatingTarget(null);
      setOperatingHistory([]);
    },
  });

  const recoverMutation = useMutation({
    mutationFn: (target: ProviderResourceItem) =>
      post<{ resource: ProviderResourceItem }>(
        `/provider-resources/${target.id}/recover`,
        rotateCredential && newCredential ? { credential_plaintext: newCredential } : {},
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.providerResources });
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.dashboard });
      setRecoverTarget(null);
      setRotateCredential(false);
      setNewCredential("");
    },
  });

  const editMutation = useMutation({
    mutationFn: (input: { target: ProviderResourceItem; values: EditResourceValues }) =>
      patch<{ resource: ProviderResourceItem }>(`/provider-resources/${input.target.id}`, {
        expected_version: input.target.version,
        name: input.values.name,
        concurrency_limit: input.values.concurrency_limit
          ? Number(input.values.concurrency_limit)
          : null,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.providerResources });
      setEditTarget(null);
      editReset();
    },
  });

  const {
    register,
    handleSubmit,
    getValues,
    reset,
    setValue,
    watch,
    formState: { errors },
  } = useForm<CreateResourceValues, unknown, CreateResourceValues>({
    resolver: zodResolver(CreateResourceSchema),
    defaultValues: {
      provider_id: "",
      name: "",
      mode: "API",
      credential_type: "API_KEY",
      credential_plaintext: "",
      concurrency_limit: "",
      currency: "CNY",
      recharge_amount: "",
      current_balance: "",
      current_period_cost: "",
      cumulative_cost: "",
      balance_updated_at: "",
      cost_period_start: "",
      cost_period_end: "",
      package_name: "",
      package_cost: "",
      total_quota: "",
      quota_unit: "TOKEN",
      effective_from: "",
      effective_until: "",
      reset_cycle: "NONE",
      reset_anchor_at: "",
    },
  });
  const createMode = watch("mode");
  const createResetCycle = watch("reset_cycle");
  const createTotalQuota = watch("total_quota");
  const {
    register: editRegister,
    handleSubmit: handleEditSubmit,
    reset: editReset,
    formState: { errors: editErrors },
  } = useForm<EditResourceValues>({
    resolver: zodResolver(EditResourceSchema),
    defaultValues: { name: "", concurrency_limit: "" },
  });

  const resources = query.data?.resources ?? [];
  const forecasts = forecastsQuery.data?.forecasts ?? [];
  // P1-02：厂商选项来自独立 /providers（不再从已有资源反推——新企业为空也能登记第一个厂商）
  const providerOptions = providersQuery.data?.providers ?? [];
  const clearCreateDiscovery = () => {
    setDiscovery(null);
    setSelectedModelIds([]);
  };

  return {
    featureFlags, providerFinanceMode, activeTab, selectTab, query, showCreate, setShowCreate,
    showNewProvider, setShowNewProvider, recoverTarget, setRecoverTarget, editTarget, setEditTarget,
    rotateCredential, setRotateCredential, newCredential, setNewCredential, discovery, setDiscovery,
    selectedModelIds, setSelectedModelIds, createValidationError, setCreateValidationError,
    syncTarget, setSyncTarget, createMutation, createProviderMutation, newProviderName,
    setNewProviderName, newProviderCode, setNewProviderCode, operatingTarget, setOperatingTarget,
    operatingDraft, setOperatingDraft, operatingValidationError, setOperatingValidationError,
    operatingHistory, setOperatingHistory, operatingMutation, recoverMutation, editMutation,
    register, handleSubmit, getValues, reset, setValue, errors, createMode, createResetCycle,
    createTotalQuota, editRegister, handleEditSubmit, editReset, editErrors, resources, forecasts,
    providerOptions, clearCreateDiscovery
  };
}

export type ResourcesPageModel = ReturnType<typeof useResourcesPageModel>;
