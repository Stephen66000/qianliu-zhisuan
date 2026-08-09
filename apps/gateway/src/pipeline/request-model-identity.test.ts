import { describe, expect, it } from "vitest";

import type { PrincipalAuthResult } from "../auth/principal-auth.js";
import { resolveRequestModelIdentity } from "./request-model-identity.js";

const principal: PrincipalAuthResult = {
  principalId: "principal-1",
  enterpriseId: "enterprise-1",
  keyId: "key-1",
  allowedModelIds: ["model-stable-1"],
  authorizedModelId: "model-stable-1",
};

describe("POOL-043 请求模型身份", () => {
  it("同时冻结请求时 alias 与鉴权确认的稳定模型 ID", () => {
    expect(resolveRequestModelIdentity(principal, "ql-deepseek-v4-flash")).toEqual({
      unified_model: "ql-deepseek-v4-flash",
      unified_model_id: "model-stable-1",
    });
  });

  it("稳定模型 ID 缺失时 fail-closed，不生成可入账身份", () => {
    expect(resolveRequestModelIdentity({ ...principal, authorizedModelId: null }, "legacy-alias"))
      .toBeNull();
  });
});
