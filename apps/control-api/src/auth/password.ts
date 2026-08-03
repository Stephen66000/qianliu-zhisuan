/**
 * 密码哈希与校验 —— Argon2id（W02）。
 *
 * 依据：TRD §14.2 L781「密码哈希使用 Argon2id 或等价方案」。
 * 管理员只能重置密码，不能读取当前密码（TRD §14.1 L774）——因此只提供 hash/verify，不提供 decode。
 */
import argon2 from "argon2";

/** Argon2id 参数（一期 10 人量级，适中强度）。 */
const HASH_OPTS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19_456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
};

/** 哈希明文密码，返回 Argon2id 标准格式字符串（含盐、参数）。 */
export async function hashPassword(plaintext: string): Promise<string> {
  return argon2.hash(plaintext, HASH_OPTS);
}

/** 校验明文密码是否匹配哈希。 */
export async function verifyPassword(hash: string, plaintext: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plaintext);
  } catch {
    // 哈希格式无效等情况，统一返回 false（不泄露内部错误细节）
    return false;
  }
}

export const PASSWORD_POLICY_MESSAGE =
  "密码需为 12～128 位，并同时包含大写字母、小写字母、数字和特殊字符";

/** 管理员新密码统一策略；登录校验不受该策略影响，避免锁死历史账号。 */
export function isStrongPassword(plaintext: string): boolean {
  return (
    plaintext.length >= 12 &&
    plaintext.length <= 128 &&
    /[a-z]/.test(plaintext) &&
    /[A-Z]/.test(plaintext) &&
    /\d/.test(plaintext) &&
    /[^A-Za-z0-9]/.test(plaintext)
  );
}
