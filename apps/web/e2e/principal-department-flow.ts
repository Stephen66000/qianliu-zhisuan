import type { Page, Locator } from "@playwright/test";
import { expect } from "./fixtures";

/** Department assignment moved from the name edit dialog into the versioned accounting-profile entry. */
export async function updatePrincipalDepartment(page: Page, row: Locator, department: string) {
  await row.getByRole("button", { name: "所属部门", exact: true }).click();
  await page.getByRole("combobox", { name: "所属部门", exact: true }).selectOption("");
  await page.getByRole("textbox", { name: "部门名称", exact: true }).fill(department);
  const saved = page.waitForResponse(response => response.url().endsWith("/accounting-profile") && response.request().method() === "PUT");
  await page.getByRole("button", { name: "保存归属", exact: true }).click();
  expect((await saved).status()).toBe(200);
  await expect(row).toContainText(department);
}
