import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createProject, cameraPlan, validateProject } from '../preview/core.mjs';
import { unzipSync } from '../vendor/libs/fflate.module.js';
const require = createRequire(process.env.PLAYWRIGHT_PACKAGE || 'playwright/package.json');
const { chromium } = require('playwright');
const directory = fileURLToPath(new URL('./artifacts/', import.meta.url)); await mkdir(directory, { recursive: true });
const script = JSON.parse(await readFile(new URL('../assets/script.json', import.meta.url), 'utf8'));
const fixture = createProject(script);
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, acceptDownloads: true });
const page = await context.newPage(), errors = [], passed = [];
page.setDefaultTimeout(15000); page.on('pageerror', e => errors.push(e.message));
const ready = () => page.waitForSelector('body[data-ready="true"]');
const check = name => { passed.push(name); console.log('PASS', name); };
const change = async (selector, value) => { await page.locator(selector).fill(String(value)); await page.locator(selector).press('Tab'); };
const seek = time => page.locator('#scrubber').evaluate((el, t) => { el.value = t; el.dispatchEvent(new Event('input', { bubbles: true })); }, time);
const getDownload = async (selector, name) => { const pending = page.waitForEvent('download', { timeout: 45000 }); await page.locator(selector).click(); const d = await pending; const path = `${directory}/${name}`; await d.saveAs(path); return path; };
const saveProject = async name => { await page.locator('.menu summary').click(); return JSON.parse(await readFile(await getDownload('#save-project', name), 'utf8')); };
try {
  await page.goto(process.env.PREVIZCAM_TEST_URL || 'http://127.0.0.1:8899/'); await ready();
  // The workspace starts empty; load the demo before exercising edit flows.
  assert.equal(await page.locator('#welcome').isVisible(), true);
  assert.equal(await page.locator('.shot-card').count(), 0);
  await page.locator('#welcome-demo').click();
  await page.waitForSelector('#welcome', { state: 'hidden' });
  await page.waitForFunction(() => document.querySelectorAll('.shot-card').length > 0);
  assert.equal(await page.locator('.shot-card').count(), 3); assert.equal(await page.locator('#stage canvas').count(), 1);
  await page.screenshot({ path: `${directory}/desktop.png`, fullPage: true });
  check('welcome starts empty, demo loads on demand with GLB and three material-level shots');

  const initialX = Number(await page.locator('[data-vector=position][data-axis="0"]').inputValue());
  await change('[data-vector=position][data-axis="0"]', initialX + .35);
  assert.ok(Math.abs(Number(await page.locator('[data-vector=position][data-axis="0"]').inputValue()) - initialX - .35) < 1e-6);
  await page.locator('#undo').click(); assert.equal(Number(await page.locator('[data-vector=position][data-axis="0"]').inputValue()), initialX);
  await page.locator('#redo').click(); assert.ok(Math.abs(Number(await page.locator('[data-vector=position][data-axis="0"]').inputValue()) - initialX - .35) < 1e-6);
  await page.locator('#undo').click();
  await page.locator('#camera-lock').check(); assert.equal(await page.locator('#camera-name').isDisabled(), true);
  await page.locator('#camera-lock').uncheck(); check('editing, undo, redo, camera lock');

  await page.locator('#camera-mode').selectOption('linear'); await page.locator('[data-key="1"]').click();
  await change('[data-vector=position][data-axis="0"]', initialX + .6);
  await seek(2.5); await page.locator('#add-key').click(); assert.equal(await page.locator('[data-key]').count(), 3);
  await page.locator('#open-export').click(); const timeline = JSON.parse(await readFile(await getDownload('#export-cameras', 'moving-timeline.json'), 'utf8'));
  assert.equal(timeline.shots[0].samples.length, 121); assert.equal(timeline.shots[0].samples.at(-1).position[0], initialX + .6);
  assert.equal(timeline.shots[1].startSeconds, 5); await page.locator('#dialog-close').click();
  check('path keyframes interpolate and export independently across hard cuts');

  await page.locator('#open-ai').click(); const plan = cameraPlan(fixture); plan.cameras = [plan.cameras[0]]; plan.cameras[0].id = 'CAM_REVIEW'; plan.cameras[0].name = '审核机位'; plan.assignments.forEach(a => a.cameraId = 'CAM_REVIEW');
  const invalid = structuredClone(plan); invalid.assignments[0].cameraId = 'MISSING';
  await page.locator('#ai-plan').fill(JSON.stringify(invalid)); await page.locator('#validate-plan').click();
  await page.waitForSelector('#plan-feedback .error-text'); assert.equal(await page.locator('#apply-plan').isDisabled(), true);
  await page.locator('#ai-plan').fill(JSON.stringify(plan)); await page.locator('#validate-plan').click();
  await page.waitForSelector('#plan-feedback .success-text'); await page.locator('#apply-plan').click();
  await page.waitForFunction(() => document.getElementById('save-state').innerText === '已保存到本机');
  await page.reload(); await ready();
  // Reload shows the welcome card again; reopen the saved project from it.
  assert.equal(await page.locator('#welcome').isVisible(), true);
  await page.locator('[data-welcome-project]').first().click();
  await page.waitForSelector('#welcome', { state: 'hidden' });
  await page.waitForFunction(() => document.getElementById('camera-name')?.innerText || document.querySelector('[data-vector=position]'));
  assert.equal(await page.locator('#camera-name').inputValue(), '审核机位');
  const exported = await saveProject('review-project.json'); validateProject(exported); assert.ok(exported.shots.every(s => s.cameraId === 'CAM_REVIEW'));
  await page.locator('.menu summary').click(); check('AI plan rejection, staged application, portable project and reopen persistence');

  await page.locator('#tab-scene').click(); await page.locator('[data-actor="CHAR_QINGRAN"]').click();
  await change('[data-vector=actor][data-axis="0"]', .3); assert.equal(await page.locator('[data-actor-time]').count(), 2);
  await page.locator('#undo').click();
  await page.locator('#model-file').setInputFiles(fileURLToPath(new URL('../assets/temple-gate.glb', import.meta.url)));
  await page.waitForSelector('#apply-calibration'); await page.locator('#dialog-close').click();
  const embedded = await saveProject('embedded-project.json'); assert.equal(embedded.scene.source, 'embedded'); assert.equal(Buffer.from(embedded.embeddedModel.base64, 'base64').readUInt32LE(0), 0x46546c67);
  await page.locator('.menu summary').click();
  await page.reload(); await ready();
  // Reload shows the welcome card; reopen the latest saved archive from it.
  assert.equal(await page.locator('#welcome').isVisible(), true);
  await page.locator('[data-welcome-project]').first().click();
  await page.waitForSelector('#welcome', { state: 'hidden' });
  await page.waitForFunction(() => document.querySelector('#camera-name') && document.querySelector('#camera-name').closest('fieldset,div') !== null);
  assert.equal(await page.locator('#camera-name').inputValue(), '审核机位');
  await page.locator('#project-file').setInputFiles(`${directory}/review-project.json`);
  await page.waitForFunction(() => document.getElementById('toast').textContent === '项目已打开，自动保存在本机项目列表。');
  check('actor blocking, GLB import, embedded model persistence and project restore');

  await page.locator('#open-export').click(); const archive = await getDownload('#export-storyboard', 'storyboards.zip');
  const files = unzipSync(new Uint8Array(await readFile(archive))); assert.equal(Object.keys(files).filter(k => k.endsWith('.png')).length, 9);
  assert.ok(files['camera-plan.json']); assert.ok(files['01_Q3_S4_M1_start.png'].length > 10000);
  const videoPending = page.waitForEvent('download', { timeout: 45000 }); await page.locator('#export-video').click();
  const video = await videoPending; await video.saveAs(`${directory}/preview.webm`); assert.ok((await stat(`${directory}/preview.webm`)).size > 20000);
  check('storyboard ZIP and complete real-time WebM export');

  await page.locator('#play').click(); await page.waitForFunction(() => document.getElementById('playhead-time').textContent !== '00:00:00'); await page.locator('#play').click();
  await seek(5); assert.equal(await page.locator('#context-id').textContent(), 'Q3_S4_M2');
  await seek(6); assert.equal(await page.locator('#context-id').textContent(), 'Q4_S1_M1');
  await seek(0);
  for (const width of [1280, 820, 390]) {
    await page.setViewportSize({ width, height: 900 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `horizontal overflow at ${width}`);
    await page.screenshot({ path: `${directory}/viewport-${width}.png`, fullPage: true });
  }
  check('playback boundaries and responsive layouts at 1280, 820, 390');
  assert.deepEqual(errors, []); check('no uncaught browser errors');
  await writeFile(`${directory}/workflow-results.json`, JSON.stringify({ passed, errors }, null, 2));
} catch (error) {
  console.error(error); console.error('Browser errors:', errors); await page.screenshot({ path: `${directory}/workflow-failure.png`, fullPage: true }); process.exitCode = 1;
} finally { await browser.close(); }
