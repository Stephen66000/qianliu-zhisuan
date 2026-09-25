/**
 * 静态租约与排空状态面板（WP05 任务 5.3；PFU-04 Scenario: Enterprise is not quiescent）。
 *
 * 「预检前展示并管理」：面板同时承担**展示**（租约有效期、剩余时间、排空计数）
 * 与**操作**（启动 / 解除租约）。所有时间判定以服务端返回的 `remaining_seconds` 为准，
 * 本地倒计时只用于展示。
 */
import { ShieldCheck, TimerReset } from "lucide-react";
import { useState } from "react";

import { formatDateTimeFull } from "../../lib/format";
import { FormField, INPUT_CLASS } from "../writes/FormField";
import {
  evaluateQuiescenceGate, formatRemainingSeconds, prePersistBlockers,
} from "./activation-preflight-model";
import type { QuiescenceView } from "../../api/provider-finance-activation-types";

const DEFAULT_LEASE_MINUTES = 30;
const MAX_LEASE_MINUTES = 60;

function DrainChecklist({ quiescence }: { quiescence: QuiescenceView }) {
  const items = [
    { label: "在途请求", value: quiescence.drain.in_progress_requests },
    { label: "未结束上游尝试", value: quiescence.drain.open_attempts },
    { label: "未配对用量行", value: quiescence.drain.unpaired_usage_lines },
    { label: "待结算账本事务", value: quiescence.drain.pending_ledger_transactions },
    { label: "候选修复豁免行", value: quiescence.drain.exonerated_usage_lines },
  ];
  return (
    <dl className="mt-3 grid gap-2 text-[12px] sm:grid-cols-3 lg:grid-cols-5">
      {items.map((item) => (
        <div className="rounded-lg border border-ql-border bg-ql-surface px-3 py-2" key={item.label}>
          <dt className="text-ql-fg-tertiary">{item.label}</dt>
          <dd className={`mt-0.5 font-mono text-[14px] font-semibold ${item.value === 0 ? "text-ql-success" : "text-ql-warning"}`}>
            {item.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function ActivationQuiescencePanel({
  quiescence, writeEnabled, canOperate, starting, releasing, error, onStart, onRelease,
}: {
  quiescence: QuiescenceView;
  writeEnabled: boolean;
  canOperate: boolean;
  starting: boolean;
  releasing: boolean;
  error: string | null;
  onStart: (durationMinutes: number) => void;
  onRelease: (reason: string) => void;
}) {
  const [minutes, setMinutes] = useState(DEFAULT_LEASE_MINUTES);
  const [releaseOpen, setReleaseOpen] = useState(false);
  const [reason, setReason] = useState("");
  const gate = evaluateQuiescenceGate(quiescence);
  const drainNotes = prePersistBlockers(quiescence);
  const writable = writeEnabled && canOperate;

  return (
    <section
      aria-label="静默与排空状态"
      className="mt-4 rounded-xl border border-ql-border-zone bg-ql-surface p-4"
      data-testid="activation-quiescence"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-1.5 text-[14px] font-semibold text-ql-fg">
            <ShieldCheck aria-hidden className="h-4 w-4" />静默与排空
          </h3>
          <p className="mt-1 text-[12px] text-ql-fg-tertiary">
            预检与激活要求目标企业处于静默租约内且排空完成；租约最长 {MAX_LEASE_MINUTES} 分钟，到期自动恢复流量。
          </p>
        </div>
        <span className={`rounded-full px-2.5 py-1 text-[12px] font-medium ${gate.ready ? "bg-ql-success-soft text-ql-success" : "bg-ql-warning-soft text-ql-warning"}`}>
          {gate.ready ? "已排空，可预检" : `待排空 ${gate.blockers.length} 项`}
        </span>
      </div>

      <div className="mt-3 grid gap-3 text-[12px] sm:grid-cols-3">
        <div>
          <p className="text-ql-fg-tertiary">租约状态</p>
          <p className="mt-0.5 text-ql-fg">{quiescence.status ?? "未建立"}{quiescence.active ? "（有效）" : ""}</p>
        </div>
        <div>
          <p className="text-ql-fg-tertiary">到期时间</p>
          <p className="mt-0.5 text-ql-fg">
            {quiescence.expires_at ? formatDateTimeFull(quiescence.expires_at) : "—"}
          </p>
        </div>
        <div>
          <p className="text-ql-fg-tertiary">剩余时间</p>
          <p className="mt-0.5 font-mono text-ql-fg">
            {quiescence.active ? formatRemainingSeconds(quiescence.remaining_seconds) : "已到期"}
          </p>
        </div>
      </div>

      <DrainChecklist quiescence={quiescence} />

      {gate.blockers.length > 0 ? (
        <ul className="mt-3 space-y-1 text-[12px] text-ql-warning" data-testid="quiescence-blockers">
          {gate.blockers.map((blocker) => <li key={blocker}>ACTIVATION_NOT_QUIESCENT：{blocker}</li>)}
        </ul>
      ) : null}

      {drainNotes.length > 0 ? (
        <ul className="mt-2 space-y-1 text-[12px] text-ql-fg-tertiary" data-testid="quiescence-drain-notes">
          {drainNotes.map((note) => <li key={note}>{note}</li>)}
        </ul>
      ) : null}

      {quiescence.released_at ? (
        <p className="mt-2 text-[12px] text-ql-fg-tertiary">
          最近解除：{formatDateTimeFull(quiescence.released_at)} · 原因 {quiescence.release_reason ?? "—"}
        </p>
      ) : null}

      {writable ? (
        <div className="mt-4 flex flex-wrap items-end gap-2">
          <div className="w-40">
            <FormField htmlFor="activation-lease-minutes" label="租约时长（分钟）">
              <input
                className={INPUT_CLASS} id="activation-lease-minutes" max={MAX_LEASE_MINUTES} min={1}
                onChange={(event) => setMinutes(Number(event.target.value) || DEFAULT_LEASE_MINUTES)}
                type="number" value={minutes}
              />
            </FormField>
          </div>
          <button
            className="flex h-10 items-center gap-1.5 rounded-lg bg-ql-action px-4 text-[13px] font-medium text-white hover:bg-ql-action-hover disabled:opacity-50"
            disabled={starting} data-write-action onClick={() => onStart(minutes)} type="button"
          >
            <TimerReset aria-hidden className="h-4 w-4" />{starting ? "启动中…" : "启动静默租约"}
          </button>
          {quiescence.active ? (
            <button
              className="h-10 rounded-lg border border-ql-border px-4 text-[13px] disabled:opacity-50"
              disabled={releasing} onClick={() => setReleaseOpen((open) => !open)} type="button"
            >
              解除租约
            </button>
          ) : null}
        </div>
      ) : (
        <p className="mt-3 text-[12px] text-ql-fg-tertiary">
          {writeEnabled ? "当前账号无 resources.operate 权限，只能查看静默状态。" : "当前为 DARK 只读模式，静默租约操作不可用。"}
        </p>
      )}

      {releaseOpen && writable ? (
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <div className="min-w-64 flex-1">
            <FormField htmlFor="activation-release-reason" label="解除原因（必填）">
              <input
                className={INPUT_CLASS} id="activation-release-reason"
                onChange={(event) => setReason(event.target.value)} value={reason}
              />
            </FormField>
          </div>
          <button
            className="h-10 rounded-lg border border-ql-danger px-4 text-[13px] text-ql-danger disabled:opacity-50"
            disabled={releasing || reason.trim() === ""}
            onClick={() => { onRelease(reason.trim()); setReason(""); setReleaseOpen(false); }}
            type="button"
          >
            {releasing ? "解除中…" : "确认解除"}
          </button>
        </div>
      ) : null}

      {error ? <p className="mt-3 text-[12px] text-ql-danger" role="alert">{error}</p> : null}
    </section>
  );
}
