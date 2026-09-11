import { describe, expect, it, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import {
  encryptWecomMessage,
  decryptWecomMessage,
  calculateWecomSignature,
} from "@qianliu/provider-adapters";
import { wecomCallbackRoutes } from "../callback-routes.js";

const TEST_TOKEN = "QianliuTestWecomToken1234";
const TEST_AES_KEY = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
const TEST_CORP_ID = "ww_test_corp_123456";

function extractXmlTag(xml: string, tag: string): string | null {
  const regex = new RegExp(`<${tag}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`, "i");
  const match = regex.exec(xml);
  return match ? match[1].trim() : null;
}

describe("WeCom Callback Routes", () => {
  let app: FastifyInstance;
  let mockDb: any;

  beforeEach(async () => {
    process.env.WECOM_CALLBACK_TOKEN = TEST_TOKEN;
    process.env.WECOM_CALLBACK_AES_KEY = TEST_AES_KEY;

    mockDb = {
      selectFrom: (table: string) => {
        const queryChain: any = {
          innerJoin: () => queryChain,
          select: () => queryChain,
          where: () => queryChain,
          executeTakeFirst: async () => {
            if (table.includes("person_external_identity")) {
              return {
                enterprise_id: "test-ent-id",
                person_id: "test-person-id",
                person_name: "张三",
                department_label: "技术研发部",
                email: "zhangsan@example.com",
              };
            }
            if (table.includes("principal")) {
              return {
                id: "test-principal-id",
                name: "张三 (AI员工)",
              };
            }
            if (table.includes("admin_user")) {
              return { id: "admin-id" };
            }
            return null;
          },
        };
        return queryChain;
      },
      transaction: () => ({
        setIsolationLevel: () => ({
          execute: async (fn: any) => {
            return fn({
              selectFrom: mockDb.selectFrom,
            });
          },
        }),
      }),
    };

    app = Fastify();
    app.addContentTypeParser(
      ["text/xml", "application/xml"],
      { parseAs: "string" },
      (_req, body, done) => {
        done(null, body);
      },
    );
    app.decorate("db", mockDb);
    await app.register(wecomCallbackRoutes);
    await app.ready();
  });

  describe("GET /api/wecom/callback (URL 验签)", () => {
    it("合法签名与 echostr 返回解密后的明文", async () => {
      const echostrRaw = "test_echostr_verification_123456";
      const encrypted = encryptWecomMessage(TEST_TOKEN, TEST_AES_KEY, TEST_CORP_ID, echostrRaw);

      const res = await app.inject({
        method: "GET",
        url: `/api/wecom/callback?msg_signature=${encrypted.signature}&timestamp=${encrypted.timestamp}&nonce=${encrypted.nonce}&echostr=${encodeURIComponent(encrypted.encrypt)}`,
      });

      expect(res.statusCode).toBe(200);
      expect(res.body).toBe(echostrRaw);
    });

    it("非法签名请求返回 401", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/wecom/callback?msg_signature=invalid_sign&timestamp=12345&nonce=67890&echostr=dummy",
      });
      expect(res.statusCode).toBe(401);
    });

    it("缺少参数时返回 400", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/wecom/callback?timestamp=12345",
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("POST /api/wecom/callback (消息接收与被动回复)", () => {
    it("非法签名请求返回 401", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/wecom/callback?msg_signature=invalid_sign&timestamp=12345&nonce=67890",
        headers: { "content-type": "application/xml" },
        payload: "<xml><Encrypt>dummy</Encrypt></xml>",
      });
      expect(res.statusCode).toBe(401);
    });

    it("普通问候文本消息返回小助手菜单提示", async () => {
      const msgXml = [
        "<xml>",
        `<ToUserName><![CDATA[${TEST_CORP_ID}]]></ToUserName>`,
        "<FromUserName><![CDATA[zhangsan_userid]]></FromUserName>",
        `<CreateTime>${Math.floor(Date.now() / 1000)}</CreateTime>`,
        "<MsgType><![CDATA[text]]></MsgType>",
        "<Content><![CDATA[你好，在吗？]]></Content>",
        "<MsgId>1234567890</MsgId>",
        "</xml>",
      ].join("");

      const encrypted = encryptWecomMessage(TEST_TOKEN, TEST_AES_KEY, TEST_CORP_ID, msgXml);
      const postBody = `<xml><Encrypt><![CDATA[${encrypted.encrypt}]]></Encrypt></xml>`;

      const res = await app.inject({
        method: "POST",
        url: `/api/wecom/callback?msg_signature=${encrypted.signature}&timestamp=${encrypted.timestamp}&nonce=${encrypted.nonce}`,
        headers: { "content-type": "application/xml" },
        payload: postBody,
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("application/xml");

      const replyEncrypt = extractXmlTag(res.body, "Encrypt");
      expect(replyEncrypt).toBeDefined();

      const decryptedReply = decryptWecomMessage(TEST_AES_KEY, replyEncrypt!);
      expect(decryptedReply.message).toContain("我是【仟流智算】AI 助手");
      expect(decryptedReply.message).toContain("今天我用了多少token");
    });

    it("未关联企微账号人员提问时返回友好引导", async () => {
      // 覆盖 mockDb 返回 null
      mockDb.selectFrom = () => ({
        innerJoin: () => mockDb.selectFrom(),
        select: () => mockDb.selectFrom(),
        where: () => mockDb.selectFrom(),
        executeTakeFirst: async () => null,
      });

      const msgXml = [
        "<xml>",
        `<ToUserName><![CDATA[${TEST_CORP_ID}]]></ToUserName>`,
        "<FromUserName><![CDATA[unregistered_user]]></FromUserName>",
        `<CreateTime>${Math.floor(Date.now() / 1000)}</CreateTime>`,
        "<MsgType><![CDATA[text]]></MsgType>",
        "<Content><![CDATA[今天我用了多少token]]></Content>",
        "<MsgId>1234567891</MsgId>",
        "</xml>",
      ].join("");

      const encrypted = encryptWecomMessage(TEST_TOKEN, TEST_AES_KEY, TEST_CORP_ID, msgXml);
      const postBody = `<xml><Encrypt><![CDATA[${encrypted.encrypt}]]></Encrypt></xml>`;

      const res = await app.inject({
        method: "POST",
        url: `/api/wecom/callback?msg_signature=${encrypted.signature}&timestamp=${encrypted.timestamp}&nonce=${encrypted.nonce}`,
        headers: { "content-type": "application/xml" },
        payload: postBody,
      });

      expect(res.statusCode).toBe(200);
      const replyEncrypt = extractXmlTag(res.body, "Encrypt")!;
      const decryptedReply = decryptWecomMessage(TEST_AES_KEY, replyEncrypt);

      expect(decryptedReply.message).toContain("未找到您企业微信账号");
    });
  });
});
