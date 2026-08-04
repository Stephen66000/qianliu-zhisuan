import type { AdapterResource } from "./index.js";

export function resolveFirstByteTimeoutMs(
  resource: AdapterResource,
  fallbackMs: number,
  resolver?: (resource: AdapterResource) => number,
): number {
  return resolver?.(resource) ?? fallbackMs;
}
