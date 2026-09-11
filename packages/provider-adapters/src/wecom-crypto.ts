import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export interface DecryptedWecomPayload {
  message: string;
  receiveId: string;
}

export interface EncryptedWecomReply {
  encrypt: string;
  signature: string;
  timestamp: string;
  nonce: string;
}

export class WecomCryptoError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = "WecomCryptoError";
  }
}

/**
 * 校验企业微信签名 (SHA1 字典序拼接)。
 * 适用于 GET /api/wecom/callback (echostr) 或 POST /api/wecom/callback (encrypt)。
 */
export function verifyWecomSignature(
  token: string,
  timestamp: string,
  nonce: string,
  data: string,
  expectedSignature: string,
): boolean {
  const sorted = [token, timestamp, nonce, data].sort().join("");
  const actual = createHash("sha1").update(sorted).digest("hex");
  return actual === expectedSignature;
}

/**
 * 计算企业微信签名
 */
export function calculateWecomSignature(
  token: string,
  timestamp: string,
  nonce: string,
  data: string,
): string {
  const sorted = [token, timestamp, nonce, data].sort().join("");
  return createHash("sha1").update(sorted).digest("hex");
}

function deriveKeyAndIv(encodingAesKey: string): { key: Buffer; iv: Buffer } {
  if (typeof encodingAesKey !== "string" || encodingAesKey.length !== 43) {
    throw new WecomCryptoError("EncodingAESKey 必须是 43 位字符串", "INVALID_AES_KEY");
  }
  const key = Buffer.from(`${encodingAesKey}=`, "base64");
  if (key.length !== 32) {
    throw new WecomCryptoError("解码后的 AES Key 长度必须为 32 字节", "INVALID_KEY_LENGTH");
  }
  const iv = key.subarray(0, 16);
  return { key, iv };
}

/**
 * 解密企业微信加密消息 (AES-256-CBC, PKCS#7 填充)。
 * 返回包含明文 XML/字符串与接收端 ID (CorpID)。
 */
export function decryptWecomMessage(
  encodingAesKey: string,
  encryptedBase64: string,
): DecryptedWecomPayload {
  const { key, iv } = deriveKeyAndIv(encodingAesKey);
  const cipherBuffer = Buffer.from(encryptedBase64, "base64");

  let decrypted: Buffer;
  try {
    const decipher = createDecipheriv("aes-256-cbc", key, iv);
    decipher.setAutoPadding(false);
    decrypted = Buffer.concat([decipher.update(cipherBuffer), decipher.final()]);
  } catch (err) {
    throw new WecomCryptoError(
      `AES 解密失败: ${err instanceof Error ? err.message : String(err)}`,
      "DECRYPTION_FAILED",
    );
  }

  // 去除 PKCS#7 填充 (块大小为 32 字节)
  if (decrypted.length === 0) {
    throw new WecomCryptoError("解密内容为空", "EMPTY_BUFFER");
  }
  const pad = decrypted[decrypted.length - 1];
  if (pad === undefined || pad < 1 || pad > 32) {
    throw new WecomCryptoError("PKCS#7 填充长度无效", "INVALID_PADDING");
  }
  const unpadded = decrypted.subarray(0, decrypted.length - pad);

  if (unpadded.length < 20) {
    throw new WecomCryptoError("解密内容长度不足 20 字节", "INVALID_BUFFER_LENGTH");
  }

  // 协议结构：16 字节随机串 + 4 字节网络字节序长度 + msgContent + receiveId
  const msgLength = unpadded.readUInt32BE(16);
  if (20 + msgLength > unpadded.length) {
    throw new WecomCryptoError("解密内容标称长度超过缓冲区边界", "BUFFER_OVERFLOW");
  }

  const message = unpadded.subarray(20, 20 + msgLength).toString("utf8");
  const receiveId = unpadded.subarray(20 + msgLength).toString("utf8");

  return { message, receiveId };
}

/**
 * 加密企业微信被动回复消息 (AES-256-CBC, PKCS#7 补齐 32 字节块)。
 */
export function encryptWecomMessage(
  token: string,
  encodingAesKey: string,
  receiveId: string,
  replyXml: string,
  timestamp: string = String(Math.floor(Date.now() / 1000)),
  nonce: string = randomBytes(8).toString("hex"),
): EncryptedWecomReply {
  const { key, iv } = deriveKeyAndIv(encodingAesKey);

  const random16 = randomBytes(16);
  const msgBuffer = Buffer.from(replyXml, "utf8");
  const lengthBuffer = Buffer.alloc(4);
  lengthBuffer.writeUInt32BE(msgBuffer.length, 0);
  const receiveIdBuffer = Buffer.from(receiveId, "utf8");

  const rawBuffer = Buffer.concat([random16, lengthBuffer, msgBuffer, receiveIdBuffer]);

  // PKCS#7 补位到 32 字节整数倍
  const pad = 32 - (rawBuffer.length % 32);
  const padBuffer = Buffer.alloc(pad, pad);
  const toEncrypt = Buffer.concat([rawBuffer, padBuffer]);

  const cipher = createCipheriv("aes-256-cbc", key, iv);
  cipher.setAutoPadding(false);
  const encrypted = Buffer.concat([cipher.update(toEncrypt), cipher.final()]).toString("base64");

  const signature = calculateWecomSignature(token, timestamp, nonce, encrypted);

  return {
    encrypt: encrypted,
    signature,
    timestamp,
    nonce,
  };
}
