/**
 * POOL-038：模型 alias 改为 ql-{display_name} 简洁格式。
 *
 * 历史背景：POOL-033 切型号后，暴露给客户端（ZCode/WorkBuddy/Codex）的模型标识符是
 * `qianliu-{provider}-{model}`（如 qianliu-zhipu-glm-5-2），过长。改为 ql-{display_name}
 * （如 ql-glm-5.2），与仟流智算品牌前缀 "ql" 对齐。
 *
 * 本迁移是幂等的纯 UPDATE：
 *   1. unified_model.alias：7 条 ACTIVE 型号改名（按旧 alias 精确匹配，已改名则命中 0 行）
 *   2. principal_grant.model_alias：同步更新型号级行（不动 POOL-033 池化的 '*' 行）
 *
 * 不迁移历史用量数据（ai_request.unified_model / gateway_ledger 等），历史统计按
 * 旧/新 alias 分两段显示，总量正确（账本原则：不重算历史）。
 *
 * 向后兼容：旧 alias 改名后立即失效，客户端配置需同步更新（运维者控制全部客户端）。
 */

const ALIAS_MAP = [
  ["qianliu-deepseek-deepseek-v4-flash", "ql-deepseek-v4-flash"],
  ["qianliu-deepseek-deepseek-v4-pro", "ql-deepseek-v4-pro"],
  ["qianliu-kimi-k3", "ql-k3"],
  ["qianliu-kimi-k3-256k", "ql-k3-256k"],
  ["qianliu-zhipu-glm-4-6", "ql-glm-4.6"],
  ["qianliu-zhipu-glm-4-7", "ql-glm-4.7"],
  ["qianliu-zhipu-glm-5-2", "ql-glm-5.2"],
];

/** @param {import('kysely').Kysely} db */
export async function up(db) {
  for (const [oldAlias, newAlias] of ALIAS_MAP) {
    // unified_model.alias 改名（幂等：旧 alias 不存在则命中 0 行）
    await db.updateTable("unified_model")
      .set({ alias: newAlias })
      .where("alias", "=", oldAlias)
      .execute();

    // principal_grant.model_alias 同步（只改型号级行，不动池化 '*' 行）
    await db.updateTable("principal_grant")
      .set({ model_alias: newAlias })
      .where("model_alias", "=", oldAlias)
      .execute();
  }
}

/** @param {import('kysely').Kysely} db */
export async function down(db) {
  for (const [oldAlias, newAlias] of ALIAS_MAP) {
    await db.updateTable("unified_model")
      .set({ alias: oldAlias })
      .where("alias", "=", newAlias)
      .execute();
    await db.updateTable("principal_grant")
      .set({ model_alias: oldAlias })
      .where("model_alias", "=", newAlias)
      .execute();
  }
}
