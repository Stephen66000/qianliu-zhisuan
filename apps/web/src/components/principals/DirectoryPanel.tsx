import { useState } from "react";
import { Download, RefreshCw, Search, Upload, Users } from "lucide-react";
import { download } from "../../api/client";
import {
  useDirectoryImportItems, useDirectoryImportRun, useDirectoryMembers,
  useDirectorySource, useSaveDirectorySource, useStartDirectorySync,
  useUploadDirectoryExcel,
} from "../../api/v2-hooks";
import type { DirectorySourceType } from "../../api/v2-types";
import { StatusTag } from "../dashboard/StatusTag";
import { QueryGate } from "../states/QueryGate";
import { INPUT_CLASS } from "../writes/FormField";

export function DirectoryPanel() {
  const [search, setSearch] = useState("");
  const [sourceType, setSourceType] = useState<DirectorySourceType>("WECOM");
  const [identity, setIdentity] = useState("");
  const [secret, setSecret] = useState("");
  const [runId, setRunId] = useState<string | null>(null);
  const members = useDirectoryMembers(search);
  const source = useDirectorySource(sourceType);
  const saveSource = useSaveDirectorySource(sourceType);
  const startSync = useStartDirectorySync();
  const excel = useUploadDirectoryExcel();
  const run = useDirectoryImportRun(runId);
  const items = useDirectoryImportItems(runId);

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

  const memberRows = members.data?.items ?? [];
  const currentSource = source.data?.source;
  return <div className="space-y-4">
    <section className="rounded-xl border border-ql-border-zone bg-ql-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><h2 className="text-[15px] font-semibold text-ql-fg">接口单向同步</h2>
          <p className="mt-1 text-[12px] text-ql-fg-tertiary">只从企业微信或飞书读取，不向外部通讯录回写。</p></div>
        {currentSource ? <StatusTag tone={currentSource.status === "ACTIVE" ? "success" : "warning"}>已配置 · {currentSource.config_fingerprint}</StatusTag> : null}
      </div>
      <div className="mt-4 grid gap-3 md:grid-cols-[10rem_1fr_1fr_auto]">
        <select aria-label="通讯录来源" className={INPUT_CLASS} onChange={(event) => { setSourceType(event.target.value as DirectorySourceType); setIdentity(""); setSecret(""); }} value={sourceType}>
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
      <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-[15px] font-semibold">Excel 导入</h2><p className="mt-1 text-[12px] text-ql-fg-tertiary">固定 .xlsx 模板，最多 5 MiB / 1,000 行；逐行返回冲突原因。</p></div>
        <div className="flex gap-2"><button className="flex h-9 items-center gap-1 rounded-lg border border-ql-border px-3 text-[13px]" onClick={() => void downloadTemplate()} type="button"><Download className="h-4 w-4"/>下载模板</button>
          <label className="flex h-9 cursor-pointer items-center gap-1 rounded-lg bg-ql-action px-3 text-[13px] text-white"><Upload className="h-4 w-4"/>上传文件<input accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" className="sr-only" onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadExcel(file); event.target.value = ""; }} type="file"/></label></div>
      </div>{excel.error ? <p className="mt-2 text-[12px] text-ql-danger">{excel.error.message}</p> : null}
    </section>

    {runId ? <section className="rounded-xl border border-ql-border-zone bg-ql-surface p-4">
      <div className="flex items-center justify-between"><h2 className="text-[15px] font-semibold">最近处理结果</h2><StatusTag tone={run.data?.run.status === "SUCCEEDED" ? "success" : run.data?.run.status === "FAILED" ? "danger" : "warning"}>{run.data?.run.status ?? "读取中"}</StatusTag></div>
      {run.data ? <p className="mt-2 text-[12px] text-ql-fg-secondary">共 {run.data.run.total_count} · 成功 {run.data.run.success_count} · 冲突 {run.data.run.conflict_count} · 失败 {run.data.run.failed_count}</p> : null}
      {(items.data?.items ?? []).length ? <div className="mt-3 overflow-x-auto"><table className="w-full text-left text-[12px]"><thead><tr className="border-b border-ql-border text-ql-fg-tertiary"><th className="py-2">行</th><th>姓名</th><th>部门</th><th>结果</th><th>原因</th></tr></thead><tbody>{items.data!.items.map((item) => <tr className="border-b border-ql-border-zone" key={item.id}><td className="py-2">{item.row_number ?? "—"}</td><td>{item.normalized_name}</td><td>{item.normalized_department ?? "—"}</td><td>{item.status}</td><td>{item.reason_code ?? "—"}</td></tr>)}</tbody></table></div> : null}
    </section> : null}

    <section className="rounded-xl border border-ql-border-zone bg-ql-surface p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-[15px] font-semibold">通讯录成员</h2><p className="mt-1 text-[12px] text-ql-fg-tertiary">稳定身份匹配后自动建立员工主体；既有 Key 和授权不会被重置。</p></div><label className="relative"><Search className="absolute left-3 top-2.5 h-4 w-4 text-ql-fg-tertiary"/><input aria-label="搜索通讯录成员" className={`${INPUT_CLASS} pl-9`} onChange={(event) => setSearch(event.target.value)} placeholder="姓名 / 员工编号" value={search}/></label></div>
      <QueryGate emptyDescription="配置通讯录来源并执行同步，或上传标准模板。" emptyIcon={Users} emptyTitle="暂无通讯录成员" error={members.error} isEmpty={memberRows.length === 0} isLoading={members.isLoading} onRetry={() => void members.refetch()}>
        <div className="overflow-x-auto"><table className="w-full text-left text-[12px]"><thead><tr className="border-b border-ql-border text-ql-fg-tertiary"><th className="py-2">成员</th><th>员工编号</th><th>部门</th><th>来源</th><th>主体</th><th>接入配置</th></tr></thead><tbody>{memberRows.map((member) => <tr className="border-b border-ql-border-zone" key={member.person_id}><td className="py-2 font-medium">{member.name}</td><td>{member.employee_number ?? "—"}</td><td>{member.department_name ?? "待归属"}</td><td>{member.source_type ?? "手工"}</td><td>{member.principal_status ?? "未建立"}</td><td>{member.access_config_status}</td></tr>)}</tbody></table></div>
      </QueryGate>
    </section>
  </div>;
}
