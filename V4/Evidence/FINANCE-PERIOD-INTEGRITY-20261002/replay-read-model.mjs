// Runs only SELECTs inside a database-enforced read-only repeatable-read snapshot.
// Output contains operational financial data and must stay in the protected server evidence directory.
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const require=createRequire(resolve('packages/database/package.json'));
const {sql}=require('kysely');
const {createKysely,OperatingBillRepository,getStandardHomeSummary}=await import(pathToFileURL(resolve('packages/database/src/index.ts')));
const {readProviderFinanceMode}=await import(pathToFileURL(resolve('packages/config/src/index.ts')));
const months=(process.env.FINANCE_REPLAY_MONTHS || '2026-09,2026-10').split(',');
const db=createKysely();
try {
 const result=await db.transaction().setIsolationLevel('repeatable read').execute(async trx=>{
  await sql`SET TRANSACTION READ ONLY`.execute(trx);
  const readonly=await sql`SHOW transaction_read_only`.execute(trx);
  if(readonly.rows[0]?.transaction_read_only!=='on')throw new Error('Replay transaction is not read-only');
  const e=await trx.selectFrom('enterprise').select(['id','name']).orderBy('created_at').orderBy('id').limit(1).executeTakeFirstOrThrow();
  const mode=readProviderFinanceMode(process.env);
  const funds=await trx.selectFrom('provider_finance_event').select(['id','event_type','account_amount','account_currency','occurred_at'])
    .where('enterprise_id','=',e.id).orderBy('id').execute();
  const unknown=await trx.selectFrom('ledger_line').select(['id','api_cost_status','api_cost','api_cost_currency','settled_at'])
    .where('enterprise_id','=',e.id).where('resource_mode','=','API').where('api_cost_status','=','UNKNOWN_COST').orderBy('id').execute();
  const response={readOnly:true,mode,financialEventsSha256:createHash('sha256').update(JSON.stringify(funds)).digest('hex'),
    unknownCostRowsSha256:createHash('sha256').update(JSON.stringify(unknown)).digest('hex'),unknownCostCount:unknown.length,months:[]};
  const now=new Date();
  const currentMonth=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit'}).format(now);
  for(const month of months){
   const b=await new OperatingBillRepository(trx,mode,true).getBill(e.id,month);
   response.months.push({month,status:b.status,summary:b.summary,providers:b.providers.map(p=>({name:p.resourceName,mode:p.mode,
     opening:p.openingBalance,ending:p.endingBalance,apiCost:p.apiCost,apiSpendStatus:p.apiSpendStatus,apiSpendReason:p.apiSpendReason})),gaps:b.gaps});
   if(month===currentMonth){
    const home=await getStandardHomeSummary(trx,{enterpriseId:e.id,asOf:now,bill:b,financeRead:!!b.sourceFacts?.providerFinance});
    response.home={monthlyCost:home.monthlyCost,resources:home.resources};
   }
  }
  return response;
 });
 console.log(JSON.stringify(result,null,2));
} finally {await db.destroy();}
