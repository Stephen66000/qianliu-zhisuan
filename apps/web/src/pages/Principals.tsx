/**
 * W19 使用主体 —— 列表 + 创建 + 停用（二次确认）。
 *
 * PRD §6：创建四步一期只落第一步（建主体）；Key/grant 在详情展开。
 * 停用 = PATCH status=DISABLED（后端级联撤销全部 Key，TRD §5.3），破坏性 → 二次确认。
 */
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Users } from "lucide-react";

import { del, get, post, patch } from "../api/client";
import { QUERY_KEYS, usePrincipals } from "../api/hooks";
import type { Principal, PrincipalCleanupPreview } from "../api/types";
import { PageShell } from "../components/layout/PageShell";
import { DirectoryPanel } from "../components/principals/DirectoryPanel";
import { StatusTag } from "../components/dashboard/StatusTag";
import { QueryGate } from "../components/states/QueryGate";
import { ConfirmDialog } from "../components/writes/ConfirmDialog";
import { FormField, INPUT_CLASS } from "../components/writes/FormField";
import { useRedirectOnUnauthorized } from "../components/useRedirectOnUnauthorized";
import { formatDateTimeFull, maskMobile } from "../lib/format";
import { useFeatureFlags } from "../feature-flags";
import { EmployeeModelRulesPage } from "./EmployeeModelRules";
import { PrincipalCreateForm } from "../components/principals/PrincipalCreateForm";
import { PrincipalAccountingPanel } from "../components/principals/PrincipalAccountingPanel";
import { PrincipalAccessPanel } from "../components/principals/PrincipalAccessPanel";
import {
  resolvePrincipalTab,
  TYPE_LABEL,
  type PrincipalTab,
} from "./principal-page-support";

