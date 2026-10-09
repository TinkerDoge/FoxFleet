// Browser regressions against an isolated mock hub. Build web first.
// node web/tools/ui-audit-check.mjs <absolute evidence dir> [Playwright runtime root]
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createMock } from './mock-hub.mjs';

const output = path.resolve(process.argv[2] ?? '../docs/images/ui-audit-stage-1');
const require = createRequire(process.argv[3] ? path.join(path.resolve(process.argv[3]), 'package.json') : import.meta.url);
const { chromium } = require('playwright');
await mkdir(output, { recursive: true });
const hub = createMock(); await new Promise((resolve) => hub.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${hub.address().port}`;
const checks = [], errors = [];
let browser;
const check = (name, detail = {}) => { checks.push({ name, ...detail }); console.log(`PASS ${name}`); };
try {
  browser = await chromium.launch({ headless: true, ...(process.env.FOXFLEET_CHROME ? { executablePath: process.env.FOXFLEET_CHROME } : {}) });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'light' });
  const page = await context.newPage(); page.setDefaultTimeout(10000); page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(base);
  await page.locator('input[name=username]').fill('owner1'); await page.locator('input[name=password]').fill('correct horse battery');
  await page.locator('button[type=submit]').click(); await page.locator('.chat').waitFor();
  const history = () => page.getByRole('button', { name: 'History', exact: true });
  const selected = async (id) => {
    await history().click(); await page.locator(`.sessions [data-sid="${id}"][aria-current=true]`).waitFor();
    await page.keyboard.press('Escape');
  };
  await page.goto(`${base}/#/chat?agent=atlas&session=sess_a2`); await page.locator('.messages .md:not(.plain)').first().waitFor(); await selected('sess_a2');
  await page.evaluate(() => { location.hash = '#/chat?agent=atlas&session=sess_a1'; }); await selected('sess_a1'); check('same-agent session link');
  await page.reload(); await page.locator('.messages .md:not(.plain)').first().waitFor(); await selected('sess_a1'); check('session reload');
  await history().click(); await page.locator('.sessions [data-sid=sess_a2]').click(); await selected('sess_a2');
  await page.goBack(); await selected('sess_a1'); await page.goForward(); await selected('sess_a2'); check('History selection and Back/Forward');
  await page.screenshot({ animations: 'disabled', path: path.join(output, 'desktop-chat.png') });

  let block = true;
  const sessionsRoute = async (route) => block ? route.abort() : route.continue();
  await page.route('**/api/agents/atlas/sessions?*', sessionsRoute);
  await history().click(); await page.locator('.sessions [role=alert]').waitFor();
  assert.equal(await page.locator('.sessions [data-sid]').count(), 4); check('failed history refresh retains stale rows');
  await page.screenshot({ animations: 'disabled', path: path.join(output, 'history-refresh-error.png') });
  block = false; await page.getByRole('menuitem', { name: 'Retry', exact: true }).click(); await page.locator('.sessions [role=alert]').waitFor({ state: 'detached' });
  check('history Retry clears the error'); await page.keyboard.press('Escape'); await page.unroute('**/api/agents/atlas/sessions?*', sessionsRoute);

  await page.getByRole('button', { name: 'Attach', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: 'Attach', exact: true }).getAttribute('aria-expanded'), 'true');
  assert(await page.locator('[role=menuitem]').first().evaluate((el) => el === document.activeElement));
  await page.keyboard.press('Escape'); assert(await page.getByRole('button', { name: 'Attach', exact: true }).evaluate((el) => el === document.activeElement)); check('attachment Escape and focus restoration');
  await page.getByRole('button', { name: 'Attach', exact: true }).click();
  const picker = page.waitForEvent('filechooser'); await page.getByRole('menuitem', { name: 'File', exact: true }).click(); await picker;
  assert.equal(await page.locator('.action-menu').count(), 0); check('file picker opens after menu closes');

  await page.setViewportSize({ width: 320, height: 740 });
  await page.evaluate(() => { document.documentElement.dataset.text = 'large'; });
  const measureHeader = async () => {
    const heading = await page.locator('.chat-head h1').boundingBox(), actions = await page.locator('.chat-head .sessions-anchor').boundingBox(), more = await page.getByRole('button', { name: 'More chat actions' }).boundingBox();
    assert(heading && actions && more); assert(heading.x + heading.width <= Math.min(actions.x, more.x) + 1, 'identity overlaps actions');
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'horizontal page overflow');
    return { heading, actions, more };
  };
  check('320px Large text header', await measureHeader()); await page.screenshot({ animations: 'disabled', path: path.join(output, 'phone-320-large-text.png') });
  await page.route('**/api/agents', async (route) => { const r = await route.fetch(); const data = await r.json(); data.agents = data.agents.map((a) => a.name === 'atlas' ? { ...a, displayName: 'Atlas Research and Release Planning Workstation' } : a); await route.fulfill({ response: r, json: data }); });
  await page.reload(); await page.locator('.chat-head h1').waitFor(); await page.evaluate(() => { document.documentElement.dataset.text = 'large'; });
  check('long agent identity at 320px Large text', await measureHeader()); await page.screenshot({ animations: 'disabled', path: path.join(output, 'phone-320-long-name.png') });
  await page.getByRole('button', { name: 'More chat actions' }).click(); await page.getByRole('menuitem', { name: 'Screen', exact: true }).waitFor();
  await page.keyboard.press('Escape'); check('mobile secondary actions remain accessible');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Menu', exact: true }).click();
  assert.equal(await page.locator('.sidebar').getAttribute('aria-modal'), 'true'); assert.equal(await page.locator('main').getAttribute('inert'), '');
  assert(await page.locator('.sidebar').evaluate((el) => el.contains(document.activeElement)));
  await page.getByRole('button', { name: 'Sign out', exact: true }).focus(); await page.keyboard.press('Tab');
  assert(await page.getByRole('button', { name: 'Close navigation' }).evaluate((el) => el === document.activeElement));
  await page.keyboard.press('Shift+Tab'); assert(await page.getByRole('button', { name: 'Sign out', exact: true }).evaluate((el) => el === document.activeElement));
  await page.screenshot({ animations: 'disabled', path: path.join(output, 'phone-modal-drawer.png') });
  await page.keyboard.press('Escape'); assert(await page.getByRole('button', { name: 'Menu', exact: true }).evaluate((el) => el === document.activeElement));
  check('phone drawer containment and Escape restoration');
  await page.getByRole('button', { name: 'Menu', exact: true }).click(); await page.setViewportSize({ width: 1280, height: 800 });
  await page.locator('.sidebar[aria-modal=true]').waitFor({ state: 'detached' }); assert.equal(await page.locator('main').getAttribute('inert'), null); check('desktop resize releases the modal background');

  await page.setViewportSize({ width: 390, height: 844 }); await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await page.screenshot({ animations: 'disabled', path: path.join(output, 'phone-dark.png') });
  assert.equal(await page.locator('.chat h1').count(), 1); check('chat has a descriptive heading');
  assert.deepEqual(errors, []); check('no browser application errors');
  await context.close();
} catch (e) {
  errors.push(e.message); throw e;
} finally {
  await browser?.close(); hub.closeAllConnections(); await new Promise((resolve) => hub.close(resolve));
  await writeFile(path.join(output, 'observations.json'), JSON.stringify({ checkedDate: '2026-10-10', timezone: 'Asia/Bangkok', environment: 'Chromium and isolated mock hub; no device or screen-reader acceptance', checks, errors }, null, 2));
}
