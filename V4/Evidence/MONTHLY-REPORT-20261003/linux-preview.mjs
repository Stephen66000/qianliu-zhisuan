// Real production records, read-only connections and dryRun reports: no external delivery.
import fs from 'node:fs/promises';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const require=createRequire(resolve('apps/worker/package.json'));
const {Image}=require('@napi-rs/canvas');
const {sql}=createRequire(resolve('packages/database/package.json'))('kysely');
const {createKysely}=await import(pathToFileURL(resolve('packages/database/src/index.ts')));
const {runCompanyMonthlyReport,runPersonalMonthlyReports,renderSvgToPng,completedReportMonth}=await import(pathToFileURL(resolve('apps/worker/src/reporting/index.ts')));
const url=new URL(process.env.DATABASE_URL);
url.searchParams.set('options',`${url.searchParams.get('options')||''} -c default_transaction_read_only=on`.trim());
const db=createKysely(url.toString());
const sizes=[];const decode=Image.prototype.decode;
Image.prototype.decode=async function(){await decode.call(this);sizes.push([this.width,this.height]);};
try {
 const readonly=await sql`SHOW default_transaction_read_only`.execute(db);
 if(readonly.rows[0]?.default_transaction_read_only!=='on')throw new Error('Preview database is not read-only');
 const enterprise=await db.selectFrom('enterprise').select('id').orderBy('created_at').orderBy('id').limit(1).executeTakeFirstOrThrow();
 const month=completedReportMonth();
 const company=await runCompanyMonthlyReport({db,enterpriseId:enterprise.id,kekBase64:'unused',month:month.month,dryRun:true});
 const personal=await runPersonalMonthlyReports({db,enterpriseId:enterprise.id,kekBase64:'unused',month:month.month,dryRun:true});
 if(company.status!=='DRY_RUN'||!company.pngBuffer||!personal[0]?.svg)throw new Error('Missing monthly report previews');
 const personalPng=await renderSvgToPng(personal[0].svg,{fitWidth:1080});
 const pngSize=png=>[png.readUInt32BE(16),png.readUInt32BE(20)];
 const companySize=pngSize(company.pngBuffer),personalSize=pngSize(personalPng);
 if(String(companySize)!=='1080,1520'||String(personalSize)!=='1080,1538')throw new Error('Preview PNG dimensions incorrect');
 if(!sizes.some(s=>String(s)==='1080,1520')||!sizes.some(s=>String(s)==='1080,1538'))throw new Error('SVG decoded below 2x');
 await fs.mkdir('/previews',{recursive:true});
 await fs.writeFile('/previews/company-monthly.png',company.pngBuffer);
 await fs.writeFile('/previews/company-monthly.svg',company.svg);
 await fs.writeFile('/previews/personal-monthly.png',personalPng);
 await fs.writeFile('/previews/personal-monthly.svg',personal[0].svg);
 const proof={revision:process.env.REPORT_PREVIEW_REVISION,status:'PASS',readOnly:true,month:month.month,
  start:month.start.toISOString(),endExclusive:month.end.toISOString(),days:month.days,
  companySize,personalSize,decodedSizes:sizes,companyTokens:company.totalTokens,companyRequests:company.requestCount,
  personalReports:personal.length};
 await fs.writeFile('/previews/preview.json',JSON.stringify(proof,null,2));
 console.log(JSON.stringify(proof,null,2));
} finally {Image.prototype.decode=decode;await db.destroy();}
