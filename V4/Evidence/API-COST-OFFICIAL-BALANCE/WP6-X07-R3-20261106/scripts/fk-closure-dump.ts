/**
 * X07 R3：实测 FK 全图（白名单闭包推导依据）。
 *
 * 起 postgres:17-alpine（digest 锁定，同 packages/testing/src/postgres-container.ts），
 * migrateToLatest 到 0096 水位，dump pg_constraint 全部外键边，
 * 再从白名单种子出发计算反向闭包（哪些白名单外表引用了白名单表的新行）。
 *
 * 只读调查脚本：库为一次性容器，不涉任何业务库。
 * 解析注意（X08 先例同款）：V4 目录无 workspace 链接，禁止 bare "@qianliu/*"，
 * 全部用绝对路径直引源码；pg 经 packages/database/node_modules 直引。
 */
import pgRaw from "/Users/mac/Projects/仟流智算-api-decouple/packages/database/node_modules/pg/lib/index.js";
import { startPostgresContainer } from "/Users/mac/Projects/仟流智算-api-decouple/packages/testing/src/index.ts";
import { createKysely, migrateToLatest } from "/Users/mac/Projects/仟流智算-api-decouple/packages/database/src/index.ts";

const pg = pgRaw as typeof import("pg");

/** 白名单种子（合同给定；闭包计算后与实测边核对）。 */
const SEEDS = [
  "ai_request", "upstream_attempt", "ledger_line", "ledger_transaction",
  "principal_quota_period", "principal_quota_usage", "principal_grant",
  "provider", "provider_resource", "principal", "principal_key",
  "unified_model", "model_route", "billing_rule", "resource_pool",
] as const;

interface FkEdge {
  child: string;
  parent: string;
  child_cols: string;
  parent_cols: string;
}

async function main(): Promise<void> {
  const instance = await startPostgresContainer("wp6_r3_fk_graph");
  const db = createKysely(instance.connectionString);
  const pool = new pg.Pool({ connectionString: instance.connectionString });
  try {
    const executed = await migrateToLatest(db);
    console.log("[migrate] executed =", JSON.stringify(executed));

    const edgeResult = await pool.query<FkEdge>(`
      SELECT conrelid::regclass::text AS child,
             confrelid::regclass::text AS parent,
             (SELECT string_agg(a.attname, ',' ORDER BY a.attnum)
                FROM unnest(con.conkey) k
                JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k) AS child_cols,
             (SELECT string_agg(a.attname, ',' ORDER BY a.attnum)
                FROM unnest(con.confkey) k
                JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k) AS parent_cols
        FROM pg_constraint con
       WHERE contype = 'f'
       ORDER BY 1, 2
    `);
    const edges = edgeResult.rows;

    console.log("[fk] total edges =", edges.length);
    for (const edge of edges) {
      console.log(`FK ${edge.child}(${edge.child_cols}) -> ${edge.parent}(${edge.parent_cols})`);
    }

    const parentToChildren = new Map<string, string[]>();
    const childToParents = new Map<string, string[]>();
    for (const edge of edges) {
      (parentToChildren.get(edge.parent) ?? parentToChildren.set(edge.parent, []).get(edge.parent)!).push(edge.child);
      (childToParents.get(edge.child) ?? childToParents.set(edge.child, []).get(edge.child)!).push(edge.parent);
    }
    const whitelist = new Set<string>(SEEDS);
    // 正向闭包：白名单表的 FK 父链（seed 行引用的行也须在位）
    const forward = new Set<string>(whitelist);
    let grew = true;
    while (grew) {
      grew = false;
      for (const [child, parents] of childToParents) {
        if (forward.has(child)) {
          for (const parent of parents) {
            if (!forward.has(parent)) { forward.add(parent); grew = true; }
          }
        }
      }
    }
    // 反向闭包：引用白名单行的表（候选增量面）
    const reverse = new Set<string>(whitelist);
    grew = true;
    while (grew) {
      grew = false;
      for (const [parent, children] of parentToChildren) {
        if (reverse.has(parent)) {
          for (const child of children) {
            if (!reverse.has(child)) { reverse.add(child); grew = true; }
          }
        }
      }
    }
    const sorted = (set: Set<string>) => [...set].sort();
    console.log("[closure] seeds =", JSON.stringify(sorted(whitelist)));
    console.log("[closure] forward (seeds + FK parents) =", JSON.stringify(sorted(forward)));
    console.log("[closure] reverse (seeds + FK referrers) =", JSON.stringify(sorted(reverse)));
    console.log("[closure] reverse-only (referrers not in forward) =",
      JSON.stringify(sorted(new Set([...reverse].filter((t) => !forward.has(t))))));
    console.log("[fk-closure-dump] OK");
  } finally {
    await db.destroy();
    await pool.end();
    await new Promise((resolve) => setTimeout(resolve, 200));
    await instance.stop();
  }
}

try {
  await main();
} catch (error) {
  console.error("[fk-closure-dump] FAILED:", error);
  process.exit(1);
}
