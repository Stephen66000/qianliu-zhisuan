import { describe, expect, it, vi } from "vitest";
import { createOpenAiCompatibleCaller, SecretValue } from "../index.js";
import { hasImageInput, preservesImageInputs } from "../model-image-capability.js";
import { buildRequestShapeSummary, buildUpstreamErrorEvidence } from "../upstream-error-evidence.js";
const image = { type: "image_url", image_url: { url: "https://example.invalid/a.png" } };
const chat = (content: unknown) => ({ messages: [{ role: "user", content }] });
const shape = buildRequestShapeSummary({ model: "test", messages: [], stream: false });

describe("CQA-01 protocol envelopes are not tool arguments", () => {
  it.each(["tool_use", "function_call"])("outer type=%s must not hide message images", async (type) => {
    const fetch = vi.fn();
    const outcome = await createOpenAiCompatibleCaller({ fetch })({ providerCode: "zhipu", upstreamModel: "glm-5.3", resourceId: "test", mode: "CODING_PLAN", concurrencyLimit: 0, secret: new SecretValue("test-only") },
      { requestId: "test", unifiedModel: "alias", capability: "chat", stream: false, body: { type, ...chat([image]) } }, 1);
    expect(outcome.error).toBe("model_image_unsupported"); expect(fetch).not.toHaveBeenCalled();
  });
  it("message-level extension type does not hide content", () => {
    expect(hasImageInput({ messages: [{ role: "user", type: "tool_use", content: [image] }] })).toBe(true);
  });
  it("Responses input cannot be hidden by an outer function_call type", () => {
    expect(hasImageInput({ type: "function_call", input: [{ role: "user", content: [{ type: "input_image", image_url: "url" }] }] })).toBe(true);
  });
});

describe("CQA-04 image references and multiplicity", () => {
  it.each([null, undefined, false, 1, "image", { content: "image" }, chat([null, false, 1, "image"])])("ignores non-image content %s", (body) => {
    expect(hasImageInput(body)).toBe(false); expect(preservesImageInputs(body, {})).toBe(true);
  });
  it("generic files and function arguments are not image inputs", () => {
    expect(hasImageInput(chat([{ type: "file", file_id: "file" }]))).toBe(false);
    expect(hasImageInput({ input: [{ type: "function_call", input: image, arguments: image }] })).toBe(false);
  });
  it("preserves duplicates but rejects a missing or replaced image", () => {
    expect(preservesImageInputs(chat([image, image]), chat([image, image]))).toBe(true);
    expect(preservesImageInputs(chat([image, image]), chat([image]))).toBe(false);
    expect(preservesImageInputs(chat([image]), chat([{ type: "image_url", image_url: { url: "different" } }]))).toBe(false);
    expect(preservesImageInputs(chat([image]), chat([{ type: "text", text: "https://example.invalid/a.png" }]))).toBe(false);
  });
  it("retains file images and inspects Responses output, system and internal envelope", () => {
    expect(preservesImageInputs(chat([{ type: "image", source: { type: "file", file_id: "image-file" } }]), chat([{ type: "file", file_id: "image-file" }]))).toBe(true);
    expect(hasImageInput({ input: [{ type: "function_call_output", output: [image] }] })).toBe(true);
    expect(hasImageInput({ system: [image] })).toBe(true);
    expect(hasImageInput({ responsesRequest: { input: [{ role: "user", content: [{ type: "input_image", file_id: "image-file" }] }] } })).toBe(true);
  });
  it.each([
    { type: "image_url" }, { type: "image_url", image_url: null }, { type: "image_url", image_url: 1 }, { type: "image_url", image_url: { url: 1 } },
    { type: "input_image" }, { type: "input_image", image_url: 1 }, { type: "input_image", file_id: 1 },
    { type: "image" }, { type: "image", source: null }, { type: "image", source: "url" },
    { type: "image", source: { type: "base64", data: "png" } }, { type: "image", source: { type: "base64", media_type: "image/png" } },
    { type: "image", source: { type: "unknown", media_type: "image/png", data: "png" } }, { type: "image", source: { type: "url", url: 1 } },
    { type: "image", source: { type: "unknown", url: "url" } }, { type: "image", source: { type: "file", file_id: 1 } },
    { type: "image", source: { type: "unknown", file_id: "file" } },
  ])("rejects matching invalid blocks %j", (block) => {
    expect(hasImageInput(chat([block]))).toBe(true); expect(preservesImageInputs(chat([block]), chat([block]))).toBe(false);
  });
});

