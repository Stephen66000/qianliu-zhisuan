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
import { ClipboardCheck, RotateCcw } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { ApiError } from "../../api/client";
import {
  ACTIVATION_QUERY_KEY, useActivateProviderFinance, useActivationPreview,
  useReleaseQuiescenceLease, useStartQuiescenceLease,
} from "../../api/provider-finance-activation";
import type {
  ActivationPreviewView, ActivationStateView, ProviderFinanceActivationMode,
} from "../../api/provider-finance-activation-types";
import { formatDateTimeFull } from "../../lib/format";
import { useQueryClient } from "@tanstack/react-query";

import { ActivationDraftEditor, type LegacySuggestion, type ResourceOption } from "./ActivationDraftEditor";
import { ActivationQuiescencePanel } from "./ActivationQuiescencePanel";
import {
  activationErrorMessage, evaluateHold, evaluateQuiescenceGate, shouldClearHoldForError, type PreviewHold,
} from "./activation-preflight-model";
import {
  buildActivationDraft, countActiveRows, emptyDraftState, newRecordIdempotencyKey, validateDraft,
  type ActivationDraftState,
} from "./activation-draft-model";
import {
  clearDraftAutosave, loadDraftAutosave, saveDraftAutosave,
} from "./draft-autosave";
import { useNowTicker } from "./use-now-ticker";
import { Button } from "../ui/Button";
import { ActivationConfirmDialog, PreviewResult } from "./ActivationPreviewPanels";



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
  // 本机自动保存（2026-09-27 功能 A）：key 按 enterpriseId + cutoverAt 隔离。
  // 恢复放在 lazy initializer 里完成——首帧即持有恢复值，React StrictMode 的
  // 双挂载不会产生「先空状态后保存」覆盖已有草稿的窗口；保存副作用只在
  // 水合标记置位之后运行。
  const draftStorage = typeof window === "undefined" ? null : window.localStorage;
  const [draft, setDraft] = useState<ActivationDraftState>(() =>
    loadDraftAutosave(draftStorage, enterpriseId, state.cutover_at) ?? emptyDraftState());
  const autosaveHydratedRef = useRef(false);
  const [autosaveSavedAt, setAutosaveSavedAt] = useState<string | null>(null);
  // 清除本机草稿的两步确认（复核修复 R3）：第一次单击只进入确认态，不删除；
  // 只有确认态下的第二次单击才真正 removeItem + 清空状态，避免误触。
  const [confirmingDraftClear, setConfirmingDraftClear] = useState(false);
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

  // 草稿变化后自动保存完整草稿状态；预检、候选过期、静默租约开始/释放都不清除草稿，
  // 只有激活成功（submitActivation onSuccess）才清除对应 key。
  useEffect(() => {
    if (!autosaveHydratedRef.current) {
      autosaveHydratedRef.current = true;
      return;
    }
    const savedAt = new Date().toISOString();
    if (saveDraftAutosave(draftStorage, draft, enterpriseId, state.cutover_at, savedAt)) {
      setAutosaveSavedAt(savedAt);
    }
  }, [draft, draftStorage, enterpriseId, state.cutover_at]);

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
      onSuccess: () => {
        // 只有激活成功才清除对应本机草稿（其他任何路径不得清除）。
        clearDraftAutosave(draftStorage, enterpriseId, state.cutover_at);
        setDraft(emptyDraftState());
        setAutosaveSavedAt(null);
        setConfirmOpen(false);
      },
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
        <p className="mt-1 text-[13px] text-ql-fg-tertiary">
          严格资金写入口尚未开启。请补齐 API 期初、历史充值、Coding Plan 与旧记录关闭，
          预检通过后执行不可逆激活。切换时点 {formatDateTimeFull(state.cutover_at)}。
        </p>
        {writeEnabled ? null : (
          <p className="mt-3 rounded-lg border border-ql-warning/30 bg-ql-warning-soft px-3 py-2 text-[13px] text-ql-warning">
            当前为只读验收模式（DARK）：可以填写与查看草稿，预检与激活暂不可用。
          </p>
        )}
        {canOperate ? null : (
          <p className="mt-3 rounded-lg border border-ql-warning/30 bg-ql-warning-soft px-3 py-2 text-[13px] text-ql-warning">
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

      <div className="mt-4 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-ql-border-zone bg-ql-surface px-4 py-2"
        data-testid="draft-autosave-bar">
        <p className="text-[13px] text-ql-fg-tertiary" data-testid="draft-autosave-status" role="status">
          {autosaveSavedAt
            ? `草稿已自动保存到本机 · ${formatDateTimeFull(autosaveSavedAt)}`
            : "本机草稿：尚未保存（填写后自动保存到本机浏览器）"}
        </p>
        {confirmingDraftClear && (
          <Button
            variant="secondary" size="sm"
            data-testid="draft-autosave-clear-cancel" disabled={!canOperate}
            onClick={() => setConfirmingDraftClear(false)}
            type="button"
          >
            取消
          </Button>
        )}
        <Button
          variant="secondary" size="sm"
          data-testid="draft-autosave-clear" disabled={!canOperate}
          onClick={() => {
            if (!confirmingDraftClear) {
              setConfirmingDraftClear(true);
              return;
            }
            clearDraftAutosave(draftStorage, enterpriseId, state.cutover_at);
            setDraft(emptyDraftState());
            setAutosaveSavedAt(null);
            setConfirmingDraftClear(false);
          }}
          type="button"
        >
          {confirmingDraftClear ? "确认清除本机草稿" : "清除本机草稿"}
        </Button>
      </div>

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
            <p className="mt-1 text-[13px] text-ql-fg-tertiary">
              预检只读：不会写入任何资金事实。已填 {totalRows} 行草稿。
            </p>
          </div>
          <Button loading={previewMutation.isPending} loadingText="预检中…" size="form"
            variant="primary"
            data-write-action disabled={!canSubmitPreview} onClick={runPreview} type="button"
          >
            <RotateCcw aria-hidden className="h-4 w-4" />执行预检
          </Button>
        </div>

        {issues.length > 0 ? (
          <ul className="mt-3 space-y-1 text-[13px] text-ql-danger" data-testid="activation-draft-issues" role="alert">
            {issues.map((issue, index) => (
              <li key={`${issue.section}-${issue.rowId}-${issue.field}-${index}`}>
                {issue.section} · {issue.message}
              </li>
            ))}
          </ul>
        ) : null}
        {!gate.ready ? (
          <ul className="mt-3 space-y-1 text-[13px] text-ql-warning">
            {gate.blockers.map((blocker) => <li key={blocker}>静默门禁未满足：{blocker}</li>)}
          </ul>
        ) : null}
        {previewMutation.error ? (
          <p className="mt-3 text-[13px] text-ql-danger" role="alert" data-testid="preview-error">
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
        <p className="mt-4 flex items-center gap-1.5 text-[13px] text-ql-success" role="status">
          激活完成，正在切换到日常资金面板…
        </p>
      ) : null}
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
