import { describe, expect, it } from "vitest";

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
});
