import { describe, expect, it } from "vitest";
import { canonicalJson, fingerprintRequest } from "../pipeline/request-idempotency.js";

describe("POOL-007 请求体指纹", () => {
  it("对象键顺序不同但语义相同时指纹一致", () => {
    const left = {
      model: "qianliu-deepseek",
      messages: [{ role: "user" as const, content: "hello" }],
      stream: true,
      tools: [{ name: "weather", parameters: { required: ["city"], type: "object" } }],
    };
    const right = {
      tools: [{ parameters: { type: "object", required: ["city"] }, name: "weather" }],
      stream: true,
      messages: [{ content: "hello", role: "user" as const }],
      model: "qianliu-deepseek",
    };

    expect(fingerprintRequest("chat", left)).toBe(fingerprintRequest("chat", right));
  });

  it("协议或请求正文变化时指纹不同", () => {
    const body = {
      model: "qianliu-deepseek",
      messages: [{ role: "user" as const, content: "hello" }],
    };

    expect(fingerprintRequest("chat", body)).not.toBe(
      fingerprintRequest("messages", body),
    );
    expect(fingerprintRequest("chat", body)).not.toBe(
      fingerprintRequest("chat", {
        ...body,
        messages: [{ role: "user", content: "different" }],
      }),
    );
  });

  it("canonicalJson 不持久化 undefined 字段且保留数组顺序", () => {
    expect(canonicalJson({ b: undefined, a: [2, 1] })).toBe('{"a":[2,1]}');
  });
});
