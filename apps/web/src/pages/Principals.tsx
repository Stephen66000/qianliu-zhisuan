/**
 * W19 使用主体 —— 列表 + 创建 + 停用（二次确认）。
 *
 * PRD §6：创建四步一期只落第一步（建主体）；Key/grant 在详情展开。
 * 停用 = PATCH status=DISABLED（后端级联撤销全部 Key，TRD §5.3），破坏性 → 二次确认。
 */
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useForm } from "react-hook-form";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Users } from "lucide-react";
import { zodResolver } from "@hookform/resolvers/zod";

import { del, get, post, patch } from "../api/client";
import {
  QUERY_KEYS,
  usePrincipals,
} from "../api/hooks";
import type {
  Principal,
  PrincipalCleanupPreview,
} from "../api/types";
import type { DirectoryMember } from "../api/v2-types";
import { PageShell } from "../components/layout/PageShell";
import { DirectoryPanel } from "../components/principals/DirectoryPanel";
import { StatusTag } from "../components/dashboard/StatusTag";
import { QueryGate } from "../components/states/QueryGate";
import { ConfirmDialog } from "../components/writes/ConfirmDialog";
import { FormField, INPUT_CLASS } from "../components/writes/FormField";
import { useRedirectOnUnauthorized } from "../components/useRedirectOnUnauthorized";
import { formatDateTimeFull } from "../lib/format";
import { useFeatureFlags } from "../feature-flags";
import { EmployeeModelRulesPage } from "./EmployeeModelRules";
import { PrincipalAccessPanel } from "../components/principals/PrincipalAccessPanel";
import { CreatePrincipalSchema, resolvePrincipalTab, TYPE_LABEL, type CreatePrincipalValues, type PrincipalTab } from "./principal-page-support";

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
      resetCreateForm();
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
    setValue: setCreateValue,
    watch: watchCreate,
    formState: { errors },
  } = useForm<CreatePrincipalValues, unknown, CreatePrincipalValues>({
    resolver: zodResolver(CreatePrincipalSchema),
    defaultValues: { type: "EMPLOYEE", name: "", department_label: "" },
  });
  const createType = watchCreate("type");
  const createName = watchCreate("name");

  // B 方式：员工主体名称联想企微候选人，点选后绑定 person_id 并带出部门。
  const [personSuggestions, setPersonSuggestions] = useState<DirectoryMember[]>([]);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [selectedPerson, setSelectedPerson] = useState<DirectoryMember | null>(null);
  const suggestBoxRef = useRef<HTMLDivElement | null>(null);
  const resetCreateForm = () => {
    resetCreate();
    setSelectedPerson(null);
    setPersonSuggestions([]);
    setSuggestionsOpen(false);
  };
  useEffect(() => {
    if (createType !== "EMPLOYEE") return;
    if (selectedPerson && createName === selectedPerson.name) return;
    setSelectedPerson(null);
    const keyword = createName.trim();
    if (!keyword) { setPersonSuggestions([]); setSuggestionsOpen(false); return; }
    const timer = setTimeout(() => {
      void get<{ items?: DirectoryMember[] }>(`/directory-members?search=${encodeURIComponent(keyword)}&limit=20`)
        .then((result) => {
          setPersonSuggestions(Array.isArray(result?.items) ? result.items : []);
          setSuggestionsOpen(true);
        })
        .catch(() => { setPersonSuggestions([]); setSuggestionsOpen(false); });
    }, 300);
    return () => clearTimeout(timer);
  }, [createType, createName, selectedPerson]);
  useEffect(() => {
    const onClickOutside = (event: MouseEvent) => {
      if (suggestBoxRef.current && !suggestBoxRef.current.contains(event.target as Node)) {
        setSuggestionsOpen(false);
      }
    };
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);
  const choosePerson = (member: DirectoryMember) => {
    setSelectedPerson(member);
    setCreateValue("name", member.name);
    setCreateValue("department_label", member.department_name ?? "");
    setSuggestionsOpen(false);
  };

  const principals = query.data?.principals ?? [];

  return (
    <PageShell
      description="员工与项目的统一主体管理；停用主体将同步撤销其全部 Key"
      title="使用主体"
    >
      <div className="mb-4 flex gap-2 border-b border-ql-border">
        <button className={`border-b-2 px-4 py-2 text-[13px] ${activeTab === "principals" ? "border-ql-brand text-ql-brand" : "border-transparent text-ql-fg-secondary"}`} onClick={() => selectTab("principals")} type="button">使用主体</button>
        {featureFlags.FEATURE_DIRECTORY_IMPORT ? <button className={`border-b-2 px-4 py-2 text-[13px] ${activeTab === "directory" ? "border-ql-brand text-ql-brand" : "border-transparent text-ql-fg-secondary"}`} onClick={() => selectTab("directory")} type="button">组织通讯录</button> : null}
        <button className={`border-b-2 px-4 py-2 text-[13px] ${activeTab === "batch-authorization" ? "border-ql-brand text-ql-brand" : "border-transparent text-ql-fg-secondary"}`} onClick={() => selectTab("batch-authorization")} type="button">批量模型授权</button>
      </div>
      {activeTab === "batch-authorization" ? <EmployeeModelRulesPage embedded />
        : featureFlags.FEATURE_DIRECTORY_IMPORT && activeTab === "directory" ? <DirectoryPanel /> : <>
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
        <form
          className="mb-5 flex flex-col gap-4 rounded-xl border border-ql-border bg-ql-surface-subtle p-4"
          onSubmit={handleSubmit((values) =>
            createMutation.mutate({ ...values, person_id: selectedPerson?.person_id ?? null }))}
        >
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <FormField error={errors.type?.message} htmlFor="principal-type" label="类型">
              <select className={INPUT_CLASS} id="principal-type" {...register("type")}>
                <option value="EMPLOYEE">员工</option>
                <option value="PROJECT">项目</option>
              </select>
            </FormField>
            <FormField error={errors.name?.message} htmlFor="principal-name" label="名称">
              <div className="relative" ref={suggestBoxRef}>
                <input
                  aria-autocomplete="list"
                  autoComplete="off"
                  className={INPUT_CLASS}
                  id="principal-name"
                  placeholder={createType === "EMPLOYEE" ? "如：张三（输入可联想企微候选人）" : "如：数据平台项目组"}
                  {...register("name")}
                />
                {createType === "EMPLOYEE" && suggestionsOpen && personSuggestions.length > 0 ? (
                  <ul aria-label="企微候选人" className="absolute z-20 mt-1 max-h-60 w-full overflow-y-auto rounded-lg border border-ql-border bg-ql-surface-raised py-1 shadow-ql-raised" role="listbox">
                    {personSuggestions.map((member) => (
                      <li key={member.person_id} role="option" aria-selected={selectedPerson?.person_id === member.person_id}>
                        <button
                          className="w-full px-3 py-2 text-left hover:bg-ql-surface-subtle"
                          onClick={() => choosePerson(member)}
                          type="button"
                        >
                          <span className="block text-[13px] font-medium text-ql-fg">{member.name}</span>
                          <span className="block text-[12px] text-ql-fg-tertiary">
                            {member.department_name ?? "待归属"}
                            {member.external_member_id ? ` · 企微账号: ${member.external_member_id}` : ""}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
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
          {createType === "EMPLOYEE" && selectedPerson ? (
            <p className="text-[12px] text-ql-fg-secondary" role="status">
              已绑定企微候选人「{selectedPerson.name}」
              {selectedPerson.external_member_id ? `（${selectedPerson.external_member_id}）` : ""}；
              手动修改名称将解除绑定。
            </p>
          ) : null}
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
                resetCreateForm();
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
