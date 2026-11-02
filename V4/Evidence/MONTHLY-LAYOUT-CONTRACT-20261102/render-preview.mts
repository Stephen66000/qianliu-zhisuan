import {writeFile} from 'node:fs/promises';
import {generateCompanyWeeklySvg} from '../../../apps/worker/src/reporting/templates/company-weekly-svg.ts';
import {renderSvgToPng} from '../../../apps/worker/src/reporting/render-png.ts';
import {companyMonthlyMetrics} from '../../../apps/worker/src/reporting/company-monthly-metrics.ts';
const metrics=companyMonthlyMetrics('2200000000','2709467730','22607');
// Display values from the previously verified October production report and user screenshots.
const data={enterpriseName:'仟流科技',reportMonth:'2026 年 10 月',dateRange:'2026 年 10 月 · 10.1 - 10.31',
monthQuotaTotal:metrics.allocation,monthTokenUsageRate:metrics.usageRate,monthConsumedTokens:'27.1 亿',monthQuotaRemaining:metrics.remaining,
totalRequests:metrics.requestsWan,totalTokens:'27.1 亿',dailyAvgTokens:'8740.2 万 /天',totalEmployees:4,totalModels:4,
topUsers:[
{rank:1,name:'曹磊',department:'技术部',requests:'15,323',tokens:'19.4 亿',dailyTokens:'6265.9 万 /天',share:'71.7%'},
{rank:2,name:'王涛',department:'技术部',requests:'4,994',tokens:'6.3 亿',dailyTokens:'2027.4 万 /天',share:'23.2%'},
{rank:3,name:'邱志杰',department:'技术部',requests:'2,217',tokens:'1.4 亿',dailyTokens:'446.8 万 /天',share:'5.1%'},
{rank:4,name:'李佳',department:'总经理办公室',requests:'73',tokens:'5.0 万',dailyTokens:'0.2 万 /天',share:'0.0%'}],
topModels:[
{model:'deepseek-flash',tokens:'20.2 亿',dailyTokens:'6518.3 万 /天',requests:'16,188',share:'74.6%'},
{model:'GLM 5.3 Flash',tokens:'4.5 亿',dailyTokens:'1441.9 万 /天',requests:'4,379',share:'16.5%'},
{model:'GLM 5.3',tokens:'2.4 亿',dailyTokens:'779.5 万 /天',requests:'1,963',share:'8.9%'}]};
const svg=generateCompanyWeeklySvg(data),png=await renderSvgToPng(svg,{fitWidth:1080});
await writeFile(new URL('./月报版式-本地预览.svg',import.meta.url),svg.split(String.fromCharCode(10)).map(line=>line.trimEnd()).join(String.fromCharCode(10)));
await writeFile(new URL('./月报版式-本地预览.png',import.meta.url),png);
await writeFile(new URL('./preview-data.json',import.meta.url),JSON.stringify({source:'Previously verified October production display values; final release must verify fresh read-only generation',data,metrics},null,2));
console.log(JSON.stringify({width:png.readUInt32BE(16),height:png.readUInt32BE(20),metrics}));
