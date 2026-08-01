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
  /** 未提供扫描器的存储必须是 null，不能伪装成零命中。 */
  hits: Record<StorageKind, number | null>;
  scannedKinds: StorageKind[];
  unscannedKinds: StorageKind[];
  /** 是否四类存储都实际执行过扫描。 */
  complete: boolean;
  total: number;
  /** 仅表示 requiredKinds 均已扫描且零命中。 */
  passed: boolean;
}

/**
 * 跨多个存储扫描 canary 命中。
 * 默认期望 total === 0（passed = true）；任何非零命中即失败。
 */
export async function scanCanary(
  canary: string,
  sinks: CanarySink[],
  requiredKinds: readonly StorageKind[] = sinks.map((sink) => sink.kind),
): Promise<CanaryScanResult> {
  const hits: Record<StorageKind, number | null> = {
    postgres: null,
    redis: null,
    logs: null,
    traces: null,
  };
  for (const sink of sinks) {
    hits[sink.kind] = await sink.scan(canary);
  }
  const storageKinds: StorageKind[] = ["postgres", "redis", "logs", "traces"];
  const scannedKinds = storageKinds.filter((kind) => hits[kind] !== null);
  const unscannedKinds = storageKinds.filter((kind) => hits[kind] === null);
  const total = scannedKinds.reduce((sum, kind) => sum + (hits[kind] ?? 0), 0);
  const passed = requiredKinds.every((kind) => hits[kind] === 0);
  return {
    canary,
    hits,
    scannedKinds,
    unscannedKinds,
    complete: unscannedKinds.length === 0,
    total,
    passed,
  };
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