describe("CQA-02/04 diagnostic language and independent code semantics", () => {
  it.each([
    ["zhipu", null, "Model glm-5.3 does not support image input", "MODEL_IMAGE_UNSUPPORTED"],
    ["deepseek", null, "This model does not support image input", "MODEL_IMAGE_UNSUPPORTED"],
    ["deepseek", null, "Image input is unsupported by this model", "MODEL_IMAGE_UNSUPPORTED"],
    ["deepseek", null, "Image format is not supported", "INVALID_MESSAGE_CONTENT"],
    ["zhipu", null, "模型暂时无法处理这些图片", "MODEL_IMAGE_UNSUPPORTED"],
    ["zhipu", null, "图片暂时不支持当前模型", "MODEL_IMAGE_UNSUPPORTED"],
    ["zhipu", null, "模型暂时不存在", "MODEL_UNAVAILABLE"], ["zhipu", "1211", "", "MODEL_UNAVAILABLE"],
    ["zhipu", null, "上下文长度超过上限", "CONTEXT_LENGTH_EXCEEDED"], ["zhipu", null, "参数类型非法", "INVALID_PARAMETER"],
    ["zhipu", null, "图片输入无效", "INVALID_MESSAGE_CONTENT"], ["deepseek", "1210", "", "UNCLASSIFIED"],
    ["deepseek", null, "context length exceeded", "CONTEXT_LENGTH_EXCEEDED"],
    ["deepseek", null, "tool has invalid schema", "INVALID_TOOL_SCHEMA"], ["deepseek", null, "invalid custom function", "INVALID_TOOL_SCHEMA"],
    ["deepseek", null, "function parameter unsupported", "INVALID_TOOL_SCHEMA"], ["deepseek", null, "image is invalid", "INVALID_MESSAGE_CONTENT"],
    ["deepseek", null, "unsupported custom parameter", "UNSUPPORTED_PARAMETER"], ["deepseek", null, "expected large integer for field", "INVALID_PARAMETER"],
    ["deepseek", null, "model is unavailable", "MODEL_UNAVAILABLE"], ["deepseek", null, "unrecognized", "UNCLASSIFIED"],
  ])("%s / %s / %s => %s", (provider, code, message, category) => {
    expect(buildUpstreamErrorEvidence({ error: { code, message } }, 400, provider!, shape).messageCategory).toBe(category);
  });
  it.each(["1210", "1212", "1213", "1214", "1215"])("generic code %s alone has parameter semantics", (code) => {
    expect(buildUpstreamErrorEvidence({ error: { code, message: "" } }, 400, "zhipu", shape).messageCategory).toBe("INVALID_PARAMETER");
  });
});

describe("CQA-04 remaining envelope and diagnostic counterexamples", () => {
  it("raw message arrays retain images even with message extension types", () => {
    expect(hasImageInput([{ role: "user", type: "tool_use", content: [image] }])).toBe(true);
  });
  it("tool-call content extensions and unrelated message output are not image inputs", () => {
    for (const type of ["tool_use", "function_call"]) {
      expect(hasImageInput(chat([{ type, input: { message: "business" }, content: [image], output: [image] }]))).toBe(false);
    }
    expect(hasImageInput({ messages: [{ role: "user", content: "hello", output: [image] }] })).toBe(false);
  });
  it("nested tool result content/output is inspected, and only valid converted file blocks match", () => {
    expect(hasImageInput(chat([{ type: "tool_result", content: [{ type: "nested", content: [image] }] }]))).toBe(true);
    expect(hasImageInput(chat([{ type: "tool_result", output: [image] }]))).toBe(true);
    const original = chat([{ type: "input_image", file_id: "0" }]);
    expect(preservesImageInputs(original, chat([{ type: "file", file_id: 0 }]))).toBe(false);
    expect(preservesImageInputs(original, chat([{ type: "text", file_id: "0" }]))).toBe(false);
  });
  it.each([
    ["zhipu", null, "unrecognized", "UNCLASSIFIED"],
    ["zhipu", "model_not_found", "unrecognized", "UNCLASSIFIED"],
    ["deepseek", null, "This model does not support inline image input", "MODEL_IMAGE_UNSUPPORTED"],
    ["deepseek", null, "context window length exceeded", "CONTEXT_LENGTH_EXCEEDED"],
  ])("unrecognized code and multiword diagnostic %s/%s/%s", (provider, code, message, category) => {
    expect(buildUpstreamErrorEvidence({ error: { code, message } }, 400, provider!, shape).messageCategory).toBe(category);
  });
});
