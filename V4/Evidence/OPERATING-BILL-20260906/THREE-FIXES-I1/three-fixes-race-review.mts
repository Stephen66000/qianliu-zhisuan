import {sql} from "/Users/mac/.codex/worktrees/operating-bill-0906/仟流智算/packages/database/node_modules/kysely/dist/esm/index.js";
import {createKysely,migrateToLatest,savePrincipalAccounting,readPrincipalAccounting,previewPrincipalAttributionBackfill,confirmPrincipalAttributionBackfill} from "/Users/mac/.codex/worktrees/operating-bill-0906/仟流智算/packages/database/src/index.ts";
import {createAnalysisFixture,seedAnalysisUsage} from "/Users/mac/.codex/worktrees/operating-bill-0906/仟流智算/packages/database/src/__tests-integration__/fixtures/operating-analysis.ts";
import {startPostgresContainer} from "/Users/mac/.codex/worktrees/operating-bill-0906/仟流智算/packages/testing/src/index.ts";
import {guardOperatingBillLedgerWrite} from "/Users/mac/.codex/worktrees/operating-bill-0906/仟流智算/packages/database/src/repositories/operating-bill-write-barrier.ts";
const pg=await startPostgresContainer("three_fixes_review_race");
const db=createKysely(pg.connectionString);
let release;
try{
 await migrateToLatest(db);const t=await createAnalysisFixture(db);
 await savePrincipalAccounting(db,{enterpriseId:t.enterpriseId,principalId:t.a,adminId:t.adminId,departmentName:"研发部",expectedVersion:0});
 const departmentId=(await readPrincipalAccounting(db,t.enterpriseId,t.a)).suggestedDepartmentId;
 const at=new Date("2026-09-02T00:00:00Z");
 await seedAnalysisUsage(t,t.a,"deepseek",10n,at,"1");
 const input={enterpriseId:t.enterpriseId,principalId:t.a,departmentId,from:new Date("2026-09-01T00:00:00+08:00"),until:new Date("2026-09-07T00:00:00+08:00")};
 const preview=await previewPrincipalAttributionBackfill(db,input);
 let ready;const locked=new Promise(r=>ready=r);const gate=new Promise(r=>release=r);
 const writer=db.transaction().execute(async trx=>{
   await guardOperatingBillLedgerWrite(trx,t.enterpriseId,at);ready();await gate;
   await seedAnalysisUsage({...t,db:trx},t.a,"deepseek",20n,at,"2");
 });
 await locked;
 const confirmation=confirmPrincipalAttributionBackfill(db,{...input,adminId:t.adminId,reason:"确认",fingerprint:preview.fingerprint}).then(result=>({result}),error=>({error:error.message}));
 let blocked=false;
 for(let n=0;n<150;n++){
   const r=await sql`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory'`.execute(db);
   if(r.rows[0].n>0){blocked=true;break;} await new Promise(r=>setTimeout(r,20));
 }
 if(!blocked) throw Error("confirmation did not reach blocked monthly barrier");
 release();await writer;
 const outcome=await confirmation;
 const remaining=await previewPrincipalAttributionBackfill(db,input);
 console.log(JSON.stringify({previewCount:preview.requestCount,confirmedAfterSetChanged:outcome,remainingCount:remaining.requestCount,observedMonthLockWait:blocked}));
}finally{release?.();await db.destroy();await pg.stop();}
