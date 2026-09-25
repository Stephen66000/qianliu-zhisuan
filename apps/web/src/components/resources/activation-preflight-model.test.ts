/**
 * 预检结果、候选时效与静默门禁纯模型测试（WP05 任务 5.3、5.4、5.5；PFU-03、PFU-04、PFA-09）。
 *
 * 关键回归点：服务端的「静默排空」是**两段式**门禁 —— 未配对用量行只在只读投影**之后**
 * 按候选修复集豁免重算，因此它**不得**阻断预检本身；把两者混为一谈会让首次预检永远不可达。
 */
import { describe, expect, it } from "vitest";

import {
  activationErrorMessage, evaluateHold, evaluateQuiescenceGate, gapLocator, groupGapsByCategory,
  prePersistBlockers, prePreviewBlockers, receiptFactCountSummary, shouldClearHoldForError,
  type PreviewHold,
} from "./activation-preflight-model";
import type {
  ActivationCandidateMetadata, ActivationGapView, ActivationReceiptView, QuiescenceView,
} from "../../api/provider-finance-activation-types";

const NOW = Date.parse("2026-09-22T03:00:00.000Z");
const FUTURE = "2026-09-22T03:30:00.000Z";
const PAST = "2026-09-22T02:00:00.000Z";

function gap(patch: Partial<ActivationGapView> = {}): ActivationGapView {
  return {
    code: "MISSING_OPENING_BALANCE", category: "OPENING_BALANCE", message: "缺少期初",
    resourceId: null, accountCurrency: null, legacyRecordId: null, ledgerLineId: null,
    month: null, detail: null, ...patch,
  };
}

function candidate(patch: Partial<ActivationCandidateMetadata> = {}): ActivationCandidateMetadata {
  return {
    candidate_id: "cand-1", candidate_hash: "hash-1", fact_watermark_hash: "wm-1",
    decision: "GO_CANDIDATE", status: "PREVIEWED", created_at: "2026-09-22T02:59:00.000Z",
    expires_at: FUTURE, expired: false, created_by_admin_user_id: "admin-1",
    gap_summary: [], activated_at: null, activated_by_admin_user_id: null, ...patch,
  };
}

function hold(patch: Partial<PreviewHold> = {}): PreviewHold {
  return {
    candidateId: "cand-1", candidateHash: "hash-1", factWatermarkHash: "wm-1",
    expiresAt: FUTURE, decision: "GO_CANDIDATE", ...patch,
  };
}

function quiescence(patch: Partial<QuiescenceView> = {}, drain: Partial<QuiescenceView["drain"]> = {}): QuiescenceView {
  return {
    status: "ACTIVE", active: true, started_at: "2026-09-22T02:55:00.000Z", expires_at: FUTURE,
    released_at: null, release_reason: null, remaining_seconds: 1_800,
    insufficient_for_activation: false,
    drain: {
      in_progress_requests: 0, open_attempts: 0, unpaired_usage_lines: 0,
      pending_ledger_transactions: 0, exonerated_usage_lines: 0, drained: true, ...drain,
    },
    ...patch,
  };
}

describe("结构化缺口分组", () => {
  it("按固定类别顺序分组，并给到资源/账户/月份/旧记录/用量行的定位", () => {
    const groups = groupGapsByCategory([
      gap({ code: "UNKNOWN_COST", category: "USAGE", ledgerLineId: "aaaaaaaa-bbbb" }),
      gap({ resourceId: "res-1", accountCurrency: "CNY" }),
      gap({ code: "LEGACY_RECORD_UNCLOSED", category: "LEGACY_RECORD", legacyRecordId: "cccccccc-dddd" }),
    ]);
    expect(groups.map((group) => group.category)).toEqual(["OPENING_BALANCE", "LEGACY_RECORD", "USAGE"]);
    expect(groups[0]!.label).toBe("API 期初余额");

    const label = (id: string) => (id === "res-1" ? "Kimi · 主账号" : id.slice(0, 8));
    expect(gapLocator(gap({ resourceId: "res-1", accountCurrency: "USD", month: "2026-08" }), label))
      .toBe("Kimi · 主账号 · USD · 2026-08");
    expect(gapLocator(gap(), label)).toBe("企业级");
    expect(gapLocator(gap({ ledgerLineId: "aaaaaaaa-bbbb" }), label)).toBe("用量行 aaaaaaaa");
  });
});

