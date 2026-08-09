/**
 * POOL-039：主体接入配置与批量规则共用的锁序。
 *
 * 事务内的顺序固定为：
 * 1. enterprise 内按 principal_id 升序锁 ACTIVE Key；
 * 2. 调用方捕获 manual baseline；
 * 3. 规则／乐观锁处理完成后，按 principal_id、provider_code 升序锁 ACTIVE 池。
 *
 * 每行使用独立 SELECT ... FOR UPDATE，避免依赖带 ORDER BY 的扫描计划来推断
 * PostgreSQL 的实际行锁获取顺序。这里不重试死锁，锁序本身必须消除死锁。
 */
import type { Selectable, Transaction } from "kysely";
import type { Database, PrincipalGrantTable } from "../kysely.js";

export type LockedPrincipalGrant = Selectable<PrincipalGrantTable>;

function stableUnique(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right, "en"));
}

/** 先按稳定主体顺序锁定每个主体唯一的 ACTIVE Key。缺失 Key 不在这里报业务错。 */
export async function lockActivePrincipalKeys(
  trx: Transaction<Database>,
  enterpriseId: string,
  principalIds: string[],
): Promise<Map<string, string>> {
  const locked = new Map<string, string>();
  for (const principalId of stableUnique(principalIds)) {
    const key = await trx.selectFrom("principal_key")
      .select("id")
      .where("enterprise_id", "=", enterpriseId)
      .where("principal_id", "=", principalId)
      .where("status", "=", "ACTIVE")
      .forUpdate()
      .executeTakeFirst();
    if (key) locked.set(principalId, key.id);
  }
  return locked;
}

/** 最后按稳定主体／厂商顺序锁定现有 ACTIVE 池；不存在的池由调用方在锁序之后创建。 */
export async function lockActiveProviderPools(
  trx: Transaction<Database>,
  enterpriseId: string,
  principalIds: string[],
  providerCodes: string[],
): Promise<Map<string, LockedPrincipalGrant>> {
  const locked = new Map<string, LockedPrincipalGrant>();
  for (const principalId of stableUnique(principalIds)) {
    for (const providerCode of stableUnique(providerCodes)) {
      const pool = await trx.selectFrom("principal_grant")
        .selectAll()
        .where("enterprise_id", "=", enterpriseId)
        .where("principal_id", "=", principalId)
        .where("provider", "=", providerCode)
        .where("pool_model_alias", "=", "*")
        .where("status", "=", "ACTIVE")
        .forUpdate()
        .executeTakeFirst();
      if (pool) locked.set(`${principalId}:${providerCode}`, pool);
    }
  }
  return locked;
}
