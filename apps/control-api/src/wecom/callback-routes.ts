import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { z } from "zod";
import {
  decryptWecomMessage,
  encryptWecomMessage,
  verifyWecomSignature,
  WecomCryptoError,
} from "@qianliu/provider-adapters";
import { handleWecomMessage } from "./message-handler.js";

function extractXmlTag(xml: string, tag: string): string | null {
  const regex = new RegExp(`<${tag}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`, "i");
  const match = regex.exec(xml);
  return match && match[1] !== undefined ? match[1].trim() : null;
}

const WecomGetQuerySchema = z.object({
  msg_signature: z.string().min(1),
  timestamp: z.string().min(1),
  nonce: z.string().min(1),
  echostr: z.string().min(1),
});

const WecomPostQuerySchema = z.object({
  msg_signature: z.string().min(1),
  timestamp: z.string().min(1),
  nonce: z.string().min(1),
});

export const wecomCallbackRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  // 1. GET /api/wecom/callback: 企业微信后台“设置 API 接收” URL 验签
  app.get("/api/wecom/callback", async (req, reply) => {
    const token = process.env.WECOM_CALLBACK_TOKEN;
    const encodingAesKey = process.env.WECOM_CALLBACK_AES_KEY;

    if (!token || !encodingAesKey) {
      app.log.error("WECOM_CALLBACK_TOKEN 或 WECOM_CALLBACK_AES_KEY 未配置");
      return reply.code(500).send("WeCom callback credentials not configured");
    }

    const parsed = WecomGetQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send("Invalid query parameters");
    }

    const { msg_signature, timestamp, nonce, echostr } = parsed.data;

    const isValid = verifyWecomSignature(token, timestamp, nonce, echostr, msg_signature);
    if (!isValid) {
      app.log.warn({ query: req.query }, "企业微信 GET 回调签名验证失败");
      return reply.code(401).send("Invalid signature");
    }

    try {
      const decrypted = decryptWecomMessage(encodingAesKey, echostr);
      reply.type("text/plain").send(decrypted.message);
    } catch (err) {
      app.log.error({ err }, "企业微信 echostr 解密失败");
      return reply.code(400).send("Decryption failed");
    }
  });

  // 2. POST /api/wecom/callback: 接收用户消息并被动回复
  app.post("/api/wecom/callback", async (req, reply) => {
    const token = process.env.WECOM_CALLBACK_TOKEN;
    const encodingAesKey = process.env.WECOM_CALLBACK_AES_KEY;

    if (!token || !encodingAesKey) {
      app.log.error("WECOM_CALLBACK_TOKEN 或 WECOM_CALLBACK_AES_KEY 未配置");
      return reply.code(500).send("WeCom callback credentials not configured");
    }

    const parsedQuery = WecomPostQuerySchema.safeParse(req.query);
    if (!parsedQuery.success) {
      return reply.code(400).send("Invalid query parameters");
    }

    const { msg_signature, timestamp, nonce } = parsedQuery.data;
    const rawXml = typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? "");

    const encrypt = extractXmlTag(rawXml, "Encrypt");
    if (!encrypt) {
      app.log.warn("企微消息 XML 缺少 Encrypt 标签");
      return reply.code(400).send("Missing Encrypt in body");
    }

    const isValid = verifyWecomSignature(token, timestamp, nonce, encrypt, msg_signature);
    if (!isValid) {
      app.log.warn("企业微信 POST 回调签名验证失败");
      return reply.code(401).send("Invalid signature");
    }

    let decryptedMsg: string;
    let receiveId: string;
    try {
      const decrypted = decryptWecomMessage(encodingAesKey, encrypt);
      decryptedMsg = decrypted.message;
      receiveId = decrypted.receiveId;
    } catch (err) {
      app.log.error({ err }, "企微消息解密失败");
      return reply.code(400).send("Decryption failed");
    }

    const fromUserName = extractXmlTag(decryptedMsg, "FromUserName");
    const toUserName = extractXmlTag(decryptedMsg, "ToUserName");
    const msgType = extractXmlTag(decryptedMsg, "MsgType");
    const content = extractXmlTag(decryptedMsg, "Content") ?? "";

    if (!fromUserName || !toUserName) {
      return reply.code(200).send("success");
    }

    let replyText = "";
    if (msgType === "text") {
      replyText = await handleWecomMessage(app.db, fromUserName, content);
    } else {
      replyText = "您好！目前支持接收文字消息，例如发送「今天我用了多少token」查询消耗。";
    }

    // 构造被动回复明文 XML
    const createTime = Math.floor(Date.now() / 1000);
    const replyXml = [
      "<xml>",
      `<ToUserName><![CDATA[${fromUserName}]]></ToUserName>`,
      `<FromUserName><![CDATA[${toUserName}]]></FromUserName>`,
      `<CreateTime>${createTime}</CreateTime>`,
      "<MsgType><![CDATA[text]]></MsgType>",
      `<Content><![CDATA[${replyText}]]></Content>`,
      "</xml>",
    ].join("");

    try {
      const encryptedReply = encryptWecomMessage(token, encodingAesKey, receiveId, replyXml);
      const responseXml = [
        "<xml>",
        `<Encrypt><![CDATA[${encryptedReply.encrypt}]]></Encrypt>`,
        `<MsgSignature><![CDATA[${encryptedReply.signature}]]></MsgSignature>`,
        `<TimeStamp>${encryptedReply.timestamp}</TimeStamp>`,
        `<Nonce><![CDATA[${encryptedReply.nonce}]]></Nonce>`,
        "</xml>",
      ].join("");

      reply.type("application/xml").send(responseXml);
    } catch (err) {
      app.log.error({ err }, "企微回复消息加密失败");
      reply.code(200).send("success");
    }
  });
};
