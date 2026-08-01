/**
 * W19 厂商资源 —— 列表 + 登记（凭证一次展示原则）+ 凭证恢复（二次确认 + 可选轮换）。
 *
 * 安全红线：凭证明文只在创建响应中由后端返回指纹，前端不回显明文；
 * 恢复操作 = POST /provider-resources/:id/recover（WT-19），破坏性 → 二次确认。
 */
import { useState } from "react";
import { useForm } from "react-hook-form";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Server } from "lucide-react";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";

import { get, patch, post } from "../api/client";
import {
  QUERY_KEYS,
  useProviderResources,
  useProviders,
  useSupplyForecasts,
} from "../api/hooks";
import type {
  ProviderResourceItem,
  ProviderResourceOperatingSnapshot,
} from "../api/types";
import { PageShell } from "../components/layout/PageShell";
import { StatusTag } from "../components/dashboard/StatusTag";
import { QueryGate } from "../components/states/QueryGate";
import { ConfirmDialog } from "../components/writes/ConfirmDialog";
import { FormField, INPUT_CLASS } from "../components/writes/FormField";
import { useRedirectOnUnauthorized } from "../components/useRedirectOnUnauthorized";
import { formatDateTimeFull } from "../lib/format";

const OptionalDecimal = z.string().refine(
  (value) => value === "" || /^\d+(?:\.\d+)?$/.test(value),
  "请输入非负数字",
);

const CreateResourceSchema = z.object({
  provider_id: z.string().uuid("请选择厂商"),
  name: z.string().min(1, "名称不能为空").max(255),
  mode: z.enum(["API", "CODING_PLAN"]),
  credential_type: z.enum(["API_KEY", "OAUTH", "SUBSCRIPTION_SESSION"]),
  credential_plaintext: z.string().min(1, "凭证不能为空"),
  concurrency_limit: z.string().refine(
    (value) => value === "" || /^\d+$/.test(value) && Number(value) > 0,
    "并发上限必须是正整数",
  ),
  currency: z.string().max(8),
  recharge_amount: OptionalDecimal,
  current_balance: OptionalDecimal,
  current_period_cost: OptionalDecimal,
  cumulative_cost: OptionalDecimal,
  balance_updated_at: z.string(),
  cost_period_start: z.string(),
  cost_period_end: z.string(),
  package_name: z.string().max(255),
  package_cost: OptionalDecimal,
  total_quota: OptionalDecimal,
  quota_unit: z.string().max(32),
  effective_from: z.string(),
  effective_until: z.string(),
  reset_cycle: z.enum(["NONE", "DAILY", "WEEKLY", "MONTHLY"]),
  reset_anchor_at: z.string(),
}).superRefine((value, ctx) => {
  if (value.mode === "CODING_PLAN" && !value.total_quota) {
    ctx.addIssue({
      code: "custom",
      path: ["total_quota"],
      message: "套餐资源必须填写总额度",
    });
  }
  if (value.mode === "CODING_PLAN" && !value.effective_from) {
    ctx.addIssue({
      code: "custom",
      path: ["effective_from"],
      message: "请选择套餐生效时间",
    });
  }
  if (value.mode === "CODING_PLAN" && value.reset_cycle !== "NONE" && !value.reset_anchor_at) {
    ctx.addIssue({
      code: "custom",
      path: ["reset_anchor_at"],
      message: "请选择重置日期",
    });
  }
});

type CreateResourceValues = z.infer<typeof CreateResourceSchema>;

const EditResourceSchema = z.object({
  name: z.string().min(1, "名称不能为空").max(255),
  upstream_models: z.string(),
  concurrency_limit: z.string().refine(
    (value) => value === "" || /^\d+$/.test(value) && Number(value) > 0,
    "并发限制必须是正整数",
  ),
});

type EditResourceValues = z.infer<typeof EditResourceSchema>;

const EMPTY_OPERATING_DRAFT: Record<string, string> = {
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
};

const OPERATING_FIELDS = [
  ["total_quota", "厂商总额度", "text"],
  ["quota_unit", "原生单位", "text"],
  ["package_name", "套餐名称", "text"],
  ["package_cost", "套餐费用", "text"],
  ["recharge_amount", "充值金额", "text"],
  ["current_balance", "当前余额", "text"],
  ["current_period_cost", "本期实际费用", "text"],
  ["cumulative_cost", "累计费用", "text"],
  ["currency", "币种", "text"],
  ["balance_updated_at", "余额更新时间", "datetime-local"],
  ["cost_period_start", "费用周期开始", "datetime-local"],
  ["cost_period_end", "费用周期结束", "datetime-local"],
  ["effective_from", "套餐生效时间", "datetime-local"],
  ["effective_until", "套餐失效时间", "datetime-local"],
  ["reset_cycle", "重置周期", "select"],
  ["reset_anchor_at", "重置日期", "datetime-local"],
] as const;

