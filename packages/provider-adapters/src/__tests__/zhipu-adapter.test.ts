/**
 * W09 单元测试：ZhipuAdapter + StubUpstream(providerCode=zhipu) + committed 边界。
 *
 * 覆盖：
 *   - StubUpstream 以 providerCode=zhipu 复用全部 5 种响应模式（SUCCESS/STREAM/ERROR/TIMEOUT/CANCEL）
 *   - ZhipuAdapter 能力声明（含 coding_plan、不含 prompt_cache）
 *   - 模型映射（qianliu-glm-coding → glm-5.2）
 *   - usage 原始口径解析（无缓存分项时 cache=0）
 *   - 错误归一化（TRD §9 分类映射）
 *   - committed 边界（failAfterChunk → STREAM_INTERRUPTED_AFTER_COMMIT）
 *
 * 依据：TRD §7.2（智谱 Coding Plan）、§9（错误分类）、调研文档（GLM-5.2 当前 Coding Plan 模型）。
 */
import { describe, it, expect } from "vitest";
import {
  ZhipuAdapter,
  StubUpstream,
  SecretValue,
} from "../index.js";
import type { AdapterResource, AdapterRequest } from "../index.js";

function makeResource(): AdapterResource {
  return {
    providerCode: "zhipu",
    resourceId: "res-zhipu-1",
    mode: "CODING_PLAN",
    upstreamModel: "glm-5.2",
    concurrencyLimit: 100,
    secret: new SecretValue("zhipu-coding-token-test"),
  };
}

function makeRequest(stream = false): AdapterRequest {
  return {
    requestId: "req-zhipu-1",
    unifiedModel: "qianliu-glm-coding",
    stream,
    body: { messages: [{ role: "user", content: "hi" }] },
  };
}

describe("StubUpstream(providerCode=zhipu)", () => {
  it("SUCCESS 模式返回 committed=true + PROVIDER_REPORTED usage", async () => {
    const stub = new StubUpstream({
      default: { kind: "SUCCESS", usage: { input: 120, output: 60, cache: 0 } },
      providerCode: "zhipu",
    });
    const outcome = await stub.invoke(makeResource(), makeRequest(), 1);
    expect(outcome.status).toBe(200);
    expect(outcome.committed).toBe(true);
    expect(outcome.usage.quality).toBe("PROVIDER_REPORTED");
    expect(outcome.usage.input).toBe(120);
    expect(stub.providerCode).toBe("zhipu");
    expect(stub.calls).toHaveLength(1);
  });

  it("ERROR 模式返回 committed=false + 状态码", async () => {
    const stub = new StubUpstream({
      default: { kind: "ERROR", status: 429, errorCode: "rate_limited", classification: "UPSTREAM_RATE_LIMITED" },
      providerCode: "zhipu",
    });
    const outcome = await stub.invoke(makeResource(), makeRequest(), 1);
    expect(outcome.status).toBe(429);
    expect(outcome.committed).toBe(false);
    expect(outcome.error).toBe("rate_limited");
  });

  it("TIMEOUT 返回 status=0 committed=false transport_error", async () => {
    const stub = new StubUpstream({ default: { kind: "TIMEOUT" }, providerCode: "zhipu" });
    const outcome = await stub.invoke(makeResource(), makeRequest(), 1);
    expect(outcome.status).toBe(0);
    expect(outcome.committed).toBe(false);
    expect(outcome.error).toBe("transport_error");
  });

  it("STREAM + failAfterChunk 模拟 committed 后中断（WT-12 边界）", async () => {
    const stub = new StubUpstream({
      default: {
        kind: "STREAM",
        chunks: ["你好", " 智谱"],
        usage: { input: 12, output: 24, cache: 0 },
        failAfterChunk: 1,
      },
      providerCode: "zhipu",
    });
    const outcome = await stub.invoke(makeResource(), makeRequest(true), 1);
    expect(outcome.committed).toBe(true);
    expect(outcome.error).toBe("stream_interrupted_after_commit");
    expect(outcome.usage.quality).toBe("ESTIMATED");
  });

  it("byAttempt 配置不同 attempt 不同响应（双 Attempt failover 前置）", async () => {
    const stub = new StubUpstream({
      default: { kind: "SUCCESS", usage: { input: 50, output: 25, cache: 0 } },
      byAttempt: {
        1: { kind: "ERROR", status: 503, errorCode: "server_error", classification: "UPSTREAM_TEMPORARY" },
      },
      providerCode: "zhipu",
    });
    const o1 = await stub.invoke(makeResource(), makeRequest(), 1);
    const o2 = await stub.invoke(makeResource(), makeRequest(), 2);
    expect(o1.status).toBe(503);
    expect(o1.committed).toBe(false);
    expect(o2.status).toBe(200);
    expect(o2.committed).toBe(true);
  });

  it("未配 providerCode 时默认 deepseek（向后兼容）", async () => {
    const stub = new StubUpstream({
      default: { kind: "SUCCESS", usage: { input: 1, output: 1, cache: 0 } },
    });
    expect(stub.providerCode).toBe("deepseek");
  });
});

describe("ZhipuAdapter", () => {
  it("能力声明含 coding_plan 但不含 prompt_cache", () => {
    const adapter = new ZhipuAdapter(async () => ({
      status: 200,
      committed: true,
      usage: { input: 0, output: 0, cache: 0, quality: "PROVIDER_REPORTED" },
    }));
    expect(adapter.capabilities.has("chat")).toBe(true);
    expect(adapter.capabilities.has("coding_plan")).toBe(true);
    expect(adapter.capabilities.has("prompt_cache")).toBe(false);
    expect(adapter.providerCode).toBe("zhipu");
  });

  it("未知模型别名返回 model_not_mapped", async () => {
    const adapter = new ZhipuAdapter(async () => ({
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

  it("invoke 串联 StubUpstream 后 committed=true 且 usage 原样透传", async () => {
    const stub = new StubUpstream({
      default: { kind: "SUCCESS", usage: { input: 130, output: 45, cache: 0 } },
      providerCode: "zhipu",
    });
    const adapter = new ZhipuAdapter(async (res, req, n) => stub.invoke(res, req, n));
    const outcome = await adapter.invoke(makeResource(), makeRequest(), 1);
    expect(outcome.status).toBe(200);
    expect(outcome.committed).toBe(true);
    expect(outcome.usage.input).toBe(130);
    expect(outcome.usage.output).toBe(45);
    expect(outcome.usage.cache).toBe(0);
  });

  it("usage 原始口径解析（无缓存分项，cache=0）", () => {
    const adapter = new ZhipuAdapter(async () => ({
      status: 200,
      committed: true,
      usage: { input: 0, output: 0, cache: 0, quality: "PROVIDER_REPORTED" },
    }));
    const usage = adapter.parseUsage({
      prompt_tokens: 800,
      completion_tokens: 200,
      total_tokens: 1000,
    });
    expect(usage.input).toBe(800);
    expect(usage.output).toBe(200);
    expect(usage.cache).toBe(0); // 智谱 Coding Plan 当前无缓存命中分项
    expect(usage.quality).toBe("PROVIDER_REPORTED");
  });

  it("错误归一化映射（TRD §9 分类）", () => {
    const adapter = new ZhipuAdapter(async () => ({
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
