import type { Kysely } from "kysely";
import type { Database } from "../kysely.js";
import { migrateDown } from "../migrator.js";

/**
 * 回滚到指定迁移，返回按回滚顺序排列的迁移名（含目标迁移本身）。
 *
 * 回滚链测试只关心「目标迁移及其之前的守卫链」，不应把当时的迁移头写死：
 * `migrateDown` 返回的是**最后一个已应用**的迁移，因此只要仓库继续新增迁移
 * （例如资金账本初始化的 `0078`），写死 `0072` 作为首个回滚项就会失效，
 * 而这类失效与被测的守卫语义无关。
 *
 * 用法：
 *   const rolledBack = await rollbackTo(db, "0072_admin_roles_security");
 *   expect(rolledBack.at(-1)).toBe("0072_admin_roles_security");
 */
export async function rollbackTo(db: Kysely<Database>, target: string): Promise<string[]> {
  const rolledBack: string[] = [];
  for (let guard = 0; guard < 500; guard += 1) {
    const name = await migrateDown(db);
    if (name === null) throw new Error(`回滚链在到达 ${target} 之前已经清空`);
    rolledBack.push(name);
    if (name === target) return rolledBack;
  }
  throw new Error(`回滚 ${target} 之前超过了安全上限`);
}
