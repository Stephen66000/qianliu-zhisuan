/**
 * EG-02（gate-supplement run2）定向补充：api-cost-estimation 防御回退分支的最小
 * 单元覆盖（不触数据库，stub 驱动）。
 *
 * 覆盖合同明文的防御语义（与折单前行为一致的回退，不另发明行为）：
 *   - loadApiCostEstimation：count(*) 聚合恒返回一行（空集为 0），缺行只能是驱动层
 *     异常 → api_cost_estimation_aggregate_row_missing（L326-327 防御 throw）；
 *   - loadApiCostEstimationByResource：unnest 驱动保证每请求资源恰一行；缺行 →
 *     EMPTY_ESTIMATE_AGGREGATE / amounts '[]' / basis '[]' 等价回退（L445-447）；
 *   - 批量入口空清单 → 空 Map（L377）与清单去重（L376 Set）。
 */
import { describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import type { Database } from "../kysely.js";
import { loadApiCostEstimation, loadApiCostEstimationByResource } from "./api-cost-estimation.js";

/** 最小驱动 stub：sql``.execute(db) 一律返回给定行集（绕过真实连接）。 */
function stubDb(rows: unknown[]): Kysely<Database> {
  // sql``.execute(db) 调 db.getExecutor() 取执行器，再 transformQuery → compileQuery
  // → executeQuery（与 kysely RawBuilder #getExecutor/#compile 契约一致）。
  return {
    getExecutor: () => ({
      transformQuery: (node: unknown) => node,
      compileQuery: (node: unknown) => node,
      executeQuery: async () => ({ rows }),
    }),
  } as unknown as Kysely<Database>;
}

const start = new Date("2026-09-01T00:00:00+08:00");
const end = new Date("2026-10-01T00:00:00+08:00");

describe("api-cost-estimation 防御回退（EG-02 定向）", () => {
  it("单资源版：聚合行缺失（驱动层异常）→ api_cost_estimation_aggregate_row_missing", async () => {
    const db = stubDb([]);
    await expect(loadApiCostEstimation(db, "00000000-0000-0000-0000-000000000001", {
      start, end,
    })).rejects.toThrow("api_cost_estimation_aggregate_row_missing");
  });

  it("批量版：驱动行缺失 → 每请求资源回退 EMPTY_ESTIMATE_AGGREGATE＋空 amounts/basis", async () => {
    const db = stubDb([]);
    const idA = "00000000-0000-0000-0000-00000000000a";
    const result = await loadApiCostEstimationByResource(db, "00000000-0000-0000-0000-000000000001", {
      start, end, resourceIds: [idA],
    });
    expect(result.size).toBe(1);
    const estimation = result.get(idA);
    expect(estimation).toBeDefined();
    expect(estimation!.scope).toEqual({
      enterpriseId: "00000000-0000-0000-0000-000000000001", resourceIds: [idA],
    });
    expect(estimation!.period).toEqual({ start, end });
    // 空聚合 = 期间无任何 API 行 → KNOWN_COMPLETE＋空 amounts，与逐资源空期间同语义。
    expect(estimation!.completeness).toBe("KNOWN_COMPLETE");
    expect(estimation!.amounts).toEqual([]);
    expect(estimation!.gaps).toEqual([]);
    expect(estimation!.priceBasis).toEqual([]);
    expect(estimation!.excludedNoRecordedCost).toBe(0);
  });

  it("批量版：空清单 → 空 Map；重复清单去重为单条目", async () => {
    const emptyDb = stubDb([]);
    const idA = "00000000-0000-0000-0000-00000000000a";
    await expect(loadApiCostEstimationByResource(emptyDb, "00000000-0000-0000-0000-000000000001", {
      start, end, resourceIds: [],
    })).resolves.toEqual(new Map());

    // 去重后 unnest 只驱动一次；缺行回退使重复 id 仍映射到同一 EMPTY 估计。
    const result = await loadApiCostEstimationByResource(emptyDb, "00000000-0000-0000-0000-000000000001", {
      start, end, resourceIds: [idA, idA],
    });
    expect(result.size).toBe(1);
    expect(result.get(idA)!.completeness).toBe("KNOWN_COMPLETE");
  });
});
