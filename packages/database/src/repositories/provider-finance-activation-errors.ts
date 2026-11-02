import { ProviderFinanceActivationError } from "./provider-finance-activation-types.js";
import { ProviderFinanceError } from "./provider-finance-types.js";

function sqlStateOf(error: unknown): string | null {
  if (error === null || typeof error !== "object") return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

/**
 * 事务执行边界之外的故障映射（design §7）。
 *
 * - `40001`（序列化失败）/ `40P01`（死锁）→ `ACTIVATION_RETRY_REQUIRED`、`retryable=true`；
 * - `ProviderFinanceError`（Tx 原语的确定性输入校验，如"账户金额必须为正"）→
 *   `FACT_WRITE_INVALID`（400）：这类错误是**确定性**的，重试或重新预检都不会改变结果，
 *   不能改写成 `CANDIDATE_STALE`——那会暗示"重新预检可解"，误导管理员陷入无意义循环，
 *   也掩盖了原始错误码；
 * - 其它错误原样抛出；
 * - 本函数**不做任何重试**：协调器、仓储与 HTTP 层都不得自动重试，
 *   管理员必须先重读 activation-state 再决定是否重提（水位变化会变成 `CANDIDATE_STALE`）。
 */
export function mapActivationFailure(error: unknown): unknown {
  const state = sqlStateOf(error);
  if (state === "40001" || state === "40P01") {
    return new ProviderFinanceActivationError(
      "ACTIVATION_RETRY_REQUIRED", "激活事务与并发写入冲突，请重读激活状态后再提交",
      { sqlstate: state, retryable: true }, true);
  }
  if (error instanceof ProviderFinanceError) {
    return new ProviderFinanceActivationError(
      "FACT_WRITE_INVALID", `初始化事实写入参数不合法：${error.message}`, { code: error.code }, false);
  }
  return error;
}
