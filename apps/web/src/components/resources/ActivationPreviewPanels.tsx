/** 初始化向导的只读预检展示与二次确认输入；权威候选/幂等与请求生命周期仍由向导持有。 */
import { useState } from "react";
import { AlertTriangle, ShieldAlert } from "lucide-react";
import type { ActivationGapView, ActivationPreviewView } from "../../api/provider-finance-activation-types";
import { formatDateTimeFull } from "../../lib/format";
import { FormField, INPUT_CLASS } from "../writes/FormField";
import { Button } from "../ui/Button";
import { gapCodeLabel, gapLocator, groupGapsByCategory, type PreviewHold, type evaluateHold } from "./activation-preflight-model";
const DECISION_LABELS: Record<string, string> = {
  GO_CANDIDATE: "可激活候选（GO_CANDIDATE）",
  NO_GO: "存在缺口，不可激活（NO_GO）",
};


function remainingSeconds(expiresAt: string, nowMs: number): number {
  return Math.max(0, Math.floor((Date.parse(expiresAt) - nowMs) / 1000));
}


/** 结构化缺口报告：按缺口类别分组，并给到资源 / 账户 / 旧记录 / 月份的行级定位。 */
function ActivationGapReport({ preview, resourceLabel }: {
  preview: ActivationPreviewView; resourceLabel: (resourceId: string) => string;
}) {
  const groups = groupGapsByCategory(preview.gaps);
  if (groups.length === 0) {
    return (
      <p className="mt-3 text-[13px] text-ql-success" data-testid="activation-gaps-empty">
        预检未发现结构性缺口。
      </p>
    );
  }
  return (
    <div className="mt-3 space-y-3" data-testid="activation-gaps">
      {groups.map((group) => (
        <div className="rounded-lg border border-ql-border bg-ql-surface-subtle p-3" key={group.category}>
          <p className="text-[13px] font-semibold text-ql-fg">
            {group.label}<span className="ml-2 font-normal text-ql-fg-tertiary">{group.gaps.length} 项</span>
          </p>
          <ul className="mt-2 space-y-1.5">
            {group.gaps.map((gap, index) => <GapRow gap={gap} index={index} key={`${gap.code}-${index}`}
              resourceLabel={resourceLabel} />)}
          </ul>
        </div>
      ))}
    </div>
  );
}


function GapRow({ gap, index, resourceLabel }: {
  gap: ActivationGapView; index: number; resourceLabel: (resourceId: string) => string;
}) {
  return (
    <li className="text-[13px] text-ql-fg-secondary" data-testid={`activation-gap-${gap.code}`}>
      <span className="font-medium text-ql-fg">{gapCodeLabel(gap)}</span>
      <span className="ml-2 rounded-md bg-ql-surface px-1.5 py-0.5 font-mono text-[12px] text-ql-fg-tertiary">
        {gap.code}
      </span>
      <span className="ml-2 text-ql-fg-tertiary">{gapLocator(gap, resourceLabel)}</span>
      {gap.detail ? <span className="ml-1 text-ql-fg-tertiary">· {gap.detail}</span> : null}
      {index === 0 && gap.code === "UNKNOWN_COST" ? (
        <span className="ml-1 text-ql-warning">（必须独立处置，不能用旧记录关闭绕过）</span>
      ) : null}
    </li>
  );
}


/**
 * 不可逆激活的二次确认（PFU-04）。
 *
 * 必须同时展示：企业、候选 ID/哈希、事实水位、TTL 到期时间、影响范围；
 * 管理员须**逐字输入会话企业 ID**才能提交，密确本次激活作用于预期企业。
 */
