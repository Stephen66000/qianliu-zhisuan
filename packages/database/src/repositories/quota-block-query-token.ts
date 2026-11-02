import { createHash } from "node:crypto";
import type { Kysely, Transaction } from "kysely";
import { resolveProviderEndpoint } from "@qianliu/provider-adapters";
import { parseQuotaBlockState } from "@qianliu/domain";
import type { Database } from "../kysely.js";
import type { ProviderResourceRow } from "./resource-pool-repository.js";

/** 额度查询 token：GET 前捕获，提交时逐项匹配；任何一项变化都使旧结果失效。 */
export interface QuotaQueryToken {
  enterpriseId: string;
  resourceId: string;
  providerCode: string;
  resourceVersion: number;
  credentialVersion: number | null;
  quotaStateRevision: number;
  incidentId: string | null;
  endpointHash: string;
  queryStartedAt: string;
}

/** GET 前捕获结果：token + 调用方执行网络请求所需的资源事实。 */
export interface QuotaQueryCapture {
  token: QuotaQueryToken;
  credentialCiphertext: string | null;
  status: string;
}

export type QuotaCommitSupersededReason =
  | "RESOURCE_MISSING"
  | "PROVIDER_UNAVAILABLE"
  | "RESOURCE_VERSION_CHANGED"
  | "CREDENTIAL_ROTATED"
  | "QUOTA_REVISION_CHANGED"
  | "INCIDENT_CHANGED"
  | "ENDPOINT_CHANGED"
  | "RESOURCE_PREREQUISITE_CHANGED";

/** 实际额度端点配置哈希：capture 与 commit 各自重算，端点变化即 token 失配。 */
export function codingPlanQuotaEndpointHash(providerCode: string): string {
  const resolved = resolveProviderEndpoint({
    providerCode,
    resourceMode: "CODING_PLAN",
    operation: "CODING_PLAN_QUOTA",
  });
  return createHash("sha256")
    .update(resolved.ok ? resolved.url : `unresolved:${providerCode}`)
    .digest("hex")
    .slice(0, 16);
}

function isKimiOrZhipu(providerCode: string): providerCode is "kimi" | "zhipu" {
  return providerCode === "kimi" || providerCode === "zhipu";
}

function currentIncidentId(row: Pick<ProviderResourceRow, "quota_block_state">): string | null {
  if (row.quota_block_state === null) return null;
  const parsed = parseQuotaBlockState(row.quota_block_state);
  return parsed?.incidentId ?? null;
}

  /**
   * GET 前捕获 queryToken（计划§7）。资源不适用（非 CP、厂商停用/归档、无凭证）
   * 返回 null，调用方跳过本次查询。
   */
export async function captureQuotaQueryToken(db: Kysely<Database>, resourceId: string, now: Date = new Date()): Promise<QuotaQueryCapture | null> {
    const row = await db
      .selectFrom("provider_resource as resource")
      .innerJoin("provider as provider", "provider.id", "resource.provider_id")
      .selectAll("resource")
      .select(["provider.code as provider_code", "provider.status as provider_status", "provider.archived_at as provider_archived_at"])
      .where("resource.id", "=", resourceId)
      .executeTakeFirst();
    if (!row) return null;
    if (row.mode !== "CODING_PLAN") return null;
    if (row.provider_status !== "ACTIVE" || row.provider_archived_at !== null) return null;
    if (row.archived_at !== null) return null;
    const providerCode = row.provider_code.toLowerCase();
    if (!isKimiOrZhipu(providerCode)) return null;
    if (row.credential_ciphertext === null) return null;
    return {
      token: {
        enterpriseId: row.enterprise_id,
        resourceId: row.id,
        providerCode,
        resourceVersion: row.version,
        credentialVersion: row.credential_version,
        quotaStateRevision: Number(row.quota_state_revision),
        incidentId: currentIncidentId(row),
        endpointHash: codingPlanQuotaEndpointHash(providerCode),
        queryStartedAt: now.toISOString(),
      },
      credentialCiphertext: row.credential_ciphertext,
      status: row.status,
    };
  }

  /**
   * 提交事务内的 token 核验：锁资源 → provider FOR SHARE → 逐项比对。
   * 任何一项失配即 SUPERSEDED（仅元数据），不写当前事实。
   */
export async function verifyQuotaQueryTokenTx(
    trx: Transaction<Database>,
    token: QuotaQueryToken,
  ): Promise<{ row: ProviderResourceRow } | { reason: QuotaCommitSupersededReason }> {
    const row = await trx
      .selectFrom("provider_resource")
      .selectAll()
      .where("id", "=", token.resourceId)
      .forUpdate()
      .executeTakeFirst();
    if (!row) return { reason: "RESOURCE_MISSING" };
    const provider = await trx
      .selectFrom("provider")
      .select(["status", "archived_at"])
      .where("enterprise_id", "=", row.enterprise_id)
      .where("id", "=", row.provider_id)
      .forKeyShare()
      .executeTakeFirst();
    if (!provider || provider.status !== "ACTIVE" || provider.archived_at !== null) {
      return { reason: "PROVIDER_UNAVAILABLE" };
    }
    if (row.mode !== "CODING_PLAN" || row.archived_at !== null) {
      return { reason: "RESOURCE_PREREQUISITE_CHANGED" };
    }
    if (row.version !== token.resourceVersion) return { reason: "RESOURCE_VERSION_CHANGED" };
    if ((row.credential_version ?? null) !== token.credentialVersion) return { reason: "CREDENTIAL_ROTATED" };
    if (Number(row.quota_state_revision) !== token.quotaStateRevision) return { reason: "QUOTA_REVISION_CHANGED" };
    if (currentIncidentId(row) !== token.incidentId) return { reason: "INCIDENT_CHANGED" };
    if (codingPlanQuotaEndpointHash(token.providerCode) !== token.endpointHash) {
      return { reason: "ENDPOINT_CHANGED" };
    }
    return { row };
  }

  /** PG 冲突最多两次短事务重试（计划§7）；token 在重试事务内重新核验，不重复 GET。 */
export async function withQuotaCommitRetry<T>(work: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await work();
      } catch (error) {
        if (!isPgConflictError(error) || attempt === 2) return await Promise.reject(error);
        lastError = error;
      }
    }
    return await Promise.reject(lastError);
  }
function isPgConflictError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return code === "40001" || code === "40P01";
}
