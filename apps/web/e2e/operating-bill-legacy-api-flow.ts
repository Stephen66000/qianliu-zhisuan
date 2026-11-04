/** Retired UI controls stay retired; public legacy value/close APIs retain their financial regression. */
import { writeFile } from "node:fs/promises";
import type { Page, TestInfo } from "@playwright/test";
import { createKysely } from "../../../packages/database/src/index.js";
import { expect, apiGet } from "./fixtures";
import type { OperatingBill } from "../src/api/operating-bills";

export async function verifyLegacyOperatingBillApi(page: Page, testInfo: TestInfo) {
  const url = new URL(process.env.DATABASE_URL!);
  if (url.hostname !== "127.0.0.1" || !url.pathname.endsWith("_e2e")) throw new Error("isolated local database required");
  const call = async (path: string, method: string, body: unknown = {}) => page.evaluate(async input => {
    const response = await fetch(`/api${input.path}`, { method: input.method, headers: { "content-type": "application/json" }, body: JSON.stringify(input.body) });
    return { status: response.status, body: await response.json() };
  }, { path, method, body });
  const created = await call("/operating-bills/2026-07/value-items", "POST", { title: "E2E 客户项目按期验收", value_type: "MONETARY", amount: "100000", evidence_ref: "E2E-POOL-025-验收单" });
  expect(created.status).toBe(201); expect(created.body.item.status).toBe("PENDING");
  const confirmed = await call(`/operating-bill-value-items/${created.body.item.id}/confirm`, "POST");
  expect(confirmed.status).toBe(200); expect(confirmed.body.item.status).toBe("CONFIRMED");
  const bill = await apiGet<OperatingBill>(page, "/operating-bills/2026-07");
  expect(bill.providers.length).toBeGreaterThan(0);
  for (const provider of bill.providers) expect((await call(`/operating-bills/2026-07/resource-confirmations/${provider.providerResourceId}`, "PUT", { status: "CONFIRMED", note: "隔离E2E历史资源事实确认" })).status).toBe(200);
  const closed = await call("/operating-bills/2026-07/close", "POST", { allow_incomplete: true, note: "E2E 授权结账；测试夹具中缺失的厂商历史事实已作为例外冻结" });
  expect(closed.status).toBe(200); expect(closed.body).toMatchObject({ status: "CLOSED", version: 1 });
  const frozen = await apiGet<OperatingBill>(page, "/operating-bills/2026-07");
  expect(frozen).toMatchObject({ status: "CLOSED", version: 1 });
  expect(frozen.values).toEqual(expect.arrayContaining([expect.objectContaining({ title: "E2E 客户项目按期验收", status: "CONFIRMED" })]));
  const refused = await call("/operating-bills/2026-07/value-items", "POST", { title: "冻结后不得追加", value_type: "MONETARY", amount: "1", evidence_ref: "synthetic" });
  expect(refused.status).toBe(409); expect(refused.body.error).toBe("bill_closed");
  const db = createKysely(url.toString());
  try {
    const period = await db.selectFrom("operating_bill_period").selectAll().where("period_month", "=", "2026-07-01").executeTakeFirstOrThrow();
    expect(period.status).toBe("CLOSED"); expect(period.current_version).toBe(1);
    const facts = await db.selectFrom("operating_bill_version").select(["version", "snapshot"]).where("period_id", "=", period.id).execute();
    expect(facts).toHaveLength(1); expect(facts[0]!.version).toBe(1);
    const values = await db.selectFrom("operating_bill_value_item").select(["title", "status", "amount"]).where("period_id", "=", period.id).execute();
    expect(values).toEqual(expect.arrayContaining([expect.objectContaining({ title: "E2E 客户项目按期验收", status: "CONFIRMED" })]));
    expect(values.some(item => item.title === "冻结后不得追加")).toBe(false);
    await writeFile(testInfo.outputPath("retired-ui-public-value-close-api-evidence.json"), JSON.stringify({ source: "ISOLATED_E2E_AUTHENTICATED_REAL_HTTP_AND_DATABASE", productionAcceptance: false, created, confirmed, closed, refused, period, facts, values }, null, 2));
  } finally { await db.destroy(); }
}
