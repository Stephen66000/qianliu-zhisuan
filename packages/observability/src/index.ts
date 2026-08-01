/**
 * @qianliu/observability — 日志、指标、Trace、canary 框架。
 *
 * W01 迁移 PoC observability.mjs 的 MetadataLogger 白名单机制和 scanCanary 零留存验证框架。
 * 语义保留，TypeScript 重写（PoC 是 .mjs，不直接搬）。
 * 依据：
 *   - PoC observability.mjs（MetadataLogger 白名单 11 字段）。
 *   - TRD §14.3 行 803（canary 扫 PG/Redis/日志/Trace 命中数为 0）。
 *   - 工程规则 §5（不得出现明文正文/Secret）。
 */
export { MetadataLogger } from "./logger.js";
export {
  type CanarySink,
  type CanaryScanResult,
  scanCanary,
  createLogSinkFromBuffer,
} from "./canary.js";
export { createPgCanarySink } from "./pg-canary-sink.js";
export {
  type GracefulShutdownController,
  type GracefulShutdownOptions,
  installGracefulShutdown,
} from "./graceful-shutdown.js";

export const OBSERVABILITY_VERSION = "0.3.0" as const;
