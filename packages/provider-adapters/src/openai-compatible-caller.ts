import { hasImageInput, modelSupportsImages, preservesImageInputs, MODEL_IMAGE_UNSUPPORTED, IMAGE_INPUT_UNSUPPORTED } from "./model-image-capability.js";
import { createHash } from "node:crypto";
/**
 * OpenAI-compatible Provider HTTP caller.
 *
 * DeepSeek、智谱 Coding Plan、Kimi Coding Plan 均从 Chat Completions 兼容入口调用。
 * 北向 Responses 的正文只在内存中转换，不进入日志或账本：
 * Responses input/tools/function_call_output -> Chat messages/tools/tool_calls；
 * Chat assistant content/tool_calls -> Responses output items。
 */
import { decryptCredential, type EncryptedCredential } from "./crypto.js";
import { SecretValue } from "./secret-value.js";
import {
  type AdapterResource,
  type UpstreamCaller,
} from "./index.js";
import type { HttpResponseLike, OpenAiCompatibleCallerOptions } from "./openai-compatible-types.js";
import { resolveFirstByteTimeoutMs, resolveStreamIdleTimeoutMs } from "./resource-timeout-policy.js";
import { buildRequestShapeSummary } from "./upstream-error-evidence.js";
import { upstreamFailure } from "./upstream-failure.js";
import { toChatCompletionsRequest } from "./openai-compatible-request.js";
import { failedOutcome, parseJsonResponse, parseStreamingResponse } from "./openai-compatible-response.js";
import { chatCompletionsUrl, createLayeredTimeout, defaultFetch } from "./openai-compatible-timeout.js";
import { resolveProviderEndpoint } from "./endpoint-policy.js";
import { canonicalProviderCode } from "./provider-code.js";

export { toChatCompletionsRequest } from "./openai-compatible-request.js";
export { chatAssistantToResponsesOutput } from "./openai-compatible-conversion.js";
export { responsesToChatCompletions } from "./openai-compatible-request.js";

export type { HttpFetch, HttpResponseLike, OpenAiCompatibleCallerOptions } from "./openai-compatible-types.js";

type ProviderCode = AdapterResource["providerCode"];

/** Shared endpoint selection for business calls and credential probes. */
export function providerChatBaseUrl(provider: ProviderCode, env: NodeJS.ProcessEnv = process.env): string {
  const p = String(provider).toLowerCase();
  const envKey = BASE_URL_ENV[p];
  return (envKey ? env[envKey] : undefined) ?? DEFAULT_BASE_URL[p] ?? env[`${String(provider).toUpperCase().replace(/[^A-Z0-9]/g, "_")}_BASE_URL`] ?? "";
}

export function providerChatConfigHash(provider: ProviderCode, mode: string, model: string,
  env: NodeJS.ProcessEnv = process.env): string {
  return createHash("sha256").update(JSON.stringify({ provider, mode, model,
    baseUrl: providerChatBaseUrl(provider, env), protocol: "chat", version: 1 })).digest("hex");
}

const BASE_URL_ENV: Record<string, string> = {
  deepseek: "DEEPSEEK_BASE_URL",
  zhipu: "ZHIPU_CODING_BASE_URL",
  kimi: "KIMI_CODING_BASE_URL",
  qwen: "QWEN_BASE_URL",
  minimax: "MINIMAX_BASE_URL",
  openai: "OPENAI_BASE_URL",
  siliconflow: "SILICONFLOW_BASE_URL",
};

const SECRET_ENV: Record<string, string> = {
  deepseek: "DEEPSEEK_API_KEY",
  zhipu: "ZHIPU_CODING_TOKEN",
  kimi: "KIMI_CODING_TOKEN",
  qwen: "DASHSCOPE_API_KEY",
  minimax: "MINIMAX_API_KEY",
  openai: "OPENAI_API_KEY",
  siliconflow: "SILICONFLOW_API_KEY",
};

const DEFAULT_BASE_URL: Record<string, string> = {
  deepseek: "https://api.deepseek.com",
  zhipu: "https://open.bigmodel.cn/api/coding/paas/v4",
  kimi: "https://api.kimi.com/coding/v1",
  qwen: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  minimax: "https://api.minimax.chat/v1",
  openai: "https://api.openai.com/v1",
  siliconflow: "https://api.siliconflow.cn/v1",
};

/**
 * 创建真实 HTTP caller。未配置凭证或厂商 Base URL 时明确失败，不返回模拟内容。
 */
