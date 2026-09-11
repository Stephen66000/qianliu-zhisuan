import { useMemo, useState } from "react";
import { Download, RefreshCw, Search, Upload } from "lucide-react";
import { download } from "../../api/client";
import {
  useActivateDirectoryMembers, useBatchDeleteDirectoryMembers, useDeleteDirectoryMember,
  useDirectoryImportItems, useDirectoryImportRun, useDirectoryMembers,
  useDirectorySource, useSaveDirectorySource, useStartDirectorySync,
  useUploadDirectoryExcel,
} from "../../api/v2-hooks";
import { StatusTag } from "../dashboard/StatusTag";
import { ConfirmDialog } from "../writes/ConfirmDialog";
import { INPUT_CLASS } from "../writes/FormField";
import { ActivationListDialog } from "./ActivationListDialog";
import { DirectoryMembersTable, isActivated } from "./DirectoryMembersTable";

type ActivationFilter = "all" | "inactive" | "active";

function RunResultSection({ runId }: { runId: string }) {
  const run = useDirectoryImportRun(runId);
  const items = useDirectoryImportItems(runId);
  return (
    <section className="rounded-xl border border-ql-border-zone bg-ql-surface p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-[15px] font-semibold">最近处理结果</h2>
        <StatusTag tone={run.data?.run.status === "SUCCEEDED" ? "success" : run.data?.run.status === "FAILED" ? "danger" : "warning"}>
          {run.data?.run.status ?? "读取中"}
        </StatusTag>
      </div>
      {run.data ? (
        <p className="mt-2 text-[12px] text-ql-fg-secondary">
          共 {run.data.run.total_count} · 成功 {run.data.run.success_count} · 冲突 {run.data.run.conflict_count} · 失败 {run.data.run.failed_count}
        </p>
      ) : null}
      {(items.data?.items ?? []).length ? (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-left text-[12px]">
            <thead>
              <tr className="border-b border-ql-border text-ql-fg-tertiary">
                <th className="py-2">行</th>
                <th>姓名</th>
                <th>部门</th>
                <th>结果</th>
                <th>原因</th>
              </tr>
            </thead>
            <tbody>
              {items.data!.items.map((item) => (
                <tr className="border-b border-ql-border-zone" key={item.id}>
                  <td className="py-2">{item.row_number ?? "—"}</td>
                  <td>{item.normalized_name}</td>
                  <td>{item.normalized_department ?? "—"}</td>
                  <td>{item.status}</td>
                  <td>{item.reason_code ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}

export function DirectoryPanel() {
  const [search, setSearch] = useState("");
  const [sourceType, setSourceType] = useState<"WECOM" | "FEISHU">("WECOM");
  const [identity, setIdentity] = useState("");
  const [secret, setSecret] = useState("");
  const [runId, setRunId] = useState<string | null>(null);
  const [activationFilter, setActivationFilter] = useState<ActivationFilter>("all");
  const [selectedPersonIds, setSelectedPersonIds] = useState<Set<string>>(new Set());
  const [batchConfirmOpen, setBatchConfirmOpen] = useState(false);
  const [batchDeleteConfirmOpen, setBatchDeleteConfirmOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [batchDeleteError, setBatchDeleteError] = useState<string | null>(null);
  const [batchNotice, setBatchNotice] = useState<string | null>(null);
  const [listUploadOpen, setListUploadOpen] = useState(false);
  const members = useDirectoryMembers(search);
  const source = useDirectorySource(sourceType);
  const saveSource = useSaveDirectorySource(sourceType);
  const startSync = useStartDirectorySync();
  const excel = useUploadDirectoryExcel();
  const activate = useActivateDirectoryMembers();
  const deleteMember = useDeleteDirectoryMember();
  const batchDeleteMembers = useBatchDeleteDirectoryMembers();

  const confirmDeleteSingle = async () => {
    if (!deleteTarget) return;
    setDeleteError(null);
    try {
      await deleteMember.mutateAsync(deleteTarget.id);
      selectedPersonIds.delete(deleteTarget.id);
      setSelectedPersonIds(new Set(selectedPersonIds));
      setBatchNotice(`已成功清理候选人员档案「${deleteTarget.name}」`);
      setDeleteTarget(null);
    } catch (err) {
      setDeleteError((err as Error)?.message ?? "清理失败");
    }
  };

  const confirmBatchDelete = async () => {
    const unactivatedIds = selectedRows.filter((m) => !isActivated(m)).map((m) => m.person_id);
    if (!unactivatedIds.length) return;
    setBatchDeleteError(null);
    try {
      const res = await batchDeleteMembers.mutateAsync(unactivatedIds);
      for (const id of unactivatedIds) selectedPersonIds.delete(id);
      setSelectedPersonIds(new Set(selectedPersonIds));
      setBatchNotice(`已清理 ${res.deleted_count} 名候选人员档案${res.skipped_active_count ? `（跳过 ${res.skipped_active_count} 名已开通主体的人员）` : ""}`);
      setBatchDeleteConfirmOpen(false);
    } catch (err) {
      setBatchDeleteError((err as Error)?.message ?? "批量清理失败");
    }
  };

  const save = async () => {
    const result = await saveSource.mutateAsync({
      expected_version: source.data?.source?.version ?? 0,
      status: "ACTIVE",
      config: sourceType === "WECOM"
        ? { corp_id: identity.trim(), corp_secret: secret }
        : { app_id: identity.trim(), app_secret: secret },
    });
    setIdentity(""); setSecret("");
    return result;
  };
  const sync = async () => {
    const current = source.data?.source;
    if (!current) return;
    const result = await startSync.mutateAsync(current.id); setRunId(result.runId);
  };
  const uploadExcel = async (file: File) => {
    const result = await excel.mutateAsync(file); setRunId(result.runId);
  };
  const downloadTemplate = async () => {
    const blob = await download("/directory-excel-template");
    const url = URL.createObjectURL(blob); const anchor = document.createElement("a");
    anchor.href = url; anchor.download = "仟流智算-通讯录导入模板-v1.xlsx"; anchor.click();
    URL.revokeObjectURL(url);
  };

  const filteredRows = useMemo(() => (members.data?.items ?? []).filter((member) => {
    if (activationFilter === "inactive") return !isActivated(member);
    if (activationFilter === "active") return isActivated(member);
    return true;
  }), [members.data, activationFilter]);
  const selectedRows = filteredRows.filter((member) => selectedPersonIds.has(member.person_id));
  const pageAllSelected = filteredRows.length > 0
    && filteredRows.every((member) => selectedPersonIds.has(member.person_id));
  const togglePerson = (personId: string) => {
    setSelectedPersonIds((current) => {
      const next = new Set(current);
      if (next.has(personId)) next.delete(personId); else next.add(personId);
      return next;
    });
  };
  const togglePage = () => {
    setSelectedPersonIds((current) => {
      const next = new Set(current);
      if (pageAllSelected) filteredRows.forEach((member) => next.delete(member.person_id));
      else filteredRows.forEach((member) => next.add(member.person_id));
      return next;
    });
  };
  const runActivation = async (personIds: string[]) => {
    const result = await activate.mutateAsync(personIds);
    setSelectedPersonIds(new Set());
    setBatchConfirmOpen(false);
    setBatchNotice(`开通完成：新开通 ${result.activated_count} 人，已开通跳过 ${result.already_active_count} 人。`);
  };

  const currentSource = source.data?.source;
  return <div className="space-y-4">
    <section className="rounded-xl border border-ql-border-zone bg-ql-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-[15px] font-semibold text-ql-fg">接口同步</h2>
            <StatusTag tone={currentSource?.status === "ACTIVE" ? "success" : "neutral"}>
              {currentSource?.status === "ACTIVE" ? "已配置" : "未配置"}
            </StatusTag>
          </div>
          <p className="mt-1 text-[12px] text-ql-fg-tertiary">只从企业微信或飞书读取，不向外部通讯录回写。</p>
        </div>
      </div>
      <div className="mt-4 grid gap-3 md:grid-cols-[10rem_1fr_1fr_auto]">
        <select aria-label="通讯录来源" className={INPUT_CLASS} onChange={(event) => { setSourceType(event.target.value as "WECOM" | "FEISHU"); setIdentity(""); setSecret(""); }} value={sourceType}>
          <option value="WECOM">企业微信</option><option value="FEISHU">飞书</option>
        </select>
        <input aria-label={sourceType === "WECOM" ? "企业 ID" : "应用 ID"} className={INPUT_CLASS} onChange={(event) => setIdentity(event.target.value)} placeholder={sourceType === "WECOM" ? "Corp ID" : "App ID"} value={identity}/>
        <input aria-label="应用 Secret" autoComplete="new-password" className={INPUT_CLASS} onChange={(event) => setSecret(event.target.value)} placeholder="Secret 只写不回显" type="password" value={secret}/>
        <div className="flex gap-2"><button data-write-action className="h-9 rounded-lg border border-ql-border px-3 text-[13px] text-ql-action disabled:opacity-50" disabled={!identity.trim() || !secret || saveSource.isPending} onClick={() => void save()} type="button">保存连接</button>
          <button data-write-action className="flex h-9 items-center gap-1 rounded-lg bg-ql-action px-3 text-[13px] text-white disabled:opacity-50" disabled={!currentSource || startSync.isPending} onClick={() => void sync()} type="button"><RefreshCw className="h-4 w-4"/>同步</button></div>
      </div>
      {saveSource.error || startSync.error ? <p className="mt-2 text-[12px] text-ql-danger" role="alert">{(saveSource.error ?? startSync.error)?.message}</p> : null}
    </section>

    <section className="rounded-xl border border-ql-border-zone bg-ql-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-[15px] font-semibold">Excel 导入</h2><p className="mt-1 text-[12px] text-ql-fg-tertiary">固定 .xlsx 模板，最多 5 MiB / 1,000 行；导入只建立候选档案，不自动开通。</p></div>
        <div className="flex gap-2"><button className="flex h-9 items-center gap-1 rounded-lg border border-ql-border px-3 text-[13px]" onClick={() => void downloadTemplate()} type="button"><Download className="h-4 w-4"/>下载模板</button>
          <button className="flex h-9 items-center gap-1 rounded-lg border border-ql-border px-3 text-[13px] text-ql-action" onClick={() => setListUploadOpen(true)} type="button"><Upload className="h-4 w-4"/>上传名单开通 AI</button>
          <label className="flex h-9 cursor-pointer items-center gap-1 rounded-lg bg-ql-action px-3 text-[13px] text-white"><Upload className="h-4 w-4"/>上传文件<input accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" className="sr-only" onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadExcel(file); event.target.value = ""; }} type="file"/></label></div>
      </div>{excel.error ? <p className="mt-2 text-[12px] text-ql-danger">{excel.error.message}</p> : null}
    </section>

    {runId ? <RunResultSection runId={runId} /> : null}

    <section className="rounded-xl border border-ql-border-zone bg-ql-surface p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div><h2 className="text-[15px] font-semibold">通讯录成员</h2><p className="mt-1 text-[12px] text-ql-fg-tertiary">导入先入候选库；按需勾选开通 AI 员工主体，既有 Key 和授权不会被重置。</p></div>
        <div className="flex items-center gap-2">
          <select aria-label="开通状态筛选" className={`${INPUT_CLASS} h-9 w-auto`} onChange={(event) => setActivationFilter(event.target.value as ActivationFilter)} value={activationFilter}>
            <option value="all">全部人员</option>
            <option value="inactive">仅未开通</option>
            <option value="active">已开通</option>
          </select>
          <label className="relative"><Search className="absolute left-3 top-2.5 h-4 w-4 text-ql-fg-tertiary"/><input aria-label="搜索通讯录成员" className={`${INPUT_CLASS} pl-9`} onChange={(event) => setSearch(event.target.value)} placeholder="姓名 / 工号 / 手机 / ID" value={search}/></label>
        </div>
      </div>
      {selectedRows.length > 0 ? <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-ql-action-soft bg-ql-action-soft/40 px-3 py-2">
        <p className="text-[13px] text-ql-fg-secondary">已选择 {selectedRows.length} 人（其中未开通 {selectedRows.filter((member) => !isActivated(member)).length} 人）</p>
        <div className="flex gap-2">
          <button className="h-8 rounded-lg border border-ql-border bg-ql-surface px-3 text-[12px] text-ql-fg-secondary" onClick={() => setSelectedPersonIds(new Set())} type="button">清空选择</button>
          {selectedRows.some((member) => !isActivated(member)) ? (
            <button className="h-8 rounded-lg border border-ql-danger/40 px-3 text-[12px] font-medium text-ql-danger hover:bg-ql-danger-soft disabled:opacity-50" disabled={batchDeleteMembers.isPending} onClick={() => setBatchDeleteConfirmOpen(true)} type="button">批量清理档案</button>
          ) : null}
          <button className="h-8 rounded-lg bg-ql-action px-3 text-[12px] font-medium text-white disabled:opacity-50" disabled={activate.isPending} onClick={() => setBatchConfirmOpen(true)} type="button">批量开通 AI</button>
        </div>
      </div> : null}
      {batchNotice ? <p className="mb-3 text-[12px] text-ql-fg-secondary" role="status">{batchNotice}</p> : null}
      <DirectoryMembersTable
        activating={activate.isPending}
        deleting={deleteMember.isPending || batchDeleteMembers.isPending}
        error={members.error ?? activate.error}
        filteredRows={filteredRows}
        isLoading={members.isLoading}
        onActivate={(personId) => void runActivation([personId])}
        onDelete={(personId, personName) => setDeleteTarget({ id: personId, name: personName })}
        onRetry={() => void members.refetch()}
        onTogglePage={togglePage}
        onTogglePerson={togglePerson}
        pageAllSelected={pageAllSelected}
        selectedPersonIds={selectedPersonIds}
      />
    </section>

    <ConfirmDialog
      cancelLabel="取消"
      confirmLabel="确认开通"
      impact={`将为已选 ${selectedRows.length} 名人员建立 AI 员工主体（含全员模型授权与配额池）；已开通人员自动跳过，不会重复授权。`}
      loading={activate.isPending}
      onCancel={() => setBatchConfirmOpen(false)}
      onConfirm={() => void runActivation([...selectedPersonIds])}
      open={batchConfirmOpen}
      title="批量开通 AI 员工"
    />

    <ConfirmDialog
      cancelLabel="取消"
      confirmLabel="确认清理"
      danger
      impact={`清理后「${deleteTarget?.name}」将从候选库中移除；后续若通过企业微信或 Excel 重新同步，可重新拉取该人员。`}
      loading={deleteMember.isPending}
      onCancel={() => { setDeleteTarget(null); setDeleteError(null); }}
      onConfirm={() => void confirmDeleteSingle()}
      open={deleteTarget !== null}
      title="清理候选人员档案"
    >
      {deleteError ? <p className="mt-2 text-[12px] text-ql-danger" role="alert">{deleteError}</p> : null}
    </ConfirmDialog>

    <ConfirmDialog
      cancelLabel="取消"
      confirmLabel="确认批量清理"
      danger
      impact={`将清理所选 ${selectedRows.filter((m) => !isActivated(m)).length} 名未开通候选人的档案（已开通主体的人员会自动跳过）。后续可通过重新同步再次导入。`}
      loading={batchDeleteMembers.isPending}
      onCancel={() => { setBatchDeleteConfirmOpen(false); setBatchDeleteError(null); }}
      onConfirm={() => void confirmBatchDelete()}
      open={batchDeleteConfirmOpen}
      title="批量清理候选人员档案"
    >
      {batchDeleteError ? <p className="mt-2 text-[12px] text-ql-danger" role="alert">{batchDeleteError}</p> : null}
    </ConfirmDialog>

    <ActivationListDialog onClose={() => setListUploadOpen(false)} open={listUploadOpen} />
  </div>;
}
