import { describe, expect, it, vi } from "vitest";
import {
  chatAssistantToResponsesOutput,
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
      thinking: { type: "enabled", clear_thinking: false },
      tool_stream: true,
    },
  };
}

describe("Responses → Chat Completions", () => {
  it("仅含推理字段的上游消息保持空正文 Responses 占位，不把推理正文伪装成答案", () => {
    expect(chatAssistantToResponsesOutput({
      reasoning_content: "private reasoning",
    }, "reasoning-only")).toEqual([{
      id: "msg_reasoning-only",
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{
        type: "output_text",
        text: "",
        annotations: [],
        logprobs: [],
      }],
    }]);
  });

  it("DeepSeek Responses 保留推理开关，但不转发智谱专用 tool_stream", () => {
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
    expect(body.thinking).toEqual({ type: "enabled" });
    expect(Object.hasOwn(body, "tool_stream")).toBe(false);
  });

  it.each([
    ["deepseek", "deepseek-v4-flash", { type: "enabled" }, false],
    ["zhipu", "glm-5.3", { type: "enabled", clear_thinking: false }, true],
    ["kimi", "k3", undefined, false],
  ] as const)(
    "%s：按厂商合同过滤顶层 thinking/tool_stream",
    (providerCode, upstreamModel, expectedThinking, keepsToolStream) => {
      const body = toChatCompletionsRequest(resource({ providerCode, upstreamModel }), {
        requestId: `reasoning-roundtrip-${providerCode}`,
        unifiedModel: `ql-${providerCode}`,
        capability: "chat",
        stream: true,
        body: {
          messages: [
            { role: "user", content: "检查状态", reasoning_content: "不得转发用户伪造字段" },
            {
              role: "assistant",
              content: null,
              reasoning_content: "provider-reasoning-content",
              reasoning_details: [{ type: "reasoning.summary", text: "summary" }],
              reasoning: { trace: "provider-native-reasoning" },
              tool_calls: [{
                id: "call_reasoning_1",
                type: "function",
                function: { name: "status", arguments: "{}" },
              }],
            },
            { role: "tool", tool_call_id: "call_reasoning_1", content: "ok" },
          ],
          tools: [{
            type: "function",
            function: { name: "status", parameters: { type: "object", properties: {} } },
          }],
          reasoning_effort: "high",
          thinking: { type: "enabled", clear_thinking: false },
          tool_stream: true,
        },
      });

      expect(body.messages[0]).toEqual({ role: "user", content: "检查状态" });
      expect(body.messages[1]).toMatchObject({
        role: "assistant",
        reasoning_content: "provider-reasoning-content",
        tool_calls: [{ id: "call_reasoning_1" }],
      });
      expect(Object.hasOwn(body.messages[1]!, "reasoning_details")).toBe(false);
      expect(Object.hasOwn(body.messages[1]!, "reasoning")).toBe(false);
      expect(body.thinking).toEqual(expectedThinking);
      expect(Object.hasOwn(body, "tool_stream")).toBe(keepsToolStream);
      if (keepsToolStream) expect(body.tool_stream).toBe(true);
    },
  );

  it.each([
    ["deepseek", "deepseek-v4-flash", "low", "low"],
    ["deepseek", "deepseek-v4-flash", "medium", "medium"],
    ["deepseek", "deepseek-v4-flash", "xhigh", "xhigh"],
    ["deepseek", "deepseek-v4-flash", "minimal", undefined],
    ["zhipu", "glm-5.3", "minimal", "minimal"],
    ["zhipu", "glm-5.3", "none", "none"],
    ["zhipu", "glm-5.3", "invalid", undefined],
    ["zhipu", "glm-4.7", "max", undefined],
    ["kimi", "k3", "low", "low"],
    ["kimi", "k3-256k", "medium", "high"],
    ["kimi", "kimi-k3", "xhigh", "max"],
    ["kimi", "k3", "none", undefined],
    ["kimi", "kimi-k2.6", "high", undefined],
  ] as const)(
    "%s/%s：reasoning_effort=%s 归一化为 %s",
    (providerCode, upstreamModel, input, expected) => {
      const body = toChatCompletionsRequest(resource({ providerCode, upstreamModel }), {
        requestId: `reasoning-effort-${providerCode}-${input}`,
        unifiedModel: `ql-${providerCode}`,
        capability: "chat",
        stream: false,
        body: {
          messages: [{ role: "user", content: "effort" }],
          reasoning_effort: input,
        },
      });
      expect(body.reasoning_effort).toBe(expected);
    },
  );

  it("推理扩展缺失、空值、false 与非法 tool_stream 均按原合同处理", () => {
    const withoutBody = toChatCompletionsRequest(resource(), {
      requestId: "reasoning-no-body",
      unifiedModel: "ql-deepseek-v4-flash",
      capability: "chat",
      stream: false,
      body: null,
    });
    expect(Object.hasOwn(withoutBody, "thinking")).toBe(false);
    expect(Object.hasOwn(withoutBody, "tool_stream")).toBe(false);

    const withoutExtensions = toChatCompletionsRequest(resource(), {
      requestId: "reasoning-no-extensions",
      unifiedModel: "ql-deepseek-v4-flash",
      capability: "chat",
      stream: false,
      body: {
        messages: [{
          role: "assistant",
          content: "ok",
          reasoning_content: undefined,
        }],
        tool_stream: "true",
      },
    });
    expect(Object.hasOwn(withoutExtensions, "thinking")).toBe(false);
    expect(Object.hasOwn(withoutExtensions, "tool_stream")).toBe(false);
    expect(Object.hasOwn(withoutExtensions.messages[0]!, "reasoning_content")).toBe(false);
    expect(Object.hasOwn(withoutExtensions.messages[0]!, "reasoning_details")).toBe(false);
    expect(Object.hasOwn(withoutExtensions.messages[0]!, "reasoning")).toBe(false);

    const invalidExtensions = toChatCompletionsRequest(resource(), {
      requestId: "reasoning-invalid-extensions",
      unifiedModel: "ql-deepseek-v4-flash",
      capability: "chat",
      stream: false,
      body: {
        messages: [{ role: "user", content: "invalid" }],
        reasoning_effort: 3,
        thinking: { type: "auto", clear_thinking: false },
      },
    });
    expect(Object.hasOwn(invalidExtensions, "reasoning_effort")).toBe(false);
    expect(Object.hasOwn(invalidExtensions, "thinking")).toBe(false);

    const explicitValues = toChatCompletionsRequest(resource({
      providerCode: "zhipu",
      upstreamModel: "glm-5.3",
    }), {
      requestId: "reasoning-explicit-values",
      unifiedModel: "ql-glm-5.3",
      capability: "chat",
      stream: false,
      body: {
        messages: [{ role: "assistant", content: null, reasoning_content: null }],
        thinking: { type: "disabled", clear_thinking: true, foreign: "drop" },
        tool_stream: false,
      },
    });
    expect(explicitValues.thinking).toEqual({ type: "disabled", clear_thinking: true });
    expect(explicitValues.tool_stream).toBe(false);
    expect(explicitValues.messages[0]?.reasoning_content).toBeNull();

    const responsesWithoutExtensions = responsesRequest().body as Record<string, unknown>;
    delete responsesWithoutExtensions.thinking;
    delete responsesWithoutExtensions.tool_stream;
    const responsesBody = responsesToChatCompletions(
      responsesWithoutExtensions as never,
      "deepseek-chat",
      false,
    );
    expect(Object.hasOwn(responsesBody, "thinking")).toBe(false);
    expect(Object.hasOwn(responsesBody, "tool_stream")).toBe(false);
  });

  it("生产失败形状：108 条消息、23 个工具、51 组调用结果不丢推理字段", () => {
    const messages: Array<Record<string, unknown>> = Array.from({ length: 6 }, (_, index) => ({
      role: "user", content: `context-${index}`,
    }));
    for (let index = 0; index < 51; index += 1) {
      const callId = `call_${index}`;
      messages.push({
        role: "assistant",
        content: null,
        reasoning_content: `reasoning-${index}`,
        tool_calls: [{
          id: callId,
          type: "function",
          function: { name: `tool_${index % 23}`, arguments: "{}" },
        }],
      });
      messages.push({ role: "tool", tool_call_id: callId, content: "ok" });
    }
    const tools = Array.from({ length: 23 }, (_, index) => ({
      type: "function",
      function: { name: `tool_${index}`, parameters: { type: "object", properties: {} } },
    }));
    const body = toChatCompletionsRequest(resource(), {
      requestId: "production-failure-shape",
      unifiedModel: "ql-deepseek-v4-flash",
      capability: "chat",
      stream: true,
      body: {
        messages,
        tools,
        reasoning_effort: "high",
        thinking: { type: "enabled", clear_thinking: false },
        tool_stream: true,
      },
    });

    expect(body.messages).toHaveLength(108);
    expect(body.tools).toHaveLength(23);
    expect(body.messages.filter((message) => message.tool_calls?.length)).toHaveLength(51);
    expect(body.messages.filter((message) => message.role === "tool")).toHaveLength(51);
    expect(body.messages.filter((message) => message.reasoning_content !== undefined)).toHaveLength(51);
    expect(body.messages[6]).toMatchObject({
      role: "assistant", reasoning_content: "reasoning-0", tool_calls: [{ id: "call_0" }],
    });
    expect(body.thinking).toEqual({ type: "enabled" });
    expect(Object.hasOwn(body, "tool_stream")).toBe(false);
  });

  it("DeepSeek 工具续轮为缺失推理字段的 assistant 补空字符串且保留真实值", () => {
    const body = toChatCompletionsRequest(resource(), {
      requestId: "deepseek-tool-reasoning-backfill",
      unifiedModel: "ql-deepseek-v4-flash",
      capability: "chat",
      stream: false,
      body: {
        messages: [
          { role: "user", content: "检查状态" },
          {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: "call_missing",
              type: "function",
              function: { name: "status", arguments: "{}" },
            }],
          },
          { role: "tool", tool_call_id: "call_missing", content: "ok" },
          {
            role: "assistant",
            content: null,
            reasoning_content: "provider-reasoning",
            tool_calls: [{
              id: "call_existing",
              type: "function",
              function: { name: "status", arguments: "{}" },
            }],
          },
          { role: "tool", tool_call_id: "call_existing", content: "ok" },
        ],
        tools: [{
          type: "function",
          function: { name: "status", parameters: { type: "object", properties: {} } },
        }],
      },
    });

    expect(body.messages[1]?.reasoning_content).toBe("");
    expect(body.messages[3]?.reasoning_content).toBe("provider-reasoning");
    expect(Object.hasOwn(body.messages[0]!, "reasoning_content")).toBe(false);
    expect(Object.hasOwn(body.messages[2]!, "reasoning_content")).toBe(false);
  });

  it("DeepSeek 无工具时不补 reasoning_content", () => {
    const body = toChatCompletionsRequest(resource(), {
      requestId: "deepseek-no-tool-no-backfill",
      unifiedModel: "ql-deepseek-v4-flash",
      capability: "chat",
      stream: false,
      body: { messages: [{ role: "assistant", content: "ok" }] },
    });

    expect(Object.hasOwn(body.messages[0]!, "reasoning_content")).toBe(false);
  });

  it("Kimi K3 工具请求补空 reasoning_content，但不扩到 K2.6", () => {
    const request = (upstreamModel: string) => toChatCompletionsRequest(resource({
      providerCode: "kimi",
      upstreamModel,
    }), {
      requestId: `kimi-${upstreamModel}-reasoning-backfill`,
      unifiedModel: `ql-${upstreamModel}`,
      capability: "chat",
      stream: false,
      body: {
        messages: [
          { role: "assistant", content: null },
          { role: "assistant", content: null, reasoning_content: "provider-reasoning" },
        ],
        tools: [{
          type: "function",
          function: { name: "status", parameters: { type: "object", properties: {} } },
        }],
      },
    });

    const k3 = request("k3");
    expect(k3.messages[0]?.reasoning_content).toBe("");
    expect(k3.messages[1]?.reasoning_content).toBe("provider-reasoning");
    const k26 = request("kimi-k2.6");
    expect(Object.hasOwn(k26.messages[0]!, "reasoning_content")).toBe(false);
  });

  it("GLM 工具历史缺少真实推理时退出保留式思考并重新开始", () => {
    const convert = (reasoningContent: unknown, thinking?: unknown) =>
      toChatCompletionsRequest(resource({
        providerCode: "zhipu",
        upstreamModel: "glm-5.3",
      }), {
        requestId: "glm-missing-reasoning-restart",
        unifiedModel: "ql-glm-5.3",
        capability: "chat",
        stream: false,
        body: {
          messages: [{
            role: "assistant",
            content: null,
            ...(reasoningContent === undefined
              ? {}
              : { reasoning_content: reasoningContent }),
            tool_calls: [{
              id: "call_glm_restart",
              type: "function",
              function: { name: "status", arguments: "{}" },
            }],
          }],
          tools: [{
            type: "function",
            function: { name: "status", parameters: { type: "object", properties: {} } },
          }],
          ...(thinking === undefined ? {} : { thinking }),
        },
      });

    expect(convert(undefined, { type: "enabled", clear_thinking: false }).thinking)
      .toEqual({ type: "enabled", clear_thinking: true });
    expect(convert("", { type: "enabled", clear_thinking: false }).thinking)
      .toEqual({ type: "enabled", clear_thinking: true });
    expect(convert(undefined).thinking)
      .toEqual({ type: "enabled", clear_thinking: true });
    expect(convert("provider-reasoning", { type: "enabled", clear_thinking: false }).thinking)
      .toEqual({ type: "enabled", clear_thinking: false });
    expect(convert(undefined, { type: "disabled" }).thinking)
      .toEqual({ type: "disabled" });
  });

  it("GLM 无工具时不因缺少 reasoning_content 改写思考策略", () => {
    const body = toChatCompletionsRequest(resource({
      providerCode: "zhipu",
      upstreamModel: "glm-5.3",
    }), {
      requestId: "glm-no-tool-no-restart",
      unifiedModel: "ql-glm-5.3",
      capability: "chat",
      stream: false,
      body: {
        messages: [{ role: "assistant", content: "ok" }],
        thinking: { type: "enabled", clear_thinking: false },
      },
    });

    expect(body.thinking).toEqual({ type: "enabled", clear_thinking: false });
    expect(Object.hasOwn(body.messages[0]!, "reasoning_content")).toBe(false);
  });

  it("生产故障形状：212 条消息、23 个工具、103 组续轮全部补齐推理字段", () => {
    const messages: Array<Record<string, unknown>> = Array.from(
      { length: 6 },
      (_, index) => ({ role: "user", content: `context-${index}` }),
    );
    for (let index = 0; index < 103; index += 1) {
      const callId = `call_missing_${index}`;
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: [{
          id: callId,
          type: "function",
          function: { name: `tool_${index % 23}`, arguments: "{}" },
        }],
      });
      messages.push({ role: "tool", tool_call_id: callId, content: "ok" });
    }
    const tools = Array.from({ length: 23 }, (_, index) => ({
      type: "function",
      function: { name: `tool_${index}`, parameters: { type: "object", properties: {} } },
    }));
    const body = toChatCompletionsRequest(resource(), {
      requestId: "production-missing-reasoning-shape",
      unifiedModel: "ql-deepseek-v4-flash",
      capability: "chat",
      stream: true,
      body: { messages, tools, thinking: { type: "enabled" } },
    });

    expect(body.messages).toHaveLength(212);
    expect(body.tools).toHaveLength(23);
    expect(body.messages.filter((message) => message.tool_calls?.length)).toHaveLength(103);
    expect(body.messages.filter((message) => message.role === "tool")).toHaveLength(103);
    expect(body.messages.filter((message) => message.reasoning_content === "")).toHaveLength(103);
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

  it("DeepSeek Vision：Anthropic Messages 图片块转换为上游多模态内容", () => {
    const body = toChatCompletionsRequest(resource({ providerCode: "deepseek" }), {
      requestId: "req-vision-messages",
      unifiedModel: "ql-deepseek-v4-flash-vision-exp",
      capability: "messages",
      stream: false,
      body: {
        messages: [{
          role: "user",
          content: [
            { type: "text", text: "分析图片" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "aW1hZ2U=" } },
            { type: "image", source: { type: "url", url: "https://example.com/a.png" } },
            { type: "image", source: { type: "file", file_id: "file-api-vision" } },
          ],
        }],
      },
    });
    expect(body.messages).toEqual([{
      role: "user",
      content: [
        { type: "text", text: "分析图片" },
        { type: "image_url", image_url: { url: "data:image/png;base64,aW1hZ2U=" } },
        { type: "image_url", image_url: { url: "https://example.com/a.png" } },
        { type: "file", file_id: "file-api-vision" },
      ],
    }]);
  });

  it("DeepSeek Vision：Responses 保留 image_url detail 与 file_id", () => {
    const body = toChatCompletionsRequest(resource({ providerCode: "deepseek" }), {
      requestId: "req-vision-responses",
      unifiedModel: "ql-deepseek-v4-flash-vision-exp",
      capability: "responses",
      stream: false,
      body: {
        model: "ql-deepseek-v4-flash-vision-exp",
        input: [{
          role: "user",
          content: [
            { type: "input_text", text: "读取图表" },
            { type: "input_image", image_url: "https://example.com/chart.png", detail: "low" },
            { type: "input_image", file_id: "file-api-chart" },
          ],
        }],
      },
    });
    expect(body.messages).toEqual([{
      role: "user",
      content: [
        { type: "text", text: "读取图表" },
        { type: "image_url", image_url: { url: "https://example.com/chart.png", detail: "low" } },
        { type: "file", file_id: "file-api-chart" },
      ],
    }]);
  });
});

