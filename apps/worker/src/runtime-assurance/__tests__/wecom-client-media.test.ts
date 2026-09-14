import { describe, expect, it } from "vitest";
import { WecomAppClient, type EndpointConfig } from "../wecom-client.js";
import { encryptCredential } from "@qianliu/provider-adapters";

describe("WecomAppClient Media & Message Extension", () => {
  const kekBase64 = "ZGV2LW9ubHkta2VrLXJlcGxhY2UtaW4tcGlsb3QAAAA="; // 32 bytes base64
  const kek = Buffer.from(kekBase64, "base64");

  const secretPlain = "test_corp_secret_123456";
  const encryptedSecret = encryptCredential(secretPlain, kek);

  const endpoint: EndpointConfig = {
    id: "ep-test-1",
    corp_id: "ww_corp_test",
    agent_id: "1000002",
    secret_ciphertext: JSON.stringify(encryptedSecret),
    secret_fingerprint: "fp_test_123",
  };

  it("uploadMedia: 成功上传图片临时素材并返回 media_id", async () => {
    const mockFetch = async (url: URL | RequestInfo, _init?: RequestInit): Promise<Response> => {
      const urlStr = url.toString();
      if (urlStr.includes("/cgi-bin/gettoken")) {
        return new Response(JSON.stringify({ errcode: 0, access_token: "mock_tok_1", expires_in: 7200 }));
      }
      if (urlStr.includes("/cgi-bin/media/upload")) {
        expect(urlStr).toContain("type=image");
        expect(urlStr).toContain("access_token=mock_tok_1");
        return new Response(JSON.stringify({
          errcode: 0,
          errmsg: "ok",
          type: "image",
          media_id: "media_test_abc_123",
          created_at: String(Date.now()),
        }));
      }
      throw new Error(`Unexpected url: ${urlStr}`);
    };

    const client = new WecomAppClient(kekBase64, mockFetch as unknown as typeof fetch);
    const dummyImage = Buffer.from("fake_png_data");
    const mediaId = await client.uploadMedia(endpoint, dummyImage, "report.png");

    expect(mediaId).toBe("media_test_abc_123");
  });

  it("sendImageMessage: 成功发送图片消息", async () => {
    let messageBody: { text?: { content?: string } } | null = null;
    const mockFetch = async (url: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
      const urlStr = url.toString();
      if (urlStr.includes("/cgi-bin/gettoken")) {
        return new Response(JSON.stringify({ errcode: 0, access_token: "mock_tok_1", expires_in: 7200 }));
      }
      if (urlStr.includes("/cgi-bin/message/send")) {
        messageBody = JSON.parse(init?.body as string);
        return new Response(JSON.stringify({ errcode: 0, errmsg: "ok", msgid: "msg_987654" }));
      }
      throw new Error(`Unexpected url: ${urlStr}`);
    };

    const client = new WecomAppClient(kekBase64, mockFetch as unknown as typeof fetch);
    const result = await client.sendImageMessage(endpoint, ["user1", "user2"], "media_test_abc_123");

    expect(result.status).toBe("SENT");
    expect(result.providerMessageId).toBe("msg_987654");
    expect(messageBody).toEqual({
      touser: "user1|user2",
      msgtype: "image",
      agentid: 1000002,
      image: { media_id: "media_test_abc_123" },
      safe: 0,
    });
  });

  it("sendTextMessage: 成功发送文字消息", async () => {
    let messageBody: { text?: { content?: string } } | null = null;
    const mockFetch = async (url: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
      const urlStr = url.toString();
      if (urlStr.includes("/cgi-bin/gettoken")) {
        return new Response(JSON.stringify({ errcode: 0, access_token: "mock_tok_1", expires_in: 7200 }));
      }
      if (urlStr.includes("/cgi-bin/message/send")) {
        messageBody = JSON.parse(init?.body as string);
        return new Response(JSON.stringify({ errcode: 0, errmsg: "ok", msgid: "msg_112233" }));
      }
      throw new Error(`Unexpected url: ${urlStr}`);
    };

    const client = new WecomAppClient(kekBase64, mockFetch as unknown as typeof fetch);
    const result = await client.sendTextMessage(endpoint, ["admin_user"], "测试日报摘要");

    expect(result.status).toBe("SENT");
    expect(messageBody.text.content).toBe("测试日报摘要");
  });
});
