// Visual probe: brand menu layout, local project entries, gutter resize.
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const require = createRequire(process.env.PLAYWRIGHT_PACKAGE || 'playwright/package.json');
const { chromium } = require('playwright');
const out = fileURLToPath(new URL('./artifacts/', import.meta.url)); await mkdir(out, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, acceptDownloads: true });
const errors = []; page.on('pageerror', e => errors.push(e.message));
await page.goto('http://127.0.0.1:8899/', { waitUntil: 'networkidle' });
await page.waitForSelector('body[data-ready="true"]');
// Create a project so the menu has a local entry, then reload to list it.
await page.locator('#welcome-new').click();
await page.locator('#new-project-name').fill('测试项目');
await page.locator('#confirm-new-project').click();
await page.waitForSelector('#welcome', { state: 'hidden' });
// The new-project dialog closes after creation; wait for it before continuing.
await page.waitForFunction(() => !document.getElementById('dialog').open);
await page.waitForFunction(() => document.getElementById('save-state').innerText.includes('已保存'));
// Gutter drag: widen sidebar via the first vertical gutter.
const before = await page.evaluate(() => getComputedStyle(document.getElementById('workspace')).gridTemplateColumns);
const gutter = await page.locator('#gutter-sidebar').boundingBox();
await page.mouse.move(gutter.x + gutter.width / 2, gutter.y + 300);
await page.mouse.down();
await page.mouse.move(gutter.x + 120, gutter.y + 300, { steps: 8 });
await page.mouse.up();
const after = await page.evaluate(() => getComputedStyle(document.getElementById('workspace')).gridTemplateColumns);
// Timeline gutter drag: raise the timeline height.
const timelineBefore = await page.evaluate(() => getComputedStyle(document.getElementById('workspace')).gridTemplateRows);
const tg = await page.locator('#gutter-timeline').boundingBox();
await page.mouse.move(tg.x + 700, tg.y + tg.height / 2);
await page.mouse.down();
await page.mouse.move(tg.x + 700, tg.y - 60, { steps: 8 });
await page.mouse.up();
const timelineAfter = await page.evaluate(() => getComputedStyle(document.getElementById('workspace')).gridTemplateRows);
// Open the brand menu and screenshot the local project entries.
await page.locator('.brand-menu summary').click();
await page.waitForSelector('#menu-projects .menu-project');
await page.screenshot({ path: `${out}/ui-brand-menu.png` });
const entryText = await page.locator('#menu-projects .menu-project').first().innerText();
console.log(JSON.stringify({
  sidebarResized: before !== after, sidebarBefore: before.split(' ').slice(0, 2).join(' '), sidebarAfter: after.split(' ').slice(0, 2).join(' '),
  timelineResized: timelineBefore !== timelineAfter, timelineAfter: timelineAfter.split(' ').filter(Boolean).slice(-2).join(' '),
  menuEntry: entryText.replace(/\n/g, ' | '), errors,
}, null, 2));
await browser.close();
