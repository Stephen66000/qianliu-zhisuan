/**
 * PostgreSQL canary sink 工厂 —— 扫描 PG 表检测正文/Secret canary 命中（W07）。
 *
 * 依据：TRD §14.3 行 803、PoC persistence.mjs scanCanary PG 扫描模式。
 * 为避免 observability 包直接依赖 kysely，本工厂接受一个扫描函数（由 gateway 注入 kysely 查询实现）。
 */
import type { CanarySink } from "./canary.js";

/**
 * 扫描函数：给定 canary 字面量，返回在所有受扫描表中的命中总数。
 * 调用方（gateway）用 kysely 实现：跨表 row_to_json::text LIKE %canary%。
 */
export type PgScanFn = (canary: string) => Promise<number>;

/**
 * 创建 PG canary sink。
 * @param scanFn 扫描函数（由 gateway 注入 kysely 实现）
 */
export function createPgCanarySink(scanFn: PgScanFn): CanarySink {
  return {
    kind: "postgres",
    async scan(canary: string): Promise<number> {
      return scanFn(canary);
    },
  };
}
