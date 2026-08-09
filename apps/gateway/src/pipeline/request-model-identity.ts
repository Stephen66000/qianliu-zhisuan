import type { PrincipalAuthResult } from "../auth/principal-auth.js";

export interface RequestModelIdentity {
  /** 请求当时的 alias，作为历史证据保留。 */
  unified_model: string;
  /** 模型鉴权阶段确认的稳定 unified_model.id。 */
  unified_model_id: string;
}

/**
 * 将已鉴权的稳定模型 ID 与请求 alias 绑定为同一份入账身份。
 * 稳定 ID 缺失时 fail-closed，调用方必须在 claim 和上游调度前拒绝。
 */
export function resolveRequestModelIdentity(
  principal: PrincipalAuthResult,
  requestedAlias: string,
): RequestModelIdentity | null {
  if (!principal.authorizedModelId) return null;
  return {
    unified_model: requestedAlias,
    unified_model_id: principal.authorizedModelId,
  };
}
