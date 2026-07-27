/**
 * scanCanary — 零留存验证框架。
 *
 * W01 迁移 PoC persistence.mjs scanCanary 跨四存储扫描机制。
 * 用唯一 canary 字面量扫描 PostgreSQL/Redis/日志/Trace，命中数必须为 0。
 * 依据：TRD §14.3 行 803、§16 行 878；PRD §15 行 583。
 *
 * W01 只提供框架与日志 sink 扫描；PG/Redis sink 在 M2 集成测试接入。
 */

export type StorageKind = "postgres" | "redis" | "logs" | "traces";

/** 单个存储的扫描器接口。返回 canary 在该存储的命中数。 */
export interface CanarySink {
  kind: StorageKind;
  scan(canary: string): Promise<number>;
}

export interface CanaryScanResult {
  canary: string;
  hits: Record<StorageKind, number>;
  total: number;
  passed: boolean; // total === 0
}

/**
 * 跨多个存储扫描 canary 命中。
 * 默认期望 total === 0（passed = true）；任何非零命中即失败。
 */
export async function scanCanary(
  canary: string,
  sinks: CanarySink[],
): Promise<CanaryScanResult> {
  const hits: Record<StorageKind, number> = {
    postgres: 0,
    redis: 0,
    logs: 0,
    traces: 0,
  };
  for (const sink of sinks) {
    hits[sink.kind] = await sink.scan(canary);
  }
  const total = hits.postgres + hits.redis + hits.logs + hits.traces;
  return { canary, hits, total, passed: total === 0 };
}

/**
 * 日志 canary sink：扫描内存缓冲的日志文本。
 * 用于在测试中捕获 MetadataLogger 写入的日志并扫描 canary。
 */
export function createLogSinkFromBuffer(buffer: { text(): string }): CanarySink {
  return {
    kind: "logs",
    async scan(canary: string): Promise<number> {
      return buffer.text().includes(canary) ? 1 : 0;
    },
  };
}
