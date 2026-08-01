/**
 * 真实 HTTP 上游调用器（DEP-PROVIDER-CREDENTIALS 解锁）。
 *
 * 替换 StubUpstream：用真实 fetch 调用上游厂商 API。
 * 当前实现 DeepSeek（OpenAI 兼容）；智谱/Kimi 后续按各自协议实现。
 *
 * 凭证：resource.secret.reveal() 取明文 API Key（SecretValue 保证不写日志/Trace）。
 * 安全：请求正文（messages）只在内存，不持久化（content_retention_mode=METADATA_ONLY）。
 *
 * 依据：TRD §7（Adapter 统一能力）、§7.1（DeepSeek API 模式）。
 */
import type { Outcome, Usage } from "@qianliu/contracts";
import type { AdapterResource, AdapterRequest, UpstreamCaller } from "@qianliu/provider-adapters";

function zeroUsage(): Usage {
  return { input: 0, output: 0, cache: 0, quality: "UNKNOWN" };
}

/**
 * 真实 DeepSeek HTTP 调用器。
 * DeepSeek API 兼容 OpenAI Chat Completions：POST https://api.deepseek.com/chat/completions
 */
export function createDeepSeekHttpCaller(): UpstreamCaller {
  return async (resource: AdapterResource, request: AdapterRequest, _attemptNo: number): Promise<Outcome> => {
    const apiKey = resource.secret.reveal();
    if (!apiKey) {
      return { status: 401, committed: false, usage: zeroUsage(), error: "missing_credential" };
    }

    // pipeline 传的 request.body 就是 messages 数组（非 {messages:[]} 对象）
    const messages = Array.isArray(request.body) ? request.body : [];
    const upstreamModel = resource.upstreamModel || "deepseek-chat";
    const payload = {
      model: upstreamModel,
      messages,
      stream: false,
    };

    let response: Response;
    try {
      response = await fetch("https://api.deepseek.com/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(payload),
        signal: request.abort,
      });
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") {
        return { status: 0, committed: false, usage: zeroUsage(), error: "client_cancelled" };
      }
      return { status: 0, committed: false, usage: zeroUsage(), error: "transport_error" };
    }

    // 非 2xx：归一化为错误 outcome（不 committed，可 failover）
    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      // 诊断：打印上游真实错误（只到 stdout 日志，不写库；正文零留存红线除外——这是错误响应非请求正文）
      console.error(`[deepseek-caller] upstream ${response.status}: ${errorText.slice(0, 500)}`);
      return {
        status: response.status,
        committed: false,
        usage: zeroUsage(),
        error: `upstream_${response.status}`.slice(0, 60),
      };
    }

    // 解析成功响应
    const data = (await response.json()) as {
      choices?: { message?: { content?: string }; finish_reason?: string }[];
      usage?: { prompt_tokens: number; completion_tokens: number; prompt_tokens_details?: { cached_tokens?: number } };
    };

    const rawUsage = data.usage;
    const cache = rawUsage?.prompt_tokens_details?.cached_tokens ?? 0;

    return {
      status: 200,
      committed: true,
      usage: {
        input: rawUsage?.prompt_tokens ?? 0,
        output: rawUsage?.completion_tokens ?? 0,
        cache,
        quality: "PROVIDER_REPORTED",
      },
      // 透传 DeepSeek 原始响应正文（内存态，pipeline 从中取 content；METADATA_ONLY 不持久化）
      responseBody: data,
    };
  };
}
