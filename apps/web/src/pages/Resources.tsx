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

import { post } from "../api/client";
import { QUERY_KEYS, useProviderResources, useProviders } from "../api/hooks";
import type { ProviderResourceItem } from "../api/types";
import { PageShell } from "../components/layout/PageShell";
import { StatusTag } from "../components/dashboard/StatusTag";
import { QueryGate } from "../components/states/QueryGate";
import { ConfirmDialog } from "../components/writes/ConfirmDialog";
import { FormField, INPUT_CLASS } from "../components/writes/FormField";
import { useRedirectOnUnauthorized } from "../components/useRedirectOnUnauthorized";
import { formatDateTimeFull } from "../lib/format";

const CreateResourceSchema = z.object({
  provider_id: z.string().uuid("请选择厂商"),
  name: z.string().min(1, "名称不能为空").max(255),
  mode: z.enum(["API", "CODING_PLAN"]),
  credential_type: z.enum(["API_KEY", "OAUTH", "SUBSCRIPTION_SESSION"]),
  credential_plaintext: z.string().min(1, "凭证不能为空"),
});

type CreateResourceValues = z.infer<typeof CreateResourceSchema>;

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
};

export function ResourcesPage() {
  const query = useProviderResources();
  const providersQuery = useProviders();
  useRedirectOnUnauthorized(query.error ?? providersQuery.error);
  const queryClient = useQueryClient();

  const [showCreate, setShowCreate] = useState(false);
  const [showNewProvider, setShowNewProvider] = useState(false);
  const [recoverTarget, setRecoverTarget] = useState<ProviderResourceItem | null>(null);
  const [rotateCredential, setRotateCredential] = useState(false);
  const [newCredential, setNewCredential] = useState("");

  const createMutation = useMutation({
    mutationFn: (values: CreateResourceValues) =>
      post<{ resource: ProviderResourceItem }>("/provider-resources", values),
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
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.providers });
      setShowNewProvider(false);
      // 新建后自动选中
      setValue("provider_id", data.provider.id);
    },
  });

  const [newProviderName, setNewProviderName] = useState("");
  const [newProviderCode, setNewProviderCode] = useState("zhipu");

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

  const {
    register,
    handleSubmit,
    reset,
    setValue,
    formState: { errors },
  } = useForm<CreateResourceValues, unknown, CreateResourceValues>({
    resolver: zodResolver(CreateResourceSchema),
    defaultValues: {
      provider_id: "",
      name: "",
      mode: "API",
      credential_type: "API_KEY",
      credential_plaintext: "",
    },
  });

  const resources = query.data?.resources ?? [];
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
              <select className={INPUT_CLASS} id="res-mode" {...register("mode")}>
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
                <th className="py-2 pr-4 font-medium">模式</th>
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
                  <td className="py-2.5 pr-4 text-ql-fg-secondary">{MODE_LABEL[r.mode]}</td>
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
                    {ISOLATED.has(r.status) ? (
                      <button
                        className="rounded-md px-2 py-1 text-[12px] font-medium text-ql-warning hover:bg-ql-warning-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ql-warning"
                        onClick={() => setRecoverTarget(r)}
                        type="button"
                      >
                        恢复
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </QueryGate>

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
