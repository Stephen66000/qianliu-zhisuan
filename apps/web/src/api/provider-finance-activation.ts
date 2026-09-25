/**
 * 资金账本初始化激活的 Web 客户端（WP05；PFU-01～PFU-06）。
 *
 * 权威身份：所有请求都不携带 `enterprise_id` / `admin_id`，企业与管理员由服务端
 * 从认证会话取得（PFA-07 / PFU-02）。`confirm_enterprise_id` 只用于激活前的二次防误操作匹配。
 *
 * 静默与排空的**唯一读取源**是 `activation-state.quiescence`：该接口已经返回租约有效期、
 * 剩余时间与排空计数，因此不再单独查询 `activation-quiescence`，避免同一窗口出现两份
 * 可能互相矛盾的快照。租约变更成功后失效 `activation-state` 即可拿到新状态。
 *
 * 重试语义（PFU-03 Scenario: Serializable activation requires manual retry）：
 * 写操作（预检/激活/静默租约）一律 `retry: 0`，UI 不做任何自动重试；
 * `409 activation_retry_required` 必须由管理员重新读取状态后人工重试。
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { get, post } from "./client";
import { invalidateProviderFinanceCaches } from "./provider-finance";
import type {
  ActivationOutcomeView,
  ActivationPreviewView,
  ActivationStateView,
  ActivationDraftPayload,
  ActivatePayload,
  QuiescenceEnvelopeView,
} from "./provider-finance-activation-types";

export const ACTIVATION_QUERY_KEY = ["provider-finance-activation", "state"] as const;

/**
 * 运行模式与激活状态（任务 4.1 的只读投影，含静默与排空）。只读请求允许一次自动重试。
 *
 * `strict_writes_enabled` 是「是否已激活」的运行期事实，`mode` 是运维模式，
 * 二者共同决定初始化向导 / 日常面板的切换（PFU-01）。
 */
export function useProviderFinanceActivationState(enabled = true) {
  return useQuery({
    queryKey: ACTIVATION_QUERY_KEY,
    queryFn: ({ signal }) => get<ActivationStateView>("/provider-finance/activation-state", signal),
    enabled, staleTime: 5_000, retry: 1,
  });
}

function useQuiescenceMutation<TInput, TResult>(mutationFn: (input: TInput) => Promise<TResult>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn,
    retry: 0,
    onSuccess: () => { void client.invalidateQueries({ queryKey: ACTIVATION_QUERY_KEY }); },
  });
}

/** 启动静默租约：上限 60 分钟，服务端按服务器时间计算到期。 */
export function useStartQuiescenceLease() {
  return useQuiescenceMutation(
    (input: { durationSeconds?: number }) => post<QuiescenceEnvelopeView>(
      "/provider-finance/activation-quiescence",
      input.durationSeconds === undefined ? {} : { duration_seconds: input.durationSeconds },
    ),
  );
}

/** 解除静默租约必须给出原因，与服务端审计口径一致。 */
export function useReleaseQuiescenceLease() {
  return useQuiescenceMutation(
    (input: { reason: string }) => post<QuiescenceEnvelopeView>(
      "/provider-finance/activation-quiescence/release", { reason: input.reason },
    ),
  );
}

/**
 * 只读预检（PFU-03）。返回结构化缺口与候选元数据；**不写入资金事实**。
 * 预检不做自动重试：失败（含静默不足、排空未完成）应立即反馈给管理员。
 */
export function useActivationPreview() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (draft: ActivationDraftPayload) =>
      post<ActivationPreviewView>("/provider-finance/activation-preview", draft),
    retry: 0,
    onSuccess: () => {
      // 预检会写候选元数据并可能改变静默/排空可见性，刷新状态读模型。
      void client.invalidateQueries({ queryKey: ACTIVATION_QUERY_KEY });
    },
  });
}

/**
 * 不可逆激活（PFU-04）。`idempotency_key` 由调用方持有：同一次人工提交必须复用同一个键，
 * 重试（含 `ACTIVATION_RETRY_REQUIRED` 后的人工重试）不得换键（PFA-04 §9）。
 */
export function useActivateProviderFinance() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (payload: ActivatePayload) =>
      post<ActivationOutcomeView>("/provider-finance/activate", payload),
    retry: 0,
    onSuccess: () => {
      // 激活成功后刷新资金、资源、经营账单、分析与首页（PFU-04、PFU-05）。
      invalidateProviderFinanceCaches(client);
      void client.invalidateQueries({ queryKey: ACTIVATION_QUERY_KEY });
    },
  });
}
