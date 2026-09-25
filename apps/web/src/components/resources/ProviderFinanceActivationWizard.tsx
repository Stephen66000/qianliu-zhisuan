/**
 * 资金账本初始化向导（WP05 任务 5.1～5.4；PFU-01～PFU-06）。
 *
 * 职责边界：
 *  - **只**负责「未激活 → 预检 → 激活」这一段；激活成功后的日常入账沿用既有
 *    `ProviderFinancePanel`，由 `FinanceInitializationPanel` 切换（PFU-01）。
 *  - 权威身份：请求体只含业务草稿与候选标识；企业与管理员一律由服务端从会话取得，
 *    前端**不提交** `enterprise_id` / `admin_id`（PFU-02、PFA-07）。
 *    二次确认弹窗里的 `confirm_enterprise_id` 只用于防误操作匹配。
 *  - 失败关闭：写操作无自动重试；`ACTIVATION_RETRY_REQUIRED` 只提示管理员人工重试，
 *    且必须复用**同一个**幂等键（PFU-03、PFU-04）。
 *  - 候选时效：过期 / 被取代 / 哈希或水位漂移 / 服务端判定候选失效时，
 *    立即清除可激活状态并提示重新预检（PFU-03）。
 */
import { AlertTriangle, ClipboardCheck, RotateCcw, ShieldAlert } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { ApiError } from "../../api/client";
import {
  ACTIVATION_QUERY_KEY, useActivateProviderFinance, useActivationPreview,
  useReleaseQuiescenceLease, useStartQuiescenceLease,
} from "../../api/provider-finance-activation";
import type {
  ActivationGapView, ActivationPreviewView, ActivationStateView, ProviderFinanceActivationMode,
} from "../../api/provider-finance-activation-types";
import { formatDateTimeFull } from "../../lib/format";
import { useQueryClient } from "@tanstack/react-query";

