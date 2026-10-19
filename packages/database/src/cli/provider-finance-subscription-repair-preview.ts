import { createKysely } from "../kysely.js";
import { previewSubscriptionLinkRepair } from "../repositories/provider-finance-subscription-repair-preview.js";

const [enterpriseId, from, to, ...extra]=process.argv.slice(2);
if (!enterpriseId || !from || !to || extra.length) {
  throw new Error("Usage (read only): provider-finance-subscription-repair-preview.ts <enterprise-uuid> <from-ISO> <to-exclusive-ISO>");
}
const db=createKysely();
try {
  console.log(JSON.stringify(await previewSubscriptionLinkRepair(db,enterpriseId,new Date(from),new Date(to)),null,2));
} finally { await db.destroy(); }
