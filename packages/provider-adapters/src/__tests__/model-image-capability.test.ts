import { describe, expect, it, vi } from "vitest";
import { createOpenAiCompatibleCaller, SecretValue, type AdapterRequest, type AdapterResource } from "../index.js";
import { hasImageInput, modelSupportsImages } from "../model-image-capability.js";
import { buildRequestShapeSummary, buildUpstreamErrorEvidence } from "../upstream-error-evidence.js";
import { parseUpstreamErrorEvidence, sanitizeUpstreamErrorCode } from "@qianliu/contracts";

const url = "https://example.invalid/private-image.png";
const variants: Array<[NonNullable<AdapterRequest["capability"]>, unknown]> = [
  ["chat", { messages: [{ role: "user", content: [{ type: "image_url", image_url: { url } }] }] }],
  ["messages", { messages: [{ role: "user", content: [{ type: "image", source: { type: "url", url } }] }] }],
  ["messages", { messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "aW1hZ2U=" } }] }] }],
  ["responses", { input: [{ role: "user", content: [{ type: "input_image", image_url: url }] }] }],
  ["responses", { input: [{ role: "user", content: [{ type: "input_image", file_id: "private-file" }] }] }],
];
function resource(model: string): AdapterResource { return { providerCode: "zhipu", upstreamModel: model, resourceId: "test", mode: "CODING_PLAN", concurrencyLimit: 0, secret: new SecretValue("test-only") }; }
const shape = buildRequestShapeSummary({ model: "test", stream: false, messages: [] });

describe("POOL20-054 image admission and lossless forwarding", () => {
  it.each(["glm-4.6", "glm-4.7", "glm-5", "glm-5.2", "glm-5.3"])("known text model %s is gated, unrelated models remain unknown", (model) => {
    expect(modelSupportsImages("zhipu", model)).toBe(false);
    expect(modelSupportsImages("deepseek", model)).toBeNull();
    expect(modelSupportsImages("zhipu", model + "-vision")).toBeNull();
  });
  it.each(variants)("%s images never call a known text-only upstream", async (capability, body) => {
    const fetch = vi.fn();
    const outcome = await createOpenAiCompatibleCaller({ fetch })(resource("glm-5.3"), { requestId: "test", unifiedModel: "custom-alias", stream: true, capability, body }, 1);
    expect(fetch).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ status: 400, error: "model_image_unsupported", committed: false, usage: { input: 0, output: 0 } });
  });
  it.each(variants)("%s unknown model retains its images instead of being rejected as text-only", async (capability, body) => {
    const fetch = vi.fn(async () => ({ ok: false, status: 400, text: async () => "", body: null, json: async () => ({ error: { code: "1210", message: "参数有误" } }) }));
    await createOpenAiCompatibleCaller({ fetch })(resource("glm-5.3-flash"), { requestId: "test", unifiedModel: "custom-alias", stream: false, capability, body }, 1);
    expect(fetch).toHaveBeenCalledTimes(1);
    const init = fetch.mock.calls[0] as unknown as [string, { body: string }];
    const sent = JSON.parse(init[1].body);
    expect(sent.messages[0].content[0].type).toBe(capability === "responses" && JSON.stringify(body).includes("file_id") ? "file" : "image_url");
    expect(JSON.stringify(sent)).toContain(JSON.stringify(body).includes("private-file") ? "private-file" : JSON.stringify(body).includes("aW1hZ2U=") ? "aW1hZ2U=" : url);
  });
  it.each([
    ["url", { type: "url", url }, url],
    ["base64", { type: "base64", media_type: "image/png", data: "aW1hZ2U=" }, "data:image/png;base64,aW1hZ2U="],
  ])("preserves %s images and text in an Anthropic tool result", async (_kind, source, expectedUrl) => {
    const fetch = vi.fn(async () => ({
      ok: false, status: 400, text: async () => "", body: null,
      json: async () => ({ error: { code: "test", message: "controlled rejection" } }),
    }));
    const body = { messages: [{
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: "call",
        content: [{ type: "text", text: "截图结果" }, { type: "image", source }],
      }],
    }] };

    await createOpenAiCompatibleCaller({ fetch })(resource("unknown"), {
      requestId: "test", unifiedModel: "test", stream: false, capability: "messages", body,
    }, 1);

    expect(fetch).toHaveBeenCalledTimes(1);
    const init = fetch.mock.calls[0] as unknown as [string, { body: string }];
    const sent = JSON.parse(init[1].body);
    expect(sent.messages).toEqual([{
      role: "tool",
      tool_call_id: "call",
      content: [
        { type: "text", text: "截图结果" },
        { type: "image_url", image_url: { url: expectedUrl } },
      ],
    }]);
  });
  it("tool arguments that look like image blocks are not multimodal input", () => {
    expect(hasImageInput({ messages: [{ role: "assistant", content: [{ type: "tool_use", input: { type: "image", source: { type: "url", url } } }] }] })).toBe(false);
  });
  it("image-looking text and tool schema data do not trigger a gate", () => {
    expect(hasImageInput({ messages: [{ role: "user", content: '{"type":"image"}' }], tools: [{ content: [{ type: "image" }] }] })).toBe(false);
  });
});

describe("Zhipu safe code and Chinese semantic normalization", () => {
  it.each([1210, "1210", 1211, "1211", 1212, "1212", 1213, "1213", 1214, "1214", 1215, "1215"])("retains approved code %s while image meaning comes from the message", (code) => {
    const evidence = buildUpstreamErrorEvidence({ error: { code, message: "该模型不支持图片输入 private-image-secret" } }, 400, "zhipu", shape);
    expect(evidence).toMatchObject({ code: String(code), messageCategory: "MODEL_IMAGE_UNSUPPORTED" });
    expect(parseUpstreamErrorEvidence(evidence)).toEqual(evidence);
    expect(JSON.stringify(evidence)).not.toContain("private-image-secret");
  });
  it.each([[1210, "API 调用参数有误", "INVALID_PARAMETER"], [1211, "模型不存在", "MODEL_UNAVAILABLE"], [1212, "当前模型不支持此调用方式", "INVALID_PARAMETER"], [1214, "图片参数非法", "INVALID_MESSAGE_CONTENT"], [1210, "模型不支持图片格式 WEBP", "INVALID_MESSAGE_CONTENT"]])("classifies %s without mislabeling generic errors as image unsupported", (code, message, messageCategory) => {
    expect(buildUpstreamErrorEvidence({ error: { code, message } }, 400, "zhipu", shape).messageCategory).toBe(messageCategory);
  });
  it.each([123456, 1210.5, NaN, Infinity, "1210-secret", "private-secret", {}, null])("rejects unsafe/unrecognized code %s", (code) => { expect(sanitizeUpstreamErrorCode(code)).toBeNull(); });
});