import { FormField, INPUT_CLASS } from "../writes/FormField";
import { ActivationDraftEditor, type LegacySuggestion, type ResourceOption } from "./ActivationDraftEditor";
import { ActivationQuiescencePanel } from "./ActivationQuiescencePanel";
import {
  activationErrorMessage, evaluateHold, evaluateQuiescenceGate, gapCodeLabel, gapLocator,
  groupGapsByCategory, shouldClearHoldForError, type PreviewHold,
} from "./activation-preflight-model";
import {
  buildActivationDraft, countActiveRows, emptyDraftState, newRecordIdempotencyKey, validateDraft,
  type ActivationDraftState,
} from "./activation-draft-model";
import { useNowTicker } from "./use-now-ticker";

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
      <p className="mt-3 text-[12px] text-ql-success" data-testid="activation-gaps-empty">
        预检未发现结构性缺口。
      </p>
    );
  }
  return (
    <div className="mt-3 space-y-3" data-testid="activation-gaps">
      {groups.map((group) => (
        <div className="rounded-lg border border-ql-border bg-ql-surface-subtle p-3" key={group.category}>
          <p className="text-[12px] font-semibold text-ql-fg">
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
    <li className="text-[12px] text-ql-fg-secondary" data-testid={`activation-gap-${gap.code}`}>
      <span className="font-medium text-ql-fg">{gapCodeLabel(gap)}</span>
      <span className="ml-2 rounded bg-ql-surface px-1.5 py-0.5 font-mono text-[11px] text-ql-fg-tertiary">
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
function ActivationConfirmDialog({
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
      <p className="mt-1 text-[12px] text-ql-fg-secondary">
        激活会写入资金事实并开启严格资金写入口，**不可撤销**。请逐项核对后输入企业 ID 确认。
      </p>

      <dl className="mt-3 grid gap-2 text-[12px] sm:grid-cols-2">
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
        <p className="text-[12px] text-ql-fg-tertiary" data-testid="confirm-scope-months">
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
        <p className="mt-3 text-[12px] text-ql-danger" role="alert" data-testid="activation-error">
          {errorMessage}{retryable ? "（事务已整体回滚，可用同一幂等键重试）" : ""}
        </p>
      ) : null}

      <div className="mt-4 flex justify-end gap-2">
        <button className="rounded-lg border border-ql-border px-4 py-2 text-[13px]" onClick={onCancel} type="button">
          取消
        </button>
        <button
          className="rounded-lg bg-ql-danger px-4 py-2 text-[13px] font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
          data-write-action disabled={!matches || pending} onClick={() => onConfirm(typed.trim())} type="button"
        >
          {pending ? "激活中…" : "确认不可逆激活"}
        </button>
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

export interface ActivationWizardProps {
  state: ActivationStateView;
  /**
   * `state` 对应查询的最近一次成功取数时间（`react-query` 的 `dataUpdatedAt`）。
   *
   * 用于判定读模型是否**新于**本次预检：预检成功后状态查询会异步刷新，
   * 刷新返回前 `state.latest_candidate` 仍是预检前的旧值，不能据此判定候选失效。
   * 不传时按「视为权威」处理，保持既有调用语义。
   */
  stateUpdatedAt?: number;
  mode: ProviderFinanceActivationMode;
  canOperate: boolean;
  enterpriseId: string;
  resourceOptions: ResourceOption[];
  resourceLabel: (resourceId: string) => string;
}

export function ProviderFinanceActivationWizard({
  state, stateUpdatedAt, mode, canOperate, enterpriseId, resourceOptions, resourceLabel,
}: ActivationWizardProps) {
  const client = useQueryClient();
  const nowMs = useNowTicker(1_000);
  const [draft, setDraft] = useState<ActivationDraftState>(emptyDraftState);
  const [preview, setPreview] = useState<ActivationPreviewView | null>(null);
  const [hold, setHold] = useState<PreviewHold | null>(null);
  // 持有候选的发起时刻：只有当读模型的时间戳不早于它时，`latest_candidate` 才算「已确认」。
  const [holdIssuedAt, setHoldIssuedAt] = useState<number | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  // 幂等键代表「一次人工提交」：弹窗打开时生成，重试复用；关闭后重开视为新提交。
  const [idempotencyKey, setIdempotencyKey] = useState(() => newRecordIdempotencyKey());

  const previewMutation = useActivationPreview();
  const activateMutation = useActivateProviderFinance();
  const startLease = useStartQuiescenceLease();
  const releaseLease = useReleaseQuiescenceLease();

  const writeEnabled = mode === "ACTIVE";
  const gate = evaluateQuiescenceGate(state.quiescence);
  const issues = useMemo(() => validateDraft(draft, state.cutover_at), [draft, state.cutover_at]);
  const activeRows = countActiveRows(draft);
  const totalRows = Object.values(activeRows).reduce((sum, count) => sum + count, 0);
  // 读模型未刷新到本次预检之前的旧值时不作失效判定（stateUpdatedAt 缺省视为权威）。
  const latestAuthoritative = holdIssuedAt === null
    || stateUpdatedAt === undefined || stateUpdatedAt >= holdIssuedAt;
  const holdEvaluation = useMemo(() => {
    // 预检结论仍在展示、但候选已被清除（失效 / 被取代 / 服务端拒绝）：显式要求重新预检，
    // 避免出现「尚未执行预检」与 GO 结论并存的矛盾提示。
    if (hold === null && preview !== null && !previewMutation.isPending) {
      return { activatable: false, reason: "候选已失效或被取代，请重新预检", cleared: false };
    }
    return evaluateHold(hold, state.latest_candidate, nowMs, { latestAuthoritative });
  }, [hold, preview, previewMutation.isPending, state.latest_candidate, nowMs, latestAuthoritative]);

  // 候选失效（过期 / 被取代 / 哈希或水位漂移 / 服务端已失效）→ 立即清除可激活状态。
  useEffect(() => {
    if (hold !== null && holdEvaluation.cleared) setHold(null);
  }, [hold, holdEvaluation.cleared]);

  const activateError = activateMutation.error;
  const activateErrorCode = activateError instanceof ApiError ? activateError.code : null;

  const runPreview = () => {
    setConfirmOpen(false);
    setHold(null);
    setHoldIssuedAt(null);
    previewMutation.mutate(buildActivationDraft(draft, state.cutover_at), {
      onSuccess: (result) => {
        setPreview(result);
        setHold({
          candidateId: result.candidate_id, candidateHash: result.candidate_hash,
          factWatermarkHash: result.fact_watermark_hash, expiresAt: result.expires_at,
          decision: result.decision,
        });
        // 记录发起时刻：此后返回的读模型才算「已确认本次预检的候选」。
        setHoldIssuedAt(Date.now());
      },
    });
  };

  const openConfirm = () => {
    setIdempotencyKey(newRecordIdempotencyKey());
    setConfirmOpen(true);
  };

  const submitActivation = (confirmEnterpriseId: string) => {
    if (hold === null) return;
    activateMutation.mutate({
      candidate_id: hold.candidateId, candidate_hash: hold.candidateHash,
      idempotency_key: idempotencyKey, confirm_enterprise_id: confirmEnterpriseId,
    }, {
      onSuccess: () => setConfirmOpen(false),
      onError: (error) => {
        const code = error instanceof ApiError ? error.code : null;
        // 候选已失效：清除可激活状态并强制重新预检（PFU-03）。
        if (shouldClearHoldForError(code)) {
          setHold(null); setHoldIssuedAt(null); setPreview(null); setConfirmOpen(false);
        }
        // 已完成激活：刷新状态，容器会切到日常面板 + 回执。
        if (code === "already_activated") {
          void client.invalidateQueries({ queryKey: ACTIVATION_QUERY_KEY });
          setConfirmOpen(false);
        }
        // ACTIVATION_RETRY_REQUIRED 不改变任何本地状态：保持弹窗与同一幂等键，人工重试。
      },
    });
  };

  const legacySuggestions: LegacySuggestion[] = (preview?.gaps ?? [])
    .filter((gap) => gap.code === "LEGACY_RECORD_UNCLOSED" && gap.legacyRecordId !== null)
    .map((gap) => ({ legacyRecordId: gap.legacyRecordId!, resourceId: gap.resourceId ?? "" }));
  const requiredAccounts = state.scope_summary?.required_accounts ?? [];
  const canSubmitPreview = writeEnabled && canOperate && gate.ready
    && issues.length === 0 && !previewMutation.isPending;

  return (
    <div data-testid="activation-wizard">
      <section className="rounded-xl border border-ql-border-zone bg-ql-surface p-4" aria-label="初始化状态">
        <h2 className="text-[15px] font-semibold text-ql-fg">资金账本初始化</h2>
        <p className="mt-1 text-[12px] text-ql-fg-tertiary">
          严格资金写入口尚未开启。请补齐 API 期初、历史充值、Coding Plan 与旧记录关闭，
          预检通过后执行不可逆激活。切换时点 {formatDateTimeFull(state.cutover_at)}。
        </p>
        {writeEnabled ? null : (
          <p className="mt-3 rounded-lg border border-ql-warning/30 bg-ql-warning-soft px-3 py-2 text-[12px] text-ql-warning">
            当前为只读验收模式（DARK）：可以填写与查看草稿，预检与激活暂不可用。
          </p>
        )}
        {canOperate ? null : (
          <p className="mt-3 rounded-lg border border-ql-warning/30 bg-ql-warning-soft px-3 py-2 text-[12px] text-ql-warning">
            当前账号无 <code>resources.operate</code> 权限，草稿与激活均只读。
          </p>
        )}
      </section>

      <ActivationQuiescencePanel
        canOperate={canOperate} error={startLeaseError(startLease, releaseLease)}
        onRelease={(reason) => releaseLease.mutate({ reason })}
        onStart={(minutes) => startLease.mutate({ durationSeconds: minutes * 60 })}
        quiescence={state.quiescence}
        releasing={releaseLease.isPending} starting={startLease.isPending} writeEnabled={writeEnabled}
      />

      <ActivationDraftEditor
        cutoverAt={state.cutover_at} issues={issues} legacySuggestions={legacySuggestions}
        onChange={setDraft} readOnly={!canOperate} requiredAccounts={requiredAccounts}
        resourceOptions={resourceOptions} state={draft}
      />

      <section className="mt-4 rounded-xl border border-ql-border-zone bg-ql-surface p-4" aria-label="预检">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="flex items-center gap-1.5 text-[14px] font-semibold text-ql-fg">
              <ClipboardCheck aria-hidden className="h-4 w-4" />结构化预检
            </h3>
            <p className="mt-1 text-[12px] text-ql-fg-tertiary">
              预检只读：不会写入任何资金事实。已填 {totalRows} 行草稿。
            </p>
          </div>
          <button
            className="flex h-10 items-center gap-1.5 rounded-lg bg-ql-action px-4 text-[13px] font-medium text-white hover:bg-ql-action-hover disabled:cursor-not-allowed disabled:opacity-50"
            data-write-action disabled={!canSubmitPreview} onClick={runPreview} type="button"
          >
            <RotateCcw aria-hidden className="h-4 w-4" />{previewMutation.isPending ? "预检中…" : "执行预检"}
          </button>
        </div>

        {issues.length > 0 ? (
          <ul className="mt-3 space-y-1 text-[12px] text-ql-danger" data-testid="activation-draft-issues" role="alert">
            {issues.map((issue, index) => (
              <li key={`${issue.section}-${issue.rowId}-${issue.field}-${index}`}>
                {issue.section} · {issue.message}
              </li>
            ))}
          </ul>
        ) : null}
        {!gate.ready ? (
          <ul className="mt-3 space-y-1 text-[12px] text-ql-warning">
            {gate.blockers.map((blocker) => <li key={blocker}>静默门禁未满足：{blocker}</li>)}
          </ul>
        ) : null}
        {previewMutation.error ? (
          <p className="mt-3 text-[12px] text-ql-danger" role="alert" data-testid="preview-error">
            {previewErrorMessage(previewMutation.error)}
          </p>
        ) : null}

        {preview ? <PreviewResult holdEvaluation={holdEvaluation} nowMs={nowMs} onActivate={openConfirm}
          preview={preview} resourceLabel={resourceLabel} /> : null}
      </section>

      {confirmOpen && preview !== null && hold !== null ? (
        <ActivationConfirmDialog
          enterpriseId={enterpriseId} errorMessage={activateErrorMessage(activateError)}
          hold={hold} nowMs={nowMs} onCancel={() => setConfirmOpen(false)}
          onConfirm={submitActivation} pending={activateMutation.isPending} preview={preview}
          resourceLabel={resourceLabel} retryable={activateErrorCode === "activation_retry_required"} />
      ) : null}

      {!confirmOpen && activateMutation.isSuccess ? (
        <p className="mt-4 flex items-center gap-1.5 text-[12px] text-ql-success" role="status">
          激活完成，正在切换到日常资金面板…
        </p>
      ) : null}
    </div>
  );
}

function PreviewResult({ preview, holdEvaluation, nowMs, resourceLabel, onActivate }: {  preview: ActivationPreviewView;
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
          <span className="ml-2 font-mono text-[11px] text-ql-fg-tertiary">
            候选 {preview.candidate_id}
          </span>
        </p>
        <p className="text-[12px] text-ql-fg-tertiary">
          TTL 到期 {formatDateTimeFull(preview.expires_at)}（剩余 {remainingSeconds(preview.expires_at, nowMs)} 秒）
        </p>
      </div>
      <p className="mt-1 break-all font-mono text-[11px] text-ql-fg-tertiary" data-testid="preview-candidate-hash">
        候选哈希 {preview.candidate_hash} · 事实水位 {preview.fact_watermark_hash}
      </p>

      {holdEvaluation.reason ? (
        <p className="mt-3 flex items-start gap-1.5 rounded-lg border border-ql-warning/30 bg-ql-warning-soft px-3 py-2 text-[12px] text-ql-warning"
          data-testid="activation-hold-reason">
          <AlertTriangle aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" />{holdEvaluation.reason}
        </p>
      ) : null}

      <ActivationGapReport preview={preview} resourceLabel={resourceLabel} />

      <div className="mt-4 flex justify-end">
        <button
          className="flex h-10 items-center gap-1.5 rounded-lg bg-ql-danger px-4 text-[13px] font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
          data-write-action disabled={!holdEvaluation.activatable} onClick={onActivate} type="button"
        >
          <ShieldAlert aria-hidden className="h-4 w-4" />进入不可逆激活确认
        </button>
      </div>
    </div>
  );
}

function startLeaseError(
  startLease: ReturnType<typeof useStartQuiescenceLease>,
  releaseLease: ReturnType<typeof useReleaseQuiescenceLease>,
): string | null {
  const error = startLease.error ?? releaseLease.error;
  if (error === null || error === undefined) return null;
  if (error instanceof ApiError) return activationErrorMessage(error.code, error.message);
  return error instanceof Error ? error.message : "操作失败";
}

function previewErrorMessage(error: unknown): string {
  if (error instanceof ApiError) return activationErrorMessage(error.code, error.message);
  return error instanceof Error ? error.message : "预检失败";
}

function activateErrorMessage(error: unknown): string | null {
  if (error === null || error === undefined) return null;
  if (error instanceof ApiError) return activationErrorMessage(error.code, error.message);
  return error instanceof Error ? error.message : "激活失败";
}
