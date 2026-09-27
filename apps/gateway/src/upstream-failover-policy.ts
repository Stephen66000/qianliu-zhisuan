import type { Outcome } from "@qianliu/contracts";
import { isSwitchable, type ErrorClassification } from "@qianliu/domain";

/** 首字节超时可能意味着上游仍在生成，盲目 failover 会放大占用与计费风险。 */
export function shouldAttemptUpstreamFailover(
  outcome: Pick<Outcome, "committed" | "failureLayer">,
  classification: ErrorClassification | null,
): boolean {
  // STREAM_IDLE_TIMEOUT 是终止性 Attempt 结果：无论北向是否已提交，都不再
  // 为本请求启动新 Attempt（避免已输出后拼接或等待 5 分钟后再来一轮 6 分钟）。
  // 此前因其他可切换错误完成的合法 Attempt 不受影响。
  return !outcome.committed
    && outcome.failureLayer !== "FIRST_BYTE_TIMEOUT"
    && outcome.failureLayer !== "STREAM_IDLE_TIMEOUT"
    && isSwitchable(classification as ErrorClassification);
}