describe("OpenAI-compatible HTTP caller", () => {
  it("非流式非法 JSON 与流式空 body 分别归一化为协议失败", async () => {
    const invalidJsonCaller = createOpenAiCompatibleCaller({
      fetch: async () => ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => { throw new Error("invalid json"); },
        text: async () => "",
        body: null,
      }),
      env: { DEEPSEEK_BASE_URL: "https://deepseek.example" },
    });
    expect(await invalidJsonCaller(resource(), responsesRequest(false), 1)).toMatchObject({
      status: 0,
      committed: false,
      error: "upstream_invalid_json",
      failureLayer: "UPSTREAM_PROTOCOL",
    });

    const emptyStreamCaller = createOpenAiCompatibleCaller({
      fetch: async () => ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({}),
        text: async () => "",
        body: null,
      }),
      env: { DEEPSEEK_BASE_URL: "https://deepseek.example" },
    });
    expect(await emptyStreamCaller(resource(), responsesRequest(true), 1)).toMatchObject({
      status: 0,
      committed: false,
      error: "upstream_empty_stream",
      failureLayer: "UPSTREAM_PROTOCOL",
    });
  });

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
            reasoning_content: "provider-reasoning-content",
            reasoning_details: [{ type: "reasoning.summary", text: "summary" }],
            reasoning: { trace: "provider-native-reasoning" },
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
    expect(outcome.responseReasoningExtensions).toEqual({
      reasoning_content: "provider-reasoning-content",
    });
  });

  it("Kimi K3 回归：保留 reasoning_effort、图片和工具，剔除不支持的 thinking/tool_stream", async () => {
    let capturedBody: Record<string, unknown> = {};
    const tools = Array.from({ length: 36 }, (_, index) => ({
      type: "function",
      function: {
        name: `tool_${index}`,
        description: `tool ${index}`,
        parameters: { type: "object", properties: {} },
      },
    }));
    const caller = createOpenAiCompatibleCaller({
      fetch: async (_url, init) => {
        capturedBody = JSON.parse(init.body) as Record<string, unknown>;
        return jsonResponse({
          choices: [{ message: { role: "assistant", content: "ok" } }],
          usage: { prompt_tokens: 8, completion_tokens: 1 },
        });
      },
      env: { KIMI_CODING_BASE_URL: "https://kimi.example" },
    });

    const outcome = await caller(resource({
      providerCode: "kimi",
      upstreamModel: "k3",
      secret: new SecretValue("kimi-test"),
    }), {
      requestId: "kimi-k3-provider-policy-regression",
      unifiedModel: "ql-k3",
      capability: "chat",
      stream: false,
      body: {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "识别图片" },
              { type: "image_url", image_url: { url: "data:image/png;base64,aW1hZ2U=" } },
            ],
          },
          { role: "assistant", content: "继续", reasoning_content: "preserved" },
        ],
        tools,
        reasoning_effort: "high",
        thinking: { type: "enabled", clear_thinking: false },
        tool_stream: true,
      },
    }, 1);

    expect(outcome).toMatchObject({ status: 200, committed: true });
    expect(capturedBody.model).toBe("k3");
    expect(capturedBody.reasoning_effort).toBe("high");
    expect(Object.hasOwn(capturedBody, "thinking")).toBe(false);
    expect(Object.hasOwn(capturedBody, "tool_stream")).toBe(false);
    expect(capturedBody.tools).toHaveLength(36);
    expect(capturedBody.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: "assistant",
        reasoning_content: "preserved",
      }),
    ]));
  });

  it("400 诊断不记录推理正文，并只反映实际发往 DeepSeek 的顶层字段", async () => {
    const canary = "PRIVATE_REASONING_CONTENT_MUST_NOT_PERSIST";
    const caller = createOpenAiCompatibleCaller({
      fetch: async () => jsonResponse({
        error: { type: "invalid_request_error", code: "invalid_request_error", message: "invalid request" },
      }, 400),
      env: { DEEPSEEK_BASE_URL: "https://deepseek.example" },
    });
    const outcome = await caller(resource(), {
      requestId: "reasoning-diagnostic-privacy",
      unifiedModel: "ql-deepseek-v4-flash",
      capability: "chat",
      stream: true,
      body: {
        messages: [{
          role: "assistant",
          content: null,
          reasoning_content: canary,
          tool_calls: [],
        }],
        reasoning_effort: "high",
        thinking: { type: "enabled", clear_thinking: false },
        tool_stream: true,
      },
    }, 1);

    expect(outcome.requestShapeSummary?.topLevelFields).toContain("thinking");
    expect(outcome.requestShapeSummary?.topLevelFields).not.toContain("tool_stream");
    expect(JSON.stringify(outcome)).not.toContain(canary);
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
    expect(Object.hasOwn(outcome, "responseReasoningExtensions")).toBe(false);
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
    expect(outcome.upstreamErrorEvidence).toBeUndefined();
    expect(outcome.requestShapeSummary).toBeUndefined();
  });

  it("POOL20-048：Messages 转换后的 400 生成脱敏证据与工具 Schema issue", async () => {
    const canary = "POOL048_PRIVATE_MESSAGE_CANARY";
    const toolName = "private.tool.name";
    const propertyName = "private_customer_property";
    const caller = createOpenAiCompatibleCaller({
      fetch: async () => jsonResponse({
        error: {
          type: "invalid_request_error",
          code: "invalid_request_error",
          param: `tools[0].function.parameters.properties.${propertyName}`,
          message: `tool schema invalid ${canary}`,
        },
      }, 400),
      env: { DEEPSEEK_BASE_URL: "https://deepseek.example" },
    });
    const request: AdapterRequest = {
      requestId: "pool048-messages",
      unifiedModel: "ql-deepseek-v4-flash",
      capability: "messages",
      stream: true,
      body: {
        model: "ql-deepseek-v4-flash",
        system: canary,
        messages: [{ role: "user", content: [{ type: "text", text: canary }] }],
        tools: [{
          name: toolName,
          description: canary,
          input_schema: {
            type: "array",
            properties: { [propertyName]: { type: "string", default: canary } },
          },
        }],
        tool_choice: { type: "auto", disable_parallel_tool_use: false },
      },
    };

    const outcome = await caller(resource({ upstreamModel: "deepseek-v4-flash" }), request, 1);

    expect(outcome).toMatchObject({
      status: 400,
      error: "invalid_request_error",
      upstreamErrorEvidence: {
        type: "invalid_request_error",
        code: "invalid_request_error",
        param: "tools[].function.parameters.properties.*",
        messageCategory: "INVALID_TOOL_SCHEMA",
      },
      requestShapeSummary: {
        toolCount: 1,
        functionToolCount: 1,
        invalidToolCount: 1,
        toolSchemaIssueCounts: {
          FUNCTION_NAME_INVALID: 1,
          PARAMETERS_SCHEMA_INVALID: 1,
        },
        stream: true,
        streamOptionsIncluded: true,
      },
    });
    expect(outcome.upstreamErrorEvidence?.diagnosticHash).toMatch(/^[0-9a-f]{64}$/);
    const serialized = JSON.stringify(outcome);
    for (const value of [canary, toolName, propertyName]) expect(serialized).not.toContain(value);
  });

  it("POOL20-048：非 JSON 400 生成通用诊断，未知 code/type 不落 Outcome", async () => {
    const canary = "POOL048_RAW_PROVIDER_BODY";
    const caller = createOpenAiCompatibleCaller({
      fetch: async () => ({
        ok: false,
        status: 400,
        headers: { get: () => null },
        json: async () => { throw new Error("not json"); },
        text: async () => canary,
        body: null,
      }),
      env: { DEEPSEEK_BASE_URL: "https://deepseek.example" },
    });
    const outcome = await caller(resource(), responsesRequest(), 1);
    expect(outcome).toMatchObject({
      status: 400,
      error: "upstream_http_400",
      upstreamErrorEvidence: {
        type: null,
        code: null,
        param: null,
        messageCategory: "UNCLASSIFIED",
      },
    });
    expect(JSON.stringify(outcome)).not.toContain(canary);
  });

  it("Chat 401 保存脱敏拒绝字段与原因分类，不保存厂商原文", async () => {
    const canary = "KIMI_PRIVATE_AUTH_MESSAGE_CANARY";
    const caller = createOpenAiCompatibleCaller({
      fetch: async () => jsonResponse({
        error: {
          type: "authentication_error",
          code: "expired_token",
          message: `The access token has expired ${canary}`,
        },
      }, 401),
      env: { KIMI_BASE_URL: "https://kimi.example" },
    });

    const outcome = await caller(resource({
      providerCode: "kimi",
      mode: "CODING_PLAN",
      upstreamModel: "k3",
    }), responsesRequest(), 1);

    expect(outcome).toMatchObject({
      status: 401,
      error: "expired_token",
      upstreamErrorEvidence: {
        httpStatus: 401,
        type: "authentication_error",
        code: "expired_token",
        param: null,
        messageCategory: "CREDENTIAL_EXPIRED",
      },
      requestShapeSummary: { messageCount: 4 },
    });
    expect(outcome.upstreamErrorEvidence?.diagnosticHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(outcome)).not.toContain(canary);
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

  it("Kimi 403 五小时窗口耗尽返回限流信号和厂商恢复时间", async () => {
    const caller = createOpenAiCompatibleCaller({
      fetch: async () => jsonResponse({
        error: {
          type: "permission_error",
          message: "The 5-hour rolling window quota has been exhausted.",
          resetTime: "2026-09-03T17:00:00.000Z",
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
      upstreamErrorKind: "WINDOW_EXHAUSTED",
      unifiedAvailabilitySignal: "RATE_LIMIT_RETRY_AFTER",
      recoverAt: "2026-09-03T17:00:00.000Z",
    });
  });

  it("Retry-After HTTP 日期和非法恢复时间都有稳定边界", async () => {
    const future = new Date(Date.now() + 60_000).toUTCString();
    const dated = createOpenAiCompatibleCaller({
      fetch: async () => jsonResponse(
        { error: { code: "rate_limit_exceeded", message: "too many requests", resetTime: 1e20 } },
        429,
        { "retry-after": future },
      ),
      env: { DEEPSEEK_BASE_URL: "https://deepseek.example" },
    });
    const outcome = await dated(resource(), responsesRequest(), 1);
    expect(outcome.retryAfterMs).toBeGreaterThan(0);
    expect(outcome.recoverAt).toBeDefined();

    const invalid = createOpenAiCompatibleCaller({
      fetch: async () => jsonResponse(
        { error: { code: "rate_limit_exceeded", message: "too many requests" } },
        429,
        { "retry-after": "not-a-date" },
      ),
      env: { DEEPSEEK_BASE_URL: "https://deepseek.example" },
    });
    expect((await invalid(resource(), responsesRequest(), 1)).retryAfterMs).toBeUndefined();
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

  it("P2：capability_set.endpoints[mode] 模式专属地址优先于历史 Moonshot base_url", async () => {
    let calledUrl = "";
    const fetch: HttpFetch = async (url) => {
      calledUrl = url;
      return jsonResponse({
        choices: [{ message: { content: "ok" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });
    };
    const caller = createOpenAiCompatibleCaller({ fetch, env: {} });

    // 生产 Provider 形态：base_url=历史 Moonshot 平台地址 + endpoints.CODING_PLAN 显式 Coding 地址。
    const outcome = await caller(
      resource({
        providerCode: "Kimi",
        mode: "CODING_PLAN",
        upstreamModel: "k3",
        baseUrl: "https://api.moonshot.cn/v1",
        endpoints: { CODING_PLAN: "https://coding-gateway.corp.example/v1" },
        secret: new SecretValue("kimi-real"),
      }),
      responsesRequest(),
      1,
    );

    expect(outcome.error).toBeUndefined();
    expect(calledUrl).toBe("https://coding-gateway.corp.example/v1/chat/completions");
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