const PLAN_OPERATING_KEYS = new Set([
  "total_quota",
  "quota_unit",
  "package_name",
  "package_cost",
  "currency",
  "effective_from",
  "effective_until",
  "reset_cycle",
  "reset_anchor_at",
]);

const API_OPERATING_KEYS = new Set([
  "recharge_amount",
  "current_balance",
  "current_period_cost",
  "cumulative_cost",
  "currency",
  "balance_updated_at",
  "cost_period_start",
  "cost_period_end",
]);

function operatingFieldsForMode(mode: ProviderResourceItem["mode"]) {
  const keys = mode === "API" ? API_OPERATING_KEYS : PLAN_OPERATING_KEYS;
  return OPERATING_FIELDS.filter(([key]) => keys.has(key));
}

function operatingPayload(
  draft: Record<string, string>,
  mode: ProviderResourceItem["mode"],
) {
  const value = (key: string) => draft[key]?.trim() || null;
  const date = (key: string) => {
    const raw = draft[key];
    if (!raw) return null;
    const withShanghaiOffset = `${raw.length === 16 ? `${raw}:00` : raw}+08:00`;
    return new Date(withShanghaiOffset).toISOString();
  };
  const payload = {
    source: "ADMIN" as const,
    collected_at: new Date().toISOString(),
    currency: value("currency"),
    recharge_amount: value("recharge_amount"),
    current_balance: value("current_balance"),
    current_period_cost: value("current_period_cost"),
    cumulative_cost: value("cumulative_cost"),
    balance_updated_at: date("balance_updated_at"),
    cost_period_start: date("cost_period_start"),
    cost_period_end: date("cost_period_end"),
    package_name: value("package_name"),
    package_cost: value("package_cost"),
    total_quota: value("total_quota"),
    quota_unit: value("quota_unit"),
    effective_from: date("effective_from"),
    effective_until: date("effective_until"),
    reset_cycle: value("reset_cycle"),
    reset_anchor_at: date("reset_anchor_at"),
  };
  return mode === "API"
    ? {
        ...payload,
        package_name: null,
        package_cost: null,
        total_quota: null,
        quota_unit: null,
        effective_from: null,
        effective_until: null,
        reset_cycle: null,
        reset_anchor_at: null,
      }
    : {
        ...payload,
        recharge_amount: null,
        current_balance: null,
        cumulative_cost: null,
        current_period_cost: null,
        cost_period_start: null,
        cost_period_end: null,
        balance_updated_at: null,
      };
}

function operatingDraftFromResource(resource: ProviderResourceItem): Record<string, string> {
  const snapshot = resource.operating_snapshot;
  const result = { ...EMPTY_OPERATING_DRAFT };
  if (!snapshot) return result;
  for (const [key, , type] of OPERATING_FIELDS) {
    const raw = snapshot[key as keyof typeof snapshot];
    result[key] =
      typeof raw === "string"
        ? (type === "datetime-local"
            ? new Date(new Date(raw).getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 16)
            : raw)
        : "";
  }
  return result;
}

function planDraftError(draft: Record<string, string>): string | null {
  if (!draft.total_quota) return "请填写厂商总额度";
  if (!draft.effective_from) return "请选择套餐生效时间";
  if (draft.reset_cycle !== "NONE" && !draft.reset_anchor_at) return "请选择重置日期";
  return null;
}

function ReadOnlyMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-ql-border bg-ql-surface px-3 py-2">
      <p className="text-[11px] text-ql-fg-tertiary">{label}</p>
      <p className="mt-1 font-mono text-[13px] text-ql-fg">{value}</p>
    </div>
  );
}

const ISOLATED = new Set(["CREDENTIAL_INVALID", "EXHAUSTED", "EXPIRED", "UNAVAILABLE"]);

const MODE_LABEL: Record<ProviderResourceItem["mode"], string> = {
  API: "API",
  CODING_PLAN: "套餐",
};

const STATUS_LABEL: Record<string, string> = {
  ACTIVE: "正常",
  DEGRADED: "降级",
  CREDENTIAL_INVALID: "凭证失效",
  EXHAUSTED: "额度耗尽",
  EXPIRED: "已过期",
  UNAVAILABLE: "不可用",
  RATE_LIMITED: "限流冷却",
};

