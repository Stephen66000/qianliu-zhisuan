const fs=require('fs'),vm=require('vm');const ts=require('/Users/mac/Projects/仟流智算/node_modules/typescript');
const file='/Users/mac/Projects/仟流智算/packages/database/src/repositories/dashboard-home-providers.ts';
const source=fs.readFileSync(file,'utf8')+'\nexport const auditProviderRow=providerRow;';
const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const sandbox={exports:{},require(n){if(n==='@qianliu/domain')return {worstResourceStatus:()=> 'ACTIVE'};if(n==='kysely')return {};return {}},Date,Map};vm.runInNewContext(code,sandbox);
const now=new Date('2026-09-10T06:00:00Z');const rows=['fresh','stale'].map(id=>({provider_code:'p',provider_name:'P',resource_id:id,resource_name:id,mode:'API',status:'ACTIVE',updated_at:now}));
const sync=t=>({balance_status:'SUCCESS',cost_status:'SUCCESS',last_success_data_at:new Date(t),completed_at:new Date(t)});
const result=sandbox.exports.auditProviderRow(rows,new Map(),new Map([['fresh',sync('2026-09-10T05:00:00Z')],['stale',sync('2026-09-01T05:00:00Z')]]),now);
console.log(JSON.stringify({scenario:'same provider: fresh resource plus 9-day stale resource',result},null,2));
