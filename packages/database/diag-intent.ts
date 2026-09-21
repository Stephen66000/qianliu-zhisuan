
import { randomUUID } from "node:crypto";
import { createKysely, migrateToLatest, createProjectMembership, publishProjectIntent, publishEmployeeRules } from "./src/index.js";
import { startPostgresContainer } from "@qianliu/testing";
const pg = await startPostgresContainer("diag_intent");
const db = createKysely(pg.connectionString);
await migrateToLatest(db);
const ent=randomUUID(),admin=randomUUID(),P=randomUUID(),Q=randomUUID(),emp=randomUUID();
await db.insertInto("enterprise").values([{id:ent,name:"d"}]).execute();
await db.insertInto("admin_user").values([{id:admin,enterprise_id:ent,username:"a",password_hash:"x"}]).execute();
await db.insertInto("principal").values([{id:P,enterprise_id:ent,type:"PROJECT",name:"P"},{id:Q,enterprise_id:ent,type:"PROJECT",name:"Q"},{id:emp,enterprise_id:ent,type:"EMPLOYEE",name:"e"}]).execute();
const m1 = await createProjectMembership(db,{enterpriseId:ent,projectId:P,employeePrincipalId:emp,joinedAt:new Date("2026-09-01T00:00:00Z"),leftAt:null,reason:"r",idempotencyKey:"k1",actorAdminId:admin});
console.log("P membership ok, policy:", m1.policyVersion, "months:", m1.affectedMonths);
const m2 = await createProjectMembership(db,{enterpriseId:ent,projectId:Q,employeePrincipalId:emp,joinedAt:new Date("2026-10-01T00:00:00Z"),leftAt:new Date("2026-10-20T16:00:00Z"),reason:"r",idempotencyKey:"k2",actorAdminId:admin});
console.log("Q membership ok");
try {
  const out = await publishProjectIntent(db,{enterpriseId:ent,projectId:Q,employeePrincipalId:emp,segments:[{weightBps:10001,validFrom:new Date("2026-10-04T16:00:00Z"),validUntil:null}],expectedPolicyVersion:null,reason:"over",idempotencyKey:"over",actorAdminId:admin});
  console.log("intent:", out);
} catch (e) {
  console.log("intent error:", (e as any).conflicts ?? e.message);
}
await db.destroy(); await pg.stop();