export function ResourcesPage() {
  const query = useProviderResources();
  const providersQuery = useProviders();
  const forecastsQuery = useSupplyForecasts();
  useRedirectOnUnauthorized(query.error ?? providersQuery.error ?? forecastsQuery.error);
  const queryClient = useQueryClient();

  const [showCreate, setShowCreate] = useState(false);
  const [showNewProvider, setShowNewProvider] = useState(false);
  const [recoverTarget, setRecoverTarget] = useState<ProviderResourceItem | null>(null);
  const [editTarget, setEditTarget] = useState<ProviderResourceItem | null>(null);
  const [rotateCredential, setRotateCredential] = useState(false);
  const [newCredential, setNewCredential] = useState("");

  const createMutation = useMutation({
    mutationFn: (values: CreateResourceValues) => {
      const {
        currency, recharge_amount, current_balance, current_period_cost,
        cumulative_cost, balance_updated_at, cost_period_start, cost_period_end,
        package_name, package_cost, total_quota, quota_unit, effective_from,
        effective_until, reset_cycle, reset_anchor_at, ...resource
      } = values;
      const hasOperating = resource.mode === "CODING_PLAN"
        ? [package_name, package_cost, total_quota, effective_from, effective_until]
            .some(Boolean)
        : [
            recharge_amount, current_balance, current_period_cost, cumulative_cost,
            balance_updated_at, cost_period_start, cost_period_end,
          ].some(Boolean);
      const draft = {
        currency, recharge_amount, current_balance, current_period_cost,
        cumulative_cost, balance_updated_at, cost_period_start, cost_period_end,
        package_name, package_cost, total_quota, quota_unit, effective_from,
        effective_until, reset_cycle, reset_anchor_at,
      };
      return post<{ resource: ProviderResourceItem }>("/provider-resources", {
        ...resource,
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
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.providerResources });
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.dashboard });
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
        upstream_models: input.values.upstream_models
          .split(",")
          .map((model) => model.trim())
          .filter(Boolean),
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
  const {
    register: editRegister,
    handleSubmit: handleEditSubmit,
    reset: editReset,
    formState: { errors: editErrors },
  } = useForm<EditResourceValues>({
    resolver: zodResolver(EditResourceSchema),
    defaultValues: { name: "", upstream_models: "", concurrency_limit: "" },
  });

  const resources = query.data?.resources ?? [];
  const forecasts = forecastsQuery.data?.forecasts ?? [];
  // P1-02：厂商选项来自独立 /providers（不再从已有资源反推——新企业为空也能登记第一个厂商）
  const providerOptions = providersQuery.data?.providers ?? [];

  return (
    <PageShell
      description="厂商 API 与套餐资源的登记、凭证安全与受控恢复（WT-19）"
      title="厂商资源"
    >
      <div className="mb-4 flex justify-end">
        <button
          className="flex h-9 items-center gap-1.5 rounded-lg bg-ql-action px-4 text-[14px] font-medium text-white hover:bg-ql-action-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ql-action"
          onClick={() => setShowCreate((v) => !v)}
          type="button"
        >
          <Plus aria-hidden className="h-4 w-4" />
          登记资源
        </button>
      </div>

      {showCreate ? (
        <form
          className="mb-5 flex flex-col gap-4 rounded-xl border border-ql-border bg-ql-surface-subtle p-4"
          onSubmit={handleSubmit((values) => createMutation.mutate(values))}
        >
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <FormField error={errors.provider_id?.message} htmlFor="res-provider" label="厂商">
              <div className="flex gap-2">
                <select className={`${INPUT_CLASS} flex-1`} id="res-provider" {...register("provider_id")}>
                  <option value="">请选择厂商</option>
                  {providerOptions.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}（{p.code}）
                    </option>
                  ))}
                </select>
                <button
                  className="h-10 shrink-0 rounded-lg border border-ql-border bg-ql-surface px-3 text-[13px] font-medium text-ql-action hover:bg-ql-action-soft"
                  onClick={() => setShowNewProvider((v) => !v)}
                  type="button"
                >
                  新建厂商
                </button>
              </div>
            </FormField>
            {showNewProvider ? (
              <div className="sm:col-span-2 flex items-end gap-2 rounded-lg border border-ql-border-zone bg-ql-surface p-3">
                <FormField htmlFor="new-provider-code" label="厂商代码">
                  <select
                    className={INPUT_CLASS}
                    id="new-provider-code"
                    onChange={(e) => setNewProviderCode(e.target.value)}
                    value={newProviderCode}
                  >
                    <option value="deepseek">deepseek</option>
                    <option value="zhipu">zhipu</option>
                    <option value="kimi">kimi</option>
                  </select>
                </FormField>
                <FormField htmlFor="new-provider-name" label="显示名称">
                  <input
                    className={INPUT_CLASS}
                    id="new-provider-name"
                    onChange={(e) => setNewProviderName(e.target.value)}
                    placeholder="如：智谱"
                    value={newProviderName}
                  />
                </FormField>
                <button
                  className="h-10 shrink-0 rounded-lg bg-ql-action px-4 text-[13px] font-medium text-white hover:bg-ql-action-hover disabled:opacity-60"
                  disabled={createProviderMutation.isPending || !newProviderName}
                  onClick={() =>
                    createProviderMutation.mutate({ code: newProviderCode, name: newProviderName })
                  }
                  type="button"
                >
                  {createProviderMutation.isPending ? "创建中…" : "确认"}
                </button>
                {createProviderMutation.error ? (
                  <p className="text-[12px] text-ql-danger">{createProviderMutation.error.message}</p>
                ) : null}
              </div>
            ) : null}
            <FormField error={errors.name?.message} htmlFor="res-name" label="资源名称">
              <input
                className={INPUT_CLASS}
                id="res-name"
                placeholder="如：智谱 GLM 主账号"
                {...register("name")}
              />
            </FormField>
            <FormField error={errors.mode?.message} htmlFor="res-mode" label="模式">
              <select
                className={INPUT_CLASS}
                id="res-mode"
                {...register("mode", {
                  onChange: (event) => {
                    const nextMode = event.target.value as ProviderResourceItem["mode"];
                    const forbidden =
                      nextMode === "API" ? PLAN_OPERATING_KEYS : API_OPERATING_KEYS;
                    for (const key of forbidden) {
                      if (key !== "currency") {
                        setValue(
                          key as keyof CreateResourceValues,
                          key === "reset_cycle" ? "NONE" : "",
                        );
                      }
                    }
                  },
                })}
              >
                <option value="API">API</option>
                <option value="CODING_PLAN">套餐</option>
              </select>
            </FormField>
            <FormField
              error={errors.credential_type?.message}
              htmlFor="res-cred-type"
              label="凭证类型"
            >
              <select
                className={INPUT_CLASS}
                id="res-cred-type"
                {...register("credential_type")}
              >
                <option value="API_KEY">API Key</option>
                <option value="OAUTH">OAuth</option>
                <option value="SUBSCRIPTION_SESSION">订阅会话</option>
              </select>
            </FormField>
            <FormField
              error={errors.credential_plaintext?.message}
              hint="凭证明文仅一次提交，立即加密存储，绝不回显"
              htmlFor="res-cred"
              label="上游凭证"
            >
              <input
                autoComplete="off"
                className={INPUT_CLASS}
                id="res-cred"
                placeholder="sk-..."
                type="password"
                {...register("credential_plaintext")}
              />
            </FormField>
            <FormField
              error={errors.concurrency_limit?.message}
              hint="按套餐能力填写，例如 5；留空表示不做本地并发限制"
              htmlFor="res-concurrency"
              label="并发上限"
            >
              <input
                className={INPUT_CLASS}
                id="res-concurrency"
                inputMode="numeric"
                {...register("concurrency_limit")}
              />
            </FormField>
            <div className="sm:col-span-2 border-t border-ql-border pt-3">
              <h3 className="text-[13px] font-semibold text-ql-fg">厂商经营快照（可选）</h3>
              <p className="mt-1 text-[12px] text-ql-fg-tertiary">
                未录入字段显示“未录入/未同步”，不会用主体分配额度代替。
              </p>
            </div>
            {createMode === "CODING_PLAN" ? (
              <>
                <FormField error={errors.total_quota?.message} htmlFor="res-total-quota" label="厂商总额度">
                  <input className={INPUT_CLASS} id="res-total-quota" {...register("total_quota")} />
                </FormField>
                <FormField htmlFor="res-quota-unit" label="原生单位">
                  <input className={INPUT_CLASS} id="res-quota-unit" {...register("quota_unit")} />
                </FormField>
                <div className="rounded-lg border border-ql-border bg-ql-surface px-3 py-2 sm:col-span-2">
                  <p className="text-[12px] font-medium text-ql-fg">系统自动计算</p>
                  <p className="mt-1 text-[12px] leading-5 text-ql-fg-tertiary">
                    已用额度取当前周期内该资源的账本扣减；剩余额度和下一次重置日期由系统生成。
                  </p>
                </div>
                <FormField htmlFor="res-package-name" label="套餐名称">
                  <input className={INPUT_CLASS} id="res-package-name" {...register("package_name")} />
                </FormField>
                <FormField error={errors.package_cost?.message} htmlFor="res-package-cost" label="套餐费用">
                  <input className={INPUT_CLASS} id="res-package-cost" {...register("package_cost")} />
                </FormField>
              </>
            ) : (
              <>
                <FormField error={errors.recharge_amount?.message} htmlFor="res-recharge" label="充值金额">
                  <input className={INPUT_CLASS} id="res-recharge" {...register("recharge_amount")} />
                </FormField>
                <FormField error={errors.current_balance?.message} htmlFor="res-balance" label="当前余额">
                  <input className={INPUT_CLASS} id="res-balance" {...register("current_balance")} />
                </FormField>
                <FormField error={errors.current_period_cost?.message} htmlFor="res-period-cost" label="本期实际费用">
                  <input className={INPUT_CLASS} id="res-period-cost" {...register("current_period_cost")} />
                </FormField>
                <FormField error={errors.cumulative_cost?.message} htmlFor="res-cumulative-cost" label="累计费用">
                  <input className={INPUT_CLASS} id="res-cumulative-cost" {...register("cumulative_cost")} />
                </FormField>
              </>
            )}
            <FormField htmlFor="res-currency" label="币种">
              <input className={INPUT_CLASS} id="res-currency" {...register("currency")} />
            </FormField>
            {createMode === "CODING_PLAN" ? (
              <>
                <FormField htmlFor="res-effective-until" label="有效期">
                  <input className={INPUT_CLASS} id="res-effective-until" type="datetime-local" {...register("effective_until")} />
                </FormField>
                <FormField error={errors.effective_from?.message} htmlFor="res-effective-from" label="生效时间">
                  <input className={INPUT_CLASS} id="res-effective-from" type="datetime-local" {...register("effective_from")} />
                </FormField>
                <FormField htmlFor="res-reset-cycle" label="重置周期">
                  <select className={INPUT_CLASS} id="res-reset-cycle" {...register("reset_cycle")}>
                    <option value="NONE">不重置</option>
                    <option value="DAILY">每日</option>
                    <option value="WEEKLY">每周</option>
                    <option value="MONTHLY">每月</option>
                  </select>
                </FormField>
                {createResetCycle !== "NONE" ? (
                  <FormField error={errors.reset_anchor_at?.message} htmlFor="res-reset-anchor" label="重置日期">
                    <input className={INPUT_CLASS} id="res-reset-anchor" type="datetime-local" {...register("reset_anchor_at")} />
                  </FormField>
                ) : null}
              </>
            ) : (
              <>
                <FormField htmlFor="res-balance-updated" label="余额更新时间">
                  <input className={INPUT_CLASS} id="res-balance-updated" type="datetime-local" {...register("balance_updated_at")} />
                </FormField>
                <FormField htmlFor="res-cost-start" label="费用周期开始">
                  <input className={INPUT_CLASS} id="res-cost-start" type="datetime-local" {...register("cost_period_start")} />
                </FormField>
                <FormField htmlFor="res-cost-end" label="费用周期结束">
                  <input className={INPUT_CLASS} id="res-cost-end" type="datetime-local" {...register("cost_period_end")} />
                </FormField>
              </>
            )}
          </div>
          {createMutation.error ? (
            <p className="text-[13px] leading-5 text-ql-danger" role="alert">
              {createMutation.error.message}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <button
              className="h-9 rounded-lg border border-ql-border bg-ql-surface px-4 text-[14px] font-medium text-ql-fg hover:border-ql-border-strong"
              onClick={() => {
                setShowCreate(false);
                reset();
              }}
              type="button"
            >
              取消
            </button>
            <button
              className="h-9 min-w-[5.5rem] rounded-lg bg-ql-action px-4 text-[14px] font-medium text-white hover:bg-ql-action-hover disabled:cursor-not-allowed disabled:opacity-60"
              disabled={createMutation.isPending}
              type="submit"
            >
              {createMutation.isPending ? "登记中…" : "登记"}
            </button>
          </div>
        </form>
      ) : null}

      {editTarget ? (
        <form
          className="mb-5 rounded-xl border border-ql-border bg-ql-surface-subtle p-4"
          onSubmit={handleEditSubmit((values) =>
            editMutation.mutate({ target: editTarget, values })
          )}
        >
          <div className="mb-3">
            <h2 className="text-[14px] font-semibold text-ql-fg">编辑厂商资源</h2>
            <p className="mt-1 text-[12px] text-ql-fg-tertiary">
              厂商、模式和凭证类型不可原地修改；凭证轮换使用独立恢复流程。
            </p>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <FormField error={editErrors.name?.message} htmlFor="edit-resource-name" label="资源名称">
              <input className={INPUT_CLASS} id="edit-resource-name" {...editRegister("name")} />
            </FormField>
            <FormField
              error={editErrors.upstream_models?.message}
              hint="多个模型用英文逗号分隔"
              htmlFor="edit-resource-models"
              label="上游模型"
            >
              <input className={INPUT_CLASS} id="edit-resource-models" {...editRegister("upstream_models")} />
            </FormField>
            <FormField
              error={editErrors.concurrency_limit?.message}
              hint="该资源允许同时访问上游的请求数，例如 5；超出后短暂等待"
              htmlFor="edit-resource-concurrency"
              label="并发上限"
            >
              <input
                className={INPUT_CLASS}
                id="edit-resource-concurrency"
                inputMode="numeric"
                {...editRegister("concurrency_limit")}
              />
            </FormField>
          </div>
          {editMutation.error ? (
            <p className="mt-3 text-[13px] text-ql-danger" role="alert">
              {editMutation.error.message}
            </p>
          ) : null}
          <div className="mt-4 flex justify-end gap-2">
            <button
              className="h-9 rounded-lg border border-ql-border bg-ql-surface px-4 text-[13px]"
              onClick={() => {
                setEditTarget(null);
                editReset();
              }}
              type="button"
            >
              取消
            </button>
            <button
              className="h-9 rounded-lg bg-ql-action px-4 text-[13px] font-medium text-white disabled:opacity-60"
              disabled={editMutation.isPending}
              type="submit"
            >
              {editMutation.isPending ? "保存中…" : "保存修改"}
            </button>
          </div>
        </form>
      ) : null}

      {operatingTarget ? (
        <form
          className="mb-5 rounded-xl border border-ql-border bg-ql-surface-subtle p-4"
          onSubmit={(event) => {
            event.preventDefault();
            const validationError = operatingTarget.mode === "CODING_PLAN"
              ? planDraftError(operatingDraft)
              : null;
            if (validationError) {
              setOperatingValidationError(validationError);
              return;
            }
            setOperatingValidationError("");
            operatingMutation.mutate(operatingTarget);
          }}
        >
          <h2 className="text-[14px] font-semibold text-ql-fg">
            更新「{operatingTarget.name}」经营数据
          </h2>
          <p className="mt-1 text-[12px] text-ql-fg-tertiary">
            只需维护购买事实和重置规则；系统根据当前周期账本自动统计已用、剩余与下一重置日期。
            保存会追加配置快照，旧周期和历史账本不重算。
          </p>
          {operatingTarget.mode === "CODING_PLAN" ? (
            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
              <ReadOnlyMetric label="系统已用额度" value={operatingTarget.operating_snapshot?.used_quota ?? "未知"} />
              <ReadOnlyMetric label="系统剩余额度" value={operatingTarget.operating_snapshot?.remaining_quota ?? "未知"} />
              <ReadOnlyMetric
                label="下一次重置日期"
                value={operatingTarget.operating_snapshot?.next_reset_at
                  ? formatDateTimeFull(operatingTarget.operating_snapshot.next_reset_at)
                  : "不重置"}
              />
            </div>
          ) : null}
          <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-3">
            {operatingFieldsForMode(operatingTarget.mode)
              .filter(([key]) => key !== "reset_anchor_at" || operatingDraft.reset_cycle !== "NONE")
              .map(([key, label, type]) => (
                <FormField htmlFor={`operating-${key}`} key={key} label={label}>
                  {type === "select" ? (
                    <select
                      className={INPUT_CLASS}
                      id={`operating-${key}`}
                      onChange={(event) =>
                        setOperatingDraft((current) => ({ ...current, [key]: event.target.value }))
                      }
                      value={operatingDraft[key] ?? "NONE"}
                    >
                      <option value="NONE">不重置</option>
                      <option value="DAILY">每日</option>
                      <option value="WEEKLY">每周</option>
                      <option value="MONTHLY">每月</option>
                    </select>
                  ) : (
                    <input
                      className={INPUT_CLASS}
                      id={`operating-${key}`}
                      onChange={(event) =>
                        setOperatingDraft((current) => ({ ...current, [key]: event.target.value }))
                      }
                      type={type}
                      value={operatingDraft[key] ?? ""}
                    />
                  )}
                </FormField>
              ))}
          </div>
          {operatingHistory.length > 0 ? (
            <div className="mt-4 overflow-x-auto">
              <h3 className="mb-2 text-[13px] font-semibold text-ql-fg">历史配置快照（倒序）</h3>
              <table className="w-full text-left text-[12px]">
                <thead>
                  <tr className="border-b border-ql-border text-ql-fg-tertiary">
                    <th className="p-2">版本/来源</th>
                    <th className="p-2">购买/金额配置</th>
                    <th className="p-2">周期配置</th>
                    <th className="p-2">保存时间</th>
                  </tr>
                </thead>
                <tbody>
                  {operatingHistory.map((snapshot) => (
                    <tr className="border-b border-ql-border-zone" key={snapshot.id}>
                      <td className="p-2">v{snapshot.version} · {snapshot.source}</td>
                      <td className="p-2">
                        {operatingTarget.mode === "CODING_PLAN"
                          ? `总 ${snapshot.total_quota ?? "未知"} ${snapshot.quota_unit ?? ""} · ${snapshot.package_name ?? "未命名套餐"} · ${snapshot.currency ?? ""} ${snapshot.package_cost ?? "费用未知"}`
                          : `充值 ${snapshot.currency ?? ""} ${snapshot.recharge_amount ?? "未知"} · 余额 ${snapshot.current_balance ?? "未知"} · 本期费用 ${snapshot.current_period_cost ?? "未知"}`}
                      </td>
                      <td className="p-2">
                        {operatingTarget.mode === "CODING_PLAN"
                          ? `${snapshot.reset_cycle ?? "NONE"} · ${snapshot.reset_anchor_at ? formatDateTimeFull(snapshot.reset_anchor_at) : "无重置日期"}`
                          : `${snapshot.cost_period_start ? formatDateTimeFull(snapshot.cost_period_start) : "—"} ～ ${snapshot.cost_period_end ? formatDateTimeFull(snapshot.cost_period_end) : "—"}`}
                      </td>
                      <td className="p-2">{formatDateTimeFull(snapshot.collected_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          {operatingValidationError ? (
            <p className="mt-3 text-[13px] text-ql-danger" role="alert">
              {operatingValidationError}
            </p>
          ) : operatingMutation.error ? (
            <p className="mt-3 text-[13px] text-ql-danger" role="alert">
              {operatingMutation.error.message}
            </p>
          ) : null}
          <div className="mt-4 flex justify-end gap-2">
            <button
              className="h-9 rounded-lg border border-ql-border bg-ql-surface px-4 text-[13px]"
              onClick={() => setOperatingTarget(null)}
              type="button"
            >
              取消
            </button>
            <button
              className="h-9 rounded-lg bg-ql-action px-4 text-[13px] font-medium text-white disabled:opacity-60"
              disabled={operatingMutation.isPending}
              type="submit"
            >
              {operatingMutation.isPending ? "保存中…" : "追加快照"}
            </button>
          </div>
        </form>
      ) : null}

      <QueryGate
        emptyDescription="尚未登记可用 AI 资源，无法产生模型和路由候选。点击右上角「登记资源」登记 DeepSeek API、智谱或 Kimi 资源。"
        emptyIcon={Server}
        emptyTitle="尚未登记厂商资源"
        error={query.error}
        isEmpty={resources.length === 0}
        isLoading={query.isLoading}
        loadingRows={4}
        onRetry={() => void query.refetch()}
      >
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className="border-b border-ql-border text-[12px] leading-[18px] text-ql-fg-tertiary">
                <th className="py-2 pr-4 font-medium">名称</th>
                <th className="py-2 pr-4 font-medium">厂商/模型</th>
                <th className="py-2 pr-4 font-medium">模式</th>
                <th className="py-2 pr-4 font-medium">厂商经营数据</th>
                <th className="py-2 pr-4 font-medium">数据时间</th>
                <th className="py-2 pr-4 font-medium">凭证指纹</th>
                <th className="py-2 pr-4 font-medium">状态</th>
                <th className="py-2 pr-4 font-medium">创建时间</th>
                <th className="py-2 text-right font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {resources.map((r) => (
                <tr
                  className="border-b border-ql-border-zone text-[13px] leading-5 text-ql-fg last:border-b-0 hover:bg-ql-surface-subtle"
                  key={r.id}
                >
                  <td className="py-2.5 pr-4 font-medium">{r.name}</td>
                  <td className="py-2.5 pr-4 text-ql-fg-secondary">
                    <span className="block">
                      {providerOptions.find((provider) => provider.id === r.provider_id)?.name ?? "—"}
                    </span>
                    <span className="font-mono text-[11px] text-ql-fg-tertiary">
                      {r.upstream_models?.join("、") ?? "未声明模型"}
                    </span>
                  </td>
                  <td className="py-2.5 pr-4 text-ql-fg-secondary">{MODE_LABEL[r.mode]}</td>
                  <td className="py-2.5 pr-4 text-ql-fg-secondary">
                    {r.operating_snapshot ? (
                      r.mode === "CODING_PLAN" ? (
                        <>
                          总 {r.operating_snapshot.total_quota ?? "未知"} / 系统已用{" "}
                          {r.operating_snapshot.used_quota ?? "未知"} / 剩余{" "}
                          {r.operating_snapshot.remaining_quota ?? "未知"}{" "}
                          {r.operating_snapshot.quota_unit ?? ""}
                        </>
                      ) : (
                        <>
                          充值 {r.operating_snapshot.currency ?? ""}{" "}
                          {r.operating_snapshot.recharge_amount ?? "未知"} / 余额{" "}
                          {r.operating_snapshot.current_balance ?? "未知"} / 本期费用{" "}
                          {r.operating_snapshot.current_period_cost ?? "未知"}
                        </>
                      )
                    ) : "未录入/未同步"}
                  </td>
                  <td className="whitespace-nowrap py-2.5 pr-4 text-ql-fg-secondary">
                    {r.operating_snapshot
                      ? `v${r.operating_snapshot.version} · ${formatDateTimeFull(
                          r.operating_snapshot.calculated_at ?? r.operating_snapshot.collected_at,
                        )}`
                      : "—"}
                  </td>
                  <td className="py-2.5 pr-4 font-mono text-[12px] text-ql-fg-tertiary">
                    {r.credential_fingerprint ?? "—"}
                  </td>
                  <td className="py-2.5 pr-4">
                    <StatusTag
                      tone={
                        ISOLATED.has(r.status)
                          ? "warning"
                          : r.status === "DEGRADED"
                            ? "warning"
                            : "neutral"
                      }
                    >
                      {STATUS_LABEL[r.status] ?? r.status}
                    </StatusTag>
                  </td>
                  <td className="whitespace-nowrap py-2.5 pr-4 text-ql-fg-secondary">
                    {formatDateTimeFull(r.created_at)}
                  </td>
                  <td className="py-2.5 text-right">
                    <div className="flex justify-end gap-1">
                      <button
                        className="rounded-md px-2 py-1 text-[12px] font-medium text-ql-action hover:bg-ql-action-soft"
                        onClick={() => {
                          setEditTarget(r);
                          editReset({
                            name: r.name,
                            upstream_models: r.upstream_models?.join(", ") ?? "",
                            concurrency_limit: r.concurrency_limit?.toString() ?? "",
                          });
                        }}
                        type="button"
                      >
                        编辑
                      </button>
                      <button
                        className="rounded-md px-2 py-1 text-[12px] font-medium text-ql-action hover:bg-ql-action-soft"
                        onClick={async () => {
                          setOperatingTarget(r);
                          setOperatingDraft(operatingDraftFromResource(r));
                          setOperatingValidationError("");
                          const history = await get<{ snapshots: ProviderResourceOperatingSnapshot[] }>(
                            `/provider-resources/${r.id}/operating-snapshots`,
                          );
                          setOperatingHistory(history.snapshots);
                        }}
                        type="button"
                      >
                        {r.mode === "CODING_PLAN" ? "更新套餐配置" : "更新经营数据"}
                      </button>
                      {ISOLATED.has(r.status) ? (
                      <button
                        className="rounded-md px-2 py-1 text-[12px] font-medium text-ql-warning hover:bg-ql-warning-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ql-warning"
                        onClick={() => setRecoverTarget(r)}
                        type="button"
                      >
                        恢复
                      </button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </QueryGate>

      <section className="mt-5 rounded-xl border border-ql-border bg-ql-surface p-4">
        <h2 className="text-[14px] font-semibold text-ql-fg">供给预测</h2>
        <p className="mt-1 text-[12px] text-ql-fg-tertiary">
          展示每个资源最新快照；数据不足时不伪造精确预测。
        </p>
        {forecasts.length === 0 ? (
          <p className="mt-3 text-[13px] text-ql-fg-tertiary">暂无预测快照</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full border-collapse text-left text-[12px]">
              <thead>
                <tr className="border-b border-ql-border text-ql-fg-tertiary">
                  <th className="p-2 font-medium">资源</th>
                  <th className="p-2 text-right font-medium">1h / 24h / 7d 速度</th>
                  <th className="p-2 font-medium">预计耗尽</th>
                  <th className="p-2 font-medium">下一恢复</th>
                  <th className="p-2 text-right font-medium">覆盖时长</th>
                  <th className="p-2 font-medium">可信度</th>
                </tr>
              </thead>
              <tbody>
                {forecasts.map((forecast) => (
                  <tr className="border-b border-ql-border-zone last:border-b-0" key={forecast.id}>
                    <td className="p-2 font-medium">{forecast.resource_name}</td>
                    <td className="p-2 text-right font-mono">
                      {forecast.rate_1h ?? "—"} / {forecast.rate_24h ?? "—"} /{" "}
                      {forecast.rate_7d ?? "—"}
                    </td>
                    <td className="p-2">
                      {forecast.forecast_exhaust_at
                        ? formatDateTimeFull(forecast.forecast_exhaust_at)
                        : forecast.not_calculable_reason ?? "不可计算"}
                    </td>
                    <td className="p-2">
                      {forecast.next_recover_at
                        ? formatDateTimeFull(forecast.next_recover_at)
                        : "—"}
                    </td>
                    <td className="p-2 text-right font-mono">
                      {forecast.coverage_hours ? `${forecast.coverage_hours}h` : "—"}
                    </td>
                    <td className="p-2">{forecast.confidence}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* 凭证恢复：二次确认 + 可选轮换（WT-19） */}
      <ConfirmDialog
        confirmLabel="确认恢复"
        impact={`恢复「${recoverTarget?.name}」将从隔离状态（${STATUS_LABEL[recoverTarget?.status ?? ""] ?? recoverTarget?.status}）转为降级观察，恢复为路由候选。${rotateCredential ? "同时将轮换凭证（旧凭证立即失效）。" : "不轮换凭证。"}`}
        loading={recoverMutation.isPending}
        onCancel={() => {
          setRecoverTarget(null);
          setRotateCredential(false);
          setNewCredential("");
        }}
        onConfirm={() => recoverTarget && recoverMutation.mutate(recoverTarget)}
        open={recoverTarget !== null}
        title="恢复资源"
      >
        <label className="flex items-center gap-2 text-[13px] text-ql-fg">
          <input
            checked={rotateCredential}
            onChange={(e) => setRotateCredential(e.target.checked)}
            type="checkbox"
          />
          同时轮换凭证（旧凭证立即失效）
        </label>
        {rotateCredential ? (
          <input
            autoComplete="off"
            className={`${INPUT_CLASS} mt-2 w-full`}
            onChange={(e) => setNewCredential(e.target.value)}
            placeholder="新凭证明文（仅一次提交）"
            type="password"
            value={newCredential}
          />
        ) : null}
      </ConfirmDialog>
    </PageShell>
  );
}
