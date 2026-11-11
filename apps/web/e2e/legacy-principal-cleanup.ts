/** Physical cleanup remains allowed only for a synthetic legacy principal with zero accounting/usage history. */
import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { createKysely } from "../../../packages/database/src/index.js";
import { expect, E2E_IDS } from "./fixtures";
export async function verifyEmptyLegacyPrincipalCleanup(page: Page) {
  const target = new URL(process.env.DATABASE_URL!);
  if (target.hostname !== "127.0.0.1" || !target.pathname.endsWith("_e2e")) throw new Error("dedicated local database required");
  const db = createKysely(target.toString());
  const id = randomUUID();
  try {
    const scope = await db.selectFrom("principal").select("enterprise_id").where("id", "=", E2E_IDS.principal).executeTakeFirstOrThrow();
    await db.insertInto("principal").values({ id, enterprise_id: scope.enterprise_id, type: "EMPLOYEE", name: "POOL009 无用量无归属旧制夹具" }).execute();
    await page.reload();
    const row = page.getByRole("row", { name: /POOL009 无用量无归属旧制夹具/ });
    await row.getByRole("button", { name: "清理", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "删除主体", exact: true })).toBeVisible();
    await expect(dialog).toContainText("没有请求、Usage 或账本历史");
    await dialog.getByRole("button", { name: "确认删除", exact: true }).click();
    await expect(row).toHaveCount(0);
    expect(await db.selectFrom("principal").select("id").where("id", "=", id).executeTakeFirst()).toBeUndefined();
  } finally { await db.destroy(); }
}
