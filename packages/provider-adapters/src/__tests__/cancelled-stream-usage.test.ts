import { describe, expect, it, vi } from "vitest";
import {
  createOpenAiCompatibleCaller, SecretValue,
  type AdapterRequest, type AdapterResource, type HttpResponseLike,
} from "../index.js";

const resource: AdapterResource = {
  providerCode: "deepseek", resourceId: "cancel-usage", mode: "API",
  upstreamModel: "deepseek-flash", concurrencyLimit: 1,
  secret: new SecretValue("test-only"),
};
const delta = 'data: {"choices":[{"delta":{"content":"reply"}}]}\n\n';
const done = "data: [DONE]\n\n";
function usage(input: number, output: number) {
  return `data: ${JSON.stringify({ choices: [], usage: {
    prompt_tokens: input, completion_tokens: output,
    prompt_tokens_details: { cached_tokens: Math.min(input, 4) },
    completion_tokens_details: { reasoning_tokens: 0 },
  } })}\n\n`;
}
function request(controller: AbortController, onChunk: AdapterRequest["onStreamChunk"]): AdapterRequest {
  return { requestId: "req-cancel-usage", capability: "chat", stream: true,
    unifiedModel: "ql-deepseek-flash", abort: controller.signal, onStreamChunk: onChunk,
    body: { model: "ql-deepseek-flash", messages: [{ role: "user", content: "hi" }], stream: true } };
}
function fixture(chunk: string) {
  let reads = 0;
  const response: HttpResponseLike = { ok: true, status: 200,
    json: async () => ({}), text: async () => "",
    body: (async function* () {
      reads += 1;
      yield Buffer.from(chunk);
      reads += 1;
      throw new Error("must not read another upstream chunk after cancellation");
    })(),
  };
  const caller = createOpenAiCompatibleCaller({
    fetch: async () => response, env: { DEEPSEEK_BASE_URL: "https://test.invalid" },
  });
  return { caller, reads: () => reads };
}

describe("cancelled stream accounting preserves received provider usage", () => {
  it.each([false, true])("retains buffered final usage when downstream callback throws=%s", async (throws) => {
    const controller = new AbortController();
    const callback = vi.fn(() => { controller.abort(); if (throws) throw new Error("socket closed"); });
    const f = fixture(delta + usage(21, 6) + done);
    const result = await f.caller(resource, request(controller, callback), 1);
    expect(result).toMatchObject({ error: "client_cancelled", cancelled: true,
      failureLayer: "CLIENT", status: 0,
      usage: { input: 21, output: 6, cache: 4, quality: "PROVIDER_REPORTED" } });
    expect(callback).toHaveBeenCalledTimes(1);
    expect(f.reads()).toBe(1);
    expect(result.responseOutput).toBeUndefined();
  });

  it("preserves an explicitly reported zero usage instead of losing its evidence", async () => {
    const controller = new AbortController();
    const f = fixture(delta + usage(0, 0) + done);
    const result = await f.caller(resource, request(controller, () => controller.abort()), 1);
    expect(result.usage).toMatchObject({ input: 0, output: 0, quality: "PROVIDER_REPORTED" });
    expect(result.cancelled).toBe(true);
    expect(f.reads()).toBe(1);
  });

  it("does not treat usage attached to a content delta as the final accounting footer", async () => {
    const controller = new AbortController();
    const interim = 'data: {"choices":[{"delta":{"content":"partial"}}],"usage":{"prompt_tokens":21,"completion_tokens":1}}\n\n';
    const f = fixture(interim);
    const result = await f.caller(resource, request(controller, () => controller.abort()), 1);
    expect(result.usage).toMatchObject({ input: 21, output: 1, quality: "ESTIMATED" });
    expect(f.reads()).toBe(1);
  });

  it("does not invent zero-cost evidence or keep reading when no usage footer arrived", async () => {
    const controller = new AbortController();
    const f = fixture(delta);
    const result = await f.caller(resource, request(controller, () => controller.abort()), 1);
    expect(result).toMatchObject({ error: "client_cancelled", cancelled: true,
      committed: true, usage: { input: 0, output: 0, quality: "ESTIMATED" } });
    expect(f.reads()).toBe(1);
  });

  it("keeps genuine upstream interruption distinct from downstream cancellation", async () => {
    const controller = new AbortController();
    const f = fixture(delta + usage(21, 6));
    const result = await f.caller(resource, request(controller, () => undefined), 1);
    expect(result).toMatchObject({ error: "stream_interrupted_after_commit", cancelled: false,
      usage: { input: 21, output: 6, quality: "ESTIMATED" } });
    expect(f.reads()).toBe(2);
  });
});
