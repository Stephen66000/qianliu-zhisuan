import { describe, expect, it, vi } from "vitest";
import {
  createRuleExtractor,
  normalizePricingExtraction,
  type PricingExtraction,
} from "./extractor.js";

const EXTRACTION: PricingExtraction = {
  source_kind: "pricing_table",
  unit_basis: "CNY_PER_MILLION_TOKENS",
  rows: [{
    model_name: "GLM-5.3-Flash",
    context_display: "1M",
    input_price: { current: "0.4", original: "0.8" },
    output_price: { current: "1.4", original: "2.8" },
    cache_storage: "限时免费",
    cache_hit_price: { current: "0.115", original: "0.23" },
    input_modalities: ["图片", "视频", "文件", "文本"],
    badges: ["5折限时两周"],
    time_windows: [],
    model_tier_multiplier: null,
  }],
  ambiguities: ["上下文表头与 1M 展示口径不一致"],
};

describe("截图计价规则识别", () => {
  it("保留现价/原价证据并用 Decimal 换算单 Token 单价", () => {
    const result = normalizePricingExtraction(EXTRACTION, "glm-5.3-flash");
    expect(result.targetEvidence?.input_price).toEqual({ current: "0.4", original: "0.8" });
    expect(result.candidateRules).toEqual([expect.objectContaining({
      rule_type: "API_PRICE",
      cache_hit_price: "0.000000115",
      cache_miss_price: "0.0000004",
      output_price: "0.0000014",
    })]);
    expect(result.warnings).toEqual([expect.objectContaining({ blocking: false })]);
  });

  it("单位未确认时不预先生成归一化价格", () => {
    const result = normalizePricingExtraction({ ...EXTRACTION, unit_basis: "元/未知单位" }, "glm-5.3-flash");
    expect(result.candidateRules[0]).toMatchObject({
      cache_hit_price: "",
      cache_miss_price: "",
      output_price: "",
    });
    expect(result.warnings).toContainEqual(expect.objectContaining({
      code: "PRICE_UNIT_UNCONFIRMED",
      blocking: true,
    }));
  });

  it("K3 响应失败时透明切到 GLM，不拼接两份结果", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "limited" } }), { status: 429 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: "chatcmpl-glm",
        choices: [{ message: { content: JSON.stringify(EXTRACTION) } }],
      }), { status: 200 }));
    const extractor = createRuleExtractor({
      env: {
        RULE_EXTRACTION_GATEWAY_API_KEY: "test-only",
        RULE_EXTRACTION_GATEWAY_BASE_URL: "https://gateway.example/v1",
        RULE_EXTRACTION_MODELS: "ql-k3,ql-glm-5.3-flash",
      },
      fetch,
    });
    const result = await extractor.extract({
      imageDataUrl: "data:image/png;base64,iVBORw0KGgo=",
      targetUpstreamModel: "glm-5.3-flash",
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(result.extractorModel).toBe("ql-glm-5.3-flash");
    expect(result.extractorRequestId).toBe("chatcmpl-glm");
    const requestBody = JSON.parse(fetch.mock.calls[1]![1]!.body as string);
    expect(requestBody.max_completion_tokens).toBe(4096);
    expect(requestBody.response_format.json_schema.schema.properties.rows.maxItems).toBe(100);
  });
});
