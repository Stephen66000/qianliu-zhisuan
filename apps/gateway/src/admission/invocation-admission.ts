import { sql, type Kysely } from "kysely";
import type { Database } from "@qianliu/database";

export interface InvocationIdentity {
  enterpriseId: string;
  principalId: string;
  keyId: string;
}

export interface InvocationCandidate {
  routeId?: string;
  resourceId: string;
  providerCode: string;
  upstreamModel: string;
  modelAlias: string;
}

export interface AdmissibleModel {
  id: string;
  alias: string;
  display_name: string;
}

interface AdmissionRow extends AdmissibleModel {
  route_id: string;
  resource_id: string;
  provider_code: string;
  upstream_model: string;
}

/**
 * Gateway 唯一准入查询。
 *
 * 模型列表与 Adapter 前最终栅栏必须复用同一组事实：Key/主体、模型白名单、
 * exact 或厂商池 Grant、生效期、池禁用型号，以及当前 Route/Resource/Provider。
 */
async function queryCurrentAdmissions(
  db: Kysely<Database>,
  identity: InvocationIdentity,
  candidate?: InvocationCandidate,
): Promise<AdmissionRow[]> {
  const now = new Date();
  const candidateFilter = candidate
    ? sql`
        AND um.alias = ${candidate.modelAlias}
        AND mr.provider_resource_id = ${candidate.resourceId}::uuid
        AND mr.upstream_model = ${candidate.upstreamModel}
        AND pv.code = ${candidate.providerCode}
        ${candidate.routeId ? sql`AND mr.id = ${candidate.routeId}::uuid` : sql``}
      `
    : sql``;

  const result = await sql<AdmissionRow>`
    SELECT DISTINCT
      um.id,
      um.alias,
      um.display_name,
      mr.id AS route_id,
      pr.id AS resource_id,
      pv.code AS provider_code,
      mr.upstream_model
    FROM principal_key pk
    JOIN principal p
      ON p.id = pk.principal_id
     AND p.enterprise_id = pk.enterprise_id
    JOIN unified_model um
      ON um.enterprise_id = pk.enterprise_id
     AND pk.allowed_model_ids ? um.id::text
    JOIN model_route mr
      ON mr.enterprise_id = um.enterprise_id
     AND mr.unified_model_id = um.id
    JOIN provider_resource pr
      ON pr.enterprise_id = mr.enterprise_id
     AND pr.id = mr.provider_resource_id
    JOIN provider pv
      ON pv.enterprise_id = pr.enterprise_id
     AND pv.id = pr.provider_id
    WHERE pk.id = ${identity.keyId}::uuid
      AND pk.enterprise_id = ${identity.enterpriseId}::uuid
      AND pk.principal_id = ${identity.principalId}::uuid
      AND pk.status = 'ACTIVE'
      AND (pk.expires_at IS NULL OR pk.expires_at > ${now})
      AND p.status = 'ACTIVE'
      AND um.status = 'ACTIVE'
      AND mr.enabled = TRUE
      AND pv.status = 'ACTIVE'
      AND (
        pr.status IN ('ACTIVE', 'DEGRADED')
        OR (
          pr.status IN ('RATE_LIMITED', 'UNAVAILABLE')
          AND pr.cooldown_until IS NOT NULL
          AND pr.cooldown_until <= ${now}
        )
      )
      AND (
        EXISTS (
          SELECT 1
          FROM principal_grant exact_grant
          WHERE exact_grant.enterprise_id = pk.enterprise_id
            AND exact_grant.principal_id = pk.principal_id
            AND exact_grant.provider = pv.code
            AND exact_grant.model_alias = um.alias
            AND exact_grant.pool_model_alias IS NULL
            AND exact_grant.status = 'ACTIVE'
            AND exact_grant.valid_from <= ${now}
            AND (exact_grant.valid_until IS NULL OR exact_grant.valid_until > ${now})
        )
        OR (
          EXISTS (
            SELECT 1
            FROM principal_grant pool_grant
            WHERE pool_grant.enterprise_id = pk.enterprise_id
              AND pool_grant.principal_id = pk.principal_id
              AND pool_grant.provider = pv.code
              AND pool_grant.pool_model_alias = '*'
              AND pool_grant.status = 'ACTIVE'
              AND pool_grant.valid_from <= ${now}
              AND (pool_grant.valid_until IS NULL OR pool_grant.valid_until > ${now})
          )
          AND NOT EXISTS (
            SELECT 1
            FROM principal_provider_disabled_model disabled_model
            WHERE disabled_model.enterprise_id = pk.enterprise_id
              AND disabled_model.principal_id = pk.principal_id
              AND disabled_model.provider = pv.code
              AND disabled_model.unified_model_id = um.id
          )
        )
      )
      ${candidateFilter}
    ORDER BY um.alias, mr.id
  `.execute(db);
  return result.rows;
}

export async function listCurrentInvocableModels(
  db: Kysely<Database>,
  identity: InvocationIdentity,
): Promise<AdmissibleModel[]> {
  const rows = await queryCurrentAdmissions(db, identity);
  const unique = new Map(rows.map((row) => [row.id, {
    id: row.id,
    alias: row.alias,
    display_name: row.display_name,
  }]));
  return [...unique.values()];
}

export async function hasCurrentInvocationAdmission(
  db: Kysely<Database>,
  identity: InvocationIdentity,
  candidate: InvocationCandidate,
): Promise<boolean> {
  const rows = await queryCurrentAdmissions(db, identity, candidate);
  return rows.length > 0;
}
