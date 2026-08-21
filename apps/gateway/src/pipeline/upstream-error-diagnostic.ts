import type { Outcome, UpstreamErrorEvidence } from "@qianliu/contracts";

export function attemptDiagnosticUpdate(outcome: Outcome): {
  upstream_error_evidence: Record<string, unknown> | null;
  request_shape_summary: Record<string, unknown> | null;
} {
  return {
    upstream_error_evidence: outcome.upstreamErrorEvidence
      ? { ...outcome.upstreamErrorEvidence }
      : null,
    request_shape_summary: outcome.requestShapeSummary
      ? { ...outcome.requestShapeSummary }
      : null,
  };
}

export function northboundFailurePresentation(
  outcome: Outcome,
  providerDisplayName: string,
  quotaExhausted: boolean,
): {
  diagnosticExtension: Record<string, unknown>;
  message: string;
  param: string | null;
} {
  if (quotaExhausted) {
    const reset = outcome.recoverAt ? `（${outcome.recoverAt}）` : "（下一重置时间未知）";
    return {
      diagnosticExtension: {},
      message: `${providerDisplayName}厂商额度已用完，请等待额度重置${reset}`,
      param: null,
    };
  }
  if (outcome.status === 429) {
    return { diagnosticExtension: {}, message: "上游套餐暂时限流，请稍后重试", param: null };
  }
  if (outcome.status === 400 && outcome.upstreamErrorEvidence) {
    const evidence = outcome.upstreamErrorEvidence;
    return {
      diagnosticExtension: { diagnostic: diagnosticEnvelope(evidence) },
      message: invalidRequestDiagnosticMessage(evidence),
      param: evidence.param,
    };
  }
  return { diagnosticExtension: {}, message: outcome.error ?? "upstream_error", param: null };
}

function invalidRequestDiagnosticMessage(evidence: UpstreamErrorEvidence): string {
  const field = evidence.param ? `，字段 ${evidence.param}` : "";
  return `上游拒绝请求：${evidence.messageCategory}${field}；诊断 ${evidence.diagnosticHash.slice(0, 12)}`;
}

function diagnosticEnvelope(evidence: UpstreamErrorEvidence): Record<string, unknown> {
  return {
    category: evidence.messageCategory,
    upstream_type: evidence.type,
    upstream_code: evidence.code,
    param: evidence.param,
    hash: evidence.diagnosticHash,
  };
}
