import type { Database } from "@qianliu/database";
import type { Kysely } from "kysely";

/** Display only: keep raw declarations and all accounting inputs unchanged. */
export async function archivedResourceModels(db: Kysely<Database>, enterpriseId: string) {
  const rows = await db.selectFrom("model_route as route")
    .innerJoin("unified_model as model", "model.id", "route.unified_model_id")
    .select(["route.provider_resource_id", "route.upstream_model", "model.archived_at"])
    .where("route.enterprise_id", "=", enterpriseId)
    .where("model.enterprise_id", "=", enterpriseId).execute();
  const grouped = new Map<string, Map<string, boolean>>();
  for (const row of rows) {
    const models = grouped.get(row.provider_resource_id) ?? new Map<string, boolean>();
    // A shared upstream remains visible while any associated unified model is not archived.
    models.set(row.upstream_model, (models.get(row.upstream_model) ?? true) && row.archived_at !== null);
    grouped.set(row.provider_resource_id, models);
  }
  return new Map([...grouped].map(([id, models]) => [id,
    new Set([...models].filter(([, archived]) => archived).map(([name]) => name))]));
}
