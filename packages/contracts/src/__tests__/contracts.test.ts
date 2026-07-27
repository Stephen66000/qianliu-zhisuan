import { describe, it, expect } from "vitest";
import { CONTRACTS_VERSION, NORTHBOUND_ENDPOINTS } from "../index.js";

describe("@qianliu/contracts baseline", () => {
  it("exposes version", () => {
    expect(CONTRACTS_VERSION).toBe("0.3.0");
  });

  it("一期对外端点固定为三个", () => {
    expect(NORTHBOUND_ENDPOINTS).toEqual([
      "GET /v1/models",
      "POST /v1/chat/completions",
      "POST /v1/messages",
    ]);
  });
});
