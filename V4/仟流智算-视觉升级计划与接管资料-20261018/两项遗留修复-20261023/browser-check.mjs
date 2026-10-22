import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const require = createRequire(resolve(root, 'apps/web/package.json'));
const { chromium } = require('@playwright/test');
const build = resolve(process.argv[2]);
const fixture = JSON.parse(await readFile(new URL('./browser-fixture.json', import.meta.url), 'utf8'));
const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
const server = createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const path = resolve(build, `.${pathname}`);
    assert(path.startsWith(build + sep));
    const file = extname(path) ? path : resolve(build, 'index.html');
    const content = await readFile(file);
    res.writeHead(200, { 'Content-Type': mime[extname(file)] ?? 'application/octet-stream' });
    res.end(content);
  } catch {
    res.writeHead(404); res.end();
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const result = { status: 'RUNNING', environment: 'local production build; mocked API; no database', cases: [], errors: [], writeRequests: [], apiRequests: [] };
let browser, currentPage;
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  for (const width of [1024, 1440]) for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme: theme });
    await context.addInitScript(value => localStorage.setItem('ql-theme-preference', value), theme);
    const page = await context.newPage(); currentPage = page;
    page.on('pageerror', error => result.errors.push(error.message));
    await page.route(url => url.pathname.startsWith('/api/'), async route => {
      const path = new URL(route.request().url()).pathname.slice(4);
      result.apiRequests.push(path);
      const json = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
      if (!['GET', 'HEAD'].includes(route.request().method())) {
        result.writeRequests.push({ method: route.request().method(), path });
        return json({ error: 'writes_forbidden_in_visual_check' }, 403);
      }
      if (path === '/auth/me') return json({ admin: { adminUserId: 'fixture', enterpriseId: 'fixture', username: 'fixture', displayName: '额度单位展示验收', mustChangePassword: false, roleCode: 'SUPER_ADMIN' }, featureFlags: { FEATURE_USAGE_OVERVIEW_V2: true, FEATURE_RESOURCE_UTILIZATION_V2: true }, providerFinanceMode: 'OFF' });
      if (path === '/providers') return json({ providers: [] });
      if (path === '/provider-resources') return json({ resources: [] });
      if (path === '/provider-resources/usage-overview') return json(fixture);
      return json({ error: 'fixture_missing', message: path }, 404);
    });
    await page.goto(`${origin}/resources?tab=usage-overview`);
    const balanceHeader = page.locator('main th').filter({ hasText: /^余额 \/ 剩余额度$/ });
    await balanceHeader.waitFor({ timeout: 10000 });
    const expected = [
      ['CNY 87.90', '1,000 Token'], ['1,200 POINT', '2,500 Token'],
      ['9,007,199,254,740,993 TOKEN', '9,007,199,254,740,995 Token'],
      ['80 单位未知', '50 Token'], ['0 POINT', '0 Token'], ['—', '—'],
    ];
    const rows = [];
    for (const [index, item] of fixture.providerSummaries.entries()) {
      const label = `${item.providerName} ${item.mode === 'API' ? 'API' : 'Coding Plan'}`;
      const toggle = page.getByRole('button', { name: `展开${label}详情`, exact: true });
      const row = toggle.locator('xpath=ancestor::tr');
      const balance = (await row.locator('td').nth(2).innerText()).trim();
      assert.equal(balance, expected[index][0]);
      await toggle.focus(); await page.keyboard.press('Enter');
      const details = page.getByRole('region', { name: `${label}详情`, exact: true });
      const allocated = (await details.locator('div').filter({ has: page.locator('dt', { hasText: /^分配额度$/ }) }).locator('dd').innerText()).trim();
      assert.equal(allocated, expected[index][1]);
      rows.push({ label, balance, allocated });
    }
    const pageOverflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    assert.equal(pageOverflow, false);
    const headerFont = await balanceHeader.evaluate(element => getComputedStyle(element).fontSize);
    assert.equal(headerFont, '13px');
    const screenshot = `quota-units-${width}-${theme}.png`;
    await page.screenshot({ path: fileURLToPath(new URL(screenshot, import.meta.url)), fullPage: true });
    result.cases.push({ width, theme, rows, pageOverflow, headerFont, screenshot });
    await context.close();
  }
  assert.deepEqual(result.errors, []); assert.deepEqual(result.writeRequests, []);
  result.status = 'PASS';
  console.log(JSON.stringify({ status: result.status, cases: result.cases.length, errors: result.errors, writeRequests: result.writeRequests }));
} catch (error) {
  result.status = 'FAIL'; result.failure = error.stack; process.exitCode = 1;
  if (currentPage && !currentPage.isClosed()) {
    result.pageUrl = currentPage.url(); result.pageText = await currentPage.locator('body').innerText();
    await currentPage.screenshot({ path: fileURLToPath(new URL('browser-failure.png', import.meta.url)), fullPage: true });
  }
  console.error(error);
} finally {
  await writeFile(new URL('./browser-result.json', import.meta.url), JSON.stringify(result, null, 2) + '\n');
  await browser?.close(); await new Promise(resolve => server.close(resolve));
}
