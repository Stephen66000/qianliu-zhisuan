// 独立探针：用与集成测试同一个镜像 digest 的一次性 PostgreSQL，
// 证明 `DO $$ ... RAISE EXCEPTION USING ERRCODE='40P01' $$` 会被 node-postgres
// 以 error.code === '40P01' 原样抛出（即 40P01 是真实可注入的 SQLSTATE）。
import { createRequire } from "node:module";

const require = createRequire("/Users/mac/Projects/仟流智算-provider-finance-init-20260921/packages/database/package.json");
const { Client } = require("pg");

const client = new Client({ connectionString: "postgres://probe:probe@127.0.0.1:55440/probe" });
await client.connect();

async function probe(errcode, label) {
  await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  try {
    await client.query(`DO $$ BEGIN RAISE EXCEPTION '${label}' USING ERRCODE = '${errcode}'; END $$`);
    console.log(`INJECT ${errcode} -> NO ERROR (unexpected)`);
  } catch (error) {
    console.log(`INJECT ${errcode} -> raw code=${JSON.stringify(error.code)} message=${JSON.stringify(error.message)}`);
  } finally {
    await client.query("ROLLBACK");
  }
}

await probe("40001", "simulated serialization failure");
await probe("40P01", "simulated deadlock detected");
await client.end();
