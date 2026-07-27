/**
 * MetadataLogger — 白名单结构化日志。
 *
 * 只允许 11 个字段进入日志（迁移自 PoC observability.mjs）。
 * 其余字段在写入前过滤，防止正文/Secret 泄漏到日志。
 * 依据：TRD §14.3 行 799-801。
 */
import { LOG_WHITELIST_FIELDS, type LogWhitelistField } from "@qianliu/domain";

export type LogLevel = "debug" | "info" | "warn" | "error";

/** 白名单允许的字段集合。 */
const WHITELIST = new Set<string>(LOG_WHITELIST_FIELDS);

export interface LogEntry extends Partial<Record<LogWhitelistField, unknown>> {
  time: string;
  level: LogLevel;
  event: string;
}

/**
 * 白名单日志器。构造时给定写入函数（默认写到内存缓冲，便于 canary 扫描）。
 */
export class MetadataLogger {
  #sink: (line: string) => void;

  constructor(sink?: (line: string) => void) {
    this.#sink = sink ?? ((line: string) => process.stdout.write(line + "\n"));
  }

  /** 过滤非白名单字段后写入。fields 接受任意对象，运行时按白名单过滤。 */
  log(entry: Record<string, unknown>): void {
    const filtered: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(entry)) {
      if (WHITELIST.has(key)) {
        filtered[key] = value;
      }
    }
    // 强制补全必要字段
    filtered.time = filtered.time ?? new Date().toISOString();
    filtered.level = filtered.level ?? "info";
    this.#sink(JSON.stringify(filtered));
  }

  info(event: string, fields: Record<string, unknown> = {}): void {
    this.log({ time: new Date().toISOString(), level: "info", event, ...fields });
  }

  warn(event: string, fields: Record<string, unknown> = {}): void {
    this.log({ time: new Date().toISOString(), level: "warn", event, ...fields });
  }

  error(event: string, fields: Record<string, unknown> = {}): void {
    this.log({ time: new Date().toISOString(), level: "error", event, ...fields });
  }
}
