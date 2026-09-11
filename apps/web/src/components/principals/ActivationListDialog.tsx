/**
 * C 方式开通弹窗 —— 上传一维名单 Excel（首列：工号/企微账号/姓名），
 * 后台解析展示识别结果，确认后调用 activate-by-list 并反馈未匹配条目。
 */
import { useState } from "react";
import { Upload } from "lucide-react";
import {
  useActivateDirectoryListPreview, useActivateDirectoryMembersByList,
} from "../../api/v2-hooks";
import { ConfirmDialog } from "../writes/ConfirmDialog";

interface ActivationListDialogProps {
  open: boolean;
  onClose: () => void;
}

export function ActivationListDialog({ open, onClose }: ActivationListDialogProps) {
  const [identifiers, setIdentifiers] = useState<string[]>([]);
  const [result, setResult] = useState<{ activatedCount: number; alreadyActiveCount: number; notFound: string[] } | null>(null);
  const listPreview = useActivateDirectoryListPreview();
  const activateByList = useActivateDirectoryMembersByList();

  const close = () => {
    setIdentifiers([]);
    setResult(null);
    onClose();
  };
  const uploadList = async (file: File) => {
    const preview = await listPreview.mutateAsync(file);
    setIdentifiers(preview.identifiers);
  };
  const confirmActivation = async () => {
    if (identifiers.length === 0) return;
    const outcome = await activateByList.mutateAsync(identifiers);
    setResult({
      activatedCount: outcome.activated_count,
      alreadyActiveCount: outcome.already_active_count,
      notFound: outcome.not_found ?? [],
    });
  };

  return (
    <ConfirmDialog
      cancelLabel={result ? "关闭" : "取消"}
      confirmLabel={result ? "完成" : `确认开通${identifiers.length > 0 ? ` ${identifiers.length} 项` : ""}`}
      impact={result
        ? `名单开通完成：新开通 ${result.activatedCount} 人，已开通跳过 ${result.alreadyActiveCount} 人${result.notFound.length > 0 ? `，${result.notFound.length} 项未匹配。` : "。"}`
        : "上传仅含工号、企微账号或姓名的 .xlsx 名单（首列），解析确认后批量开通；未匹配条目将原样列出。"}
      loading={activateByList.isPending || listPreview.isPending}
      onCancel={close}
      onConfirm={() => void (result ? close() : confirmActivation())}
      open={open}
      title="上传名单批量开通"
    >
      <div className="space-y-3">
        <label className="flex h-9 cursor-pointer items-center justify-center gap-1 rounded-lg border border-dashed border-ql-border-strong px-3 text-[13px] text-ql-action">
          <Upload className="h-4 w-4"/>{identifiers.length > 0 ? "重新上传名单" : "选择名单文件（.xlsx）"}
          <input accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" className="sr-only" onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadList(file); event.target.value = ""; }} type="file"/>
        </label>
        {listPreview.error ? <p className="text-[12px] text-ql-danger" role="alert">{listPreview.error.message}</p> : null}
        {!result && identifiers.length > 0 ? <div className="rounded-lg border border-ql-border-zone bg-ql-surface-subtle p-3">
          <p className="text-[12px] text-ql-fg-secondary">识别到 {identifiers.length} 个标识：</p>
          <p className="mt-1 max-h-24 overflow-y-auto text-[12px] text-ql-fg-tertiary">{identifiers.join("、")}</p>
        </div> : null}
        {result ? <div className="rounded-lg border border-ql-border-zone bg-ql-surface-subtle p-3">
          {result.notFound.length > 0 ? <>
            <p className="text-[12px] text-ql-warning">以下 {result.notFound.length} 项在通讯录候选库中未找到，请核实：</p>
            <p className="mt-1 max-h-24 overflow-y-auto text-[12px] text-ql-fg-tertiary">{result.notFound.join("、")}</p>
          </> : <p className="text-[12px] text-ql-fg-secondary">全部标识均已处理。</p>}
        </div> : null}
        {activateByList.error ? <p className="text-[12px] text-ql-danger" role="alert">{activateByList.error.message}</p> : null}
      </div>
    </ConfirmDialog>
  );
}
