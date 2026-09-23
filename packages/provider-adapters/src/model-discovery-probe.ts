/**
 * 模型权限探针执行与结果映射（自 model-discovery.ts 拆出，体量门禁 P1）。
 *
 * 只有 2xx 才是 READY；5xx/超时/网络失败保留模型行并标记可重试；
 * 本侧配置错误（端点歧义/缺失、凭证未配置）不可重试且不合成上游 HTTP 状态。
 */
import { randomUUID } from "node:crypto";
import { canonicalProviderCode } from "./provider-code.js";
import { createOpenAiCompatibleCaller } from "./openai-compatible-caller.js";
import { resolveProviderEndpoint } from "./endpoint-policy.js";
import { SecretValue } from "./secret-value.js";
import type { DiscoveredProviderModel } from "./model-discovery-contract.js";
import type { HttpFetch, ResourceMode } from "./index.js";

type ProviderCode = string;

/** 探针实际调用（CHAT_COMPLETIONS）命中的端点身份，随证据落库/返回（F-P2-4）。 */
function probeEndpointIdentity(input: {
  providerCode: string;
  mode: ResourceMode;
  baseUrl?: string;
  endpoints?: Partial<Record<ResourceMode, string>>;
  env: NodeJS.ProcessEnv;
}): { endpointScope: string; endpointHost: string } {
  const endpoint = resolveProviderEndpoint({
    providerCode: input.providerCode,
    resourceMode: input.mode,
    operation: "CHAT_COMPLETIONS",
    configuredEndpoints: { base_url: input.baseUrl ?? null, endpoints: input.endpoints ?? null },
    env: input.env,
  });
  return {
    endpointScope: endpoint.ok ? endpoint.scope : "ENDPOINT_SCOPE_AMBIGUOUS",
    endpointHost: endpoint.ok ? endpoint.host : (endpoint.host ?? "unresolved"),
  };
}

