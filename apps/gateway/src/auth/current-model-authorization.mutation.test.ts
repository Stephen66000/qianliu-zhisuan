import { describe, expect, it } from "vitest";

import {
  getCurrentInvocationAuthorization,
  hasCurrentInvocationAuthorization,
} from "./current-model-authorization.js";

type Comparison = [unknown, unknown, unknown];

interface AuthorizationTrace {
  comparisons: Comparison[];
  innerJoins: string[];
  innerJoinRefs: Comparison[];
  isolationLevels: string[];
  selectFrom: unknown[];
  selections: unknown[];
  whereRefs: Comparison[];
}

const DEFAULT_BILLING_RULE = {
  id: "billing-rule", rule_type: "API_PRICE", rule_version: "v1",
  provider_resource_id: "resource", upstream_model: "kimi-k3",
  effective_from: new Date(0), effective_to: null, timezone: "Asia/Shanghai",
  days_of_week: null, start_time: null, end_time: null, time_windows: null,
  multiplier: null, cache_hit_price: "0.000001", cache_miss_price: "0.000001",
  output_price: "0.000001", currency: "CNY", priority: 100,
};

class AuthorizationQuery {
  constructor(
    private readonly trace: AuthorizationTrace,
    private readonly result: Record<string, unknown> | null,
    private readonly table: string,
    private readonly billingRules: unknown[] = [DEFAULT_BILLING_RULE],
  ) {}

  innerJoin(table: string, left: unknown, _right?: unknown) {
    this.trace.innerJoins.push(table);
    if (typeof left === "function") {
      const join = {
        onRef: (_left: unknown, _operator: unknown, _right: unknown) => join,
        on: (_left: unknown, _operator: unknown, _right: unknown) => join,
      };
      left(join);
    } else {
      this.trace.innerJoinRefs.push([left, "=", _right]);
    }
    return this;
  }

  select(selection: unknown) {
    this.trace.selections.push(selection);
    return this;
  }
  distinct() { return this; }
  whereRef(left: unknown, operator: unknown, right: unknown) {
    this.trace.whereRefs.push([left, operator, right]);
    return this;
  }

  where(column: unknown, operator?: unknown, value?: unknown) {
    if (typeof column === "function") column(this.expressionBuilder());
    else this.trace.comparisons.push([column, operator, value]);
    return this;
  }

  private expressionBuilder() {
    const builder = Object.assign(
      (column: unknown, operator: unknown, value: unknown) => {
        const comparison: Comparison = [column, operator, value];
        this.trace.comparisons.push(comparison);
        return comparison;
      },
      {
        and: (values: unknown[]) => values,
        or: (values: unknown[]) => values,
        not: (value: unknown) => value,
        exists: (value: unknown) => value,
        ref: (value: unknown) => ({ ref: value }),
        selectFrom: (table: string) => {
          this.trace.selectFrom.push(table);
          return new AuthorizationQuery(this.trace, this.result, table, this.billingRules);
        },
      },
    );
    return builder;
  }

  executeTakeFirst() {
    return Promise.resolve(this.result);
  }

  execute() {
    if (this.table === "billing_rule") return Promise.resolve(this.billingRules);
    if (this.table !== "principal_key") return Promise.resolve([]);
    if (this.result === null) return Promise.resolve([]);
    return Promise.resolve(this.billingRules.map((rule) => {
      const billing = rule as typeof DEFAULT_BILLING_RULE;
      return {
        ...(this.result as Record<string, unknown>),
        billing_rule_id: billing.id,
        billing_rule_type: billing.rule_type,
        billing_rule_version: billing.rule_version,
        billing_provider_resource_id: billing.provider_resource_id,
        billing_upstream_model: billing.upstream_model,
        billing_effective_from: billing.effective_from,
        billing_effective_to: billing.effective_to,
        billing_timezone: billing.timezone,
        billing_days_of_week: billing.days_of_week,
        billing_start_time: billing.start_time,
        billing_end_time: billing.end_time,
        billing_time_windows: billing.time_windows,
        billing_multiplier: billing.multiplier,
        billing_cache_hit_price: billing.cache_hit_price,
        billing_cache_miss_price: billing.cache_miss_price,
        billing_output_price: billing.output_price,
        billing_currency: billing.currency,
        billing_priority: billing.priority,
      };
    }));
  }
}