export function createOpenAiCompatibleCaller(
  options: OpenAiCompatibleCallerOptions = {},
): UpstreamCaller {
  const { env = process.env, fetch: fetchImpl = defaultFetch } = options;
  const requestTimeoutMs = options.requestTimeoutMs ?? 10 * 60_000;
  const firstByteTimeoutMs = options.firstByteTimeoutMs ?? 30_000;
  const streamIdleTimeoutMs = options.streamIdleTimeoutMs ?? 45_000;

  return async (resource, request) => {
    if (!resource.secret.isConfigured()) {
      return failedOutcome(401, "upstream_credential_missing");
    }

    // WP02：进入请求转换/错误映射/镜像能力分支前统一规范化 providerCode，
    // 生产 code=Kimi 与预置 code=kimi 走同一策略。
    resource = { ...resource, providerCode: canonicalProviderCode(resource.providerCode) };

    // WP01/RC-0：模式化端点解析。业务调用、权限探针、真实验证、凭证恢复
    // 共用 resolveProviderEndpoint，历史无 scope 的 Moonshot base_url
    // 不再覆盖 Kimi Coding Plan 端点。
    const endpoint = resolveProviderEndpoint({
      providerCode: resource.providerCode,
      resourceMode: resource.mode,
      operation: "CHAT_COMPLETIONS",
      configuredEndpoints: { base_url: resource.baseUrl },
      env,
    });
    if (!endpoint.ok) {
      return failedOutcome(500, "upstream_endpoint_ambiguous");
    }
    const baseUrl = endpoint.url;
    if (!baseUrl) {
      return failedOutcome(500, "upstream_base_url_missing");
    }

    if (hasImageInput(request.body) && modelSupportsImages(resource.providerCode, resource.upstreamModel) === false) {
      return failedOutcome(400, MODEL_IMAGE_UNSUPPORTED);
    }
    const chatBody = toChatCompletionsRequest(resource, request);
    if (!preservesImageInputs(request.body, chatBody)) return failedOutcome(400, IMAGE_INPUT_UNSUPPORTED);
    const timeout = createLayeredTimeout({
      requestAbort: request.abort,
      requestTimeoutMs,
      firstByteTimeoutMs: resolveFirstByteTimeoutMs(resource, firstByteTimeoutMs, options.firstByteTimeoutMsForResource),
      streamIdleTimeoutMs: resolveStreamIdleTimeoutMs(resource, streamIdleTimeoutMs, options.streamIdleTimeoutMsForResource),
    });

    let response: HttpResponseLike;
    try {
      response = await fetchImpl(chatCompletionsUrl(baseUrl), {
        method: "POST",
        headers: {
          authorization: `Bearer ${resource.secret.reveal()}`,
          "content-type": "application/json",
          accept: request.stream ? "text/event-stream" : "application/json",
          "x-request-id": request.requestId,
        },
        body: JSON.stringify(chatBody),
        signal: timeout.signal,
      });
    } catch {
      const cancelled = request.abort?.aborted === true;
      const failure = timeout.failure(cancelled);
      timeout.dispose();
      return {
        ...failedOutcome(failure.status, failure.code),
        failureLayer: failure.layer,
        cancelled,
      };
    }

    if (!response.ok) {
      timeout.markFirstByte();
      const requestShapeSummary = new Set([400, 401, 403]).has(response.status)
        ? buildRequestShapeSummary(chatBody)
        : null;
      const failure = await upstreamFailure(
        response,
        resource.providerCode,
        requestShapeSummary,
      );
      timeout.dispose();
      return {
        ...failedOutcome(response.status, failure.code),
        upstreamConfigHash: providerChatConfigHash(resource.providerCode, resource.mode, resource.upstreamModel, env),
        upstreamErrorKind: failure.kind,
        upstreamCode: failure.code,
        ...(failure.evidence && requestShapeSummary ? {
          upstreamErrorEvidence: failure.evidence,
          requestShapeSummary,
        } : {}),
        unifiedAvailabilitySignal: failure.signal,
        firstByteAt: timeout.firstByteAt,
        failureLayer: "UPSTREAM_HTTP",
        ...(failure.recoverAt === undefined ? {} : { recoverAt: failure.recoverAt }),
        ...(failure.retryAfterMs === undefined
          ? {}
          : { retryAfterMs: failure.retryAfterMs }),
      };
    }

    if (request.stream) {
      return parseStreamingResponse(response, request, timeout);
    }
    timeout.markFirstByte();
    const outcome = await parseJsonResponse(response, request, timeout);
    timeout.dispose();
    return outcome;
  };
}

/**
 * 从资源密文读取凭证；历史环境变量仅作为“资源尚未录入密文”的兼容回退。
 * 密文存在但损坏时不会回退到环境变量，避免掩盖错误资源配置。
 */
export function resolveProviderSecret(input: {
  providerCode: ProviderCode;
  credentialCiphertext: string | Partial<EncryptedCredential> | null;
  credentialKek: Buffer;
  env?: NodeJS.ProcessEnv;
}): SecretValue {
  if (input.credentialCiphertext) {
    try {
      // PostgreSQL jsonb 驱动通常返回对象；部分旧夹具/仓储类型仍声明为字符串。
      const parsed = typeof input.credentialCiphertext === "string"
        ? JSON.parse(input.credentialCiphertext) as Partial<EncryptedCredential>
        : input.credentialCiphertext;
      if (
        typeof parsed.ciphertext !== "string"
        || typeof parsed.nonce !== "string"
        || typeof parsed.tag !== "string"
      ) {
        return new SecretValue("");
      }
      return new SecretValue(decryptCredential(parsed as EncryptedCredential, input.credentialKek));
    } catch {
      return new SecretValue("");
    }
  }

  const env = input.env ?? process.env;
  const p = String(input.providerCode).toLowerCase();
  const secretKey = SECRET_ENV[p];
  return new SecretValue((secretKey ? env[secretKey] : undefined) ?? env[`${String(input.providerCode).toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`] ?? "");
}

/** Responses / Chat / Messages 北向载荷统一转换为上游 Chat Completions。 */
