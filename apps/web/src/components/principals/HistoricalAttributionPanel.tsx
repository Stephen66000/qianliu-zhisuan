import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { post } from "../../api/client";
import { INPUT_CLASS } from "../writes/FormField";

interface Preview {
  principalName: string;
  departmentName: string;
  requestCount: number;
  fingerprint: string;
}
export function HistoricalAttributionPanel({
  principalId,
  departments,
  suggestedDepartmentId,
}: {
  principalId: string;
  departments: Array<{ id: string; name: string }>;
  suggestedDepartmentId?: string | null;
}) {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const [open, setOpen] = useState(false),
    [from, setFrom] = useState(`${today.slice(0, 7)}-01`),
    [to, setTo] = useState(today);
  const [department, setDepartment] = useState(suggestedDepartmentId ?? ""),
    [reason, setReason] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null),
    [done, setDone] = useState<number | null>(null);
  const client = useQueryClient();
  useEffect(() => {
    setPreview(null);
    setDone(null);
  }, [from, to, department, reason]);
  const payload = {
    from,
    to,
    department_id: department,
    reason: reason.trim(),
  };
  const inspect = useMutation({
    mutationFn: () =>
      post<Preview>(
        `/principals/${principalId}/attribution-backfill/preview`,
        payload,
      ),
    onSuccess: setPreview,
  });
  const confirm = useMutation({
    mutationFn: () =>
      post<{ confirmedCount: number }>(
        `/principals/${principalId}/attribution-backfill`,
        { ...payload, fingerprint: preview!.fingerprint },
      ),
    onSuccess: (result) => {
      setDone(result.confirmedCount);
      setPreview(null);
      void client.invalidateQueries({
        predicate: (q) =>
          ["operating", "department", "usage", "dashboard"].some((prefix) =>
            String(q.queryKey[0]).startsWith(prefix),
          ),
      });
    },
  });
  const busy = inspect.isPending || confirm.isPending;
  return (
    <section className="mt-4 border-t border-ql-border pt-4">
      <button
        type="button"
        className="text-ql-action"
        onClick={() => setOpen(!open)}
      >
        补齐历史归属
      </button>
      {open ? (
        <div className="mt-3 space-y-3">
          <p className="text-[13px] text-ql-fg-secondary">
            按主体和时间段补齐缺失归属，已有归属保持不变。当前部门仅作为建议，请确认该时间段的实际部门。
          </p>
          <div className="flex flex-wrap gap-3">
            <label>
              开始日期
              <input
                aria-label="历史开始日期"
                type="date"
                value={from}
                disabled={busy}
                onChange={(e) => setFrom(e.target.value)}
                className={INPUT_CLASS}
              />
            </label>
            <label>
              结束日期
              <input
                aria-label="历史结束日期"
                type="date"
                value={to}
                disabled={busy}
                onChange={(e) => setTo(e.target.value)}
                className={INPUT_CLASS}
              />
            </label>
            <label>
              历史所属部门
              <select
                aria-label="历史所属部门"
                value={department}
                disabled={busy}
                onChange={(e) => setDepartment(e.target.value)}
                className={INPUT_CLASS}
              >
                <option value="">请选择部门</option>
                {departments.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {!departments.length ? (
            <p>请先保存员工所属部门或负责人所属部门。</p>
          ) : null}
          <label className="block">
            确认依据
            <input
              aria-label="历史归属确认依据"
              value={reason}
              maxLength={500}
              disabled={busy}
              onChange={(e) => setReason(e.target.value)}
              className={`${INPUT_CLASS} ml-2`}
              placeholder="例如：确认该员工在此期间始终属于研发部"
            />
          </label>
          <button
            type="button"
            disabled={busy || !from || !to || !department || !reason.trim()}
            className="text-ql-action disabled:opacity-50"
            onClick={() => {
              setPreview(null);
              setDone(null);
              inspect.mutate();
            }}
          >
            预览待补齐记录
          </button>
          {preview ? (
            <div className="rounded-lg bg-ql-surface-subtle p-3">
              <p>
                {preview.principalName} · {from} 至 {to} ·{" "}
                {preview.departmentName}：待补齐 {preview.requestCount} 条请求
              </p>
              <button
                type="button"
                className="mt-2 text-ql-action disabled:opacity-50"
                disabled={busy || preview.requestCount === 0}
                onClick={() => confirm.mutate()}
              >
                确认补齐历史归属
              </button>
            </div>
          ) : null}
          {done !== null ? (
            <p role="status">
              已补齐 {done} 条请求的历史归属，原始用量和费用保持不变。
            </p>
          ) : null}
          {inspect.error || confirm.error ? (
            <p role="alert" className="text-ql-danger">
              {inspect.error?.message ?? confirm.error?.message}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
