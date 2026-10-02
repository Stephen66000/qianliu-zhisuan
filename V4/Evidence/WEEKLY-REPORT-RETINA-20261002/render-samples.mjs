import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const root = process.cwd();
const output = process.argv[2] || '/tmp/weekly-retina-samples';
await mkdir(output, {recursive: true});
const load = (path) => import(pathToFileURL(resolve(root, path)));
const {createCanvas, Image} = await load('apps/worker/node_modules/@napi-rs/canvas/index.js');
const {renderSvgToPng} = await load('apps/worker/src/reporting/render-png.ts');
const {prepareSvgRasterSize} = await load('apps/worker/src/reporting/svg-raster-size.ts');
const {generateCompanyWeeklySvg} = await load('apps/worker/src/reporting/templates/company-weekly-svg.ts');
const {generatePersonalWeeklySvg} = await load('apps/worker/src/reporting/templates/personal-weekly-svg.ts');
const {generateDailyTokenReportSvg} = await load('apps/worker/src/reporting/templates/daily-token-report-svg.ts');
const company = generateCompanyWeeklySvg({enterpriseName:'合成企业', dateRange:'9.21 - 9.27',
  monthQuotaTotal:'14.0 亿', monthConsumedTokens:'2.0 亿', monthQuotaRemaining:'12.0 亿',
  totalRequests:'4,228 次', totalTokens:'990.9 万', dailyAvgTokens:'141.6 万 /天',
  totalEmployees:7, topUsers:Array.from({length:7},(_,i)=>({rank:i+1, name:['张三','李四','王五','赵六','孙七','周八','吴九'][i],
    department:'技术部',requests:'604',tokens:'141.6 万',dailyTokens:'20.2 万 /天',share:'14.3%'})),
  topModels:[{model:'DeepSeek',tokens:'600.0 万',dailyTokens:'85.7 万 /天',requests:'2,500',share:'60.6%'},
    {model:'K3',tokens:'300.0 万',dailyTokens:'42.9 万 /天',requests:'1,300',share:'30.3%'},
    {model:'GLM 5.3',tokens:'90.9 万',dailyTokens:'13.0 万 /天',requests:'428',share:'9.1%'}]});
const personal = generatePersonalWeeklySvg({userName:'测试成员甲',dateRange:'一周小结 9.21 - 9.27',
  quote:'功不求疾，但求有恒',metrics:[{label:'总请求次数',value:'4,228 次'},
    {label:'周消耗 Token 总量',value:'990.9 万'},{label:'日均使用量',value:'141.6 万 /天'},
    {label:'最晚请求时间',value:'周日 23:15'},{label:'本月剩余额度',value:'12.0 亿'},
    {label:'核心主力模型',value:'DeepSeek'}]});
const daily=generateDailyTokenReportSvg({enterpriseName:'合成企业',reportDate:'2026-10-01 (昨日全天)',
  totalRequests:'2',totalTokens:'1.4 万',activeEmployees:1,topUsers:[{rank:1,name:'测试成员甲',
    department:'技术部',requests:'2',tokens:'1.4 万',share:'100.0%'}],
  topModels:[{model:'K3',tokens:'1.4 万',requests:'2',share:'100.0%'}]});
