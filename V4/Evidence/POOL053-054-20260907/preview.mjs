// Local production-bundle preview with synthetic data; never proxies production.
import {createServer} from 'node:http';
import {readFile,appendFile} from 'node:fs/promises';
import {resolve,extname} from 'node:path';
const base=resolve('apps/web/dist');
const record=resolve('V4/Evidence/POOL053-054-20260907/browser-requests.jsonl');
createServer(async(req,res)=>{
 try {
  const url=new URL(req.url,'http://127.0.0.1');
  if(url.pathname.startsWith('/api/')){
   let data;
   if(url.pathname==='/api/auth/me')data={admin:{username:'local-test',displayName:'本地测试',mustChangePassword:false},featureFlags:{FEATURE_USAGE_OVERVIEW_V2:true}};
   else if(url.pathname==='/api/usage/overview'){
    const p=Object.fromEntries(url.searchParams);await appendFile(record,JSON.stringify({at:new Date().toISOString(),...p})+'\n');
    data={subjectType:p.subject_type,period:p.period,anchor:p.anchor,timezone:'Asia/Shanghai',range:{from:p.anchor,to:p.anchor},
     metrics:{activeSubjects:0,requestCount:'0',realTokens:'0',apiCost:'0',deductedQuota:'0'},trend:[],ranking:[],generatedAt:new Date().toISOString(),
     detailQuery:{subjectType:p.subject_type,settledOnly:true,from:p.anchor,toExclusive:p.anchor}};
   }else if(url.pathname==='/api/principals')data={principals:[],total:0,limit:20,offset:0};
   else {res.writeHead(404);res.end('{}');return;}
   res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(data));return;
  }
  const path=resolve(base,'.'+url.pathname);if(!path.startsWith(base+'/')&&path!==base){res.writeHead(404);res.end();return;}
  const file=extname(path)?path:resolve(base,'index.html');
  const types={'.html':'text/html','.js':'application/javascript','.css':'text/css','.png':'image/png','.svg':'image/svg+xml'};
  const bytes=await readFile(file);res.writeHead(200,{'Content-Type':types[extname(file)]??'application/octet-stream'});res.end(bytes);
 }catch{if(!res.headersSent)res.writeHead(404);res.end();}
}).listen(5189,'127.0.0.1',()=>console.log('Synthetic preview http://127.0.0.1:5189/usage'));
