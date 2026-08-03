interface PrincipalKeyDialogProps {
  copyStatus: "idle" | "success" | "error";
  onClose: () => void;
  onCopy: () => void;
  open: boolean;
  plaintextKey: string | null;
}

export function PrincipalKeyDialog(props: PrincipalKeyDialogProps) {
  if (!props.open || !props.plaintextKey) return null;
  return <div aria-modal="true"
    className="fixed inset-0 z-50 flex items-center justify-center bg-ql-canvas/60 p-4" role="dialog">
    <div className="w-full max-w-lg rounded-2xl border border-ql-border bg-ql-surface-raised p-6 shadow-ql-raised">
      <h2 className="text-[16px] font-semibold text-ql-fg">Key 已生成</h2>
      <p className="mt-1 text-[13px] text-ql-warning">
        明文仅保留在当前页面内存。刷新、切换主体或主动清除后无法找回，只能重置。
      </p>
      <code className="mt-4 block break-all rounded-lg bg-ql-surface-muted p-3 text-[13px] text-ql-fg">
        {props.plaintextKey}
      </code>
      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <button className="h-9 rounded-lg border border-ql-action px-4 text-[13px] font-medium text-ql-action"
          onClick={props.onCopy} type="button">复制完整接入信息</button>
        <button className="h-9 rounded-lg bg-ql-action px-4 text-[13px] font-medium text-white"
          onClick={props.onClose} type="button">继续配置</button>
      </div>
      {props.copyStatus === "success"
        ? <p className="mt-2 text-right text-[12px] text-ql-success" role="status">复制成功</p> : null}
      {props.copyStatus === "error"
        ? <p className="mt-2 text-right text-[12px] text-ql-danger" role="alert">复制失败，请检查剪贴板权限</p> : null}
    </div>
  </div>;
}
