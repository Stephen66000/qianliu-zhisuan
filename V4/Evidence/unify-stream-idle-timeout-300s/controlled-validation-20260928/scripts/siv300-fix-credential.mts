/** 受控验证修复：给种子资源写入测试凭证（用容器同款 KEK 加密）并重置健康字段。 */
import { readFileSync } from "node:fs";
import { createKysely } from "../../../../../packages/database/src/kysely.js";
import { encryptCredential } from "../../../../../packages/provider-adapters/src/crypto.js";

const kekB64 = readFileSync("/tmp/siv300-kek.txt", "utf8").trim().split("=")[1].trim();
const kek = Buffer.from(kekB64, "base64");
if (kek.length !== 32) throw new Error(`kek length ${kek.length}`);
const enc = encryptCredential("sk-<redacted-test-dummy>", kek);

const db = createKysely(process.env.DATABASE_URL!);
const updated = await db.updateTable("provider_resource").set({
  credential_ciphertext: JSON.stringify(enc) as never,
  credential_version: 1,
  status: "ACTIVE",
  consecutive_failures: 0,
  cooldown_until: null,
  auth_failure_id: null,
  auth_failure_model: null,
  auth_failure_config_hash: null,
}).where("name", "=", "受控验证资源").executeTakeFirst();
console.log(`updated_rows=${updated ? updated.numUpdatedRows : "?"}`);
await db.destroy();