export function PrincipalsPage() {
  const featureFlags = useFeatureFlags();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedTab = searchParams.get("tab");
  const [activeTab, setActiveTab] = useState<PrincipalTab>(
    resolvePrincipalTab(requestedTab, featureFlags.FEATURE_DIRECTORY_IMPORT),
  );
  useEffect(() => {
    setActiveTab(resolvePrincipalTab(requestedTab, featureFlags.FEATURE_DIRECTORY_IMPORT));
  }, [featureFlags.FEATURE_DIRECTORY_IMPORT, requestedTab]);
  const selectTab = (tab: PrincipalTab) => {
    const next = new URLSearchParams(searchParams);
    if (tab === "principals") next.delete("tab");
    else next.set("tab", tab);
    setSearchParams(next);
    setActiveTab(tab);
  };
  const [principalScope, setPrincipalScope] = useState<"active" | "disabled" | "archived">("active");
  const query = usePrincipals(
    principalScope === "archived" ? "only" : "exclude",
    principalScope === "active" ? "ACTIVE" : principalScope === "disabled" ? "DISABLED" : undefined,
  );
  useRedirectOnUnauthorized(query.error);
  const queryClient = useQueryClient();

  const [showCreate, setShowCreate] = useState(false);
  const [disableTarget, setDisableTarget] = useState<Principal | null>(null);
  const [selected, setSelected] = useState<Principal | null>(null);
  const [editTarget, setEditTarget] = useState<Principal | null>(null);
  const [accountingTarget, setAccountingTarget] = useState<Principal | null>(
    null,
  );
  const [editName, setEditName] = useState("");
  const [cleanupTarget, setCleanupTarget] = useState<{
    principal: Principal;
    preview: PrincipalCleanupPreview;
  } | null>(null);


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
      }),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.principals });
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.dashboard });
      setSelected((current) =>
        current?.id === result.principal.id ? result.principal : current,
      );
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


  const principals = query.data?.principals ?? [];

  return (
    <PageShell
      description="员工与项目的统一主体管理；停用主体将同步撤销其全部 Key"
      title="使用主体"
    >
      <div className="mb-4 flex gap-2 border-b border-ql-border">
        <button className={`border-b-2 px-4 py-2 text-[13px] ${activeTab === "principals" ? "border-ql-brand text-ql-brand" : "border-transparent text-ql-fg-secondary"}`} onClick={() => selectTab("principals")} type="button">使用主体</button>
        {featureFlags.FEATURE_DIRECTORY_IMPORT ? (
          <button className={`border-b-2 px-4 py-2 text-[13px] ${activeTab === "directory" ? "border-ql-brand text-ql-brand" : "border-transparent text-ql-fg-secondary"}`} onClick={() => selectTab("directory")} type="button">组织通讯录</button>
        ) : null}
        <button data-write-action className={`border-b-2 px-4 py-2 text-[13px] ${activeTab === "batch-authorization" ? "border-ql-brand text-ql-brand" : "border-transparent text-ql-fg-secondary"}`} onClick={() => selectTab("batch-authorization")} type="button">批量模型授权</button>
      </div>
      {activeTab === "batch-authorization" ? (
        <EmployeeModelRulesPage embedded />
      ) : featureFlags.FEATURE_DIRECTORY_IMPORT && activeTab === "directory" ? (
        <DirectoryPanel />
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <label className="flex items-center gap-2 text-[13px] text-ql-fg-secondary">
          显示范围
          <select
            className={`${INPUT_CLASS} h-9 w-auto`}
            onChange={(event) =>
              setPrincipalScope(event.target.value as "active" | "disabled" | "archived")
            }
            value={principalScope}
          >
            <option value="active">在用</option>
            <option value="disabled">停用</option>
            <option value="archived">归档</option>
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
            <PrincipalCreateForm onClose={() => setShowCreate(false)} />
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
                    <th className="py-2 pr-4 font-medium">部门</th>
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
                      <td className="py-2.5 pr-4 font-medium">
                        <div>{p.name}</div>
                        {p.type === "EMPLOYEE" && (p.employee_number || p.mobile) ? (
                          <div className="text-[11px] font-normal text-ql-fg-tertiary">
                            {p.employee_number ? `工号: ${p.employee_number}` : ""}
                            {p.employee_number && p.mobile ? " · " : ""}
                            {p.mobile ? (p.employee_number ? `手机: ${maskMobile(p.mobile)}` : `账号/手机: ${maskMobile(p.mobile)}`) : ""}
                          </div>
                        ) : null}
                      </td>
                      <td className="py-2.5 pr-4 text-ql-fg-secondary">
                        {TYPE_LABEL[p.type]}
                      </td>
                      <td className="py-2.5 pr-4 text-ql-fg-secondary">
                        {p.type === "PROJECT"
                          ? "随负责人部门"
                          : (p.department_label ?? "待设置")}
                      </td>
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
                          {!p.archived_at &&
                          featureFlags.FEATURE_DEPARTMENT_COST ? (
                            <button data-write-action
                              className="rounded-md px-2 py-1 text-[12px] text-ql-action"
                              onClick={() => setAccountingTarget(p)}
                              type="button"
                            >
                              {p.type === "EMPLOYEE"
                                ? "所属部门"
                                : "项目负责人"}
                            </button>
                          ) : null}
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
                              }}
                              type="button"
                            >
                              编辑
                            </button>
                          ) : null}
                          {!p.archived_at && p.status !== "DISABLED" ? (
                        <button data-write-action
                          className="rounded-md px-2 py-1 text-[12px] font-medium text-ql-danger hover:bg-ql-danger-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ql-danger"
                          onClick={() => setDisableTarget(p)}
                          type="button"
                        >
                          停用
                        </button>
                      ) : null}
                          {!p.archived_at && p.status === "DISABLED" ? (
                        <button data-write-action
                          className="rounded-md px-2 py-1 text-[12px] font-medium text-ql-action hover:bg-ql-action-soft"
                          disabled={reactivateMutation.isPending}
                          onClick={() => reactivateMutation.mutate(p)}
                          type="button"
                        >
                          重新启用
                        </button>
                      ) : null}
                          {!p.archived_at ? (
                        <button data-write-action
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

          {accountingTarget ? (
            <PrincipalAccountingPanel
              key={accountingTarget.id}
              principal={accountingTarget}
              onClose={() => setAccountingTarget(null)}
            />
          ) : null}
          {selected ? (
            <PrincipalAccessPanel key={selected.id} principal={selected} />
          ) : null}

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
            </div>
          </ConfirmDialog>
          <ConfirmDialog
            danger
            confirmLabel={
              cleanupTarget?.preview.canDelete ? "确认删除" : "确认归档"
            }
            impact={
              cleanupTarget
                ? cleanupTarget.preview.canDelete
                  ? `「${cleanupTarget.principal.name}」没有请求、Usage 或账本历史，将删除主体及 ${cleanupTarget.preview.keyCount} 把 Key、${cleanupTarget.preview.grantCount} 条 Grant。`
                  : `「${cleanupTarget.principal.name}」已有 ${cleanupTarget.preview.requestCount} 条请求、${cleanupTarget.preview.usageCount} 条 Usage、${cleanupTarget.preview.ledgerCount} 条账本记录、${cleanupTarget.preview.authorizationRuleAssignmentCount ?? 0} 条批量模型授权、${cleanupTarget.preview.accountingAssignmentCount ?? 0} 条归属记录，只会停用并归档；将撤销 ${cleanupTarget.preview.activeKeyCount} 把有效 Key、${cleanupTarget.preview.activeGrantCount} 条有效 Grant，历史数据继续保留。`
                : ""
            }
            loading={cleanupMutation.isPending}
            onCancel={() => setCleanupTarget(null)}
            onConfirm={() =>
              cleanupTarget && cleanupMutation.mutate(cleanupTarget)
            }
            open={cleanupTarget !== null}
            title={cleanupTarget?.preview.canDelete ? "删除主体" : "归档主体"}
          />
        </>
      )}
    </PageShell>
  );
}
