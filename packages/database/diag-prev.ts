
import { randomUUID } from "node:crypto";
import { createKysely, migrateToLatest, createProjectMembership, previewPolicyChange } from "./src/index.js";
import { startPostgresContainer } from "@qianliu/testing";
const pg = await startPostgresContainer("diag_prev");
const db = createKysely(pg.connectionString);
await migrateToLatest(db);
const ent=randomUUID(),admin=randomUUID(),P=randomUUID(),Q=randomUUID(),emp=randomUUID();
await db.insertInto("enterprise").values([{id:ent,name:"d"}]).execute();
await db.insertInto("admin_user").values([{id:admin,enterprise_id:ent,username:"a",password_hash:"x"}]).execute();
await db.insertInto("principal").values([{id:P,enterprise_id:ent,type:"PROJECT",name:"P"},{id:Q,enterprise_id:ent,type:"PROJECT",name:"Q"},{id:emp,enterprise_id:ent,type:"EMPLOYEE",name:"e"}]).execute();
await createProjectMembership(db,{enterpriseId:ent,projectId:P,employeePrincipalId:emp,joinedAt:new Date("2026-09-01T00:00:00Z"),leftAt:null,weight:{weightBps:6000,validFrom:new Date("2026-09-01T00:00:00Z")},reason:"r",idempotencyKey:"k1",actorAdminId:admin});
await createProjectMembership(db,{enterpriseId:ent,projectId:Q,employeePrincipalId:emp,joinedAt:new Date("2026-10-01T00:00:00Z"),leftAt:new Date("2026-10-20T16:00:00Z"),reason:"r",idempotencyKey:"k2",actorAdminId:admin});
const preview = await previewPolicyChange(db,{enterpriseId:ent,employeePrincipalId:emp,projectPrincipalId:Q,segments:[{weightBps:4000,validFrom:new Date("2026-10-04T16:00:00Z"),validUntil:new Date("2026-10-20T16:00:00Z")}],expectedPolicyVersion:null});
console.log(JSON.stringify(preview.conflicts, null, 1));
await db.destroy(); await pg.stop();
