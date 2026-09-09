import type { FastifyInstance } from "fastify";
import { requireAuth } from "../plugins/auth-guard.js";
export function registerReferenceRoutes(app: FastifyInstance) {
  app.get("/reference-data/providers", { preHandler: [requireAuth] }, async req => ({ providers: await app.db.selectFrom("provider")
    .select(["id", "code", "name"]).where("enterprise_id", "=", req.admin!.enterpriseId).execute() }));
  app.get("/reference-data/resources", { preHandler: [requireAuth] }, async req => ({ resources: await app.db.selectFrom("provider_resource")
    .select(["id", "provider_id", "name", "mode", "status"]).where("enterprise_id", "=", req.admin!.enterpriseId).execute() }));
  app.get("/reference-data/models", { preHandler: [requireAuth] }, async req => ({ models: await app.db.selectFrom("unified_model")
    .select(["id", "alias", "display_name", "archived_at"]).where("enterprise_id", "=", req.admin!.enterpriseId).execute() }));
  app.get("/reference-data/principals", { preHandler: [requireAuth] }, async req => ({ principals: await app.db.selectFrom("principal")
    .select(["id", "name", "type", "status", "archived_at"]).where("enterprise_id", "=", req.admin!.enterpriseId).execute() }));
}