function fakeDb(
  result: Record<string, unknown> | null,
  billingRules: unknown[] = [DEFAULT_BILLING_RULE],
) {
  const trace: AuthorizationTrace = {
    comparisons: [], innerJoins: [], innerJoinRefs: [], isolationLevels: [], selectFrom: [], selections: [], whereRefs: [],
  };
  const db = {
    selectFrom: (table: string) => {
        trace.selectFrom.push(table);
        return new AuthorizationQuery(trace, result, table, billingRules);
      },
    transaction: () => ({
      setIsolationLevel: (level: string) => {
        trace.isolationLevels.push(level);
        return ({
        execute: (work: (trx: unknown) => Promise<unknown>) => work(db),
        });
      },
    }),
  };
  return { trace, db };
}

const AUTH_INPUT = {
  enterpriseId: "enterprise",
  principalId: "principal",
  keyId: "key",
  modelAlias: "ql-k3",
  providerCode: "kimi",
  resourceId: "resource",
  upstreamModel: "kimi-k3",
  now: new Date("2026-08-09T12:00:00.000Z"),
};

describe("POOL-039 current authorization mutation contract", () => {
  it("keeps the exact Grant alias tied to the current unified model alias", async () => {
    const result = {
      allowed_model_ids: ["model-id"], expires_at: null, model_id: "model-id", resource_mode: "API",
    };
    const { db, trace } = fakeDb(result);
    const now = AUTH_INPUT.now;

    await expect(getCurrentInvocationAuthorization(db as never, AUTH_INPUT))
      .resolves.toMatchObject({ billingRule: { id: "billing-rule", ruleVersion: "v1" } });
    expect(trace.isolationLevels).toEqual(["repeatable read"]);

    expect(trace.selectFrom).toEqual(["principal_key", "principal_provider_disabled_model"]);
    expect(trace.innerJoins).toContain("billing_rule");
    expect(trace.innerJoinRefs).toContainEqual([
      "billing_rule.enterprise_id", "=", "unified_model.enterprise_id",
    ]);
    expect(trace.selections.flat()).toContain("billing_rule.id as billing_rule_id");
    expect(trace.comparisons).toEqual(expect.arrayContaining([
      ["principal_key.id", "=", "key"],
      ["principal_key.enterprise_id", "=", "enterprise"],
      ["principal_key.principal_id", "=", "principal"],
      ["principal_key.status", "=", "ACTIVE"],
      ["principal.status", "=", "ACTIVE"],
      ["model_route.provider_resource_id", "=", "resource"],
      ["model_route.upstream_model", "=", "kimi-k3"],
      ["billing_rule.enabled", "=", true],
      ["billing_rule.effective_from", "<=", now],
      ["billing_rule.effective_to", "is", null],
      ["billing_rule.effective_to", ">", now],
      ["billing_rule.provider_resource_id", "is", null],
      ["billing_rule.provider_resource_id", "=", { ref: "provider_resource.id" }],
      ["billing_rule.upstream_model", "is", null],
      ["billing_rule.upstream_model", "=", { ref: "model_route.upstream_model" }],
      ["provider_resource.mode", "=", "API"],
      ["billing_rule.rule_type", "=", "API_PRICE"],
      ["billing_rule.cache_hit_price", "is not", null],
      ["billing_rule.cache_miss_price", "is not", null],
      ["billing_rule.output_price", "is not", null],
      ["provider_resource.mode", "=", "CODING_PLAN"],
      ["billing_rule.rule_type", "in", ["TIME_WINDOW", "MODEL_TIER"]],
      ["billing_rule.multiplier", "is not", null],
      ["principal_grant.valid_from", "<=", now],
      ["principal_grant.valid_until", "is", null],
      ["principal_grant.valid_until", ">", now],
      ["principal_grant.pool_model_alias", "is", null],
      ["principal_grant.model_alias", "=", { ref: "unified_model.alias" }],
      ["principal_grant.pool_model_alias", "=", "*"],
      ["principal_provider_disabled_model.principal_id", "=", "principal"],
    ]));
  });

  it("fails closed for empty API prices and accepts every individual price field", async () => {
    const authorization = {
      allowed_model_ids: ["model-id"], expires_at: null, model_id: "model-id", resource_mode: "API",
    };
    for (const [field, expected] of [
      [null, false],
      ["cache_hit_price", true],
      ["cache_miss_price", true],
      ["output_price", true],
    ] as const) {
      const rule = {
        ...DEFAULT_BILLING_RULE,
        cache_hit_price: null,
        cache_miss_price: null,
        output_price: null,
        ...(field ? { [field]: "0.000001" } : {}),
      };
      const { db } = fakeDb(authorization, [rule]);
      await expect(hasCurrentInvocationAuthorization(db as never, AUTH_INPUT)).resolves.toBe(expected);
    }
  });

  it("applies CODING_PLAN multiplier windows instead of treating any rule as current", async () => {
    const authorization = {
      allowed_model_ids: ["model-id"], expires_at: null, model_id: "model-id",
      resource_mode: "CODING_PLAN",
    };
    const baseRule = {
      ...DEFAULT_BILLING_RULE,
      rule_type: "MODEL_TIER",
      multiplier: "1",
      cache_hit_price: null,
      cache_miss_price: null,
      output_price: null,
    };
    const allowed = fakeDb(authorization, [baseRule]);
    await expect(hasCurrentInvocationAuthorization(allowed.db as never, AUTH_INPUT)).resolves.toBe(true);

    const excluded = fakeDb(authorization, [{
      ...baseRule,
      rule_type: "TIME_WINDOW",
      days_of_week: [1],
      start_time: "00:00",
      end_time: "23:59",
    }]);
    await expect(hasCurrentInvocationAuthorization(excluded.db as never, AUTH_INPUT)).resolves.toBe(false);
  });

  it("fails closed for missing, expired and empty-model authorization and preserves rule windows", async () => {
    await expect(hasCurrentInvocationAuthorization(fakeDb(null).db as never, AUTH_INPUT))
      .resolves.toBe(false);
    await expect(hasCurrentInvocationAuthorization(fakeDb({
      allowed_model_ids: ["model-id"], expires_at: AUTH_INPUT.now,
      model_id: "model-id", resource_mode: "API",
    }).db as never, AUTH_INPUT)).resolves.toBe(false);
    await expect(hasCurrentInvocationAuthorization(fakeDb({
      allowed_model_ids: [], expires_at: null,
      model_id: "model-id", resource_mode: "API",
    }).db as never, AUTH_INPUT)).resolves.toBe(false);

    const futureExpiry = new Date(AUTH_INPUT.now.getTime() + 1);
    const window = {
      timezone: "Asia/Shanghai", days_of_week: [7],
      start_time: "19:00", end_time: "21:00",
    };
    const current = fakeDb({
      allowed_model_ids: ["model-id"], expires_at: futureExpiry,
      model_id: "model-id", resource_mode: "API",
    }, [{
      ...DEFAULT_BILLING_RULE,
      timezone: null, days_of_week: null, start_time: null, end_time: null,
      time_windows: [window],
    }]);
    await expect(getCurrentInvocationAuthorization(current.db as never, AUTH_INPUT))
      .resolves.toMatchObject({
        billingRule: {
          timeWindows: [{
            timezone: "Asia/Shanghai", daysOfWeek: [7],
            startTime: "19:00", endTime: "21:00",
          }],
        },
      });
  });
});
