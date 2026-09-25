/**
 * 激活回执摘要（WP05 任务 5.1、5.4；PFU-01、PFU-04）。
 *
 * 回执是**只读**的不可变事实摘要：激活成功后展示，已激活企业也常驻展示在日常面板上方。
 * 本组件不提供任何修改入口，也不允许调用方传入本地构造的数字。
 */
import { BadgeCheck, TriangleAlert } from "lucide-react";

import { formatDateTimeFull } from "../../lib/format";
import { receiptFactCountSummary } from "./activation-preflight-model";
import type { ActivationReceiptView } from "../../api/provider-finance-activation-types";

export function ActivationReceiptPanel({
  receipt,
  activatedAt,
  compact = false,
}: {
  receipt: ActivationReceiptView;
  activatedAt?: string | null;
  compact?: boolean;
}) {
  const activatedAtValue = activatedAt ?? receipt.activatedAt;
  return (
    <section
      aria-label="激活回执"
      className="rounded-xl border border-ql-border-zone bg-ql-surface p-4"
      data-testid="activation-receipt"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-[14px] font-semibold text-ql-fg">严格资金写激活回执</h3>
          <p className="mt-1 text-[12px] text-ql-fg-tertiary">
            激活时间 {formatDateTimeFull(activatedAtValue)} · 操作管理员 {receipt.activatedByAdminUserId}
          </p>
        </div>
        <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[12px] font-medium ${receipt.conservationPassed ? "bg-ql-success-soft text-ql-success" : "bg-ql-danger-soft text-ql-danger"}`}>
          {receipt.conservationPassed
            ? <><BadgeCheck aria-hidden className="h-3.5 w-3.5" />守恒通过</>
            : <><TriangleAlert aria-hidden className="h-3.5 w-3.5" />守恒未通过</>}
        </span>
      </div>
      <dl className="mt-3 grid gap-3 text-[12px] sm:grid-cols-2">
        <div>
          <dt className="text-ql-fg-tertiary">候选 ID</dt>
          <dd className="mt-0.5 font-mono text-ql-fg">{receipt.candidateId}</dd>
        </div>
        <div>
          <dt className="text-ql-fg-tertiary">候选哈希</dt>
          <dd className="mt-0.5 break-all font-mono text-ql-fg">{receipt.candidateHash}</dd>
        </div>
        <div>
          <dt className="text-ql-fg-tertiary">事实水位</dt>
          <dd className="mt-0.5 break-all font-mono text-ql-fg">{receipt.factWatermarkHash}</dd>
        </div>
        <div>
          <dt className="text-ql-fg-tertiary">覆盖月份</dt>
          <dd className="mt-0.5 text-ql-fg">{receipt.monthsChecked.join("、") || "—"}</dd>
        </div>
      </dl>
      {compact ? null : (
        <p className="mt-3 text-[12px] text-ql-fg-secondary">写入事实：{receiptFactCountSummary(receipt)}</p>
      )}
      {receipt.conservationFailures.length > 0 ? (
        <ul className="mt-3 space-y-1 text-[12px] text-ql-danger" role="alert">
          {receipt.conservationFailures.map((failure) => (
            <li key={failure.code}>{failure.code}（{failure.count}）</li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
