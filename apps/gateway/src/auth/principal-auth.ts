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
  /** 仅允许对应 unified_model.id；空数组表示不允许任何模型。 */
  allowedModelIds: string[];
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
        "principal_key.allowed_model_ids as allowed_model_ids",
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
      // 防御滚动升级或异常历史数据：NULL 也必须 fail-closed，绝不解释为“全部模型”。
      allowedModelIds: row.allowed_model_ids ?? [],
    };
  };
}

/**
 * 所有模型调用端点共用的 Key 模型硬门禁。
 * 放在 pipeline 前，拒绝请求不会创建 ai_request/attempt/usage/ledger，也不会访问上游。
 */
export function createModelAuthorization(db: Kysely<Database>) {
  return async function requireAllowedModel(
    req: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const body = req.body as { model?: unknown } | null;
    const model = body?.model;
    if (typeof model !== "string" || !req.principal) return;
    const allowed = req.principal.allowedModelIds;
    if (allowed.length === 0) return sendModelNotAllowed(reply, req, model);
    let query = db
      .selectFrom("unified_model")
      .select("id")
      .where("enterprise_id", "=", req.principal.enterpriseId)
      .where("alias", "=", model)
      .where("status", "=", "ACTIVE")
      .where("id", "in", allowed);
    const authorized = await query.executeTakeFirst();
    if (authorized) return;

    return sendModelNotAllowed(reply, req, model);
  };
}

function sendModelNotAllowed(reply: FastifyReply, req: FastifyRequest, model: string): void {
  reply
    .code(403)
    .header("x-request-id", req.requestId)
    .send({
      error: {
        message: `当前主体 Key 未获授权模型 ${model}`,
        type: "authentication_error",
        code: "model_not_allowed",
        param: "model",
        retryable: false,
        request_id: req.requestId,
      },
    });
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
