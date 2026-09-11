import { describe, expect, it } from "vitest";
import {
  calculateWecomSignature,
  decryptWecomMessage,
  encryptWecomMessage,
  verifyWecomSignature,
  WecomCryptoError,
} from "../wecom-crypto.js";

describe("WeCom Crypto Suite", () => {
  const token = "QianliuWecomToken2026Test";
  // 43 位 base64 key
  const encodingAesKey = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
  const corpId = "ww1234567890abcdef";

  describe("verifyWecomSignature & calculateWecomSignature", () => {
    it("正确计算并比对微信 SHA1 签名", () => {
      const timestamp = "1726041600";
      const nonce = "987654321";
      const data = "test_encrypt_payload";

      const signature = calculateWecomSignature(token, timestamp, nonce, data);
      expect(signature).toBeDefined();
      expect(typeof signature).toBe("string");

      const isValid = verifyWecomSignature(token, timestamp, nonce, data, signature);
      expect(isValid).toBe(true);

      const isInvalid = verifyWecomSignature(token, timestamp, nonce, data, "wrong_signature");
      expect(isInvalid).toBe(false);
    });
  });

  describe("encryptWecomMessage & decryptWecomMessage (Roundtrip)", () => {
    it("加密消息后能成功验签并解密还原 XML 与 CorpID", () => {
      const replyXml = `<xml><ToUserName><![CDATA[zhangsan]]></ToUserName><FromUserName><![CDATA[${corpId}]]></FromUserName><CreateTime>1726041600</CreateTime><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[你好，这是用量测试]]></Content></xml>`;

      const encrypted = encryptWecomMessage(token, encodingAesKey, corpId, replyXml);
      expect(encrypted.encrypt).toBeDefined();
      expect(encrypted.signature).toBeDefined();

      // 验证生成的签名合法
      const signValid = verifyWecomSignature(
        token,
        encrypted.timestamp,
        encrypted.nonce,
        encrypted.encrypt,
        encrypted.signature,
      );
      expect(signValid).toBe(true);

      // 解密密文
      const decrypted = decryptWecomMessage(encodingAesKey, encrypted.encrypt);
      expect(decrypted.message).toBe(replyXml);
      expect(decrypted.receiveId).toBe(corpId);
    });

    it("支持 GET URL 验证中的 echostr 加解密", () => {
      const echostr = "test_random_echostr_string_12345";
      const encrypted = encryptWecomMessage(token, encodingAesKey, corpId, echostr);

      const decrypted = decryptWecomMessage(encodingAesKey, encrypted.encrypt);
      expect(decrypted.message).toBe(echostr);
      expect(decrypted.receiveId).toBe(corpId);
    });
  });

  describe("Error handling", () => {
    it("当 EncodingAESKey 长度非 43 时抛出 WecomCryptoError", () => {
      expect(() => {
        decryptWecomMessage("too_short", "dummy_cipher");
      }).toThrowError(WecomCryptoError);

      expect(() => {
        encryptWecomMessage(token, "too_short", corpId, "msg");
      }).toThrowError(WecomCryptoError);
    });

    it("当密文被破坏或填充损坏时抛出 WecomCryptoError", () => {
      const corruptedBase64 = Buffer.from("corrupted_binary_data_with_32_bytes_len!!").toString("base64");
      expect(() => {
        decryptWecomMessage(encodingAesKey, corruptedBase64);
      }).toThrowError(WecomCryptoError);
    });
  });
});