export function mapProbeOutcome(model: DiscoveredProviderModel, outcome: {
  status: number; upstreamCode?: string | null; upstreamErrorKind?: string | null;
  endpointScope?: string | null; endpointHost?: string | null;
}): void {
  const checkedAt = new Date().toISOString();
  const status = outcome.status;
  const upstreamCode = outcome.upstreamCode ?? null;
  const identity = { endpointScope: outcome.endpointScope ?? null, endpointHost: outcome.endpointHost ?? null };
  if (status >= 200 && status < 300) {
    model.compatible = true;
    model.unavailableReason = null;
    model.credentialValidation = { status: "READY", httpStatus: status, errorCode: null, retryable: false, checkedAt, ...identity };
    return;
  }
  model.compatible = false;
  // 审核修复（P1）：本侧配置错误（端点歧义/缺失、凭证未配置）在状态分类
  // 之前识别——不合成上游 HTTP 状态、不可重试，与"上游暂不可用"严格区分。
  if (upstreamCode === "upstream_endpoint_ambiguous" || upstreamCode === "upstream_base_url_missing"
    || upstreamCode === "upstream_credential_missing") {
    model.unavailableReason = "探针未发出：本侧端点或凭证配置无法解析，请修正配置后重新检测";
    model.credentialValidation = { status: "REQUEST_REJECTED", httpStatus: null, errorCode: "MODEL_PROBE_CONFIGURATION_ERROR", retryable: false, checkedAt, ...identity };
    return;
  }
  // F-P2-3：401 按上游脱敏语义细分——额度/套餐类错误码映射 PLAN_NOT_ENTITLED，
  // 其余保持 AUTH_FAILED，避免"套餐未开通该模型"被误显示为"凭证鉴权失败"。
  if (status === 401) {
    const planSemantics = outcome.upstreamErrorKind === "QUOTA_EXHAUSTED"
      || outcome.upstreamErrorKind === "WINDOW_EXHAUSTED"
      || outcome.upstreamErrorKind === "PLAN_EXPIRED"
      || (upstreamCode !== null && /quota|plan|entitle|subscription/i.test(upstreamCode));
    if (planSemantics) {
      model.unavailableReason = "当前套餐/凭证未开通此模型权限 (HTTP 401)";
      model.credentialValidation = { status: "PLAN_NOT_ENTITLED", httpStatus: status, errorCode: "MODEL_PROBE_PLAN_NOT_ENTITLED", retryable: false, checkedAt, ...identity };
    } else {
      model.unavailableReason = "凭证鉴权失败 (HTTP 401)";
      model.credentialValidation = { status: "AUTH_FAILED", httpStatus: status, errorCode: "MODEL_PROBE_AUTH_FAILED", retryable: false, checkedAt, ...identity };
    }
  } else if (status === 403) {
    model.unavailableReason = "当前套餐/凭证未开通此模型权限 (HTTP 403)";
    model.credentialValidation = { status: "PLAN_NOT_ENTITLED", httpStatus: status, errorCode: "MODEL_PROBE_PLAN_NOT_ENTITLED", retryable: false, checkedAt, ...identity };
  } else if (status === 400 || status === 404) {
    model.unavailableReason = status === 404
      ? "模型不存在或请求被上游拒绝 (HTTP 404)"
      : "探针请求形状被上游拒绝 (HTTP 400)";
    model.credentialValidation = { status: "REQUEST_REJECTED", httpStatus: status, errorCode: "MODEL_PROBE_REQUEST_REJECTED", retryable: false, checkedAt, ...identity };
  } else if (status === 429) {
    model.unavailableReason = "探针被上游限流 (HTTP 429)，可稍后重试";
    model.credentialValidation = { status: "RATE_LIMITED", httpStatus: status, errorCode: "MODEL_PROBE_RATE_LIMITED", retryable: true, checkedAt, ...identity };
  } else if (upstreamCode === "upstream_timeout" || status === 504) {
    model.unavailableReason = "探针超时，可重试";
    model.credentialValidation = { status: "UPSTREAM_UNAVAILABLE", httpStatus: status || null, errorCode: "MODEL_PROBE_UPSTREAM_UNAVAILABLE", retryable: true, checkedAt, ...identity };
  } else if (status === 0 || upstreamCode === "transport_error" || upstreamCode === "client_cancelled") {
    model.unavailableReason = "探针网络失败（DNS/TLS/连接），可重试";
    model.credentialValidation = { status: "NETWORK_FAILED", httpStatus: null, errorCode: "MODEL_PROBE_NETWORK_FAILED", retryable: true, checkedAt, ...identity };
  } else if (status >= 500) {
    model.unavailableReason = `上游暂不可用 (HTTP ${status})，可重试`;
    model.credentialValidation = { status: "UPSTREAM_UNAVAILABLE", httpStatus: status, errorCode: "MODEL_PROBE_UPSTREAM_UNAVAILABLE", retryable: true, checkedAt, ...identity };
  } else {
    // 未知状态：保留原 HTTP 状态与统一错误分类，不转成空列表，不判定可用。
    model.unavailableReason = `模型探针返回未分类状态 (HTTP ${status})`;
    model.credentialValidation = { status: "REQUEST_REJECTED", httpStatus: status, errorCode: "MODEL_PROBE_REQUEST_REJECTED", retryable: false, checkedAt, ...identity };
  }
}

/** 探针上限：模型较多时只探前 5 个典型模型确认接口与 Key 健康度。 */
export const MODEL_PROBE_LIMIT = 5;

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
  const identity = probeEndpointIdentity({ providerCode: code, mode, baseUrl, endpoints, env });
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
  const modelsToProbe = chatModels.length > MODEL_PROBE_LIMIT ? chatModels.slice(0, MODEL_PROBE_LIMIT) : chatModels;
  const probedIds = new Set(modelsToProbe.map((m) => m.id));
  for (const model of chatModels) {
    // F-P2-10：探针上限外的健康模型产出 NOT_RUN（合同已定义但代码从未产出），
    // 不再以 credentialValidation=null 落到前端"不可用"红字；EMBEDDING 等
    // 非对话模型维持 null（合同注释口径：未探针）。
    if (!probedIds.has(model.id)) {
      model.credentialValidation = {
        status: "NOT_RUN", httpStatus: null, errorCode: "MODEL_PROBE_NOT_RUN",
        retryable: true, checkedAt: new Date().toISOString(), ...identity,
      };
      continue;
    }
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
      mapProbeOutcome(model, { ...outcome, ...identity });
    } catch {
      // 探针执行异常（非 HTTP 失败）：网络失败，可重试；不再原谅为兼容。
      model.compatible = false;
      model.unavailableReason = "模型探针超时或连接失败，可重试";
      model.credentialValidation = {
        status: "NETWORK_FAILED", httpStatus: null, errorCode: "MODEL_PROBE_NETWORK_FAILED",
        retryable: true, checkedAt: new Date().toISOString(), ...identity,
      };
    }
  }
}