export function ActivationConfirmDialog({
  enterpriseId, hold, preview, resourceLabel, nowMs, pending, errorMessage, retryable,
  onConfirm, onCancel,
}: {
  enterpriseId: string;
  hold: PreviewHold;
  preview: ActivationPreviewView;
  resourceLabel: (resourceId: string) => string;
  nowMs: number;
  pending: boolean;
  errorMessage: string | null;
  retryable: boolean;
  onConfirm: (confirmEnterpriseId: string) => void;
  onCancel: () => void;
}) {
  const [typed, setTyped] = useState("");
  const matches = typed.trim() === enterpriseId;
  const scope = preview.scope_summary;
  return (
    <section
      aria-label="激活二次确认"
      className="mt-4 rounded-xl border border-ql-danger/40 bg-ql-danger-soft p-4"
      data-testid="activation-confirm"
    >
      <h3 className="flex items-center gap-1.5 text-[14px] font-semibold text-ql-danger">
        <ShieldAlert aria-hidden className="h-4 w-4" />不可逆激活确认
      </h3>
      <p className="mt-1 text-[13px] text-ql-fg-secondary">
        激活会写入资金事实并开启严格资金写入口，<strong className="font-semibold">不可撤销</strong>。请逐项核对后输入企业 ID 确认。
      </p>

      <dl className="mt-3 grid gap-2 text-[13px] sm:grid-cols-2">
        <ConfirmField label="目标企业" value={enterpriseId} />
        <ConfirmField label="候选 ID" value={hold.candidateId} />
        <ConfirmField label="候选哈希" value={hold.candidateHash} mono />
        <ConfirmField label="事实水位" value={hold.factWatermarkHash} mono />
        <ConfirmField label="候选到期" value={`${formatDateTimeFull(hold.expiresAt)}（剩余 ${remainingSeconds(hold.expiresAt, nowMs)} 秒）`} />
        <ConfirmField label="覆盖月份" value={preview.projected.monthsChecked.join("、") || "—"} />
        <ConfirmField label="影响范围"
          value={`API 资源 ${scope.apiResources} · Coding Plan 资源 ${scope.codingPlanResources} · 必要账户 ${scope.requiredAccounts} · 旧记录 ${scope.legacyRecords} · 账户余额投影 ${preview.projected.accounts.length}`} />
        <ConfirmField label="确定性用量修复"
          value={`${preview.usage_repairs.eligibleRows} 行（新增 ${preview.usage_repairs.newRowsAfterPreview}）`} />
        <ConfirmField label="影响资源账户"
          value={preview.projected.accounts
            .map((account) => `${resourceLabel(account.resourceId)}（${account.currency}）`).join("、") || "—"} />
      </dl>

      <div className="mt-3 rounded-lg border border-ql-border bg-ql-surface px-3 py-2">
        <p className="text-[13px] text-ql-fg-tertiary" data-testid="confirm-scope-months">
          覆盖月份：{scope.months.join("、") || "—"}
        </p>
      </div>

      <div className="mt-3">
        <FormField hint="必须与上方目标企业完全一致" htmlFor="activation-confirm-enterprise" label="再次输入目标企业 ID">
          <input
            autoComplete="off" className={INPUT_CLASS} id="activation-confirm-enterprise"
            onChange={(event) => setTyped(event.target.value)} value={typed}
          />
        </FormField>
      </div>

      {errorMessage ? (
        <p className="mt-3 text-[13px] text-ql-danger" role="alert" data-testid="activation-error">
          {errorMessage}{retryable ? "（事务已整体回滚，可用同一幂等键重试）" : ""}
        </p>
      ) : null}

      <div className="mt-4 flex justify-end gap-2">
        <Button variant="secondary" onClick={onCancel} type="button">
          取消
        </Button>
        <Button
          variant="danger"
          data-write-action disabled={!matches || pending} onClick={() => onConfirm(typed.trim())} type="button"
        >
          {pending ? "激活中…" : "确认不可逆激活"}
        </Button>
      </div>
    </section>
  );
}


function ConfirmField({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <dt className="text-ql-fg-tertiary">{label}</dt>
      <dd className={`mt-0.5 break-all text-ql-fg ${mono ? "font-mono" : ""}`}>{value}</dd>
    </div>
  );
}


export function PreviewResult({ preview, holdEvaluation, nowMs, resourceLabel, onActivate }: {  preview: ActivationPreviewView;
  holdEvaluation: ReturnType<typeof evaluateHold>;
  nowMs: number;
  resourceLabel: (resourceId: string) => string;
  onActivate: () => void;
}) {
  return (
    <div className="mt-4" data-testid="activation-preview-result">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-[13px] font-medium text-ql-fg">
          {DECISION_LABELS[preview.decision] ?? preview.decision}
          <span className="ml-2 font-mono text-[13px] text-ql-fg-tertiary">
            候选 {preview.candidate_id}
          </span>
        </p>
        <p className="text-[13px] text-ql-fg-tertiary">
          TTL 到期 {formatDateTimeFull(preview.expires_at)}（剩余 {remainingSeconds(preview.expires_at, nowMs)} 秒）
        </p>
      </div>
      <p className="mt-1 break-all font-mono text-[13px] text-ql-fg-tertiary" data-testid="preview-candidate-hash">
        候选哈希 {preview.candidate_hash} · 事实水位 {preview.fact_watermark_hash}
      </p>

      {holdEvaluation.reason ? (
        <p className="mt-3 flex items-start gap-1.5 rounded-lg border border-ql-warning/30 bg-ql-warning-soft px-3 py-2 text-[13px] text-ql-warning"
          data-testid="activation-hold-reason">
          <AlertTriangle aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" />{holdEvaluation.reason}
        </p>
      ) : null}

      <ActivationGapReport preview={preview} resourceLabel={resourceLabel} />

      <div className="mt-4 flex justify-end">
        <Button size="form"
          variant="danger"
          data-write-action disabled={!holdEvaluation.activatable} onClick={onActivate} type="button"
        >
          <ShieldAlert aria-hidden className="h-4 w-4" />进入不可逆激活确认
        </Button>
      </div>
    </div>
  );
}
