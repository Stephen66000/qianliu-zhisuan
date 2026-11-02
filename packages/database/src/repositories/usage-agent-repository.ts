import { sql, type Kysely } from "kysely";
import type { Database } from "../kysely.js";

export async function summarizePrincipalAgents(db: Kysely<Database>, enterpriseId: string, principalId: string): Promise<AgentUsageSummary[]> {
    const result = await sql<{
      agent_family: string;
      latest_version: string | null;
      identity_source: string;
      identity_sources: string[];
      identity_confidence: string;
      first_used_at: Date;
      last_used_at: Date;
      request_count: bigint;
      total_tokens: bigint;
      total_api_cost: string;
      models: string[];
    }>`
      SELECT
        ar.agent_family,
        (array_agg(ar.agent_version ORDER BY ar.started_at DESC) FILTER (WHERE ar.agent_version IS NOT NULL))[1] AS latest_version,
        (array_agg(ar.agent_identity_source ORDER BY ar.started_at DESC))[1] AS identity_source,
        array_agg(DISTINCT ar.agent_identity_source ORDER BY ar.agent_identity_source) AS identity_sources,
        (array_agg(ar.agent_identity_confidence ORDER BY ar.started_at DESC))[1] AS identity_confidence,
        min(ar.started_at) AS first_used_at,
        max(ar.started_at) AS last_used_at,
        count(*) AS request_count,
        COALESCE(sum(lt.total_input_tokens + lt.total_output_tokens), 0) AS total_tokens,
        COALESCE(sum(lt.total_api_cost), 0)::text AS total_api_cost,
        array_agg(DISTINCT ar.unified_model) AS models
      FROM ai_request ar
      LEFT JOIN ledger_transaction lt
        ON lt.ai_request_id = ar.id AND lt.enterprise_id = ${enterpriseId}
      WHERE ar.enterprise_id = ${enterpriseId} AND ar.principal_id = ${principalId}
      GROUP BY ar.agent_family
      ORDER BY max(ar.started_at) DESC, ar.agent_family ASC
    `.execute(db);
    return result.rows.map((row) => ({
      agentFamily: row.agent_family,
      latestVersion: row.latest_version,
      identitySource: row.identity_source,
      identitySources: row.identity_sources,
      identityConfidence: row.identity_confidence,
      firstUsedAt: row.first_used_at.toISOString(),
      lastUsedAt: row.last_used_at.toISOString(),
      requestCount: row.request_count.toString(),
      totalTokens: row.total_tokens.toString(),
      totalApiCost: row.total_api_cost,
      models: row.models,
    }));
  }

export async function listExpectedAgentFamilies(db: Kysely<Database>, enterpriseId: string, principalId: string): Promise<string[]> {
    const rows = await db.selectFrom("principal_agent_expectation")
      .select("agent_family")
      .where("enterprise_id", "=", enterpriseId)
      .where("principal_id", "=", principalId)
      .orderBy("agent_family", "asc")
      .execute();
    return rows.map((row) => row.agent_family);
  }

export async function replaceExpectedAgentFamilies(db: Kysely<Database>, enterpriseId: string, principalId: string, families: string[]): Promise<string[]> {
    const unique = [...new Set(families)];
    await db.transaction().execute(async (trx) => {
      await trx.deleteFrom("principal_agent_expectation")
        .where("enterprise_id", "=", enterpriseId).where("principal_id", "=", principalId).execute();
      if (unique.length > 0) await trx.insertInto("principal_agent_expectation").values(
        unique.map((agentFamily) => ({ enterprise_id: enterpriseId, principal_id: principalId, agent_family: agentFamily })),
      ).execute();
    });
    return listExpectedAgentFamilies(db, enterpriseId, principalId);
  }
export interface AgentUsageSummary {
  agentFamily: string;
  latestVersion: string | null;
  identitySource: string;
  identitySources: string[];
  identityConfidence: string;
  firstUsedAt: string;
  lastUsedAt: string;
  requestCount: string;
  totalTokens: string;
  totalApiCost: string;
  models: string[];
}
