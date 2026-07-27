/**
 * 仟流密码学原语 —— 下游 Key 摘要与上游凭证信封加密。
 *
 * 依据：
 *   - TRD §5.3：下游 Key 用不可逆摘要 + Pepper（实现决策：HMAC-SHA256）。
 *   - TRD §5.4：上游凭证信封加密（实现决策：AES-256-GCM + 环境 KEK）。
 *   - PoC gateway-spike.mjs / app.mjs 的 HMAC 模式迁移。
 *
 * 安全约束：
 *   - Pepper/KEK 只从环境注入，不进仓库、不进日志。
 *   - Key 明文绝不返回到 digest 函数之外（调用方负责）。
 *   - 凭证密文 + 指纹可入库；明文只在 decrypt 时返回给 Adapter。
 */
import { createHmac, randomBytes, createCipheriv, createDecipheriv } from "node:crypto";

// ===== 下游 Key 摘要（HMAC-SHA256 + Pepper）=====

/**
 * 计算下游 Key 的不可逆摘要。
 * digest = HMAC-SHA256(pepper, key).hex()
 * 同一 key + 同一 pepper 产生同一摘要（可复算校验）。
 */
export function digestApiKey(key: string, pepper: string): string {
  return createHmac("sha256", pepper).update(key).digest("hex");
}

/**
 * 生成新的下游 Key 明文。
 * 格式：sk-qianliu- + 32 字节随机 base64url。
 * 调用方应在创建/重置后立即返回给客户端一次，DB 只存 digest。
 */
export function generateApiKey(): string {
  return `sk-qianliu-${randomBytes(32).toString("base64url")}`;
}

/** 取 Key 的可显示前缀（前 12 位，用于列表展示，不含完整 key）。 */
export function apiKeyPrefix(key: string): string {
  return key.slice(0, 12);
}

// ===== Session token（不透明 token + SHA-256 摘要存库）=====

/** 生成不透明 session token 明文。 */
export function generateSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

/** 计算 session token 的 SHA-256 摘要（存库）。 */
export function digestSessionToken(token: string): string {
  return createHmac("sha256", "session-token-salt").update(token).digest("hex");
}

// ===== 上游凭证信封加密（AES-256-GCM + 环境 KEK）=====

/** KEK 必须是 32 字节（256 bit）。从环境注入的 base64 字符串解码。 */
export function decodeKek(kekBase64: string): Buffer {
  const buf = Buffer.from(kekBase64, "base64");
  if (buf.length !== 32) {
    throw new Error(`CREDENTIAL_KEK must decode to 32 bytes, got ${buf.length}`);
  }
  return buf;
}

export interface EncryptedCredential {
  /** base64 密文。 */
  ciphertext: string;
  /** base64 nonce（12 字节）。 */
  nonce: string;
  /** base64 auth tag（16 字节）。 */
  tag: string;
}

/**
 * AES-256-GCM 加密上游凭证明文。
 * @param plaintext 凭证明文（如 DeepSeek API Key）
 * @param kek 32 字节 KEK（decodeKek 结果）
 */
export function encryptCredential(plaintext: string, kek: Buffer): EncryptedCredential {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", kek, nonce);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: encrypted.toString("base64"),
    nonce: nonce.toString("base64"),
    tag: tag.toString("base64"),
  };
}

/**
 * AES-256-GCM 解密上游凭证。仅 Adapter 内部调用。
 * @throws 当密文被篡改（tag 校验失败）时抛错。
 */
export function decryptCredential(enc: EncryptedCredential, kek: Buffer): string {
  const decipher = createDecipheriv("aes-256-gcm", kek, Buffer.from(enc.nonce, "base64"));
  decipher.setAuthTag(Buffer.from(enc.tag, "base64"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(enc.ciphertext, "base64")),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}

/** 计算凭证指纹（SHA-256 前 16 位 hex，用于列表展示，不可还原）。 */
export function credentialFingerprint(plaintext: string): string {
  return createHmac("sha256", "credential-fingerprint-salt")
    .update(plaintext)
    .digest("hex")
    .slice(0, 16);
}
