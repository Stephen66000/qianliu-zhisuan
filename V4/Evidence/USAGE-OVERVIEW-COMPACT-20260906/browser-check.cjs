// Local production-bundle UI check. All API responses are isolated test fixtures.
const { createRequire } = require('node:module');
const { resolve } = require('node:path');
const { readFileSync, writeFileSync } = require('node:fs');
const assert = require('node:assert/strict');
const { chromium, expect } = createRequire(resolve('apps/web/package.json'))('@playwright/test');
const evidence = resolve('V4/Evidence/USAGE-OVERVIEW-COMPACT-20260906');
const projectId = '20000000-0000-4000-8000-000000000001';
const anchor = '2026-08-12T04:00:00.000Z';
const overrides = {};
// Reuse the checked-in component fixtures, without duplicating production data.
const overviewSource = readFileSync('apps/web/src/components/usage/UsageOverviewPanel.test.tsx', 'utf8');
const overview = eval('(' + overviewSource.match(/function overview[\s\S]*?return (\{[\s\S]*?\n  \});/)[1] + ')');
overview.metrics = { ...overview.metrics, activeSubjects: 4, requestCount: "3920", realTokens: "226208343", apiCost: "29.1", deductedQuota: "124886373" };
overview.trend = [60, 50, 39, 52, 22, 3, 1].map((n, i) => ({...overview.trend[0], bucketStart:`2026-09-0${i+1}T00:00:00Z`, label:["周一","周二","周三","周四","周五","周六","周日"][i], realTokens:String(n*1000000)}));
overview.ranking = ["员工甲","员工乙","员工丙","员工丁"].map((name, i) => ({...overview.ranking[0], subjectId:`p${i}`, subjectName:name, realTokens:String((90-i*18)*1000000)}));
const usageSource = readFileSync('apps/web/src/pages/Usage.test.tsx', 'utf8');
const record = eval('(' + usageSource.match(/function sampleRecord[\s\S]*?return (\{[\s\S]*?\n  \});/)[1] + ')');
const principals = [
  {id:'p1', name:'张三', type:'EMPLOYEE', department_label:'研发'},
  {id:projectId, name:'星河项目', type:'PROJECT', department_label:'研发'},
];
(async () => {
 const browser = await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless:true});
 try {
  const page = await browser.newPage({viewport:{width:1440,height:1000}, deviceScaleFactor:1});
  const errors = [], requests = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/api/**', async route => {
   const url = new URL(route.request().url());
   requests.push(url.pathname + url.search);
   let data;
   switch (url.pathname) {
    case '/api/auth/me': data={admin:{username:'本地界面验证',displayName:'本地界面验证',mustChangePassword:false},featureFlags:{FEATURE_USAGE_OVERVIEW_V2:true}}; break;
    case '/api/usage/overview': data=overview; break;
    case '/api/usage': data={records:[record],total:1,limit:20,offset:0}; break;
    case '/api/principals/resolve-exact': data={principal:principals[1],match_count:1}; break;
    case '/api/principals': {
     const items=principals.filter(p=>!url.searchParams.get('type') || p.type===url.searchParams.get('type'));
     data={principals:items,total:items.length,limit:20,offset:0}; break;
    }
    case '/api/principals/'+projectId: data={principal:principals[1]}; break;
    case '/api/providers': data={providers:[{id:record.finalProviderId,name:'智谱'}]}; break;
    case '/api/provider-resources': data={resources:[{id:record.finalProviderResourceId,provider_id:record.finalProviderId,name:'智谱主资源'}]}; break;
    case '/api/unified-models': data={models:[{id:'m1',alias:'glm-4.6',display_name:'GLM 4.6'}]}; break;
    default: errors.push('Unexpected API: '+url.pathname); data={};
   }
   await route.fulfill({json:data});
  });
  await page.goto('http://127.0.0.1:5187/usage');
  await expect(page.getByRole('heading',{name:'消耗排名',exact:true})).toBeVisible();
  assert.ok(!requests.some(x=>/^\/api\/usage\?/.test(x)), 'default overview must not request detail data');
  await page.getByRole('combobox',{name:'用量主体类型'}).selectOption('PROJECT');
  await page.getByRole('searchbox',{name:'搜索用量主体'}).fill('星河项目');
  await page.getByRole('button',{name:'查询',exact:true}).click();
  await page.waitForURL(/subject_id=/);
  assert.equal(await page.getByRole('combobox',{name:'指定用量主体'}).inputValue(),projectId);
  assert.equal(await page.getByRole('button',{name:'主体下一页'}).count(),0);
  await page.setViewportSize({width:1440,height:768});
  await expect(page.getByRole('button',{name:'员工丁',exact:true})).toBeVisible();
  const controls = ['用量主体类型','用量周期','用量锚点','搜索用量主体','指定用量主体'];
  const rowBoxes = await Promise.all(controls.map(label=>page.getByLabel(label,{exact:true}).boundingBox()));
  assert.ok(rowBoxes.every(box=>Math.abs(box.y-rowBoxes[0].y)<2), 'all overview controls in one row');
  const lastPerson=await page.getByRole('button',{name:'员工丁',exact:true}).boundingBox();
  assert.ok(lastPerson.y+lastPerson.height<=768,'four employees fit in first screen');
  const pageText=await page.locator('main').innerText();
  assert.ok(!/参考日期|输入名称后点击|计量未知|聚合读模型|实时账本|聚合数据已滞后/.test(pageText));
  await page.screenshot({path:resolve(evidence,'overview-desktop.png'),fullPage:true});
  await page.getByRole('button',{name:'请求明细',exact:true}).click();
  const search = page.getByRole('searchbox',{name:'搜索主体、姓名或项目'});
  await search.fill('星河项目');
  assert.equal(new URL(page.url()).searchParams.get('search'),null);
  await page.getByRole('button',{name:'查询',exact:true}).click();
  await page.waitForURL(/search=/);
  assert.equal(new URL(page.url()).searchParams.get('search'),'星河项目');
  await expect(search).toHaveValue('星河项目');
  const labels = ['搜索主体、姓名或项目','主体','项目','Agent'];
  let boxes;
  await expect.poll(async () => {
   boxes = await Promise.all(labels.map(label=>page.getByLabel(label,{exact:true}).boundingBox()));
   return boxes.every(Boolean);
  }).toBe(true);
  assert.ok(boxes.every(box=>Math.abs(box.y-boxes[0].y)<2), 'four controls must share the first row');
  await page.screenshot({path:resolve(evidence,'details-desktop.png'),fullPage:true});
  await search.fill('张三');
  await search.press('Enter');
  await page.waitForURL(url=>url.searchParams.get('search')==='张三');
  await page.getByRole('button',{name:'清除筛选'}).click();
  await expect(page.getByRole('searchbox')).toHaveValue('');
  const layout=[];
  for(const width of [1440,1024,390]) {
   await page.setViewportSize({width,height:1000});
   const info=await page.getByRole('search').locator('..').evaluate(el=>({columns:getComputedStyle(el).gridTemplateColumns,scroll:el.scrollWidth,width:el.clientWidth}));
   assert.equal(info.columns.split(' ').length,width===1440?4:width===1024?2:1);
   assert.ok(info.scroll<=info.width+1,'filter grid must not overflow');
   layout.push({viewport:width,...info});
   if(width===390) await page.screenshot({path:resolve(evidence,'details-mobile.png'),fullPage:true});
  }
  assert.deepEqual(errors,[]);
  const report={status:'PASS',fixtureOnly:true,checks:['default module is overview without hidden detail requests','single row overview filters','four employees visible at 1440x768','no helper text or technical data-source copy','overview button applies subject','single-page candidates hide pagination','details draft waits for query','query and Enter apply name/project','clear filters resets search','desktop first row has four controls','responsive 4/2/1 columns without filter overflow','no browser errors'],layout,requests};
  writeFileSync(resolve(evidence,'browser-check.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({status:report.status,checks:report.checks,layout},null,2));
 } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
