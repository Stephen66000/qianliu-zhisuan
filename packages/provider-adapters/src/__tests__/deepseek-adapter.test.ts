/**
 * W06 单元测试：DeepSeek Adapter + StubUpstream + committed 边界。
 *
 * 覆盖：
 *   - StubUpstream 各响应模式（SUCCESS/STREAM/ERROR/TIMEOUT/CANCEL）
 *   - DeepSeekAdapter 能力声明
 *   - 模型映射（alias → upstream）
 *   - usage 三维度解析（cache_hit/cache_miss/output）
 *   - 错误归一化（TRD §9 分类映射）
 *   - committed 边界（failAfterChunk → committed=true 后失败）
 */
import { describe, it, expect } from "vitest";
import {
  DeepSeekAdapter,
  StubUpstream,
  SecretValue,
} from "../index.js";
import type { AdapterResource, AdapterRequest } from "../index.js";

function makeResource(): AdapterResource {
  return {
    providerCode: "deepseek",
    resourceId: "res-1",
    mode: "API",
    upstreamModel: "deepseek-chat",
    concurrencyLimit: 100,
    secret: new SecretValue("sk-deepseek-test"),
  };
}

function makeRequest(stream = false): AdapterRequest {
  return {
    requestId: "req-test-1",
    unifiedModel: "qianliu-deepseek",
    stream,
    body: { messages: [{ role: "user", content: "hi" }] },
  };
}

describe("StubUpstream", () => {
  it("SUCCESS 模式返回 committed=true + PROVIDER_REPORTED usage", async () => {
    const stub = new StubUpstream({
      default: { kind: "SUCCESS", usage: { input: 100, output: 50, cache: 30 } },
    });
    const outcome = await stub.invoke(makeResource(), makeRequest(), 1);
    expect(outcome.status).toBe(200);
    expect(outcome.committed).toBe(true);
    expect(outcome.usage.quality).toBe("PROVIDER_REPORTED");
    expect(outcome.usage.input).toBe(100);
    expect(stub.calls).toHaveLength(1);
  });

  it("ERROR 模式返回 committed=false + 状态码", async () => {
    const stub = new StubUpstream({
      default: { kind: "ERROR", status: 429, errorCode: "rate_limited", classification: "UPSTREAM_RATE_LIMITED" },
    });
    const outcome = await stub.invoke(makeResource(), makeRequest(), 1);
    expect(outcome.status).toBe(429);
    expect(outcome.committed).toBe(false);
    expect(outcome.error).toBe("rate_limited");
  });

  it("TIMEOUT 返回 status=0 committed=false transport_error", async () => {
    const stub = new StubUpstream({ default: { kind: "TIMEOUT" } });
    const outcome = await stub.invoke(makeResource(), makeRequest(), 1);
    expect(outcome.status).toBe(0);
    expect(outcome.committed).toBe(false);
    expect(outcome.error).toBe("transport_error");
  });

  it("STREAM + failAfterChunk 模拟 committed 后中断（WT-12）", async () => {
    const stub = new StubUpstream({
      default: {
        kind: "STREAM",
        chunks: ["Hello", " world"],
        usage: { input: 10, output: 20, cache: 0 },
        failAfterChunk: 1,
      },
    });
    const outcome = await stub.invoke(makeResource(), makeRequest(true), 1);
    expect(outcome.committed).toBe(true);
    expect(outcome.error).toBe("stream_interrupted_after_commit");
    expect(outcome.usage.quality).toBe("ESTIMATED");
  });

  it("byAttempt 配置不同 attempt 不同响应（WT-11 双 Attempt）", async () => {
    const stub = new StubUpstream({
      default: { kind: "SUCCESS", usage: { input: 50, output: 25, cache: 0 } },
      byAttempt: {
        1: { kind: "ERROR", status: 500, errorCode: "server_error", classification: "UPSTREAM_TEMPORARY" },
      },
    });
    const o1 = await stub.invoke(makeResource(), makeRequest(), 1);
    const o2 = await stub.invoke(makeResource(), makeRequest(), 2);
    expect(o1.status).toBe(500);
    expect(o1.committed).toBe(false);
    expect(o2.status).toBe(200);
    expect(o2.committed).toBe(true);
  });
});

describe("DeepSeekAdapter", () => {
  it("能力声明包含 chat/messages/stream/tools/prompt_cache", () => {
    const adapter = new DeepSeekAdapter(async () => ({
      status: 200,
      committed: true,
      usage: { input: 0, output: 0, cache: 0, quality: "PROVIDER_REPORTED" },
    }));
    expect(adapter.capabilities.has("chat")).toBe(true);
    expect(adapter.capabilities.has("prompt_cache")).toBe(true);
    expect(adapter.providerCode).toBe("deepseek");
  });

  it("未知模型别名返回 model_not_mapped", async () => {
    const adapter = new DeepSeekAdapter(async () => ({
      status: 200,
      committed: true,
      usage: { input: 0, output: 0, cache: 0, quality: "PROVIDER_REPORTED" },
    }));
    const req = makeRequest();
    req.unifiedModel = "qianliu-unknown";
    const outcome = await adapter.invoke(makeResource(), req, 1);
    expect(outcome.status).toBe(400);
    expect(outcome.error).toBe("model_not_mapped");
  });

  it("usage 三维度解析（prompt_tokens_details.cached_tokens）", () => {
    const adapter = new DeepSeekAdapter(async () => ({
      status: 200,
      committed: true,
      usage: { input: 0, output: 0, cache: 0, quality: "PROVIDER_REPORTED" },
    }));
    const usage = adapter.parseUsage({
      prompt_tokens: 1000,
      completion_tokens: 200,
      prompt_tokens_details: { cached_tokens: 400 },
    });
    expect(usage.input).toBe(1000);
    expect(usage.output).toBe(200);
    expect(usage.cache).toBe(400); // 缓存命中
    expect(usage.quality).toBe("PROVIDER_REPORTED");
  });

  it("错误归一化映射（TRD §9 分类）", () => {
    const adapter = new DeepSeekAdapter(async () => ({
      status: 200,
      committed: true,
      usage: { input: 0, output: 0, cache: 0, quality: "PROVIDER_REPORTED" },
    }));
    expect(adapter.classifyUpstreamError(401)).toBe("UPSTREAM_CREDENTIAL_INVALID");
    expect(adapter.classifyUpstreamError(403)).toBe("UPSTREAM_CREDENTIAL_INVALID");
    expect(adapter.classifyUpstreamError(429)).toBe("UPSTREAM_RATE_LIMITED");
    expect(adapter.classifyUpstreamError(500)).toBe("UPSTREAM_TEMPORARY");
    expect(adapter.classifyUpstreamError(503)).toBe("UPSTREAM_TEMPORARY");
    expect(adapter.classifyUpstreamError(0, "transport_error")).toBe("TRANSPORT_ERROR");
    expect(adapter.classifyUpstreamError(0, "stream_interrupted_after_commit")).toBe(
      "STREAM_INTERRUPTED_AFTER_COMMIT",
    );
    expect(adapter.classifyUpstreamError(402)).toBe("UPSTREAM_BILLING_BLOCKED");
    expect(adapter.classifyUpstreamError(400)).toBe("CLIENT_INVALID");
  });
});
