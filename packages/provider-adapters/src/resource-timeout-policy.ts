/**
 * 资源级超时策略解析边界。
 * 调用方可按资源覆盖首字节/流空闲超时；未覆盖时回落到统一运行时默认值。
 */
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
