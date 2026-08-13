import { afterEach, describe, expect, it, vi } from "vitest";
import type { Kysely } from "kysely";
import type { Database } from "@qianliu/database";
import { buildControlApi } from "./server.js";

const featureFlagNames = [
  "FEATURE_DIRECTORY_IMPORT",
  "FEATURE_USAGE_OVERVIEW_V2",
  "FEATURE_DEPARTMENT_COST",
  "FEATURE_RESOURCE_UTILIZATION_V2",
  "FEATURE_PROCUREMENT_REVIEW",
] as const;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("2.0 Feature Flag 回退", () => {
  it("关闭后不注册新增 API，1.0 API 仍在", async () => {
    vi.stubEnv("NODE_ENV", "development");
    for (const name of featureFlagNames) vi.stubEnv(name, "false");
    const app = buildControlApi({} as Kysely<Database>);
    try {
      await app.ready();
      expect(app.hasRoute({ method: "GET", url: "/usage" })).toBe(true);
      expect(app.hasRoute({ method: "GET", url: "/principals/:id" })).toBe(true);

      expect(app.hasRoute({ method: "GET", url: "/usage/overview" })).toBe(false);
      expect(app.hasRoute({ method: "POST", url: "/directory-sync-runs" })).toBe(false);
      expect(app.hasRoute({ method: "GET", url: "/organization-units" })).toBe(false);
      expect(app.hasRoute({ method: "GET", url: "/department-budgets/:departmentId/:month" })).toBe(false);
      expect(app.hasRoute({ method: "GET", url: "/provider-resources/utilization" })).toBe(false);
      expect(app.hasRoute({ method: "GET", url: "/procurement-reviews/:month" })).toBe(false);
    } finally {
      await app.close();
    }
  });
});
