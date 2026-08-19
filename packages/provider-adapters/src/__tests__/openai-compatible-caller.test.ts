import { describe, expect, it, vi } from "vitest";
import {
  createOpenAiCompatibleCaller,
  encryptCredential,
  resolveProviderSecret,
  responsesToChatCompletions,
  SecretValue,
  toChatCompletionsRequest,
  type AdapterRequest,
  type AdapterResource,
  type HttpFetch,
  type HttpResponseLike,
} from "../index.js";

function resource(overrides: Partial<AdapterResource> = {}): AdapterResource {
  return {
    providerCode: "deepseek",
    resourceId: "res-real-1",
    mode: "API",
    upstreamModel: "deepseek-chat",
    concurrencyLimit: 10,
    secret: new SecretValue("sk-real-test"),
    ...overrides,
  };
}

function responsesRequest(stream = false): AdapterRequest {
  return {
    requestId: "req-responses-1",
    unifiedModel: "qianliu-deepseek",
    capability: "responses",
    stream,
    body: {
      model: "qianliu-deepseek",
      instructions: "只使用给定工具",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "读取状态" }],
        },
        {
          type: "function_call",
          call_id: "call_previous",
          name: "exec_command",
          arguments: "{\"cmd\":\"pwd\"}",
        },
        {
          type: "function_call_output",
          call_id: "call_previous",
          output: "/tmp/project",
        },
      ],
      tools: [{
        type: "function",
        name: "exec_command",
        description: "执行命令",
        parameters: {
          type: "object",
          properties: { cmd: { type: "string" } },
          required: ["cmd"],
        },
        strict: true,
      }],
      tool_choice: { type: "function", name: "exec_command" },
      parallel_tool_calls: false,
      max_output_tokens: 512,
      reasoning: { effort: "high" },
    },
  };
}

describe("Responses → Chat Completions", () => {
  it("保留 instructions、消息、工具调用、工具结果及推理参数", () => {
    const request = responsesRequest();
    const body = responsesToChatCompletions(
      request.body as never,
      "deepseek-chat",
      false,
    );

    expect(body.model).toBe("deepseek-chat");
    expect(body.messages).toEqual([
      { role: "system", content: "只使用给定工具" },
      {
        role: "user",
        content: [{ type: "text", text: "读取状态" }],
      },
      {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "call_previous",
          type: "function",
          function: {
            name: "exec_command",
            arguments: "{\"cmd\":\"pwd\"}",
          },
        }],
      },
      {
        role: "tool",
        tool_call_id: "call_previous",
        content: "/tmp/project",
      },
    ]);
    expect(body.tools).toEqual([{
      type: "function",
      function: {
        name: "exec_command",
        description: "执行命令",
        parameters: {
          type: "object",
          properties: { cmd: { type: "string" } },
          required: ["cmd"],
        },
        strict: true,
      },
    }]);
    expect(body.tool_choice).toEqual({
      type: "function",
      function: { name: "exec_command" },
    });
    expect(body.parallel_tool_calls).toBe(false);
    expect(body.max_tokens).toBe(512);
    expect(body.reasoning_effort).toBe("high");
  });

  it("Codex 的 namespace 与托管 web_search 不得伪装成空名称 Chat 工具", () => {
    const request = responsesRequest();
    const responsesBody = request.body as Record<string, unknown>;
    responsesBody.tools = [
      ...(responsesBody.tools as unknown[]),
      {
        type: "namespace",
        name: "mcp__github",
        description: "GitHub tools",
        tools: [{ name: "search", parameters: { type: "object" } }],
      },
      { type: "web_search", external_web_access: true },
      { type: "function", name: "", parameters: { type: "object" } },
    ];

    const body = responsesToChatCompletions(
      request.body as never,
      "deepseek-chat",
      true,
    );

    expect(body.tools).toHaveLength(1);
    expect(body.tools).toEqual([{
      type: "function",
      function: {
        name: "exec_command",
        description: "执行命令",
        parameters: {
          type: "object",
          properties: { cmd: { type: "string" } },
          required: ["cmd"],
        },
        strict: true,
      },
    }]);
  });

  it("Anthropic messages 的 system 只注入一次并保留工具定义", () => {
    const body = toChatCompletionsRequest(resource(), {
      requestId: "req-messages",
      unifiedModel: "qianliu-deepseek",
      capability: "messages",
      stream: false,
      body: {
        system: "唯一系统指令",
        messages: [{ role: "user", content: "hello" }],
        tools: [{
          name: "lookup",
          description: "查询",
          input_schema: { type: "object", properties: {} },
        }],
      },
    });

    expect(body.messages.filter((message) => message.role === "system")).toEqual([
      { role: "system", content: "唯一系统指令" },
    ]);
    expect(body.tools).toEqual([{
      type: "function",
      function: {
        name: "lookup",
        description: "查询",
        parameters: { type: "object", properties: {} },
      },
    }]);
  });

  it("Claude Web Search 第二轮完整转换 tool_use、tool_result 与 tool_choice", () => {
    const body = toChatCompletionsRequest(resource({ providerCode: "kimi" }), {
      requestId: "req-claude-web-search-round-2",
      unifiedModel: "Kimi",
      capability: "messages",
      stream: false,
      body: {
        system: [{ type: "text", text: "回答前先搜索最新资料" }],
        messages: [
          { role: "user", content: [{ type: "text", text: "查一下最新定价" }] },
          {
            role: "assistant",
            content: [
              { type: "text", text: "我先搜索。" },
              {
                type: "tool_use",
                id: "toolu_web_1",
                name: "web_search",
                input: { query: "OpenAI API pricing" },
              },
            ],
          },
          {
            role: "user",
            content: [{
              type: "tool_result",
              tool_use_id: "toolu_web_1",
              content: [{ type: "text", text: "搜索结果：官方定价页" }],
            }],
          },
        ],
        tools: [{
          name: "web_search",
          description: "搜索网页",
          input_schema: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
          },
        }],
        tool_choice: { type: "tool", name: "web_search" },
      },
    });

    expect(body.messages).toEqual([
      { role: "system", content: "回答前先搜索最新资料" },
      { role: "user", content: "查一下最新定价" },
      {
        role: "assistant",
        content: "我先搜索。",
        tool_calls: [{
          id: "toolu_web_1",
          type: "function",
          function: {
            name: "web_search",
            arguments: "{\"query\":\"OpenAI API pricing\"}",
          },
        }],
      },
      {
        role: "tool",
        tool_call_id: "toolu_web_1",
        content: "搜索结果：官方定价页",
      },
    ]);
    expect(body.tool_choice).toEqual({
      type: "function",
      function: { name: "web_search" },
    });
  });

  it("Claude MCP 第二轮保留并行调用 ID 与对应结果", () => {
    const body = toChatCompletionsRequest(resource({ providerCode: "kimi" }), {
      requestId: "req-claude-mcp-round-2",
      unifiedModel: "Kimi",
      capability: "messages",
      stream: false,
      body: {
        messages: [
          { role: "user", content: "检查仓库" },
          {
            role: "assistant",
            content: [
              { type: "tool_use", id: "toolu_status", name: "mcp_git_status", input: {} },
              { type: "tool_use", id: "toolu_diff", name: "mcp_git_diff", input: { stat: true } },
            ],
          },
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "toolu_status", content: "clean" },
              {
                type: "tool_result",
                tool_use_id: "toolu_diff",
                content: [{ type: "text", text: "2 files changed" }],
              },
            ],
          },
        ],
        tools: [],
        tool_choice: { type: "any" },
      },
    });

    expect(body.messages).toEqual([
      { role: "user", content: "检查仓库" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "toolu_status",
            type: "function",
            function: { name: "mcp_git_status", arguments: "{}" },
          },
          {
            id: "toolu_diff",
            type: "function",
            function: { name: "mcp_git_diff", arguments: "{\"stat\":true}" },
          },
        ],
      },
      { role: "tool", tool_call_id: "toolu_status", content: "clean" },
      { role: "tool", tool_call_id: "toolu_diff", content: "2 files changed" },
    ]);
    expect(body.tool_choice).toBe("required");
  });
});

