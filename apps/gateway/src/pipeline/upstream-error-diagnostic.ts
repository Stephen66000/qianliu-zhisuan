import type { Outcome, UpstreamErrorEvidence } from "@qianliu/contracts";
import { parseRequestShapeSummary, parseUpstreamErrorEvidence } from "@qianliu/contracts";

export function attemptDiagnosticUpdate(outcome: Outcome): {
  upstream_error_evidence: Record<string, unknown> | null;
  request_shape_summary: Record<string, unknown> | null;
} {
  const evidence = parseUpstreamErrorEvidence(outcome.upstreamErrorEvidence);
  const shape = parseRequestShapeSummary(outcome.requestShapeSummary);
  if (!new Set([400, 401, 403]).has(outcome.status) || !evidence || !shape) {
    return { upstream_error_evidence: null, request_shape_summary: null };
  }
  return {
    upstream_error_evidence: { ...evidence },
    request_shape_summary: { ...shape },
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
  const evidence = parseUpstreamErrorEvidence(outcome.upstreamErrorEvidence);
  const shape = parseRequestShapeSummary(outcome.requestShapeSummary);
  if (outcome.status === 400 && evidence && shape) {
    const requestIssues = Object.entries(shape.toolSchemaIssueCounts)
      .filter(([, count]) => count > 0)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([code, count]) => ({ code, count }));
    return {
      diagnosticExtension: { diagnostic: diagnosticEnvelope(evidence, requestIssues) },
      message: invalidRequestDiagnosticMessage(evidence, requestIssues),
      param: evidence.param,
    };
  }
  return { diagnosticExtension: {}, message: outcome.error ?? "upstream_error", param: null };
}

function invalidRequestDiagnosticMessage(
  evidence: UpstreamErrorEvidence,
  requestIssues: Array<{ code: string; count: number }>,
): string {
  const field = evidence.param ? `，字段 ${evidence.param}` : "";
  const issues = requestIssues.length > 0
    ? `；结构 ${requestIssues.map((item) => `${item.code}:${item.count}`).join("/")}`
    : "";
  return `上游拒绝请求：${evidence.messageCategory}${field}${issues}；诊断 ${evidence.diagnosticHash.slice(0, 12)}`;
}

function diagnosticEnvelope(
  evidence: UpstreamErrorEvidence,
  requestIssues: Array<{ code: string; count: number }>,
): Record<string, unknown> {
  return {
    category: evidence.messageCategory,
    upstream_type: evidence.type,
    upstream_code: evidence.code,
    param: evidence.param,
    request_issues: requestIssues,
    hash: evidence.diagnosticHash,
  };
}
