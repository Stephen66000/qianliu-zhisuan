/**
 * W19 使用主体 —— 列表 + 创建 + 停用（二次确认）。
 *
 * PRD §6：创建四步一期只落第一步（建主体）；Key/grant 在详情展开。
 * 停用 = PATCH status=DISABLED（后端级联撤销全部 Key，TRD §5.3），破坏性 → 二次确认。
 */
import { useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Plus, Settings2, Users } from "lucide-react";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";

import { del, get, post, patch } from "../api/client";
import {
  QUERY_KEYS,
  useAccessConfiguration,
  useGrants,
  usePrincipalKeys,
  usePrincipals,
  useUnifiedModels,
} from "../api/hooks";
import type {
  Principal,
  PrincipalCleanupPreview,
} from "../api/types";
import { PageShell } from "../components/layout/PageShell";
import { AgentUsagePanel } from "../components/principals/AgentUsagePanel";
import { PrincipalAccessConfigPanel } from "../components/principals/PrincipalAccessConfigPanel";
import { PrincipalKeyDialog } from "../components/principals/PrincipalKeyDialog";
import { DirectoryPanel } from "../components/principals/DirectoryPanel";
import { StatusTag } from "../components/dashboard/StatusTag";
import { QueryGate } from "../components/states/QueryGate";
import { ConfirmDialog } from "../components/writes/ConfirmDialog";
import { FormField, INPUT_CLASS } from "../components/writes/FormField";
import { useRedirectOnUnauthorized } from "../components/useRedirectOnUnauthorized";
import { formatCount, formatDateTimeFull } from "../lib/format";
import {
  useOrganizationUnits,
  useProjectDepartmentAssignment,
  useSaveProjectDepartmentAssignment,
} from "../api/v2-hooks";
import { useFeatureFlags } from "../feature-flags";

const CreatePrincipalSchema = z.object({
  type: z.enum(["EMPLOYEE", "PROJECT"]),
  name: z.string().min(1, "名称不能为空").max(255),
  department_label: z.string().max(255).optional(),
});

type CreatePrincipalValues = z.infer<typeof CreatePrincipalSchema>;

const TYPE_LABEL: Record<Principal["type"], string> = { EMPLOYEE: "员工", PROJECT: "项目" };

