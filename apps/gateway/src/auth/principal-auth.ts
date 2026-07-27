/**
 * principal-auth —— 下游 Key Bearer 校验（W05）。
 *
 * 依据：TRD §6.1 行 393「标准 Bearer Key」、§5.3（Key 校验顺序）、§15 行 828「下游 Key 无效立即拒绝，不访问上游」。
 * W05 简化：直接查 principal_key 表比对 HMAC digest（M1 已建表）。
 * 完整热路径（Redis 缓存 5 秒 TTL）在 W07 接入。
 */
import type { FastifyRequest, FastifyReply } from "fastify";
import type { Kysely } from "kysely";
import type { Database } from "@qianliu/database";
import { digestApiKey } from "@qianliu/provider-adapters";
import { fromClassification } from "../plugins/error-envelope.js";
import { ERROR_CLASSIFICATION } from "@qianliu/domain";

export interface PrincipalAuthResult {
  principalId: string;
  enterpriseId: string;
  keyId: string;
}

declare module "fastify" {
  interface FastifyRequest {
    principal?: PrincipalAuthResult;
  }
}

export function createPrincipalAuth(db: Kysely<Database>, pepper: string) {
  return async function requirePrincipalKey(
    req: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const auth = req.headers.authorization;
    const match = typeof auth === "string" ? auth.match(/^Bearer\s+(.+)$/i) : null;
    if (!match) {
      const err = fromClassification(
        ERROR_CLASSIFICATION.DOWNSTREAM_AUTH_OR_QUOTA,
        "invalid_principal_key",
        "缺少 Bearer Key",
        req.requestId,
      );
      return sendAuthError(reply, err);
    }
    const key = match[1]!;
    const digest = digestApiKey(key, pepper);

    // 查有效 Key（status=ACTIVE）
    const row = await db
      .selectFrom("principal_key")
      .innerJoin("principal", "principal.id", "principal_key.principal_id")
      .select([
        "principal_key.id as key_id",
        "principal_key.principal_id as principal_id",
        "principal.enterprise_id as enterprise_id",
        "principal.status as principal_status",
        "principal_key.status as key_status",
        "principal_key.expires_at as expires_at",
      ])
      .where("principal_key.key_digest", "=", digest)
      .executeTakeFirst();

    if (!row || row.key_status !== "ACTIVE") {
      const err = fromClassification(
        ERROR_CLASSIFICATION.DOWNSTREAM_AUTH_OR_QUOTA,
        "invalid_principal_key",
        "主体 Key 无效",
        req.requestId,
      );
      return sendAuthError(reply, err);
    }
    if (row.principal_status !== "ACTIVE") {
      const err = fromClassification(
        ERROR_CLASSIFICATION.DOWNSTREAM_AUTH_OR_QUOTA,
        "principal_disabled",
        "主体已停用",
        req.requestId,
      );
      return sendAuthError(reply, err);
    }
    if (row.expires_at && row.expires_at.getTime() < Date.now()) {
      const err = fromClassification(
        ERROR_CLASSIFICATION.DOWNSTREAM_AUTH_OR_QUOTA,
        "key_expired",
        "主体 Key 已过期",
        req.requestId,
      );
      return sendAuthError(reply, err);
    }

    req.principal = {
      principalId: row.principal_id,
      enterpriseId: row.enterprise_id,
      keyId: row.key_id,
    };
  };
}

function sendAuthError(reply: FastifyReply, err: ReturnType<typeof fromClassification>): void {
  reply
    .code(err.status)
    .header("x-request-id", err.requestId ?? "")
    .send({
      error: {
        message: err.message,
        type: err.type,
        code: err.code,
        param: null,
        retryable: err.retryable,
        request_id: err.requestId,
      },
    });
}
