import { describe, expect, it } from "vitest";
import { assemblePrincipalAccessReadModel } from "./principal-access-read-model.js";

const createdAt = new Date("2026-08-09T00:00:00.000Z");
const model = (provider: string, id: string) => ({
  unified_model_id: id,
  display_name: `${provider}-${id}`,
  alias: `alias-${id}`,
  provider_code: provider,
  provider_name: provider.toUpperCase(),
  provider_resource_id: `resource-${id}`,
  resource_name: `Resource ${id}`,
  mode: "API" as const,
  resource_status: "ACTIVE",
  model_status: "ACTIVE",
  route_enabled: true,
  ready: true,
  unavailable_reasons: [],
});

describe("POOL-039 principal access read-model mutation contract", () => {
  it("assembles pool state, disabled models, totals and an authorized Key", () => {
    const result = assemblePrincipalAccessReadModel({
      principal: { id: "principal", name: "A", status: "ACTIVE", department_label: "R&D" },
      key: { key_prefix: "sk-ql", status: "ACTIVE", created_at: createdAt },
      models: [model("alpha", "a"), model("alpha", "blocked"), model("beta", "b")],
      pools: [{
        id: "grant-alpha", provider: "alpha", quota_value: 10n, used_value: 12n,
        allow_overage: true, valid_until: null, source: "MANAGED_SINGLE",
      }],
      disabledKeys: new Set(["alpha:blocked"]),
      manualPendingIds: ["manual"],
      configVersion: 7,
    });
    expect(result).toEqual({
      principal: { id: "principal", name: "A", status: "ACTIVE", department_label: "R&D" },
      key: {
        key_prefix: "sk-ql", status: "ACTIVE", created_at: createdAt,
        authorization_status: "AUTHORIZED",
      },
      providers: [{
        provider_code: "alpha", provider_name: "ALPHA",
        pool: {
          grant_id: "grant-alpha", quota_value: "10", quota_used: "12", allow_overage: true,
          valid_until: null, source: "MANAGED_SINGLE", over_limit: true,
        },
        models: [
          expect.objectContaining({ unified_model_id: "a", enabled: true, resource_mode: "API" }),
          expect.objectContaining({ unified_model_id: "blocked", enabled: false }),
        ],
      }, {
        provider_code: "beta", provider_name: "BETA", pool: null,
        models: [expect.objectContaining({ unified_model_id: "b", enabled: false })],
      }],
      summary: { total_quota: "10", provider_count: 1, model_count: 1 },
      manual_pending_takeover: ["manual"],
      config_version: 7,
    });
  });

  it("returns a pending or absent Key when no model is enabled", () => {
    const base = {
      principal: { id: "principal", name: "A", status: "ACTIVE", department_label: null },
      models: [model("alpha", "a")], pools: [], disabledKeys: new Set<string>(),
      manualPendingIds: [], configVersion: 1,
    };
    expect(assemblePrincipalAccessReadModel({ ...base, key: undefined }).key).toBeNull();
    expect(assemblePrincipalAccessReadModel({
      ...base, key: { key_prefix: "sk-ql", status: "ACTIVE", created_at: createdAt },
    }).key).toMatchObject({ authorization_status: "PENDING" });
  });

  it("does not mark a pool over-limit when usage exactly equals quota", () => {
    const result = assemblePrincipalAccessReadModel({
      principal: { id: "principal", name: "A", status: "ACTIVE", department_label: null },
      key: undefined,
      models: [model("alpha", "a")],
      pools: [{
        id: "grant-alpha", provider: "alpha", quota_value: 10n, used_value: 10n,
        allow_overage: false, valid_until: null, source: "MANAGED_BATCH",
      }],
      disabledKeys: new Set(), manualPendingIds: [], configVersion: 1,
    });
    expect(result.providers[0]?.pool?.over_limit).toBe(false);
  });
});
