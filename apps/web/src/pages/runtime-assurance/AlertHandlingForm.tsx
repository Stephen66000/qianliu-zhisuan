import { useEffect, useRef, useState } from "react";
import type { AlertItem } from "../../api/types";
import { INPUT_CLASS } from "../../components/writes/FormField";
import { isActionable, isHandled, formatTime } from "./alert-presenters";

export function AlertHandlingForm({
  alert,
  startHandling,
  handledPending,
  handledError,
  onHandle,
}: {
  alert: AlertItem;
  startHandling: boolean;
  handledPending: boolean;
  handledError: boolean;
  onHandle: (note: string) => void;
}) {
  const handled = isHandled(alert);
  const [editing, setEditing] = useState(
    startHandling || (handled && !alert.resolutionNote?.trim()),
  );
  const [note, setNote] = useState("");
  const noteInput = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (editing) noteInput.current?.focus();
  }, [editing]);
  return (
    <div>
      <label className="text-[11px] text-ql-fg-tertiary">
        是否处理
        <select
          aria-label="详情是否处理"
          className={`${INPUT_CLASS} mt-1 w-full`}
          disabled={!isActionable(alert) || handledPending}
          onChange={(event) => {
            setEditing(event.target.value === "yes");
          }}
          value={handled || editing ? "yes" : "no"}
        >
          <option value="no">否</option>
          <option value="yes">是</option>
        </select>
      </label>
      <p className="mt-2 text-[11px] text-ql-fg-tertiary">
        选择“是”后须填写说明并保存；人工处理不会替代系统的恢复验证。
      </p>
      {alert.resolutionNote ? (
        <p className="mt-3 rounded-lg bg-ql-surface-subtle p-3 text-[12px] text-ql-fg-secondary">
          {alert.resolutionNote}
        </p>
      ) : null}
      {handled && !alert.resolutionNote?.trim() ? (
        <p className="mt-2 text-xs text-ql-warning">
          这条历史处理记录缺少说明，请补充。
        </p>
      ) : null}
      {handled ? (
        <p className="mt-2 text-xs text-ql-fg-secondary">
          处理人：{alert.handledBy ?? alert.resolvedBy ?? "未记录"} ·{" "}
          {formatTime(alert.resolvedAt)}
        </p>
      ) : null}
      {editing && isActionable(alert) ? (
        <form
          className="mt-3 space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (note.trim()) onHandle(note);
          }}
        >
          <label className="block text-xs text-ql-fg-secondary">
            处理说明（必填）
            <textarea
              ref={noteInput}
              aria-label="处理说明"
              className={`${INPUT_CLASS} mt-2 min-h-24 w-full py-2`}
              maxLength={2000}
              placeholder="请说明故障原因、采取的措施和核对结果；不要填写密码或密钥。"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              required
            />
          </label>
          {handledError ? (
            <p role="alert" className="text-xs text-ql-danger">
              保存失败，说明已保留，请重试。
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              className="rounded-lg border px-3 py-2 text-xs"
              onClick={() => setEditing(false)}
              disabled={handledPending}
            >
              取消
            </button>
            <button
              type="submit"
              className="rounded-lg bg-ql-action px-3 py-2 text-xs text-white disabled:opacity-50"
              disabled={!note.trim() || handledPending}
            >
              {handledPending ? "保存中…" : "保存处理说明"}
            </button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
