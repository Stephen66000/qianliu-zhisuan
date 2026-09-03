import { createHash } from "node:crypto";
import { mergeDeclaredModelIds } from "./employee-model-authorization-policy.js";

/** 规范化请求体（键序无关）用于幂等 hash。 */
export function stableHash(value: unknown): string {
  const normalize = (current: unknown): unknown => {
    if (current instanceof Date) return current.toISOString();
    if (current === null || typeof current !== "object") return current;
    if (Array.isArray(current)) return current.map(normalize);
    return Object.fromEntries(
      Object.entries(current as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, normalize(entry)]),
    );
  };
  return createHash("sha256").update(JSON.stringify(normalize(value))).digest("hex");
}

export function stableProviderCodes(currentProviders: string[], requestedProviders: string[]): string[] {
  return [...new Set([...currentProviders, ...requestedProviders])]
    .sort((left, right) => left.localeCompare(right, "en"));
}

/** 白名单重算：手工、受管开关与池内未禁用型号的并集。 */
export function computeAllowedModelIds(input: {
  manualIds: string[];
  managedAssignmentModelIds: string[];
  poolModelIds: string[];
  disabledModelIds: string[];
}): string[] {
  const disabled = new Set(input.disabledModelIds);
  const poolAllowed = input.poolModelIds.filter((id) => !disabled.has(id));
  return mergeDeclaredModelIds(
    mergeDeclaredModelIds(input.manualIds, input.managedAssignmentModelIds),
    poolAllowed,
  );
}
