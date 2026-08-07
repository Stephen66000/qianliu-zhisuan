import type { AdapterResource } from "./index.js";

export function resolveFirstByteTimeoutMs(
  resource: AdapterResource,
  fallbackMs: number,
  resolver?: (resource: AdapterResource) => number,
): number {
  return resolver?.(resource) ?? fallbackMs;
}

export function resolveStreamIdleTimeoutMs(
  resource: AdapterResource,
  fallbackMs: number,
  resolver?: (resource: AdapterResource) => number,
): number {
  return resolver?.(resource) ?? fallbackMs;
}
