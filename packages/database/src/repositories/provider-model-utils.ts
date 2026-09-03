import type { Kysely, Selectable } from "kysely";
import { sql } from "kysely";
import type { Database, UnifiedModelTable } from "../kysely.js";

type UnifiedModel = Selectable<UnifiedModelTable>;

export function stableModelAlias(providerCode: string, upstreamModel: string, displayName?: string): string {
  const base = displayName ?? upstreamModel;
  const slug = base.toLowerCase().replace(/[^a-z0-9.]+/g, "-").replace(/^-|-$/g, "");
  return `ql-${slug}`.slice(0, 64);
}

export async function mergeDiscoveredCapabilities(
  trx: Kysely<Database>,
  enterpriseId: string,
  unified: UnifiedModel,
  discovered: string[],
): Promise<UnifiedModel> {
  const merged = [...new Set([...(unified.required_capabilities ?? []), ...discovered])].sort();
  const current = [...(unified.required_capabilities ?? [])].sort();
  if (merged.length === current.length && merged.every((value, index) => value === current[index])) {
    return unified;
  }
  return trx.updateTable("unified_model").set({
    required_capabilities: JSON.stringify(merged) as unknown as string[],
    version: sql`version + 1`,
    updated_at: new Date(),
  }).where("enterprise_id", "=", enterpriseId).where("id", "=", unified.id)
    .returningAll().executeTakeFirstOrThrow();
}
