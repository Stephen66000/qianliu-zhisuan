/**
 * W19 使用主体 —— 列表 + 创建 + 停用（二次确认）。
 *
 * PRD §6：创建四步一期只落第一步（建主体）；Key/grant 在详情展开。
 * 停用 = PATCH status=DISABLED（后端级联撤销全部 Key，TRD §5.3），破坏性 → 二次确认。
 */
import { useState } from "react";
import { useForm } from "react-hook-form";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Plus, Settings2, Users } from "lucide-react";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";

import { post, patch } from "../api/client";
import {
  QUERY_KEYS,
  useGrants,
  usePrincipalKeys,
  usePrincipals,
  useUnifiedModels,
} from "../api/hooks";
import type { Principal, PrincipalGrantItem } from "../api/types";
import { PageShell } from "../components/layout/PageShell";
import { StatusTag } from "../components/dashboard/StatusTag";
import { QueryGate } from "../components/states/QueryGate";
import { ConfirmDialog } from "../components/writes/ConfirmDialog";
import { FormField, INPUT_CLASS } from "../components/writes/FormField";
import { useRedirectOnUnauthorized } from "../components/useRedirectOnUnauthorized";
import { formatDateTimeFull } from "../lib/format";

const CreatePrincipalSchema = z.object({
  type: z.enum(["EMPLOYEE", "PROJECT"]),
  name: z.string().min(1, "名称不能为空").max(255),
  department_label: z.string().max(255).optional(),
});

const CreateGrantSchema = z.object({
  provider: z.enum(["deepseek", "zhipu", "kimi"]),
  model_alias: z.string().min(1, "请选择模型"),
  quota_value: z.string().regex(/^\d+$/, "额度必须是非负整数"),
  allow_overage: z.boolean(),
});

type CreatePrincipalValues = z.infer<typeof CreatePrincipalSchema>;
type CreateGrantValues = z.infer<typeof CreateGrantSchema>;

const TYPE_LABEL: Record<Principal["type"], string> = {
  EMPLOYEE: "员工",
  PROJECT: "项目",
};

