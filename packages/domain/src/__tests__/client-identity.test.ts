import { describe, expect, it } from "vitest";
import { identifyClient } from "../client-identity.js";

describe("POOL-028 客户端身份识别", () => {
  it("归一显式声明但不把它标记为受信身份", () => {
    expect(identifyClient({ headers: { "x-client-id": "Codex/0.146.0" }, protocol: "responses" }))
      .toMatchObject({ family: "CODEX", version: "0.146.0", source: "DECLARED_HEADER", confidence: "DECLARED" });
  });

  it.each([
    ["WorkBuddy/1.8.2", "WORKBUDDY"],
    ["codex_cli_rs/0.146.0", "CODEX"],
    ["Z-Code 3.2.1", "ZCODE"],
    ["Claude-Code/2.0.0", "CLAUDE_CODE"],
    ["Qianliu_IDE/1.0.0", "QIANLIU_IDE"],
  ])("从已知 User-Agent %s 识别 %s", (userAgent, family) => {
    expect(identifyClient({ headers: { "user-agent": userAgent }, protocol: "chat" }))
      .toMatchObject({ family, source: "VERIFIED_USER_AGENT", confidence: "OBSERVED" });
  });

  it("未知和敏感原始值安全降级", () => {
    expect(identifyClient({ headers: {}, protocol: "chat" }).family).toBe("UNKNOWN");
    expect(identifyClient({ headers: { "x-client-id": "Bearer sk-secret" }, protocol: "chat" }))
      .toMatchObject({ rawClientId: null, family: "UNKNOWN" });
  });

  it("支持数组 Header、清理控制字符并限制原始标识长度", () => {
    const identity = identifyClient({
      headers: { "x-client-id": [`custom\nclient/${"1".repeat(80)}`] },
      protocol: "messages",
    });
    expect(identity).toMatchObject({ family: "OTHER", source: "DECLARED_HEADER" });
    expect(identity.rawClientId).toHaveLength(64);
  });

  it("仅在 Responses 协议下用 client_version 形成有限可信的 Codex 推断", () => {
    expect(identifyClient({
      headers: { "user-agent": "generic-client" },
      protocol: "responses",
      url: "/v1/responses?client_version=0.146.0",
    })).toMatchObject({
      rawClientId: "generic-client",
      family: "CODEX",
      version: "0.146.0",
      source: "PROTOCOL_FEATURE",
      confidence: "LIMITED",
    });

    expect(identifyClient({
      headers: { "user-agent": "generic-client/2.1" },
      protocol: "chat",
      url: "/v1/chat/completions?client_version=0.146.0",
    })).toMatchObject({ family: "OTHER", version: "2.1", confidence: "LIMITED" });
  });

  it("损坏 URL 与被过滤的版本参数安全降级", () => {
    expect(identifyClient({ headers: {}, protocol: "responses", url: "http://[" }))
      .toMatchObject({ family: "UNKNOWN", version: null, source: "NONE" });
    expect(identifyClient({
      headers: {},
      protocol: "responses",
      url: "/v1/responses?client_version=Bearer%20sk-secret",
    })).toMatchObject({ family: "CODEX", version: null, source: "PROTOCOL_FEATURE" });
  });
});
