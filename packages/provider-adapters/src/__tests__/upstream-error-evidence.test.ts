import { describe, expect, it } from "vitest";
import { parseRequestShapeSummary } from "@qianliu/contracts";

import {
  buildRequestShapeSummary,
  buildUpstreamErrorEvidence,
} from "../upstream-error-evidence.js";

const SECRET = "sk-sensitive-canary-1234567890";
const CONTENT = "CUSTOMER_PROMPT_CANARY";
const TOOL_NAME = "private_business_tool";
const PROPERTY_NAME = "customer_secret_field";

function body(overrides: Record<string, unknown> = {}) {
  return {
    model: "deepseek-v4-flash",
    messages: [{ role: "user", content: CONTENT }],
    stream: true,
    stream_options: { include_usage: true },
    ...overrides,
  } as never;
}

describe("upstream error evidence", () => {
  it("推理扩展只记录顶层字段存在性，不记录 reasoning 正文", () => {
    const reasoningCanary = "PRIVATE_REASONING_MUST_NOT_ENTER_DIAGNOSTICS";
    const shape = buildRequestShapeSummary(body({
      messages: [{
        role: "assistant",
        content: null,
        reasoning_content: reasoningCanary,
        reasoning_details: [{ type: "reasoning.summary", text: reasoningCanary }],
        reasoning: { trace: reasoningCanary },
      }],
      thinking: { type: "enabled", clear_thinking: false },
      tool_stream: true,
    }));

    expect(shape.topLevelFields).toEqual(expect.arrayContaining([
      "thinking", "tool_stream",
    ]));
    expect(parseRequestShapeSummary(shape)).toEqual(shape);
    expect(JSON.stringify(shape)).not.toContain(reasoningCanary);
  });

  it("只保留白名单错误元组，不保存 raw message、Secret 或业务字段", () => {
    const shape = buildRequestShapeSummary(body({
      tools: [{
        type: "function",
        function: {
          name: TOOL_NAME,
          description: CONTENT,
          parameters: {
            type: "object",
            properties: {
              [PROPERTY_NAME]: { type: "string", default: SECRET, pattern: CONTENT },
            },
            required: [PROPERTY_NAME],
          },
        },
      }],
      tool_choice: { type: "function", function: { name: TOOL_NAME } },
    }));
    const evidence = buildUpstreamErrorEvidence({
      error: {
        type: "invalid_request_error",
        code: SECRET,
        param: "tools[7].function.parameters.properties.customer_secret_field",
        message: `Invalid tool schema ${CONTENT} ${SECRET}`,
      },
    }, 400, "deepseek", shape);

    expect(evidence).toMatchObject({
      httpStatus: 400,
      type: "invalid_request_error",
      code: null,
      param: "tools[].function.parameters.properties.*",
      messageCategory: "INVALID_TOOL_SCHEMA",
    });
    expect(evidence.diagnosticHash).toMatch(/^[0-9a-f]{64}$/);
    const serialized = JSON.stringify({ shape, evidence });
    for (const canary of [SECRET, CONTENT, TOOL_NAME, PROPERTY_NAME]) {
      expect(serialized).not.toContain(canary);
    }
    expect(shape).toMatchObject({
      toolCount: 1,
      functionToolCount: 1,
      invalidToolCount: 0,
      toolTypes: ["function"],
      schemaPropertyCount: 1,
      stream: true,
      streamOptionsIncluded: true,
      countOverflowed: false,
      toolSchemaIssueCounts: {},
    });
    expect(shape.schemaKeywords).toEqual(expect.arrayContaining([
      "default", "pattern", "properties", "required", "type",
    ]));
  });

  it("诊断 hash 只随安全错误元组或结构变化，不随 raw message 变化", () => {
    const shape = buildRequestShapeSummary(body());
    const first = buildUpstreamErrorEvidence({
      error: { type: "invalid_request_error", message: `Invalid value ${CONTENT}` },
    }, 400, "deepseek", shape);
    const second = buildUpstreamErrorEvidence({
      error: { type: "invalid_request_error", message: "Invalid value ANOTHER_PRIVATE_VALUE" },
    }, 400, "deepseek", shape);
    const changedShape = buildRequestShapeSummary(body({
      messages: [{ role: "user", content: CONTENT }, { role: "assistant", content: "" }],
    }));
    const third = buildUpstreamErrorEvidence({
      error: { type: "invalid_request_error", message: `Invalid value ${CONTENT}` },
    }, 400, "deepseek", changedShape);

    expect(first.diagnosticHash).toBe(second.diagnosticHash);
    expect(first.diagnosticHash).not.toBe(third.diagnosticHash);
  });

  it("未知业务型 code/type/param 全部 fail-closed", () => {
    const shape = buildRequestShapeSummary(body());
    const evidence = buildUpstreamErrorEvidence({
      error: {
        type: "customer_123",
        code: "secret:abc",
        param: "tenant.private_field",
        message: "invalid request",
      },
    }, 400, "deepseek", shape);
    expect(evidence).toMatchObject({ type: null, code: null, param: null });
    expect(JSON.stringify(evidence)).not.toContain("customer_123");
    expect(JSON.stringify(evidence)).not.toContain("secret:abc");
    expect(JSON.stringify(evidence)).not.toContain("private_field");
  });

  it("摘要工具调用配对与异常类型，未知字符串统一收敛", () => {
    const shape = buildRequestShapeSummary(body({
      messages: [
        { role: "assistant", content: null, tool_calls: [{ id: "call-private-1", type: "function", function: { name: TOOL_NAME, arguments: "{}" } }] },
        { role: "tool", tool_call_id: "call-private-2", content: CONTENT },
      ],
      tools: [{ type: TOOL_NAME, name: SECRET }],
      tool_choice: SECRET,
    }));

    expect(shape).toMatchObject({
      contentKinds: ["null", "string"],
      assistantToolCallCount: 1,
      toolResultCount: 1,
      unmatchedAssistantToolCallCount: 1,
      unmatchedToolResultCount: 1,
      toolCount: 1,
      functionToolCount: 0,
      invalidToolCount: 1,
      toolTypes: ["other"],
      toolChoiceKind: "other",
      toolSchemaIssueCounts: { NON_FUNCTION_TOOL: 1 },
    });
    expect(JSON.stringify(shape)).not.toContain(TOOL_NAME);
    expect(JSON.stringify(shape)).not.toContain(SECRET);
  });

  it("用固定 issue code 定位函数名与 parameters 结构错误", () => {
    const shape = buildRequestShapeSummary(body({
      tools: [{
        type: "function",
        function: {
          name: "invalid.function.name",
          parameters: { type: "array", properties: [], required: "secret" },
        },
      }],
    }));
    expect(shape).toMatchObject({
      functionToolCount: 1,
      invalidToolCount: 1,
      toolSchemaIssueCounts: {
        FUNCTION_NAME_INVALID: 1,
        PARAMETERS_SCHEMA_INVALID: 1,
      },
    });
  });

  it("超大请求计数有界并标记 overflow", () => {
    const shape = buildRequestShapeSummary(body({
      messages: Array.from({ length: 10_001 }, () => ({ role: "user", content: "" })),
    }));
    expect(shape.messageCount).toBe(10_000);
    expect(shape.messageRoles.user).toBe(10_000);
    expect(shape.countOverflowed).toBe(true);
  });

  it("未知内容块、非对象工具和超深 Schema 都只落固定摘要", () => {
    let nested: Record<string, unknown> = { type: "string" };
    for (let index = 0; index < 35; index += 1) nested = { items: nested };
    const shape = buildRequestShapeSummary(body({
      messages: [{ role: "user", content: [{ type: "private_block", value: SECRET }] }],
      tools: [null, {
        type: "function",
        function: { name: "safe_name", parameters: { type: "object", properties: { nested } } },
      }],
    }));
    expect(shape.contentBlockTypes).toEqual(["other"]);
    expect(shape).toMatchObject({
      functionToolCount: 1,
      invalidToolCount: 1,
      toolCount: 2,
      toolSchemaIssueCounts: { NON_FUNCTION_TOOL: 1 },
      toolTypes: ["function", "other"],
    });
    expect(shape.countOverflowed).toBe(true);
    expect(JSON.stringify(shape)).not.toContain("private_block");
    expect(JSON.stringify(shape)).not.toContain(SECRET);
  });

  it.each([
    ["missing function", { type: "function" }, { FUNCTION_MISSING: 1 }],
    ["parameters not object", { type: "function", function: { name: "safe", parameters: "bad" } }, { PARAMETERS_NOT_OBJECT: 1 }],
    ["properties not object", { type: "function", function: { name: "safe", parameters: { type: "object", properties: [] } } }, { PARAMETERS_SCHEMA_INVALID: 1 }],
    ["required not array", { type: "function", function: { name: "safe", parameters: { type: "object", required: "x" } } }, { PARAMETERS_SCHEMA_INVALID: 1 }],
    ["required missing property", { type: "function", function: { name: "safe", parameters: { type: "object", properties: {}, required: ["missing"] } } }, { PARAMETERS_SCHEMA_INVALID: 1 }],
  ] as const)("工具结构反例：%s", (_label, tool, issues) => {
    const shape = buildRequestShapeSummary(body({ tools: [tool] }));
    expect(shape).toMatchObject({
      functionToolCount: 1,
      invalidToolCount: 1,
      toolCount: 1,
      toolSchemaIssueCounts: issues,
      toolTypes: ["function"],
    });
  });

  it("固定顶层字段、content kind 和无 stream_options 边界", () => {
    const shape = buildRequestShapeSummary(body({
      stream_options: undefined,
      messages: [
        { role: "user", content: { type: "object" } },
        { role: "user", content: true },
        { role: "user", content: 1 },
        { role: "other", content: undefined },
      ],
    }));
    expect(shape.topLevelFields).toEqual(["messages", "model", "stream", "stream_options"]);
    expect(shape.contentKinds).toEqual(["boolean", "number", "object", "other"]);
    expect(shape.messageRoles).toEqual({ other: 1, user: 3 });
    expect(shape.streamOptionsIncluded).toBe(false);
  });

  it("未知 Provider 只影响安全 hash，不进入证据字段", () => {
    const shape = buildRequestShapeSummary(body());
    const payload = { error: { type: "invalid_request_error", message: "invalid value" } };
    const deepseek = buildUpstreamErrorEvidence(payload, 400, "deepseek", shape);
    const unknown = buildUpstreamErrorEvidence(payload, 400, "private-provider", shape);
    expect(unknown).toMatchObject({
      type: "invalid_request_error", code: null, param: null, messageCategory: "INVALID_PARAMETER",
    });
    expect(unknown.diagnosticHash).not.toBe(deepseek.diagnosticHash);
    expect(JSON.stringify(unknown)).not.toContain("private-provider");
  });

  it("安全 canonical hash 锁定消息规范化和 Provider 枚举", () => {
    const shape = buildRequestShapeSummary({
      model: "m", messages: [{ role: "user", content: "x" }], stream: false,
    });
    const payload = {
      error: { type: "invalid_request_error", message: "  invalid   value  " },
      message: " invalid value ",
    };
    expect(Object.fromEntries(["deepseek", "zhipu", "kimi", "private"].map((provider) => [
      provider,
      buildUpstreamErrorEvidence(payload, 400, provider, shape).diagnosticHash,
    ]))).toEqual({
      deepseek: "abd0680943cb62c42ec276fa9f4a3cb5228367cbcaa2c9cf6c2792010d5c53fb",
      zhipu: "e6187f423c987a0d77f09f4a329b1fd106d379016de1004ed8a544a10a1c0dac",
      kimi: "34a36317199948a2611aee5c9a79f1df503a24fc6ac4dd0f52fd54b383191983",
      private: "2f1f35c8c68fa09b51648fcaf1436ae085ea4c2c5866f1b2180efd4f8677cc6c",
    });
    expect(shape).toMatchObject({
      topLevelFields: ["messages", "model", "stream"],
      toolCount: 0,
      streamOptionsIncluded: false,
    });
  });

  it.each([
    ["no root type", { properties: {} }, {}],
    ["no properties", { type: "object" }, {}],
    ["mixed required types", { type: "object", required: ["x", 1] }, { PARAMETERS_SCHEMA_INVALID: 1 }],
    ["some required missing", { type: "object", properties: { present: {} }, required: ["present", "missing"] }, { PARAMETERS_SCHEMA_INVALID: 1 }],
  ] as const)("parameters 精确边界：%s", (_label, parameters, issues) => {
    const shape = buildRequestShapeSummary(body({
      tools: [{ type: "function", function: { name: "safe", parameters } }],
    }));
    expect(shape.toolSchemaIssueCounts).toEqual(issues);
    expect(shape.invalidToolCount).toBe(Object.keys(issues).length > 0 ? 1 : 0);
  });

  it("非字符串函数名不能通过正则强制转换", () => {
    const shape = buildRequestShapeSummary(body({
      tools: [{ type: "function", function: { name: 123, parameters: { type: "object" } } }],
    }));
    expect(shape.toolSchemaIssueCounts).toEqual({ FUNCTION_NAME_INVALID: 1 });
    expect(shape.invalidToolCount).toBe(1);
  });
});