describe("OpenAI-compatible HTTP caller", () => {
  it("非流式真实 HTTP 载荷使用资源模型和凭证，并把 tool_calls/usage 转回 Responses", async () => {
    let capturedUrl = "";
    let capturedHeaders: Record<string, string> = {};
    let capturedBody: Record<string, unknown> = {};
    const fetch: HttpFetch = async (url, init) => {
      capturedUrl = url;
      capturedHeaders = init.headers;
      capturedBody = JSON.parse(init.body) as Record<string, unknown>;
      return jsonResponse({
        id: "chatcmpl-upstream",
        choices: [{
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: "call_real_1",
              type: "function",
              function: {
                name: "exec_command",
                arguments: "{\"cmd\":\"date\"}",
              },
            }],
          },
          finish_reason: "tool_calls",
        }],
        usage: {
          prompt_tokens: 120,
          completion_tokens: 24,
          cached_tokens: 40,
          prompt_tokens_details: { cached_tokens: 20 },
          completion_tokens_details: { reasoning_tokens: 8 },
        },
      });
    };
    const caller = createOpenAiCompatibleCaller({
      fetch,
      env: { DEEPSEEK_BASE_URL: "https://deepseek.example/v1/" },
    });

    const outcome = await caller(resource(), responsesRequest(), 1);

    expect(capturedUrl).toBe("https://deepseek.example/v1/chat/completions");
    expect(capturedHeaders.authorization).toBe("Bearer sk-real-test");
    expect(capturedBody.model).toBe("deepseek-chat");
    expect(Array.isArray(capturedBody.messages)).toBe(true);
    expect(outcome).toMatchObject({
      status: 200,
      committed: true,
      usage: {
        input: 120,
        output: 24,
        cache: 20,
        reasoning: 8,
        quality: "PROVIDER_REPORTED",
      },
    });
    expect(outcome.responseOutput).toEqual([{
      id: "fc_req-responses-1_0",
      type: "function_call",
      status: "completed",
      call_id: "call_real_1",
      name: "exec_command",
      arguments: "{\"cmd\":\"date\"}",
    }]);
  });

  it("POOL20-045：Kimi 顶层 cached_tokens 进入缓存分项且不重复加入真实 Token", async () => {
    const caller = createOpenAiCompatibleCaller({
      fetch: async () => jsonResponse({
        choices: [{ message: { role: "assistant", content: "ok" } }],
        usage: { prompt_tokens: 120, completion_tokens: 24, cached_tokens: 40 },
      }),
      env: { KIMI_CODING_BASE_URL: "https://kimi.example" },
    });
    const outcome = await caller(
      resource({ providerCode: "kimi", secret: new SecretValue("kimi-test") }),
      responsesRequest(),
      1,
    );
    expect(outcome.usage).toMatchObject({
      input: 120, output: 24, cache: 40, reasoning: 0, quality: "MIXED",
    });
    expect(outcome.usage.input + outcome.usage.output).toBe(144);
  });

  it("非流式 HTTP 200 缺少 message 或有效 Usage 时拒绝伪成功", async () => {
    for (const payload of [
      { choices: [{ message: { content: "没有计量" } }] },
      { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } },
      { choices: [{ message: { content: "空计量对象" } }], usage: {} },
      {
        choices: [{ message: { content: "无效计量字段" } }],
        usage: { prompt_tokens: "1", completion_tokens: null },
      },
      {
        choices: [{ message: { content: "非法缓存计量" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, cached_tokens: -1 },
      },
      {
        choices: [{ message: { content: "非法推理计量" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, reasoning_tokens: 1.5 },
      },
    ]) {
      const caller = createOpenAiCompatibleCaller({
        fetch: async () => jsonResponse(payload),
        env: { DEEPSEEK_BASE_URL: "https://deepseek.example" },
      });
      const outcome = await caller(resource(), responsesRequest(), 1);
      expect(outcome).toMatchObject({
        status: 0,
        committed: false,
        error: "upstream_invalid_response",
      });
      expect(outcome.responseOutput).toBeUndefined();
    }
  });

  it.each([
    ["The engine is overloaded. Please retry later.", "ENGINE_OVERLOADED"],
    ["Too many concurrent requests for this account.", "CONCURRENCY_LIMITED"],
    ["The 5-hour rolling window quota has been exhausted.", "WINDOW_EXHAUSTED"],
    ["Monthly quota exhausted.", "QUOTA_EXHAUSTED"],
  ] as const)("429 保留厂商限流语义：%s", async (message, kind) => {
    const caller = createOpenAiCompatibleCaller({
      fetch: async () => jsonResponse(
        { error: { code: "rate_limit_exceeded", message } },
        429,
        { "retry-after": "1.5" },
      ),
      env: { DEEPSEEK_BASE_URL: "https://deepseek.example" },
    });

    const outcome = await caller(resource(), responsesRequest(), 1);

    expect(outcome).toMatchObject({
      status: 429,
      committed: false,
      error: "rate_limit_exceeded",
      upstreamErrorKind: kind,
      retryAfterMs: 1_500,
    });
  });

  it.each([
    ["1211", "CONFIGURATION_ERROR"],
    ["1308", "QUOTA_EXHAUSTED"],
    ["1310", "QUOTA_EXHAUSTED"],
    ["1309", "PLAN_EXPIRED"],
    ["1311", "MODEL_UNAUTHORIZED"],
    ["1305", "TECHNICAL_FAILURE"],
  ] as const)("智谱业务码 %s 映射为统一信号 %s", async (code, signal) => {
    const caller = createOpenAiCompatibleCaller({
      fetch: async () => jsonResponse(
        { error: { code, message: "sanitized", resetTime: "2026-08-03T03:00:00Z" } },
        429,
      ),
      env: { ZHIPU_CODING_BASE_URL: "https://zhipu.example" },
    });
    const outcome = await caller(resource({ providerCode: "zhipu" }), responsesRequest(), 1);
    expect(outcome).toMatchObject({ upstreamCode: code, unifiedAvailabilitySignal: signal });
    expect(outcome.recoverAt).toBe("2026-08-03T03:00:00.000Z");
  });

  it("Kimi 只按已验证的通用字段映射，不猜测业务码", async () => {
    const caller = createOpenAiCompatibleCaller({
      fetch: async () => jsonResponse(
        { error: { code: "rate_limit_exceeded", message: "monthly quota exhausted", next_flush_time: "2026-08-04T00:00:00Z" } },
        429,
      ),
      env: { KIMI_CODING_BASE_URL: "https://kimi.example" },
    });
    const outcome = await caller(resource({ providerCode: "kimi" }), responsesRequest(), 1);
    expect(outcome).toMatchObject({
      upstreamCode: "rate_limit_exceeded",
      upstreamErrorKind: "QUOTA_EXHAUSTED",
      unifiedAvailabilitySignal: "QUOTA_EXHAUSTED",
      recoverAt: "2026-08-04T00:00:00.000Z",
    });
  });

  it("Kimi 403 套餐额度耗尽不得误判为凭证失效", async () => {
    const caller = createOpenAiCompatibleCaller({
      fetch: async () => jsonResponse({
        error: {
          type: "permission_error",
          message: "Your Kimi Code membership quota has been exhausted.",
        },
      }, 403),
      env: { KIMI_CODING_BASE_URL: "https://kimi.example" },
    });

    const outcome = await caller(
      resource({ providerCode: "kimi", secret: new SecretValue("kimi-test") }),
      responsesRequest(),
      1,
    );

    expect(outcome).toMatchObject({
      status: 403,
      upstreamErrorKind: "QUOTA_EXHAUSTED",
    });
  });

  it("流式聚合文本、分片工具参数和最终 Usage，供 Gateway 输出 Responses SSE", async () => {
    const events = [
      "data: {\"choices\":[{\"delta\":{\"content\":\"真实\"}}]}\n\n",
      "data: {\"choices\":[{\"delta\":{\"content\":\"响应\"}}]}\n\n",
      "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_stream\",\"function\":{\"name\":\"exec_\",\"arguments\":\"{\\\"cmd\\\":\"}}]}}]}\n\n",
      "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"name\":\"command\",\"arguments\":\"\\\"pwd\\\"}\"}}]}}]}\n\n",
      "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":30,\"completion_tokens\":12,\"prompt_cache_hit_tokens\":5,\"completion_tokens_details\":{\"reasoning_tokens\":3}}}\n\n",
      "data: [DONE]\n\n",
    ];
    const fetch: HttpFetch = async () => streamResponse(events);
    const caller = createOpenAiCompatibleCaller({
      fetch,
      env: { DEEPSEEK_BASE_URL: "https://deepseek.example" },
    });

    const outcome = await caller(resource(), responsesRequest(true), 1);

    expect(outcome.committed).toBe(true);
    expect(outcome.usage).toMatchObject({
      input: 30,
      output: 12,
      cache: 5,
      reasoning: 3,
    });
    expect(outcome.responseOutput).toEqual([
      {
        id: "msg_req-responses-1",
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{
          type: "output_text",
          text: "真实响应",
          annotations: [],
          logprobs: [],
        }],
      },
      {
        id: "fc_req-responses-1_0",
        type: "function_call",
        status: "completed",
        call_id: "call_stream",
        name: "exec_command",
        arguments: "{\"cmd\":\"pwd\"}",
      },
    ]);
  });

  it("收到上游 SSE 事件即回调，不等待完整响应", async () => {
    let releaseRest!: () => void;
    const rest = new Promise<void>((resolve) => { releaseRest = resolve; });
    let firstForwarded!: () => void;
    const firstEvent = new Promise<void>((resolve) => { firstForwarded = resolve; });
    const observed: Record<string, unknown>[] = [];
    const request = responsesRequest(true);
    request.onStreamChunk = (payload) => {
      observed.push(payload);
      if (observed.length === 1) firstForwarded();
    };
    const caller = createOpenAiCompatibleCaller({
      fetch: async () => delayedStreamResponse(rest),
      env: { DEEPSEEK_BASE_URL: "https://deepseek.example" },
    });

    let settled = false;
    const pending = caller(resource(), request, 1).finally(() => { settled = true; });
    await firstEvent;

    expect(settled).toBe(false);
    expect(observed[0]).toMatchObject({
      choices: [{ delta: { content: "先到" } }],
    });

    releaseRest();
    const outcome = await pending;
    expect(outcome.committed).toBe(true);
    expect(outcome.firstByteAt).toEqual(expect.any(Number));
    expect(observed).toHaveLength(2);
  });

  it("首字节超时归一化为 504，不透传网络异常正文", async () => {
    const caller = createOpenAiCompatibleCaller({
      fetch: async (_url, init) => new Promise<HttpResponseLike>((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("proxy html")), { once: true });
      }),
      env: { DEEPSEEK_BASE_URL: "https://deepseek.example" },
      firstByteTimeoutMs: 15,
      requestTimeoutMs: 200,
    });

    const outcome = await caller(resource(), responsesRequest(true), 1);

    expect(outcome).toMatchObject({
      status: 504,
      committed: false,
      error: "upstream_timeout",
      failureLayer: "FIRST_BYTE_TIMEOUT",
    });
    expect(JSON.stringify(outcome)).not.toContain("proxy html");
  });

  it("29.9 秒首字节继续成功，Kimi 30 秒后首字节使用独立门限", async () => {
    vi.useFakeTimers();
    try {
      const events = [
        "data: {\"choices\":[{\"delta\":{\"content\":\"慢响应\"}}]}\n\n",
        "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":9,\"completion_tokens\":2}}\n\n",
        "data: [DONE]\n\n",
      ];
      const options = {
        env: {},
        firstByteTimeoutMs: 30_000,
        firstByteTimeoutMsForResource: (item: AdapterResource) =>
          item.providerCode === "kimi" ? 120_000 : 30_000,
        requestTimeoutMs: 10 * 60_000,
      };
      const deepseekCaller = createOpenAiCompatibleCaller({
        ...options,
        fetch: delayedResponseFetch(29_900, streamResponse(events)),
      });
      const deepseekPending = deepseekCaller(resource(), responsesRequest(true), 1);
      await vi.advanceTimersByTimeAsync(29_900);
      const deepseekOutcome = await deepseekPending;

      const kimiCaller = createOpenAiCompatibleCaller({
        ...options,
        fetch: delayedResponseFetch(30_100, streamResponse(events)),
      });
      const kimiPending = kimiCaller(
        resource({ providerCode: "kimi", mode: "CODING_PLAN" }),
        responsesRequest(true),
        1,
      );
      await vi.advanceTimersByTimeAsync(30_100);
      const kimiOutcome = await kimiPending;

      expect(deepseekOutcome).toMatchObject({ committed: true, status: 200 });
      expect(kimiOutcome).toMatchObject({
        committed: true,
        status: 200,
        usage: { input: 9, output: 2 },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("Kimi 超过 120 秒首字节门限仍稳定记录 FIRST_BYTE_TIMEOUT", async () => {
    vi.useFakeTimers();
    try {
      const caller = createOpenAiCompatibleCaller({
        fetch: delayedResponseFetch(120_100, streamResponse([])),
        env: {},
        firstByteTimeoutMsForResource: () => 120_000,
        requestTimeoutMs: 10 * 60_000,
      });
      const pending = caller(
        resource({ providerCode: "kimi", mode: "CODING_PLAN" }),
        responsesRequest(true),
        1,
      );
      await vi.advanceTimersByTimeAsync(120_000);

      await expect(pending).resolves.toMatchObject({
        status: 504,
        committed: false,
        error: "upstream_timeout",
        failureLayer: "FIRST_BYTE_TIMEOUT",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("上游真实 504 保持 UPSTREAM_HTTP，不伪装成 Gateway 主动超时", async () => {
    const caller = createOpenAiCompatibleCaller({
      fetch: async () => jsonResponse({ error: { code: "vendor_timeout" } }, 504),
      env: {},
    });

    const outcome = await caller(resource({ providerCode: "kimi" }), responsesRequest(), 1);

    expect(outcome).toMatchObject({
      status: 504,
      committed: false,
      failureLayer: "UPSTREAM_HTTP",
      upstreamCode: "vendor_timeout",
    });
  });

  it("流式空闲超时发生在已提交后，保留首字节与失败层", async () => {
    const request = responsesRequest(true);
    request.onStreamChunk = () => undefined;
    const caller = createOpenAiCompatibleCaller({
      fetch: async (_url, init) => idleStreamResponse(init.signal),
      env: { DEEPSEEK_BASE_URL: "https://deepseek.example" },
      firstByteTimeoutMs: 100,
      streamIdleTimeoutMs: 15,
      requestTimeoutMs: 200,
    });

    const outcome = await caller(resource(), request, 1);

    expect(outcome).toMatchObject({
      status: 504,
      committed: true,
      error: "upstream_timeout",
      failureLayer: "STREAM_IDLE_TIMEOUT",
    });
    expect(outcome.firstByteAt).toEqual(expect.any(Number));
    expect(outcome.lastByteAt).toEqual(expect.any(Number));
  });

  it("智谱 Coding Plan 资源首块后空闲超过 45 秒但在策略门限内恢复时请求成功", async () => {
    vi.useFakeTimers();
    try {
      const request = responsesRequest(true);
      request.onStreamChunk = () => undefined;
      const caller = createOpenAiCompatibleCaller({
        fetch: async () => delayedStreamResponse(new Promise((resolve) => setTimeout(resolve, 60_000))),
        env: { ZHIPU_BASE_URL: "https://zhipu.example" },
        firstByteTimeoutMs: 5_000,
        streamIdleTimeoutMsForResource: (item) =>
          item.providerCode === "zhipu" && item.mode === "CODING_PLAN" ? 120_000 : 45_000,
        requestTimeoutMs: 10 * 60_000,
      });

      const pending = caller(
        resource({ providerCode: "zhipu", mode: "CODING_PLAN" }),
        request,
        1,
      );
      // 跨过旧的全局 45 秒门限，但仍在智谱 120 秒门限内；流在 60 秒恢复并补齐 usage 与 [DONE]。
      await vi.advanceTimersByTimeAsync(60_000);
      const outcome = await pending;

      expect(outcome).toMatchObject({ committed: true, status: 200 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("智谱 Coding Plan 资源首块后连续超过 120 秒无数据时记录 STREAM_IDLE_TIMEOUT", async () => {
    vi.useFakeTimers();
    try {
      const request = responsesRequest(true);
      request.onStreamChunk = () => undefined;
      const caller = createOpenAiCompatibleCaller({
        fetch: async (_url, init) => idleStreamResponse(init.signal),
        env: { ZHIPU_BASE_URL: "https://zhipu.example" },
        firstByteTimeoutMs: 5_000,
        streamIdleTimeoutMsForResource: (item) =>
          item.providerCode === "zhipu" && item.mode === "CODING_PLAN" ? 120_000 : 45_000,
        requestTimeoutMs: 10 * 60_000,
      });

      const pending = caller(
        resource({ providerCode: "zhipu", mode: "CODING_PLAN" }),
        request,
        1,
      );
      await vi.advanceTimersByTimeAsync(120_000);
      const outcome = await pending;

      expect(outcome).toMatchObject({
        status: 504,
        committed: true,
        error: "upstream_timeout",
        failureLayer: "STREAM_IDLE_TIMEOUT",
      });
      expect(outcome.firstByteAt).toEqual(expect.any(Number));
      expect(outcome.lastByteAt).toEqual(expect.any(Number));
    } finally {
      vi.useRealTimers();
    }
  });

  it("DeepSeek 与 Kimi 资源仍按 45 秒流式空闲门限触发 STREAM_IDLE_TIMEOUT", async () => {
    vi.useFakeTimers();
    try {
      const request = responsesRequest(true);
      request.onStreamChunk = () => undefined;
      const options = {
        env: {
          DEEPSEEK_BASE_URL: "https://deepseek.example",
          KIMI_BASE_URL: "https://kimi.example",
        },
        firstByteTimeoutMs: 5_000,
        streamIdleTimeoutMsForResource: (item: AdapterResource) =>
          item.providerCode === "zhipu" && item.mode === "CODING_PLAN" ? 120_000 : 45_000,
        requestTimeoutMs: 10 * 60_000,
      };

      const deepseekCaller = createOpenAiCompatibleCaller({
        ...options,
        fetch: async (_url, init) => idleStreamResponse(init.signal),
      });
      const deepseekPending = deepseekCaller(
        resource({ providerCode: "deepseek", mode: "API" }),
        request,
        1,
      );
      await vi.advanceTimersByTimeAsync(45_000);
      const deepseekOutcome = await deepseekPending;

      const kimiCaller = createOpenAiCompatibleCaller({
        ...options,
        fetch: async (_url, init) => idleStreamResponse(init.signal),
      });
      const kimiPending = kimiCaller(
        resource({ providerCode: "kimi", mode: "CODING_PLAN" }),
        request,
        1,
      );
      await vi.advanceTimersByTimeAsync(45_000);
      const kimiOutcome = await kimiPending;

      expect(deepseekOutcome).toMatchObject({
        status: 504,
        failureLayer: "STREAM_IDLE_TIMEOUT",
      });
      expect(kimiOutcome).toMatchObject({
        status: 504,
        failureLayer: "STREAM_IDLE_TIMEOUT",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("请求总时长独立于首字节，在非流式解析阶段归一化为 504", async () => {
    const caller = createOpenAiCompatibleCaller({
      fetch: async (_url, init) => pendingJsonResponse(init.signal),
      env: { DEEPSEEK_BASE_URL: "https://deepseek.example" },
      firstByteTimeoutMs: 100,
      requestTimeoutMs: 15,
    });

    const outcome = await caller(resource(), responsesRequest(false), 1);

    expect(outcome).toMatchObject({
      status: 504,
      committed: false,
      error: "upstream_timeout",
      failureLayer: "REQUEST_TIMEOUT",
    });
    expect(outcome.firstByteAt).toEqual(expect.any(Number));
  });

  it("客户端取消已提交的流时标记 CLIENT，禁止切换上游", async () => {
    const controller = new AbortController();
    const request = { ...responsesRequest(true), abort: controller.signal };
    request.onStreamChunk = () => controller.abort();
    const caller = createOpenAiCompatibleCaller({
      fetch: async (_url, init) => idleStreamResponse(init.signal),
      env: { DEEPSEEK_BASE_URL: "https://deepseek.example" },
      firstByteTimeoutMs: 100,
      streamIdleTimeoutMs: 100,
      requestTimeoutMs: 200,
    });

    const outcome = await caller(resource(), request, 1);

    expect(outcome).toMatchObject({
      status: 0,
      committed: true,
      error: "client_cancelled",
      failureLayer: "CLIENT",
      cancelled: true,
    });
  });

  it("SSE 使用 CRLF 且按单字节切片时仍能识别事件边界", async () => {
    const raw = [
      "data: {\"choices\":[{\"delta\":{\"content\":\"跨\"}}]}\r\n\r\n",
      "data: {\"choices\":[{\"delta\":{\"content\":\"边界\"}}]}\r\n\r\n",
      "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":9,\"completion_tokens\":2}}\r\n\r\n",
      "data: [DONE]\r\n\r\n",
    ].join("");
    const fetch: HttpFetch = async () => byteSlicedStreamResponse(raw);
    const caller = createOpenAiCompatibleCaller({
      fetch,
      env: { DEEPSEEK_BASE_URL: "https://deepseek.example" },
    });

    const outcome = await caller(resource(), responsesRequest(true), 1);

    expect(outcome.committed).toBe(true);
    expect(outcome.usage).toMatchObject({ input: 9, output: 2 });
    expect(outcome.responseOutput).toEqual([{
      id: "msg_req-responses-1",
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{
        type: "output_text",
        text: "跨边界",
        annotations: [],
        logprobs: [],
      }],
    }]);
  });

  it("缓冲流收到 delta 后上游中断仍 committed=false，并保留 ESTIMATED usage", async () => {
    const fetch: HttpFetch = async () => interruptedStreamResponse([
      "data: {\"choices\":[{\"delta\":{\"content\":\"未向北向提交\"}}]}\n\n",
      "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":21,\"completion_tokens\":6,\"prompt_tokens_details\":{\"cached_tokens\":4},\"completion_tokens_details\":{\"reasoning_tokens\":2}}}\n\n",
    ]);
    const caller = createOpenAiCompatibleCaller({
      fetch,
      env: { DEEPSEEK_BASE_URL: "https://deepseek.example" },
    });

    const outcome = await caller(resource(), responsesRequest(true), 1);

    expect(outcome).toMatchObject({
      status: 0,
      committed: false,
      error: "transport_error",
      usage: {
        input: 21,
        output: 6,
        cache: 4,
        reasoning: 2,
        quality: "ESTIMATED",
      },
    });
    expect(outcome.responseOutput).toBeUndefined();
  });

  it("没有 [DONE] 的上游 EOF 视为提交前中断", async () => {
    const fetch: HttpFetch = async () => streamResponse([
      "data: {\"choices\":[{\"delta\":{\"content\":\"截断\"}}]}\n\n",
    ]);
    const caller = createOpenAiCompatibleCaller({
      fetch,
      env: { DEEPSEEK_BASE_URL: "https://deepseek.example" },
    });

    const outcome = await caller(resource(), responsesRequest(true), 1);

    expect(outcome.committed).toBe(false);
    expect(outcome.error).toBe("transport_error");
    expect(outcome.usage.quality).toBe("ESTIMATED");
  });

  it("有 [DONE] 但缺最终 usage 仍视为提交前不完整流", async () => {
    const fetch: HttpFetch = async () => streamResponse([
      "data: {\"choices\":[{\"delta\":{\"content\":\"无计量\"}}]}\n\n",
      "data: [DONE]\n\n",
    ]);
    const caller = createOpenAiCompatibleCaller({
      fetch,
      env: { DEEPSEEK_BASE_URL: "https://deepseek.example" },
    });

    const outcome = await caller(resource(), responsesRequest(true), 1);

    expect(outcome.committed).toBe(false);
    expect(outcome.error).toBe("transport_error");
    expect(outcome.usage).toMatchObject({
      input: 0,
      output: 0,
      quality: "ESTIMATED",
    });
  });

  it("流式 usage:null/空对象不算最终 Usage", async () => {
    const fetch: HttpFetch = async () => streamResponse([
      "data: {\"choices\":[{\"delta\":{\"content\":\"没有有效计量\"}}],\"usage\":null}\n\n",
      "data: {\"choices\":[],\"usage\":{}}\n\n",
      "data: [DONE]\n\n",
    ]);
    const caller = createOpenAiCompatibleCaller({
      fetch,
      env: { DEEPSEEK_BASE_URL: "https://deepseek.example" },
    });

    const outcome = await caller(resource(), responsesRequest(true), 1);

    expect(outcome).toMatchObject({
      status: 0,
      committed: false,
      error: "transport_error",
      usage: {
        input: 0,
        output: 0,
        quality: "ESTIMATED",
      },
    });
    expect(outcome.responseOutput).toBeUndefined();
  });

  it("任一非 [DONE] SSE data JSON 损坏时立即按缓冲流失败", async () => {
    const fetch: HttpFetch = async () => streamResponse([
      "data: {\"choices\":[{\"delta\":{\"content\":\"已聚合但未提交\"}}]}\n\n",
      "data: {broken-json}\n\n",
      "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":9,\"completion_tokens\":2}}\n\n",
      "data: [DONE]\n\n",
    ]);
    const caller = createOpenAiCompatibleCaller({
      fetch,
      env: { DEEPSEEK_BASE_URL: "https://deepseek.example" },
    });

    const outcome = await caller(resource(), responsesRequest(true), 1);

    expect(outcome).toMatchObject({
      status: 0,
      committed: false,
      error: "transport_error",
      usage: {
        input: 0,
        output: 0,
        quality: "ESTIMATED",
      },
    });
    expect(outcome.responseOutput).toBeUndefined();
  });

  it("缺少资源凭证时在 fetch 前失败；智谱使用官方默认 Base URL", async () => {
    let calls = 0;
    let calledUrl = "";
    const fetch: HttpFetch = async (url) => {
      calls += 1;
      calledUrl = url;
      return jsonResponse({
        choices: [{ message: { content: "ok" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });
    };
    const caller = createOpenAiCompatibleCaller({ fetch, env: {} });

    const missingSecret = await caller(
      resource({ secret: new SecretValue("") }),
      responsesRequest(),
      1,
    );
    const defaultZhipuUrl = await caller(
      resource({
        providerCode: "zhipu",
        secret: new SecretValue("zhipu-real"),
      }),
      responsesRequest(),
      1,
    );

    expect(missingSecret.error).toBe("upstream_credential_missing");
    expect(defaultZhipuUrl.error).toBeUndefined();
    expect(calledUrl).toBe(
      "https://open.bigmodel.cn/api/coding/paas/v4/chat/completions",
    );
    expect(calls).toBe(1);
  });
});

describe("资源凭证解析", () => {
  it("优先解密资源密文；无密文时兼容回退厂商环境变量", () => {
    const kek = Buffer.alloc(32, 7);
    const encrypted = encryptCredential("db-resource-secret", kek);
    const fromDb = resolveProviderSecret({
      providerCode: "deepseek",
      credentialCiphertext: JSON.stringify(encrypted),
      credentialKek: kek,
      env: { DEEPSEEK_API_KEY: "env-secret" },
    });
    const fromEnv = resolveProviderSecret({
      providerCode: "deepseek",
      credentialCiphertext: null,
      credentialKek: kek,
      env: { DEEPSEEK_API_KEY: "env-secret" },
    });

    expect(fromDb.reveal()).toBe("db-resource-secret");
    expect(fromEnv.reveal()).toBe("env-secret");
  });

  it("兼容 PostgreSQL jsonb 返回的密文对象", () => {
    const kek = Buffer.alloc(32, 8);
    const encrypted = encryptCredential("jsonb-object-secret", kek);
    const secret = resolveProviderSecret({
      providerCode: "deepseek",
      credentialCiphertext: encrypted,
      credentialKek: kek,
    });
    expect(secret.reveal()).toBe("jsonb-object-secret");
  });

  it("密文损坏时不扩大为环境级凭证", () => {
    const secret = resolveProviderSecret({
      providerCode: "deepseek",
      credentialCiphertext: "{\"ciphertext\":\"broken\"}",
      credentialKek: Buffer.alloc(32, 9),
      env: { DEEPSEEK_API_KEY: "must-not-fallback" },
    });
    expect(secret.isConfigured()).toBe(false);
  });
});

function jsonResponse(
  payload: unknown,
  status = 200,
  headers: Record<string, string> = {},
): HttpResponseLike {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    json: async () => payload,
    text: async () => JSON.stringify(payload),
    body: null,
  };
}

function delayedResponseFetch(delayMs: number, response: HttpResponseLike): HttpFetch {
  return async (_url, init) => new Promise<HttpResponseLike>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      resolve(response);
    }, delayMs);
    init.signal.addEventListener("abort", () => {
      if (settled) return;
      clearTimeout(timer);
      reject(new Error("aborted"));
    }, { once: true });
  });
}

function streamResponse(events: string[]): HttpResponseLike {
  return {
    ok: true,
    status: 200,
    json: async () => {
      throw new Error("stream response");
    },
    text: async () => events.join(""),
    body: (async function* chunks() {
      for (const event of events) yield Buffer.from(event);
    })(),
  };
}

function byteSlicedStreamResponse(raw: string): HttpResponseLike {
  const bytes = Buffer.from(raw);
  return {
    ok: true,
    status: 200,
    json: async () => {
      throw new Error("stream response");
    },
    text: async () => raw,
    body: (async function* chunks() {
      for (const byte of bytes) yield Uint8Array.of(byte);
    })(),
  };
}

function interruptedStreamResponse(events: string[]): HttpResponseLike {
  return {
    ok: true,
    status: 200,
    json: async () => {
      throw new Error("stream response");
    },
    text: async () => events.join(""),
    body: (async function* chunks() {
      for (const event of events) yield Buffer.from(event);
      throw new Error("upstream socket interrupted");
    })(),
  };
}

function delayedStreamResponse(rest: Promise<void>): HttpResponseLike {
  return {
    ok: true,
    status: 200,
    json: async () => { throw new Error("stream response"); },
    text: async () => "",
    body: (async function* chunks() {
      yield Buffer.from("data: {\"choices\":[{\"delta\":{\"content\":\"先到\"}}]}\n\n");
      await rest;
      yield Buffer.from("data: {\"choices\":[],\"usage\":{\"prompt_tokens\":2,\"completion_tokens\":1}}\n\n");
      yield Buffer.from("data: [DONE]\n\n");
    })(),
  };
}

function idleStreamResponse(signal: AbortSignal): HttpResponseLike {
  return {
    ok: true,
    status: 200,
    json: async () => { throw new Error("stream response"); },
    text: async () => "",
    body: (async function* chunks() {
      yield Buffer.from("data: {\"choices\":[{\"delta\":{\"content\":\"首块\"}}]}\n\n");
      await rejectWhenAborted(signal);
    })(),
  };
}

function pendingJsonResponse(signal: AbortSignal): HttpResponseLike {
  return {
    ok: true,
    status: 200,
    json: async () => rejectWhenAborted(signal),
    text: async () => "",
    body: null,
  };
}

function rejectWhenAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("aborted"));
      return;
    }
    signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
}
