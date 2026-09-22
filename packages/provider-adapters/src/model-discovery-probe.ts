/**
 * 模型权限探针执行与结果映射（自 model-discovery.ts 拆出，体量门禁 P1）。
 *
 * 只有 2xx 才是 READY；5xx/超时/网络失败保留模型行并标记可重试；
 * 本侧配置错误（端点歧义/缺失、凭证未配置）不可重试且不合成上游 HTTP 状态。
 */
import { randomUUID } from "node:crypto";
import { canonicalProviderCode } from "./provider-code.js";
import { createOpenAiCompatibleCaller } from "./openai-compatible-caller.js";
import { SecretValue } from "./secret-value.js";
import type { DiscoveredProviderModel } from "./model-discovery-contract.js";
import type { HttpFetch, ResourceMode } from "./index.js";

type ProviderCode = string;

export function mapProbeOutcome(model: DiscoveredProviderModel, outcome: {
  status: number; upstreamCode?: string | null;
}): void {
  const checkedAt = new Date().toISOString();
  const status = outcome.status;
  const upstreamCode = outcome.upstreamCode ?? null;
  if (status >= 200 && status < 300) {
    model.compatible = true;
    model.unavailableReason = null;
    model.credentialValidation = { status: "READY", httpStatus: status, errorCode: null, retryable: false, checkedAt };
    return;
  }
  model.compatible = false;
  // 审核修复（P1）：本侧配置错误（端点歧义/缺失、凭证未配置）在状态分类
  // 之前识别——不合成上游 HTTP 状态、不可重试，与"上游暂不可用"严格区分。
  if (upstreamCode === "upstream_endpoint_ambiguous" || upstreamCode === "upstream_base_url_missing"
    || upstreamCode === "upstream_credential_missing") {
    model.unavailableReason = "探针未发出：本侧端点或凭证配置无法解析，请修正配置后重新检测";
    model.credentialValidation = { status: "REQUEST_REJECTED", httpStatus: null, errorCode: "MODEL_PROBE_CONFIGURATION_ERROR", retryable: false, checkedAt };
    return;
  }
  if (status === 401) {
    model.unavailableReason = "凭证鉴权失败 (HTTP 401)";
    model.credentialValidation = { status: "AUTH_FAILED", httpStatus: status, errorCode: "MODEL_PROBE_AUTH_FAILED", retryable: false, checkedAt };
  } else if (status === 403) {
    model.unavailableReason = "当前套餐/凭证未开通此模型权限 (HTTP 403)";
    model.credentialValidation = { status: "PLAN_NOT_ENTITLED", httpStatus: status, errorCode: "MODEL_PROBE_PLAN_NOT_ENTITLED", retryable: false, checkedAt };
  } else if (status === 400 || status === 404) {
    model.unavailableReason = status === 404
      ? "模型不存在或请求被上游拒绝 (HTTP 404)"
      : "探针请求形状被上游拒绝 (HTTP 400)";
    model.credentialValidation = { status: "REQUEST_REJECTED", httpStatus: status, errorCode: "MODEL_PROBE_REQUEST_REJECTED", retryable: false, checkedAt };
  } else if (status === 429) {
    model.unavailableReason = "探针被上游限流 (HTTP 429)，可稍后重试";
    model.credentialValidation = { status: "RATE_LIMITED", httpStatus: status, errorCode: "MODEL_PROBE_RATE_LIMITED", retryable: true, checkedAt };
  } else if (upstreamCode === "upstream_timeout" || status === 504) {
    model.unavailableReason = "探针超时，可重试";
    model.credentialValidation = { status: "UPSTREAM_UNAVAILABLE", httpStatus: status || null, errorCode: "MODEL_PROBE_UPSTREAM_UNAVAILABLE", retryable: true, checkedAt };
  } else if (status === 0 || upstreamCode === "transport_error" || upstreamCode === "client_cancelled") {
    model.unavailableReason = "探针网络失败（DNS/TLS/连接），可重试";
    model.credentialValidation = { status: "NETWORK_FAILED", httpStatus: null, errorCode: "MODEL_PROBE_NETWORK_FAILED", retryable: true, checkedAt };
  } else if (status >= 500) {
    model.unavailableReason = `上游暂不可用 (HTTP ${status})，可重试`;
    model.credentialValidation = { status: "UPSTREAM_UNAVAILABLE", httpStatus: status, errorCode: "MODEL_PROBE_UPSTREAM_UNAVAILABLE", retryable: true, checkedAt };
  } else {
    // 未知状态：保留原 HTTP 状态与统一错误分类，不转成空列表，不判定可用。
    model.unavailableReason = `模型探针返回未分类状态 (HTTP ${status})`;
    model.credentialValidation = { status: "REQUEST_REJECTED", httpStatus: status, errorCode: "MODEL_PROBE_REQUEST_REJECTED", retryable: false, checkedAt };
  }
}