const results=[];
const originalDecode=Image.prototype.decode;
let sizes=[];
Image.prototype.decode=async function(){const result=await originalDecode.call(this);sizes.push([this.width,this.height]);return result;};
const decode=async(png)=>{const image=new Image();image.src=png;await image.decode();return image;};
for(const [kind,svg,height] of [['company',company,1520],['personal',personal,1538],['daily',daily,1520]]){
  const old=await renderSvgToPng(svg,{fitWidth:540});
  sizes=[];
  const fixed=await renderSvgToPng(svg,{fitWidth:1080});
  const decodedSize=sizes[0];
  if(decodedSize[0]!==1080||decodedSize[1]!==height) throw new Error(kind+' SVG decoded at wrong dimensions');
  const referenceSvg=svg.replace(/<svg\b[^>]*>/,tag=>tag.replace(/\bwidth="[^"]*"/,'width="1080"').replace(/\bheight="[^"]*"/,`height="${height}"`));
  const reference=await renderSvgToPng(referenceSvg,{fitWidth:1080});
  if(!fixed.equals(reference))throw new Error(kind+' does not match direct high-resolution reference');
  const upscaled=createCanvas(1080,height);upscaled.getContext('2d').drawImage(await decode(old),0,0,1080,height);
  const oldBitmap=upscaled.toBuffer('image/png');
  await writeFile(resolve(output,kind+'-old-upscaled.png'),oldBitmap);
  await writeFile(resolve(output,kind+'-fixed.png'),fixed);
  await writeFile(resolve(output,kind+'.svg'),svg);
  const raster=prepareSvgRasterSize(svg,1080);
  const [minX,minY,viewWidth,viewHeight]=raster.viewBox;
  const scale=Math.min(1080/viewWidth,height/viewHeight);
  const offsetX=(1080-viewWidth*scale)/2,offsetY=(height-viewHeight*scale)/2;
  const needles=kind==='company'?['合成企业','张三','4,228']:kind==='personal'?['测试成员甲','功不求疾','4,228']:['合成企业','测试成员甲','1.4'];
  const regions=needles.map(needle=>{
    const match=[...svg.matchAll(/<text\b[^>]*>[\s\S]*?<\/text>/g)].find(m=>m[0].includes(needle));
    const tag=match?.[0];
    if(!tag)throw new Error('Missing comparison text: '+needle);
    const attr=name=>Number(tag.match(new RegExp(`\\b${name}="([0-9.]+)"`))?.[1]);
    let x=attr('x'),y=attr('y');const font=attr('font-size');
    const translations=[];
    for(const group of svg.slice(0,match.index).matchAll(/<\/?g\b[^>]*>/g)){
      if(group[0].startsWith('</'))translations.pop();
      else { const moved=group[0].match(/translate\(\s*([-0-9.]+)[ ,]+([-0-9.]+)\s*\)/);
        translations.push(moved?[Number(moved[1]),Number(moved[2])]:[0,0]); }
    }
    for(const [dx,dy] of translations){x+=dx;y+=dy;}
    return {label:needle,x:Math.max(0,Math.floor(offsetX+(x-minX-4)*scale)),
      y:Math.max(0,Math.floor(offsetY+(y-minY-font-5)*scale)),width:720,height:Math.ceil((font+13)*scale)};
  });
  const rowHeight=Math.max(...regions.map(r=>r.height))+32;
  const comparison=createCanvas(1490,rowHeight*regions.length+46);const ctx=comparison.getContext('2d');
  ctx.fillStyle='white';ctx.fillRect(0,0,1490,comparison.height);ctx.fillStyle='#172033';ctx.font='18px sans-serif';
  ctx.fillText('Previous 540px enlarged to 1080px',12,26);ctx.fillText('SVG decoded directly at 1080px',758,26);
  const hi=await decode(fixed);const lo=await decode(oldBitmap);
  for(const [i,region] of regions.entries()){
    const y=46+i*rowHeight;const width=Math.min(region.width,1080-region.x);
    ctx.drawImage(lo,region.x,region.y,width,region.height,12,y,width,region.height);
    ctx.drawImage(hi,region.x,region.y,width,region.height,758,y,width,region.height);
  }
  await writeFile(resolve(output,kind+'-detail-comparison.png'),comparison.toBuffer('image/png'));
  results.push({kind,width:1080,height,decodedSize,pngBytes:fixed.length,
    sha256:createHash('sha256').update(fixed).digest('hex'),matchesHighResolutionReference:true,
    originalViewBox:svg.match(/viewBox="([^"]+)"/)[1],syntheticData:true});
}
Image.prototype.decode=originalDecode;
const report={platform:process.platform,results};
await writeFile(resolve(output,'render-validation.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report));
