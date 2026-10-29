import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const require = createRequire(process.env.PLAYWRIGHT_PACKAGE || 'playwright/package.json');
const { chromium } = require('playwright');
const out = fileURLToPath(new URL('./artifacts/', import.meta.url)); await mkdir(out, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, acceptDownloads: true });
const errors = []; page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
try {
  await page.goto(process.env.PREVIZCAM_TEST_URL || 'http://127.0.0.1:8899/', { waitUntil: 'networkidle' });
  await page.waitForSelector('body[data-ready="true"]', { timeout: 30000 });
  // The workspace starts empty: the welcome card is visible and no demo shots exist.
  await page.waitForSelector('#welcome:not([hidden])', { timeout: 10000 });
  const demoShots = await page.locator('.shot-card').count();
  await page.screenshot({ path: `${out}/initial.png`, fullPage: true });
  // Load the demo through the welcome card, then exercise the review flow.
  await page.locator('#welcome-demo').click();
  await page.waitForSelector('#welcome', { state: 'hidden', timeout: 15000 });
  await page.waitForFunction(() => document.querySelectorAll('.shot-card').length > 0, { timeout: 15000 });
  console.log(JSON.stringify({ ready: true, welcomeOnStart: demoShots === 0, shots: await page.locator('.shot-card').count(), actors: await page.locator('#actor-list button').count(), cameras: await page.locator('#camera-list button').count(), errors }, null, 2));
  await page.locator('#validate').click();
  await page.waitForFunction(() => !document.getElementById('dialog-body').innerText.includes('正在采样'));
  console.log('CHECKS', await page.locator('#dialog-body').innerText());
  await page.screenshot({ path: `${out}/checks.png`, fullPage: true });
  await page.locator('#dialog-close').click();
  const downloadPromise = page.waitForEvent('download'); await page.locator('#snapshot').click();
  const file = await downloadPromise; await file.saveAs(`${out}/first-frame.png`);
} catch (e) {
  console.error('SMOKE_FAILURE', e.message, 'ERRORS', errors);
  await page.screenshot({ path: `${out}/failure.png`, fullPage: true });
  process.exitCode = 1;
} finally { await browser.close(); }
