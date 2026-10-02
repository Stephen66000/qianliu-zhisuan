// Runs bills in a read-only repeatable-read snapshot, then the home composer with
// a read-only pool (the usage overview owns its own repeatable-read transaction).
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
const connectionUrl=new URL(process.env.DATABASE_URL);
connectionUrl.searchParams.set('options',`${connectionUrl.searchParams.get('options') || ''} -c default_transaction_read_only=on`.trim());
const db=createKysely(connectionUrl.toString());
let homeOptions;
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
    homeOptions={enterpriseId:e.id,asOf:now,bill:b,financeRead:!!b.sourceFacts?.providerFinance};
   }
  }
  return response;
 });
 if(homeOptions){
  const readonly=await sql`SHOW default_transaction_read_only`.execute(db);
  if(readonly.rows[0]?.default_transaction_read_only!=='on')throw new Error('Home replay pool is not read-only');
  const home=await getStandardHomeSummary(db,homeOptions);
  result.home={monthlyCost:home.monthlyCost,resources:home.resources};
 }
 console.log(JSON.stringify(result,null,2));
} finally {await db.destroy();}