describe("候选可激活状态的生命周期", () => {
  it("未预检 / NO_GO / 一致时给出正确可激活判定", () => {
    expect(evaluateHold(null, null, NOW)).toMatchObject({ activatable: false, cleared: false });
    expect(evaluateHold(hold({ decision: "NO_GO" }), candidate({ decision: "NO_GO" }), NOW).reason)
      .toContain("NO_GO");
    expect(evaluateHold(hold(), candidate(), NOW)).toEqual({ activatable: true, reason: null, cleared: false });
  });

  it("过期、被取代、哈希变化、水位漂移、状态非 PREVIEWED 都立即清除可激活状态", () => {
    expect(evaluateHold(hold({ expiresAt: PAST }), candidate(), NOW)).toMatchObject({ cleared: true });
    expect(evaluateHold(hold(), candidate({ candidate_id: "cand-2" }), NOW))
      .toMatchObject({ cleared: true, activatable: false });
    expect(evaluateHold(hold(), null, NOW)).toMatchObject({ cleared: true });
    expect(evaluateHold(hold(), candidate({ expired: true }), NOW)).toMatchObject({ cleared: true });
    expect(evaluateHold(hold(), candidate({ status: "ACTIVATED" }), NOW)).toMatchObject({ cleared: true });
    expect(evaluateHold(hold(), candidate({ candidate_hash: "hash-2" }), NOW).reason).toContain("候选哈希已变化");
    expect(evaluateHold(hold(), candidate({ fact_watermark_hash: "wm-2" }), NOW).reason).toContain("事实水位已漂移");
  });

  it("读模型尚未刷新到本次预检时判「未知」而非「已失效」（F-P1-1 回归）", () => {
    // 首次预检：state.latest_candidate 仍是旧值（null），不能据此清空刚拿到的 GO 候选。
    expect(evaluateHold(hold(), null, NOW, { latestAuthoritative: false }))
      .toEqual({ activatable: true, reason: null, cleared: false });
    // 旧读模型里是另一个候选（上一次预检残留）时同样不得清除。
    expect(evaluateHold(hold(), candidate({ candidate_id: "cand-0" }), NOW, { latestAuthoritative: false }))
      .toEqual({ activatable: true, reason: null, cleared: false });
    // 本地 TTL 过期与读模型无关，仍必须失败关闭。
    expect(evaluateHold(hold({ expiresAt: PAST }), null, NOW, { latestAuthoritative: false }))
      .toMatchObject({ cleared: true, activatable: false });
    // 显式权威（缺省值）时保持原有失败关闭语义。
    expect(evaluateHold(hold(), null, NOW, { latestAuthoritative: true }))
      .toMatchObject({ cleared: true, activatable: false });
    expect(evaluateHold(hold(), null, NOW)).toMatchObject({ cleared: true, activatable: false });
  });

  it("只有候选失效类错误才清除候选；ACTIVATION_RETRY_REQUIRED 必须保留候选", () => {
    expect(shouldClearHoldForError("activation_candidate_stale")).toBe(true);
    expect(shouldClearHoldForError("activation_candidate_expired")).toBe(true);
    expect(shouldClearHoldForError("activation_candidate_not_found")).toBe(true);
    expect(shouldClearHoldForError("activation_candidate_not_ready")).toBe(true);
    // 事务整体回滚，候选仍有效：管理员用同一幂等键重试。
    expect(shouldClearHoldForError("activation_retry_required")).toBe(false);
    expect(shouldClearHoldForError("activation_not_quiescent")).toBe(false);
    expect(shouldClearHoldForError(null)).toBe(false);
  });

  it("409 语义映射到可读提示，未知码回退服务端消息", () => {
    expect(activationErrorMessage("session_enterprise_mismatch", "x")).toContain("确认企业");
    expect(activationErrorMessage("activation_retry_required", "x")).toContain("人工重试");
    expect(activationErrorMessage("unknown_code", "原始消息")).toBe("原始消息");
  });
});

describe("静默与排空两段式门禁", () => {
  it("未配对用量行只属落库门，不阻断预检", () => {
    const view = quiescence({}, { unpaired_usage_lines: 7, drained: false });
    expect(prePreviewBlockers(view)).toEqual([]);
    expect(evaluateQuiescenceGate(view)).toEqual({ ready: true, blockers: [] });
    expect(prePersistBlockers(view)).toHaveLength(1);
    expect(prePersistBlockers(view)[0]).toContain("7 条未配对用量行");
  });

  it("在途请求 / 未结束尝试 / 待结算交易 / 租约缺失或不足都阻断预检", () => {
    expect(prePreviewBlockers(quiescence({}, { in_progress_requests: 2 }))).toHaveLength(1);
    expect(prePreviewBlockers(quiescence({}, { open_attempts: 1 }))).toHaveLength(1);
    expect(prePreviewBlockers(quiescence({}, { pending_ledger_transactions: 3 }))).toHaveLength(1);
    expect(prePreviewBlockers(quiescence({ active: false }))).toContain("静默租约未启动或已到期");
    expect(prePreviewBlockers(quiescence({ insufficient_for_activation: true }))[0]).toContain("剩余时间不足");
    // 租约未启动时不应再报「剩余不足」，避免重复提示同一根因。
    expect(prePreviewBlockers(quiescence({ active: false, insufficient_for_activation: true }))).toHaveLength(1);
    expect(evaluateQuiescenceGate(quiescence({}, { open_attempts: 1 })).ready).toBe(false);
  });
});

describe("回执摘要", () => {
  it("汇总六类写入事实计数", () => {
    const receipt: ActivationReceiptView = {
      candidateId: "cand-1", candidateHash: "hash-1", factWatermarkHash: "wm-1",
      activatedAt: "2026-09-22T03:00:00.000Z", activatedByAdminUserId: "admin-1",
      factCounts: { openings: 2, recharges: 1, purchases: 1, carryovers: 0, legacyResolutions: 3, usageRepairs: 4 },
      monthsChecked: ["2026-08", "2026-09"], conservationPassed: true, conservationFailures: [],
    };
    expect(receiptFactCountSummary(receipt)).toBe(
      "期初 2 · 历史充值 1 · 购买/续费 1 · 跨切换周期 0 · 旧记录关闭 3 · 用量修复 4");
  });
});
