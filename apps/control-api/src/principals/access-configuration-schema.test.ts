import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { PrincipalAccessConfigurationPutSchema } from "./access-configuration-schema.js";

const MODEL_ID = randomUUID();

function input(providers: unknown[]) {
  return {
    expected_version: 1,
    idempotency_key: "pool041-schema-test",
    providers,
  };
}

function provider(providerCode: string, modelIds = [MODEL_ID]) {
  return {
    provider_code: providerCode,
    quota_value: "1000",
    enabled_model_ids: modelIds,
  };
}

describe("POOL-041 单人接入配置 Schema", () => {
  it("拒绝重复 provider_code，并返回稳定路径与错误", () => {
    const parsed = PrincipalAccessConfigurationPutSchema.safeParse(input([
      provider(" kimi "),
      provider("kimi"),
    ]));
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: ["providers"], message: "provider_code 不能重复" }),
    ]));
  });

  it("拒绝同一厂商内重复 enabled_model_ids", () => {
    const parsed = PrincipalAccessConfigurationPutSchema.safeParse(input([
      provider("kimi", [MODEL_ID, MODEL_ID]),
    ]));
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: ["providers", 0, "enabled_model_ids"],
        message: "enabled_model_ids 不能重复",
      }),
    ]));
  });

  it("正常输入完成 trim、BigInt 转换与默认值", () => {
    const parsed = PrincipalAccessConfigurationPutSchema.parse({
      expected_version: 1,
      idempotency_key: "  12345678  ",
      providers: [
        provider(" kimi "),
        { provider_code: "deepseek", quota_value: "2000" },
      ],
    });
    expect(parsed.idempotency_key).toBe("12345678");
    expect(parsed.providers).toEqual([
      {
        provider_code: "kimi",
        quota_value: 1000n,
        allow_overage: false,
        valid_until: null,
        enabled_model_ids: [MODEL_ID],
      },
      {
        provider_code: "deepseek",
        quota_value: 2000n,
        allow_overage: false,
        valid_until: null,
        enabled_model_ids: [],
      },
    ]);
    expect(PrincipalAccessConfigurationPutSchema.parse({
      expected_version: 1,
      idempotency_key: "empty-provider-list",
    }).providers).toEqual([]);
  });

  it("额度字符串必须完整匹配非负整数", () => {
    for (const quotaValue of ["x100", "100x"]) {
      const parsed = PrincipalAccessConfigurationPutSchema.safeParse(input([{
        ...provider("kimi"),
        quota_value: quotaValue,
      }]));
      expect(parsed.success).toBe(false);
      if (parsed.success) continue;
      expect(parsed.error.issues[0]?.message).toBe("额度必须是非负整数字符串");
    }
  });
});
