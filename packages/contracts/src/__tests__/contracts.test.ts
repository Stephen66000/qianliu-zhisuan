import { describe, it, expect } from "vitest";
import {
  CONTRACTS_VERSION,
  NORTHBOUND_ENDPOINTS,
  CAPABILITY_MATRIX,
  UNSUPPORTED_POST_PATHS,
} from "../index.js";

describe("@qianliu/contracts baseline", () => {
  it("exposes version", () => {
    expect(CONTRACTS_VERSION).toBe("0.3.0");
  });

  it("北向对外端点包含官方 Codex Responses", () => {
    expect(NORTHBOUND_ENDPOINTS).toEqual([
      "GET /v1/models",
      "POST /v1/chat/completions",
      "POST /v1/messages",
      "POST /v1/responses",
    ]);
  });

  it("W23：协议能力矩阵冻结——启用集与拒绝集稳定，单一事实源", () => {
    // 原生：models + chat/messages 非流式/流式
    const native = CAPABILITY_MATRIX.filter((c) => c.support === "NATIVE");
    expect(native.map((c) => c.endpoint)).toEqual([
      "GET /v1/models",
      "POST /v1/chat/completions",
      "POST /v1/chat/completions#stream",
      "POST /v1/messages",
      "POST /v1/messages#stream",
    ]);
    expect(CAPABILITY_MATRIX.filter((c) => c.support === "TRANSFORMED")).toEqual([
      { endpoint: "POST /v1/responses", support: "TRANSFORMED" },
      { endpoint: "POST /v1/responses#stream", support: "TRANSFORMED" },
    ]);
    // 拒绝（UNSUPPORTED）：Embeddings/count_tokens(POST) + WebSocket
    const unsupported = CAPABILITY_MATRIX.filter((c) => c.support === "UNSUPPORTED");
    expect(unsupported.length).toBe(3);
    // POST 拒绝路径派生正确（gateway unsupported 路由用）
    expect(UNSUPPORTED_POST_PATHS).toEqual([
      "/v1/embeddings",
      "/v1/messages/count_tokens",
    ]);
  });
});
