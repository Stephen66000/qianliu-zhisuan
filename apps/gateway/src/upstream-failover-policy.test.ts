import { describe, expect, it } from "vitest";
import { shouldAttemptUpstreamFailover } from "./upstream-failover-policy.js";

describe("Gateway 上游切换策略", () => {
  it.each([
    [false, undefined, "UPSTREAM_TEMPORARY", true],
    [false, undefined, "TRANSPORT_ERROR", true],
    [true, undefined, "UPSTREAM_TEMPORARY", false],
    [false, "FIRST_BYTE_TIMEOUT", "UPSTREAM_TEMPORARY", false],
    [false, "REQUEST_TIMEOUT", "CLIENT_INVALID", false],
    [false, "REQUEST_TIMEOUT", null, false],
  ] as const)(
    "committed=%s layer=%s classification=%s => %s",
    (committed, failureLayer, classification, expected) => {
      expect(shouldAttemptUpstreamFailover({ committed, failureLayer }, classification)).toBe(expected);
    },
  );
});
