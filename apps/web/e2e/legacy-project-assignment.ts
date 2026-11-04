/** Preserve the legacy assignment write contract without leaking employee usage into the current PROJECT read model. */
import type { Page } from "@playwright/test";
import { createKysely } from "../../../packages/database/src/index.js";
import { expect, apiGet, E2E_IDS } from "./fixtures";
export async function verifyLegacyProjectAssignment(page: Page) {
  const target = new URL(process.env.DATABASE_URL!);
  if (target.hostname !== "127.0.0.1" || !target.pathname.endsWith("_e2e")) throw new Error("dedicated local database required");
  const db = createKysely(target.toString());
  try {
    const scope = await db.selectFrom("principal").select("enterprise_id").where("id", "=", E2E_IDS.pool043Project).executeTakeFirstOrThrow();
    const unassigned = () => db.selectFrom("ledger_line as l")
      .innerJoin("principal as p", "p.id", "l.principal_id")
      .leftJoin("operating_bill_request_project_assignment as a", join => join.onRef("a.ai_request_id", "=", "l.ai_request_id").onRef("a.enterprise_id", "=", "l.enterprise_id"))
      .select("l.ai_request_id").distinct().where("l.enterprise_id", "=", scope.enterprise_id).where("p.type", "=", "EMPLOYEE")
      .where("l.created_at", ">=", new Date("2026-08-01T00:00:00+08:00")).where("l.created_at", "<", new Date("2026-09-01T00:00:00+08:00"))
      .where("a.id", "is", null).execute();
    const before = await unassigned(); expect(before.length).toBeGreaterThan(0);
    const status = await page.evaluate(async input => {
      const response = await fetch("/api/operating-bills/2026-08/project-assignments", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
        ai_request_id: input.request, project_principal_id: input.project, reason: "隔离E2E保留公开旧归属API合同，不冒充新版规则归集" }) });
      return response.status;
    }, { request: E2E_IDS.pool043FlashRequest, project: E2E_IDS.pool043Project });
    expect(status).toBe(204);
    expect((await unassigned()).length).toBe(before.length - 1);
    const assigned = await db.selectFrom("operating_bill_request_project_assignment").selectAll()
      .where("enterprise_id", "=", scope.enterprise_id).where("project_principal_id", "=", E2E_IDS.pool043Project).execute();
    expect(assigned).toHaveLength(1); expect(assigned[0]!.ai_request_id).toBe(E2E_IDS.pool043FlashRequest);
    const after = await apiGet<{ rows: unknown[]; allocationStatus: { enabled: boolean }; unallocated: unknown }>(page, "/operating-bills/2026-08/projects");
    expect(after).toMatchObject({ rows: [], allocationStatus: { enabled: false }, unallocated: null });
    await page.reload();
    await expect(page.getByText("没有项目账单记录", { exact: true })).toBeVisible();
  } finally { await db.destroy(); }
}
