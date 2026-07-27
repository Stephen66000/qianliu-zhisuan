#!/usr/bin/env tsx
/**
 * db:migrate / db:rollback CLI。
 * 用法：tsx src/cli/migrate.ts up | down
 * 由根 package.json 的 db:migrate / db:rollback 脚本调用。
 */
import { createKysely } from "../kysely.js";
import { migrateToLatest, migrateDown, listMigrations } from "../migrator.js";

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command !== "up" && command !== "down") {
    console.error("Usage: tsx src/cli/migrate.ts <up|down>");
    process.exit(2);
  }

  const db = createKysely();
  try {
    if (command === "up") {
      const available = await listMigrations();
      console.log(`可用迁移文件 (${available.length}):`);
      for (const name of available) console.log(`  - ${name}`);
      console.log("");
      const executed = await migrateToLatest(db);
      console.log(`已执行迁移 (${executed.length}):`);
      for (const name of executed) console.log(`  ✓ ${name}`);
      if (executed.length === 0) console.log("  (数据库已是最新)");
    } else {
      const rolled = await migrateDown(db);
      if (rolled) {
        console.log(`✓ 已回滚迁移: ${rolled}`);
      } else {
        console.log("(无迁移可回滚)");
      }
    }
  } finally {
    await db.destroy();
  }
}

main().catch((err) => {
  console.error("db migrate 失败:", err);
  process.exit(1);
});
