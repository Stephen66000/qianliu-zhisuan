import type { Outcome } from "@qianliu/contracts";
import { isSwitchable, type ErrorClassification } from "@qianliu/domain";

/** 首字节超时可能意味着上游仍在生成，盲目 failover 会放大占用与计费风险。 */
export function shouldAttemptUpstreamFailover(
  outcome: Pick<Outcome, "committed" | "failureLayer">,
  classification: ErrorClassification | null,
): boolean {
  return !outcome.committed
    && outcome.failureLayer !== "FIRST_BYTE_TIMEOUT"
    && isSwitchable(classification as ErrorClassification);
}