export async function probeModelPermissions(
  providerCode: ProviderCode,
  mode: ResourceMode,
  credential: string,
  models: DiscoveredProviderModel[],
  fetcher?: HttpFetch,
  env: NodeJS.ProcessEnv = process.env,
  baseUrl?: string,
  endpoints?: Partial<Record<ResourceMode, string>>,
): Promise<void> {
  // WP02：探针分支一律使用 canonical code；Kimi/KIMI/kimi 进入同一策略。
  const code = canonicalProviderCode(providerCode);
  const caller = createOpenAiCompatibleCaller({
    ...(fetcher ? { fetch: fetcher } : {}),
    env,
    requestTimeoutMs: 60_000,
    firstByteTimeoutMs: 30_000,
    streamIdleTimeoutMs: 30_000,
  });
  const chatModels = models.filter((m) => m.modelType === "CHAT");
  // 若厂商模型数量较多（如 Qwen/OpenAI/SiliconFlow 包含数十甚至数百模型），
  // 全量串行探活会导致严重耗时或上游频控。探查前 5 个典型模型即可确认接口与 Key 健康度。
  const modelsToProbe = chatModels.length > 5 ? chatModels.slice(0, 5) : chatModels;
  for (const model of modelsToProbe) {
    // WP05：删除 k3-256k 无条件 compatible=false 硬编码；
    // 是否可用只由当前凭证的真实探针决定。
    const isK3 = code === "kimi" && /^(?:kimi-)?k3(?:-|$)/i.test(model.id);
    try {
      const outcome = await caller({
        providerCode: code,
        resourceId: "probe",
        mode,
        upstreamModel: model.id,
        concurrencyLimit: 1,
        baseUrl,
        endpoints,
        secret: new SecretValue(credential),
      }, {
        requestId: `probe-${randomUUID()}`,
        unifiedModel: model.id,
        stream: false,
        capability: "chat",
        // WP04：固定最小探针形状，显式限制输出 Token，冻结额度消耗
        //（经 toChatCompletionsRequest 映射为上游 max_tokens: 8）。
        maxOutputTokens: 8,
        body: {
          model: model.id,
          messages: [{ role: "user", content: "hi" }],
          // K3 系列按官方合同附加 reasoning_effort（canonical code 命中，
          // 生产 code=Kimi 时同样生效）。
          ...(isK3 ? { reasoning_effort: "low" } : {}),
        },
      }, 1);
      mapProbeOutcome(model, outcome);
    } catch {
      // 探针执行异常（非 HTTP 失败）：网络失败，可重试；不再原谅为兼容。
      model.compatible = false;
      model.unavailableReason = "模型探针超时或连接失败，可重试";
      model.credentialValidation = {
        status: "NETWORK_FAILED", httpStatus: null, errorCode: "MODEL_PROBE_NETWORK_FAILED",
        retryable: true, checkedAt: new Date().toISOString(),
      };
    }
  }
}