export function PrincipalsPage() {
  const query = usePrincipals();
  useRedirectOnUnauthorized(query.error);
  const queryClient = useQueryClient();

  const [showCreate, setShowCreate] = useState(false);
  const [disableTarget, setDisableTarget] = useState<Principal | null>(null);
  const [selected, setSelected] = useState<Principal | null>(null);

  const createMutation = useMutation({
    mutationFn: (values: CreatePrincipalValues) =>
      post<{ principal: Principal }>("/principals", values),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.principals });
      setShowCreate(false);
      reset();
    },
  });

  const disableMutation = useMutation({
    mutationFn: (target: Principal) =>
      patch<{ principal: Principal }>(`/principals/${target.id}`, { status: "DISABLED" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.principals });
      setDisableTarget(null);
    },
  });

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<CreatePrincipalValues, unknown, CreatePrincipalValues>({
    resolver: zodResolver(CreatePrincipalSchema),
    defaultValues: { type: "EMPLOYEE", name: "", department_label: "" },
  });

  const principals = query.data?.principals ?? [];

  return (
    <PageShell
      description="员工与项目的统一主体管理；停用主体将同步撤销其全部 Key"
      title="使用主体"
    >
      <div className="mb-4 flex justify-end">
        <button
          className="flex h-9 items-center gap-1.5 rounded-lg bg-ql-action px-4 text-[14px] font-medium text-white hover:bg-ql-action-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ql-action"
          onClick={() => setShowCreate((v) => !v)}
          type="button"
        >
          <Plus aria-hidden className="h-4 w-4" />
          新建主体
        </button>
      </div>

      {showCreate ? (
        <form
          className="mb-5 flex flex-col gap-4 rounded-xl border border-ql-border bg-ql-surface-subtle p-4"
          onSubmit={handleSubmit((values) => createMutation.mutate(values))}
        >
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <FormField error={errors.type?.message} htmlFor="principal-type" label="类型">
              <select className={INPUT_CLASS} id="principal-type" {...register("type")}>
                <option value="EMPLOYEE">员工</option>
                <option value="PROJECT">项目</option>
              </select>
            </FormField>
            <FormField error={errors.name?.message} htmlFor="principal-name" label="名称">
              <input
                className={INPUT_CLASS}
                id="principal-name"
                placeholder="如：张三 / 数据平台项目组"
                {...register("name")}
              />
            </FormField>
            <FormField
              error={errors.department_label?.message}
              htmlFor="principal-dept"
              label="部门/标签（可选）"
            >
              <input
                className={INPUT_CLASS}
                id="principal-dept"
                placeholder="如：研发部"
                {...register("department_label")}
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
              {createMutation.isPending ? "创建中…" : "创建"}
            </button>
          </div>
        </form>
      ) : null}

      <QueryGate
        emptyDescription="尚未创建使用主体，也未生成主体 Key。点击右上角「新建主体」创建员工或项目。"
        emptyIcon={Users}
        emptyTitle="尚未创建使用主体"
        error={query.error}
        isEmpty={principals.length === 0}
        isLoading={query.isLoading}
        loadingRows={4}
        onRetry={() => void query.refetch()}
      >
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className="border-b border-ql-border text-[12px] leading-[18px] text-ql-fg-tertiary">
                <th className="py-2 pr-4 font-medium">名称</th>
                <th className="py-2 pr-4 font-medium">类型</th>
                <th className="py-2 pr-4 font-medium">部门/标签</th>
                <th className="py-2 pr-4 font-medium">状态</th>
                <th className="py-2 pr-4 font-medium">创建时间</th>
                <th className="py-2 text-right font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {principals.map((p) => (
                <tr
                  className="border-b border-ql-border-zone text-[13px] leading-5 text-ql-fg last:border-b-0 hover:bg-ql-surface-subtle"
                  key={p.id}
                >
                  <td className="py-2.5 pr-4 font-medium">{p.name}</td>
                  <td className="py-2.5 pr-4 text-ql-fg-secondary">{TYPE_LABEL[p.type]}</td>
                  <td className="py-2.5 pr-4 text-ql-fg-secondary">{p.department_label ?? "—"}</td>
                  <td className="py-2.5 pr-4">
                    <StatusTag tone={p.status === "DISABLED" ? "danger" : "neutral"}>
                      {p.status === "DISABLED" ? "已停用" : "启用中"}
                    </StatusTag>
                  </td>
                  <td className="whitespace-nowrap py-2.5 pr-4 text-ql-fg-secondary">
                    {formatDateTimeFull(p.created_at)}
                  </td>
                  <td className="py-2.5 text-right">
                    <div className="flex justify-end gap-1">
                      <button
                        className="rounded-md px-2 py-1 text-[12px] font-medium text-ql-action hover:bg-ql-action-soft"
                        onClick={() => setSelected(selected?.id === p.id ? null : p)}
                        type="button"
                      >
                        {selected?.id === p.id ? "收起配置" : "接入配置"}
                      </button>
                      {p.status !== "DISABLED" ? (
                        <button
                          className="rounded-md px-2 py-1 text-[12px] font-medium text-ql-danger hover:bg-ql-danger-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ql-danger"
                          onClick={() => setDisableTarget(p)}
                          type="button"
                        >
                          停用
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

      {selected ? <PrincipalAccessPanel principal={selected} /> : null}

      <ConfirmDialog
        danger
        confirmLabel="确认停用"
        impact={`停用后「${disableTarget?.name}」将无法调用任何模型，其全部有效 Key 将被同步撤销。该操作可通过重新启用恢复。`}
        loading={disableMutation.isPending}
        onCancel={() => setDisableTarget(null)}
        onConfirm={() => disableTarget && disableMutation.mutate(disableTarget)}
        open={disableTarget !== null}
        title="停用主体"
      />
    </PageShell>
  );
}

function PrincipalAccessPanel({ principal }: { principal: Principal }) {
  const queryClient = useQueryClient();
  const keysQuery = usePrincipalKeys(principal.id);
  const grantsQuery = useGrants(principal.id);
  const modelsQuery = useUnifiedModels();
  const [plaintextKey, setPlaintextKey] = useState<string | null>(null);
  const [resetConfirm, setResetConfirm] = useState(false);
  const [quotaTarget, setQuotaTarget] = useState<PrincipalGrantItem | null>(null);
  const [quotaValue, setQuotaValue] = useState("");
  const [disableGrantTarget, setDisableGrantTarget] = useState<PrincipalGrantItem | null>(null);

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<CreateGrantValues, unknown, CreateGrantValues>({
    resolver: zodResolver(CreateGrantSchema),
    defaultValues: {
      provider: "zhipu",
      model_alias: "",
      quota_value: "100000",
      allow_overage: false,
    },
  });

  const refreshKeys = () =>
    queryClient.invalidateQueries({ queryKey: QUERY_KEYS.principalKeys(principal.id) });
  const refreshGrants = () =>
    queryClient.invalidateQueries({ queryKey: QUERY_KEYS.grants(principal.id) });

  const createKey = useMutation({
    mutationFn: async () => {
      const result = await post<{ key: string }>(`/principals/${principal.id}/key`);
      setPlaintextKey(result.key);
    },
    onSuccess: () => void refreshKeys(),
  });

  const resetKey = useMutation({
    mutationFn: async () => {
      const result = await post<{ key: string }>(`/principals/${principal.id}/key/reset`);
      setPlaintextKey(result.key);
    },
    onSuccess: () => {
      setResetConfirm(false);
      void refreshKeys();
    },
  });

  const createGrant = useMutation({
    mutationFn: (values: CreateGrantValues) =>
      post(`/principals/${principal.id}/grants`, values),
    onSuccess: () => {
      void refreshGrants();
      reset();
    },
  });

  const updateGrant = useMutation({
    mutationFn: (input: {
      grant: PrincipalGrantItem;
      patch: Record<string, unknown>;
    }) =>
      patch(`/grants/${input.grant.id}`, {
        expected_version: input.grant.version,
        ...input.patch,
      }),
    onSuccess: () => {
      setQuotaTarget(null);
      setDisableGrantTarget(null);
      void refreshGrants();
    },
  });

  const activeKey = (keysQuery.data?.keys ?? []).find((key) => key.status === "ACTIVE");
  const models = (modelsQuery.data?.models ?? []).filter((model) => model.status === "ACTIVE");
  const grants = grantsQuery.data?.grants ?? [];
  const gatewayBaseUrl =
    (import.meta.env.VITE_GATEWAY_BASE_URL as string | undefined) ??
    "http://127.0.0.1:8787/v1";

  return (
    <section className="mt-5 rounded-xl border border-ql-border bg-ql-surface-subtle p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-[14px] font-semibold text-ql-fg">
            <Settings2 aria-hidden className="h-4 w-4" />
            {principal.name} · 接入配置
          </h2>
          <p className="mt-1 text-[12px] text-ql-fg-tertiary">
            固定顺序：生成 Key → 分配模型与额度 → 复制接入信息。
          </p>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-2">
        <div className="rounded-lg border border-ql-border-zone bg-ql-surface p-4">
          <h3 className="text-[13px] font-semibold text-ql-fg">主体 Key</h3>
          {keysQuery.isLoading ? (
            <p className="mt-2 text-[13px] text-ql-fg-tertiary">正在读取 Key 元数据…</p>
          ) : activeKey ? (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <code className="rounded bg-ql-surface-muted px-2 py-1 text-[12px]">
                {activeKey.key_prefix}••••••••
              </code>
              <StatusTag tone="neutral">有效</StatusTag>
              <button
                className="rounded-md px-2 py-1 text-[12px] font-medium text-ql-warning hover:bg-ql-warning-soft"
                onClick={() => setResetConfirm(true)}
                type="button"
              >
                重置 Key
              </button>
            </div>
          ) : (
            <button
              className="mt-2 flex h-9 items-center gap-1.5 rounded-lg bg-ql-action px-3 text-[13px] font-medium text-white disabled:opacity-60"
              disabled={createKey.isPending || principal.status !== "ACTIVE"}
              onClick={() => createKey.mutate()}
              type="button"
            >
              <KeyRound aria-hidden className="h-4 w-4" />
              生成 Key
            </button>
          )}
          {createKey.error || resetKey.error ? (
            <p className="mt-2 text-[12px] text-ql-danger" role="alert">
              {(createKey.error ?? resetKey.error)?.message}
            </p>
          ) : null}

          <div className="mt-4 border-t border-ql-border-zone pt-3">
            <h3 className="text-[13px] font-semibold text-ql-fg">接入信息</h3>
            <dl className="mt-2 grid grid-cols-[5rem_1fr] gap-1 text-[12px]">
              <dt className="text-ql-fg-tertiary">Base URL</dt>
              <dd className="break-all font-mono text-ql-fg">{gatewayBaseUrl}</dd>
              <dt className="text-ql-fg-tertiary">API Key</dt>
              <dd className="font-mono text-ql-fg">
                {activeKey ? `${activeKey.key_prefix}••••••••` : "生成后一次展示"}
              </dd>
              <dt className="text-ql-fg-tertiary">模型</dt>
              <dd className="text-ql-fg">
                {grants.filter((grant) => grant.status === "ACTIVE").map((grant) => grant.model_alias).join("、") ||
                  "尚未分配"}
              </dd>
            </dl>
          </div>
        </div>

        <div className="rounded-lg border border-ql-border-zone bg-ql-surface p-4">
          <h3 className="text-[13px] font-semibold text-ql-fg">分配模型与额度</h3>
          <form
            className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2"
            onSubmit={handleSubmit((values) => createGrant.mutate(values))}
          >
            <FormField error={errors.provider?.message} htmlFor="grant-provider" label="厂商">
              <select className={INPUT_CLASS} id="grant-provider" {...register("provider")}>
                <option value="deepseek">DeepSeek</option>
                <option value="zhipu">智谱</option>
                <option value="kimi">Kimi</option>
              </select>
            </FormField>
            <FormField error={errors.model_alias?.message} htmlFor="grant-model" label="统一模型">
              <select className={INPUT_CLASS} id="grant-model" {...register("model_alias")}>
                <option value="">请选择</option>
                {models.map((model) => (
                  <option key={model.id} value={model.alias}>
                    {model.display_name}（{model.alias}）
                  </option>
                ))}
              </select>
            </FormField>
            <FormField error={errors.quota_value?.message} htmlFor="grant-quota" label="Token 额度">
              <input className={INPUT_CLASS} id="grant-quota" inputMode="numeric" {...register("quota_value")} />
            </FormField>
            <label className="flex items-center gap-2 self-end pb-2 text-[13px] text-ql-fg">
              <input type="checkbox" {...register("allow_overage")} />
              允许超额
            </label>
            <div className="sm:col-span-2 flex justify-end">
              <button
                className="h-9 rounded-lg bg-ql-action px-4 text-[13px] font-medium text-white disabled:opacity-60"
                disabled={createGrant.isPending || models.length === 0}
                type="submit"
              >
                分配
              </button>
            </div>
          </form>
          {createGrant.error ? (
            <p className="mt-2 text-[12px] text-ql-danger" role="alert">
              {createGrant.error.message}
            </p>
          ) : null}
        </div>
      </div>

      {grants.length > 0 ? (
        <div className="mt-4 overflow-x-auto rounded-lg border border-ql-border-zone bg-ql-surface">
          <table className="w-full border-collapse text-left text-[12px]">
            <thead>
              <tr className="border-b border-ql-border text-ql-fg-tertiary">
                <th className="p-2 font-medium">模型</th>
                <th className="p-2 font-medium">厂商</th>
                <th className="p-2 text-right font-medium">额度</th>
                <th className="p-2 font-medium">超额</th>
                <th className="p-2 font-medium">状态</th>
                <th className="p-2 text-right font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {grants.map((grant) => (
                <tr className="border-b border-ql-border-zone last:border-b-0" key={grant.id}>
                  <td className="p-2 font-medium">{grant.model_alias}</td>
                  <td className="p-2 text-ql-fg-secondary">{grant.provider}</td>
                  <td className="p-2 text-right font-mono">{grant.quota_value}</td>
                  <td className="p-2">{grant.allow_overage ? "允许" : "不允许"}</td>
                  <td className="p-2">{grant.status === "ACTIVE" ? "有效" : "已停用"}</td>
                  <td className="p-2 text-right">
                    {grant.status === "ACTIVE" ? (
                      <div className="flex justify-end gap-1">
                        <button
                          className="rounded px-2 py-1 text-ql-action hover:bg-ql-action-soft"
                          onClick={() => {
                            setQuotaTarget(grant);
                            setQuotaValue(grant.quota_value);
                          }}
                          type="button"
                        >
                          调额
                        </button>
                        <button
                          className="rounded px-2 py-1 text-ql-fg-secondary hover:bg-ql-surface-muted"
                          onClick={() =>
                            updateGrant.mutate({
                              grant,
                              patch: { allow_overage: !grant.allow_overage },
                            })
                          }
                          type="button"
                        >
                          {grant.allow_overage ? "关闭超额" : "开启超额"}
                        </button>
                        <button
                          className="rounded px-2 py-1 text-ql-danger hover:bg-ql-danger-soft"
                          onClick={() => setDisableGrantTarget(grant)}
                          type="button"
                        >
                          停用
                        </button>
                      </div>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <ConfirmDialog
        danger
        confirmLabel="确认重置"
        impact={`重置后「${principal.name}」的旧 Key 将立即撤销；新 Key 明文只展示一次。`}
        loading={resetKey.isPending}
        onCancel={() => setResetConfirm(false)}
        onConfirm={() => resetKey.mutate()}
        open={resetConfirm}
        title="重置主体 Key"
      />
      <ConfirmDialog
        confirmLabel="确认调额"
        impact={`将 ${quotaTarget?.model_alias ?? ""} 的 Token 额度更新为新值。`}
        loading={updateGrant.isPending}
        onCancel={() => setQuotaTarget(null)}
        onConfirm={() => {
          if (quotaTarget && /^\d+$/.test(quotaValue)) {
            updateGrant.mutate({ grant: quotaTarget, patch: { quota_value: quotaValue } });
          }
        }}
        open={quotaTarget !== null}
        title="调整额度"
      >
        <FormField htmlFor="quota-update-value" label="新额度">
          <input
            className={`${INPUT_CLASS} w-full`}
            id="quota-update-value"
            inputMode="numeric"
            onChange={(event) => setQuotaValue(event.target.value)}
            value={quotaValue}
          />
        </FormField>
      </ConfirmDialog>
      <ConfirmDialog
        danger
        confirmLabel="确认停用"
        impact={`停用 ${disableGrantTarget?.model_alias ?? ""} 授权后，该主体不能再调用此模型。`}
        loading={updateGrant.isPending}
        onCancel={() => setDisableGrantTarget(null)}
        onConfirm={() =>
          disableGrantTarget &&
          updateGrant.mutate({ grant: disableGrantTarget, patch: { status: "DISABLED" } })
        }
        open={disableGrantTarget !== null}
        title="停用模型授权"
      />
      {plaintextKey ? (
        <div
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-ql-canvas/60 p-4"
          role="dialog"
        >
          <div className="w-full max-w-lg rounded-2xl border border-ql-border bg-ql-surface-raised p-6 shadow-ql-raised">
            <h2 className="text-[16px] font-semibold text-ql-fg">Key 创建成功</h2>
            <p className="mt-1 text-[13px] text-ql-warning">
              明文只展示这一次。关闭后系统无法再次找回，只能重置。
            </p>
            <code className="mt-4 block break-all rounded-lg bg-ql-surface-muted p-3 text-[13px] text-ql-fg">
              {plaintextKey}
            </code>
            <div className="mt-5 flex justify-end">
              <button
                className="h-9 rounded-lg bg-ql-action px-4 text-[13px] font-medium text-white"
                onClick={() => setPlaintextKey(null)}
                type="button"
              >
                已安全保存，关闭
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