export function PrincipalsPage() {
  const featureFlags = useFeatureFlags();
  const [activeTab, setActiveTab] = useState<"principals" | "directory">("principals");
  const [archivedFilter, setArchivedFilter] = useState<"exclude" | "only">("exclude");
  const query = usePrincipals(archivedFilter);
  useRedirectOnUnauthorized(query.error);
  const queryClient = useQueryClient();

  const [showCreate, setShowCreate] = useState(false);
  const [disableTarget, setDisableTarget] = useState<Principal | null>(null);
  const [selected, setSelected] = useState<Principal | null>(null);
  const [editTarget, setEditTarget] = useState<Principal | null>(null);
  const [editName, setEditName] = useState("");
  const [editDepartment, setEditDepartment] = useState("");
  const [cleanupTarget, setCleanupTarget] = useState<{
    principal: Principal;
    preview: PrincipalCleanupPreview;
  } | null>(null);

  const createMutation = useMutation({
    mutationFn: (values: CreatePrincipalValues) =>
      post<{ principal: Principal }>("/principals", values),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.principals });
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.dashboard });
      setShowCreate(false);
      resetCreate();
    },
  });

  const disableMutation = useMutation({
    mutationFn: (target: Principal) =>
      patch<{ principal: Principal }>(`/principals/${target.id}`, { status: "DISABLED" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.principals });
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.dashboard });
      setDisableTarget(null);
    },
  });

  const reactivateMutation = useMutation({
    mutationFn: (target: Principal) =>
      patch<{ principal: Principal }>(`/principals/${target.id}`, { status: "ACTIVE" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.principals });
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.dashboard });
    },
  });

  const editMutation = useMutation({
    mutationFn: (target: Principal) =>
      patch<{ principal: Principal }>(`/principals/${target.id}`, {
        name: editName.trim(),
        department_label: editDepartment.trim() || null,
      }),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.principals });
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.dashboard });
      setSelected((current) => (current?.id === result.principal.id ? result.principal : current));
      setEditTarget(null);
    },
  });

  const previewMutation = useMutation({
    mutationFn: (target: Principal) =>
      get<{ preview: PrincipalCleanupPreview }>(
        `/principals/${target.id}/cleanup-preview`,
      ),
    onSuccess: (result, target) => {
      setCleanupTarget({ principal: target, preview: result.preview });
    },
  });

  const cleanupMutation = useMutation({
    mutationFn: (target: {
      principal: Principal;
      preview: PrincipalCleanupPreview;
    }) =>
      target.preview.canDelete
        ? del(`/principals/${target.principal.id}`)
        : post(`/principals/${target.principal.id}/archive`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.principals });
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.dashboard });
      setSelected(null);
      setCleanupTarget(null);
    },
  });

  const {
    register,
    handleSubmit,
    reset: resetCreate,
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
      <div className="mb-4 flex gap-2 border-b border-ql-border">
        <button className={`border-b-2 px-4 py-2 text-[13px] ${activeTab === "principals" ? "border-ql-brand text-ql-brand" : "border-transparent text-ql-fg-secondary"}`} onClick={() => setActiveTab("principals")} type="button">使用主体</button>
        {featureFlags.FEATURE_DIRECTORY_IMPORT ? <button className={`border-b-2 px-4 py-2 text-[13px] ${activeTab === "directory" ? "border-ql-brand text-ql-brand" : "border-transparent text-ql-fg-secondary"}`} onClick={() => setActiveTab("directory")} type="button">组织通讯录</button> : null}
      </div>
      {featureFlags.FEATURE_DIRECTORY_IMPORT && activeTab === "directory" ? <DirectoryPanel /> : <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <label className="flex items-center gap-2 text-[13px] text-ql-fg-secondary">
          显示范围
          <select
            className={`${INPUT_CLASS} h-9 w-auto`}
            onChange={(event) =>
              setArchivedFilter(event.target.value as "exclude" | "only")
            }
            value={archivedFilter}
          >
            <option value="exclude">在用与已停用</option>
            <option value="only">已归档</option>
          </select>
        </label>
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
                resetCreate();
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
                      {p.archived_at
                        ? "已归档"
                        : p.status === "DISABLED"
                          ? "已停用"
                          : "启用中"}
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
                      {!p.archived_at ? (
                        <button
                          className="rounded-md px-2 py-1 text-[12px] font-medium text-ql-action hover:bg-ql-action-soft"
                          onClick={() => {
                            setEditTarget(p);
                            setEditName(p.name);
                            setEditDepartment(p.department_label ?? "");
                          }}
                          type="button"
                        >
                          编辑
                        </button>
                      ) : null}
                      {!p.archived_at && p.status !== "DISABLED" ? (
                        <button
                          className="rounded-md px-2 py-1 text-[12px] font-medium text-ql-danger hover:bg-ql-danger-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ql-danger"
                          onClick={() => setDisableTarget(p)}
                          type="button"
                        >
                          停用
                        </button>
                      ) : null}
                      {!p.archived_at && p.status === "DISABLED" ? (
                        <button
                          className="rounded-md px-2 py-1 text-[12px] font-medium text-ql-action hover:bg-ql-action-soft"
                          disabled={reactivateMutation.isPending}
                          onClick={() => reactivateMutation.mutate(p)}
                          type="button"
                        >
                          重新启用
                        </button>
                      ) : null}
                      {!p.archived_at ? (
                        <button
                          className="rounded-md px-2 py-1 text-[12px] font-medium text-ql-danger hover:bg-ql-danger-soft"
                          disabled={previewMutation.isPending}
                          onClick={() => previewMutation.mutate(p)}
                          type="button"
                        >
                          清理
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

      {selected ? <PrincipalAccessPanel key={selected.id} principal={selected} /> : null}

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
      <ConfirmDialog
        confirmLabel="保存修改"
        impact="主体类型创建后不可修改；名称变更会同步用于列表、接入配置和后续账本展示。"
        loading={editMutation.isPending}
        onCancel={() => setEditTarget(null)}
        onConfirm={() => {
          if (editTarget && editName.trim()) editMutation.mutate(editTarget);
        }}
        open={editTarget !== null}
        title="编辑主体"
      >
        <div className="grid gap-3">
          <FormField htmlFor="principal-edit-name" label="名称">
            <input
              className={INPUT_CLASS}
              id="principal-edit-name"
              maxLength={255}
              onChange={(event) => setEditName(event.target.value)}
              value={editName}
            />
          </FormField>
          <FormField htmlFor="principal-edit-department" label="部门/标签（可选）">
            <input
              className={INPUT_CLASS}
              id="principal-edit-department"
              maxLength={255}
              onChange={(event) => setEditDepartment(event.target.value)}
              value={editDepartment}
            />
          </FormField>
        </div>
      </ConfirmDialog>
      <ConfirmDialog
        danger
        confirmLabel={cleanupTarget?.preview.canDelete ? "确认删除" : "确认归档"}
        impact={
          cleanupTarget
            ? cleanupTarget.preview.canDelete
              ? `「${cleanupTarget.principal.name}」没有请求、Usage 或账本历史，将删除主体及 ${cleanupTarget.preview.keyCount} 把 Key、${cleanupTarget.preview.grantCount} 条 Grant。`
              : `「${cleanupTarget.principal.name}」已有 ${cleanupTarget.preview.requestCount} 条请求、${cleanupTarget.preview.usageCount} 条 Usage、${cleanupTarget.preview.ledgerCount} 条账本记录、${cleanupTarget.preview.authorizationRuleAssignmentCount ?? 0} 条批量模型授权，只会停用并归档；将撤销 ${cleanupTarget.preview.activeKeyCount} 把有效 Key、${cleanupTarget.preview.activeGrantCount} 条有效 Grant，历史数据继续保留。`
            : ""
        }
        loading={cleanupMutation.isPending}
        onCancel={() => setCleanupTarget(null)}
        onConfirm={() => cleanupTarget && cleanupMutation.mutate(cleanupTarget)}
        open={cleanupTarget !== null}
        title={cleanupTarget?.preview.canDelete ? "删除主体" : "归档主体"}
      />
      </>}
    </PageShell>
  );
}

function PrincipalAccessPanel({ principal }: { principal: Principal }) {
  const featureFlags = useFeatureFlags();
  const queryClient = useQueryClient();
  const keysQuery = usePrincipalKeys(principal.id);
  const grantsQuery = useGrants(principal.id);
  const modelsQuery = useUnifiedModels();
  const [plaintextKey, setPlaintextKey] = useState<string | null>(null);
  const [keyDialogOpen, setKeyDialogOpen] = useState(false);
  const [copyStatus, setCopyStatus] = useState<"idle" | "success" | "error">("idle");
  const [resetConfirm, setResetConfirm] = useState(false);
  // POOL-033（GLM 评审 P0-1）：池化后额度只读展示——调额/超额/停用统一走上方
  // 接入配置面板（编排端点单事务），不再提供 PATCH /grants/:id 直写入口。
  const currentPrincipalIdRef = useRef(principal.id);
  const mountedRef = useRef(true);
  currentPrincipalIdRef.current = principal.id;

  useEffect(() => {
    setPlaintextKey(null);
    setKeyDialogOpen(false);
    setCopyStatus("idle");
    setResetConfirm(false);
  }, [principal.id]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refreshKeys = (principalId = principal.id) =>
    queryClient.invalidateQueries({ queryKey: QUERY_KEYS.principalKeys(principalId) });

  const createKey = useMutation({
    mutationFn: async () => {
      const requestedPrincipalId = principal.id;
      const result = await post<{ key: string }>(`/principals/${requestedPrincipalId}/key`, {
        allowed_model_ids: [],
      });
      return { requestedPrincipalId, key: result.key };
    },
    onSuccess: (result) => {
      void refreshKeys(result.requestedPrincipalId);
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.dashboard });
      if (
        mountedRef.current &&
        currentPrincipalIdRef.current === result.requestedPrincipalId
      ) {
        setPlaintextKey(result.key);
        setKeyDialogOpen(true);
        setCopyStatus("idle");
      }
    },
  });

  const resetKey = useMutation({
    mutationFn: async () => {
      const requestedPrincipalId = principal.id;
      const result = await post<{ key: string }>(
        `/principals/${requestedPrincipalId}/key/reset`,
      );
      return { requestedPrincipalId, key: result.key };
    },
    onSuccess: (result) => {
      void refreshKeys(result.requestedPrincipalId);
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.dashboard });
      if (
        mountedRef.current &&
        currentPrincipalIdRef.current === result.requestedPrincipalId
      ) {
        setPlaintextKey(result.key);
        setKeyDialogOpen(true);
        setCopyStatus("idle");
        setResetConfirm(false);
      }
    },
  });

  const activeKey = (keysQuery.data?.keys ?? []).find((key) => key.status === "ACTIVE");
  const models = (modelsQuery.data?.models ?? []).filter((model) => model.status === "ACTIVE");
  const grants = grantsQuery.data?.grants ?? [];
  const gatewayBaseUrl =
    (import.meta.env.VITE_GATEWAY_BASE_URL as string | undefined) ??
    (import.meta.env.PROD
      ? "https://gw.qianliuai.com/v1"
      : "http://127.0.0.1:8787/v1");
  const allowedModelIds = activeKey?.allowed_model_ids ?? [];
  // POOL-033：授权型号以接入配置为准（池化后 allowed_model_ids 由编排端点维护）。
  const accessConfigQuery = useAccessConfiguration(principal.id);
  const accessConfig = accessConfigQuery.data;
  const authorizedAliases = accessConfig
    ? accessConfig.providers.flatMap((p) => p.models.filter((m) => m.enabled).map((m) => m.alias))
    : models
        .filter((model) => allowedModelIds.includes(model.id))
        .filter((model) =>
          grants.some((grant) =>
            grant.status === "ACTIVE"
            && grant.model_alias === model.alias
            && (!grant.valid_until || new Date(grant.valid_until).getTime() > Date.now())
          )
        )
        .map((model) => model.alias);
  const copyConnectionInfo = async () => {
    if (!plaintextKey) return;
    const content = [
      `Gateway Base URL: ${gatewayBaseUrl}`,
      `API Key: ${plaintextKey}`,
      `Models: ${authorizedAliases.join(", ") || "暂无已授权且有效额度的模型"}`,
      "Protocol: OpenAI-compatible (/v1/chat/completions, /v1/responses)",
    ].join("\n");
    try {
      await navigator.clipboard.writeText(content);
      setCopyStatus("success");
    } catch {
      setCopyStatus("error");
    }
  };

  return (
    <section className="mt-5 rounded-xl border border-ql-border bg-ql-surface-subtle p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-[14px] font-semibold text-ql-fg">
            <Settings2 aria-hidden className="h-4 w-4" />
            {principal.name} · 接入配置
          </h2>
          <p className="mt-1 text-[12px] text-ql-fg-tertiary">
            生成 Key → 按厂商配置额度与型号 → 保存生效 → 复制接入信息。
          </p>
        </div>
      </div>

      {featureFlags.FEATURE_DEPARTMENT_COST && principal.type === "PROJECT" ? (
        <ProjectDepartmentEditor projectId={principal.id} />
      ) : null}

      <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-2">
        <div className="rounded-lg border border-ql-border-zone bg-ql-surface p-4">
          <h3 className="text-[13px] font-semibold text-ql-fg">主体 Key</h3>
          {keysQuery.isLoading ? (
            <p className="mt-2 text-[13px] text-ql-fg-tertiary">正在读取 Key 元数据…</p>
          ) : activeKey ? (
            <div className="mt-2">
              <div className="flex flex-wrap items-center gap-2">
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
            </div>
          ) : null}

          {activeKey ? null : (
            <button
              className="mt-3 flex h-9 items-center gap-1.5 rounded-lg bg-ql-action px-3 text-[13px] font-medium text-white disabled:opacity-60"
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
                {plaintextKey
                  ? plaintextKey
                  : activeKey
                    ? `${activeKey.key_prefix}••••••••`
                    : "生成后一次展示"}
              </dd>
              <dt className="text-ql-fg-tertiary">模型</dt>
              <dd className="text-ql-fg">
                {authorizedAliases.join("、") ||
                  "尚未分配"}
              </dd>
            </dl>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button
                className="h-8 rounded-md bg-ql-action px-3 text-[12px] font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
                disabled={!plaintextKey}
                onClick={() => void copyConnectionInfo()}
                type="button"
              >
                复制接入信息
              </button>
              {plaintextKey ? (
                <button
                  className="h-8 rounded-md border border-ql-border px-3 text-[12px] text-ql-fg-secondary"
                  onClick={() => {
                    setPlaintextKey(null);
                    setCopyStatus("idle");
                  }}
                  type="button"
                >
                  清除一次性 Key
                </button>
              ) : (
                <span className="text-[11px] text-ql-warning">
                  完整 Key 已不可恢复；如未保存，请重置 Key。
                </span>
              )}
              {copyStatus === "success" ? (
                <span className="text-[11px] text-ql-success" role="status">复制成功</span>
              ) : null}
              {copyStatus === "error" ? (
                <span className="text-[11px] text-ql-danger" role="alert">复制失败，请检查剪贴板权限</span>
              ) : null}
            </div>
          </div>
        </div>

        <div className="rounded-lg border border-ql-border-zone bg-ql-surface p-4">
          <h3 className="text-[13px] font-semibold text-ql-fg">型号与额度</h3>
          <p className="mt-1 text-[12px] text-ql-fg-tertiary">
            按厂商开通额度池；厂商下型号默认全开，可单个掐掉。
          </p>
          <div className="mt-3">
            <PrincipalAccessConfigPanel principalId={principal.id} />
          </div>
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
              </tr>
            </thead>
            <tbody>
              {grants.map((grant) => (
                <tr className="border-b border-ql-border-zone last:border-b-0" key={grant.id}>
                  <td className="p-2 font-medium">{grant.model_alias}</td>
                  <td className="p-2 text-ql-fg-secondary">{grant.provider}</td>
                  <td className="p-2 text-right font-mono">{formatCount(grant.quota_value)}</td>
                  <td className="p-2">{grant.allow_overage ? "允许" : "不允许"}</td>
                  <td className="p-2">{grant.status === "ACTIVE" ? "有效" : "已停用"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="border-t border-ql-border-zone p-2 text-[12px] text-ql-fg-tertiary">
            额度为只读展示；调额、超额开关与停用请在上方「接入配置」面板中操作。
          </p>
        </div>
      ) : null}

      <AgentUsagePanel principalId={principal.id} />

      <ConfirmDialog
        danger
        confirmLabel="确认重置"
        impact={`重置后「${principal.name}」的旧 Key 将立即撤销；新 Key 完整继承模型、IP、有效期和限额，新 Key 明文只展示一次。`}
        loading={resetKey.isPending}
        onCancel={() => setResetConfirm(false)}
        onConfirm={() => resetKey.mutate()}
        open={resetConfirm}
        title="重置主体 Key"
      />
      <PrincipalKeyDialog
        copyStatus={copyStatus}
        onClose={() => setKeyDialogOpen(false)}
        onCopy={() => void copyConnectionInfo()}
        open={keyDialogOpen}
        plaintextKey={plaintextKey}
      />
    </section>
  );
}

function ProjectDepartmentEditor({ projectId }: { projectId: string }) {
  const projectDepartment = useProjectDepartmentAssignment(projectId);
  const organizationUnits = useOrganizationUnits();
  const save = useSaveProjectDepartmentAssignment(projectId);
  const [departmentId, setDepartmentId] = useState("");
  useEffect(() => {
    setDepartmentId(projectDepartment.data?.assignment?.organization_unit_id ?? "");
  }, [projectDepartment.data?.assignment?.organization_unit_id]);
  return <div className="mt-4 rounded-lg border border-ql-border-zone bg-ql-surface p-4">
    <h3 className="text-[13px] font-semibold text-ql-fg">项目归属部门</h3>
    <p className="mt-1 text-[11px] text-ql-fg-tertiary">仅影响设置后的新请求；历史请求按发生时点快照保留。</p>
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <select aria-label="项目归属部门" className={`${INPUT_CLASS} min-w-56`} disabled={organizationUnits.isLoading} onChange={(event) => setDepartmentId(event.target.value)} value={departmentId}>
        <option value="">请选择部门</option>
        {(organizationUnits.data?.units ?? []).map((unit) => <option key={unit.id} value={unit.id}>{unit.path}</option>)}
      </select>
      <button className="h-9 rounded-lg bg-ql-action px-3 text-[12px] font-medium text-white disabled:opacity-50" disabled={!departmentId || save.isPending} onClick={() => void save.mutateAsync({
        organization_unit_id: departmentId,
        expected_version: projectDepartment.data?.assignment?.version ?? 0,
        reason: "WEB_ADMIN",
      })} type="button">{save.isPending ? "保存中…" : "保存归属"}</button>
      {projectDepartment.data?.assignment ? <span className="text-[11px] text-ql-fg-tertiary">版本 {projectDepartment.data.assignment.version} · {projectDepartment.data.assignment.department_name}</span> : null}
    </div>
    {projectDepartment.error || save.error ? <p className="mt-2 text-[12px] text-ql-danger">{(projectDepartment.error ?? save.error)?.message}</p> : null}
  </div>;
}
