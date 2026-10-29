// Run with the static PrevizCam site already listening at 127.0.0.1:8899.
// Uses an independent browser context and a private MCP process/bridge port.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { unzipSync } from '../vendor/libs/fflate.module.js';
const require = createRequire(new URL('../mcp/package.json', import.meta.url));
const { Client } = require('@modelcontextprotocol/client');
const { StdioClientTransport } = require('@modelcontextprotocol/client/stdio');
const { chromium } = createRequire(process.env.PLAYWRIGHT_PACKAGE || 'playwright/package.json')('playwright');
const out = fileURLToPath(new URL('./artifacts/mcp/', import.meta.url)); await mkdir(out, { recursive: true });
const bridgePort = process.env.PREVIZCAM_TEST_PORT || '18900';
const siteUrl = process.env.PREVIZCAM_TEST_URL || 'http://127.0.0.1:8899/';
// Headless WebM capture depends on the host browser build. Skip only the video
// assertions when the encoder is unavailable, and say so in the pass lines.
const skipVideo = process.env.PREVIZCAM_TEST_SKIP_VIDEO === '1';
const videoFormats = skipVideo ? ['project', 'storyboard', 'timeline', 'report'] : ['project', 'storyboard', 'timeline', 'report', 'video'];
const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../mcp/server.mjs', import.meta.url))], env: { ...process.env, PREVIZCAM_BRIDGE_PORT: bridgePort, PREVIZCAM_ALLOWED_ORIGINS: new URL(siteUrl).origin, PREVIZCAM_OUTPUT_DIR: out }, stderr: 'pipe' });
const client = new Client({ name: 'previzcam-e2e', version: '1.0.0' });
let browser, page, workspaceId, serverLog = '';
const errors = [];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function tool(name, args = {}, errorCode) {
  const result = await client.callTool({ name, arguments: { ...(workspaceId ? { workspaceId } : {}), ...args } }, { timeout: 60000 });
  const data = result.structuredContent || JSON.parse(result.content.find(x => x.type === 'text').text);
  if (errorCode) { assert.equal(result.isError, true, JSON.stringify(data)); assert.equal(data.code, errorCode); }
  else assert.ok(!result.isError, `${name}: ${JSON.stringify(data)}`);
  return { data, result };
}
async function context() { return (await tool('get_context')).data; }
async function idle() { for (let i = 0; i < 60; i++) { if (!(await context()).activity) return; await wait(100); } throw new Error('Renderer did not become idle'); }
async function done(jobId) {
  for (let i = 0; i < 160; i++) { const job = (await tool('get_job', { jobId })).data; if (job.status !== 'running') return job; await wait(250); }
  throw new Error('Export did not finish');
}
const pass = message => console.log(`PASS ${message}`);
try {
  await client.connect(transport); transport.stderr?.on('data', chunk => { serverLog += chunk.toString(); });
  const tools = (await client.listTools()).tools; assert.equal(tools.length, 12); assert.ok(!tools.some(t => /apply|eval|shell/.test(t.name)));
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox'] });
  const browserContext = await browser.newContext({ viewport: { width: 1440, height: 960 }, acceptDownloads: true });
  page = await browserContext.newPage(); page.on('pageerror', error => errors.push(error.message)); page.setDefaultTimeout(15000);
  await page.goto(siteUrl); await page.waitForSelector('body[data-ready="true"]');
  // The workbench now starts from an empty project; load the three-shot demo the
  // agent flow below is written against, then let the archive save settle.
  await page.evaluate(() => document.getElementById('welcome-demo')?.click() || document.getElementById('load-demo')?.click());
  await page.waitForFunction(() => document.querySelectorAll('.shot-card').length === 3, { timeout: 20000 });
  await wait(800);
  await page.locator('#open-agent').click(); await page.locator('#agent-port').fill(bridgePort); await page.locator('#agent-connect').click();
  await page.waitForFunction(() => document.querySelector('#agent-connection-state').textContent.includes('已连接'));
  const list = await client.callTool({ name: 'list_workspaces', arguments: {} }); workspaceId = list.structuredContent.workspaces[0].workspaceId;
  const initial = await context(); assert.equal(initial.project.shots.length, 3);
  await tool('get_context', { workspaceId: 'wrong-workspace' }, 'WORKSPACE_NOT_FOUND');
  // Scene reads are a summary by default; meshes are paged and filtered on demand.
  const summary = (await context()).spatialContext;
  assert.equal(summary.meshes.detail, 'summary');
  assert.equal(summary.meshes.items.length, 0, 'the default context must not dump every mesh');
  assert.ok(summary.meshes.total > 10, `expected a real mesh set, got ${summary.meshes.total}`);
  assert.ok(summary.objects.length > 0);
  const paged = (await tool('get_context', { spatial: { detail: 'full', meshLimit: 3 } })).data.spatialContext.meshes;
  assert.equal(paged.returned, 3); assert.equal(paged.nextOffset, 3);
  const nextPage = (await tool('get_context', { spatial: { detail: 'full', meshLimit: 3, meshOffset: 3 } })).data.spatialContext.meshes;
  assert.ok(nextPage.items.length > 0 && nextPage.items.every(m => !paged.items.some(seen => seen.id === m.id)), 'pages must not repeat');
  const filtered = (await tool('get_context', { spatial: { detail: 'full', meshQuery: paged.items[0].name } })).data.spatialContext.meshes;
  assert.ok(filtered.matched >= 1 && filtered.matched <= summary.meshes.total);
  pass('real stdio MCP handshake, 12 discoverable tools, explicit browser workspace');
  let draft = (await tool('create_draft', { label: '访客接待 · MCP 验收' })).data;
  const plan = structuredClone(draft.plan), newActor = { id: 'CHAR_VISITOR', name: '访客', color: '#556677', height: 1.72, position: [0, .43, -3.1], facing: 90 };
  plan.actors.push(newActor); plan.cameras[0].keyframes[0].position[0] += .2;
  plan.shots = plan.shots.map((s, i) => ({ ...s, id: `CUSTOM_${i + 1}`, title: `访客镜头 ${i + 1}`, action: '访客由门口来到接待区。', cast: [newActor.id], blocking: { [newActor.id]: [{ t: 0, position: [0, .43, -2.4] }, { t: 1, position: [0, .43, -3.1] }] } }));
  let frame = 0;
  plan.script = { title: '访客接待', format: { fps: 24 }, cameraPolicy: { mode: 'static' }, characters: [{ id: newActor.id, name: newActor.name }], shots: [{ id: 'CUSTOM_GROUP', locationId: plan.sceneId, cast: [newActor.id], materials: plan.shots.map(s => {
    const m = { id: s.id, locationId: plan.sceneId, action: s.action, useSeconds: s.duration, startFrame: frame, endFrame: frame + s.duration * 24 }; frame = m.endFrame; return m;
  }) }] };
  draft = (await tool('update_draft', { draftId: draft.id, expectedVersion: draft.version, plan })).data;
  const invalid = structuredClone(plan); invalid.sceneId = 'WRONG_SCENE'; await tool('update_draft', { draftId: draft.id, expectedVersion: draft.version, plan: invalid }, 'SCENE_MISMATCH');
  assert.deepEqual((await context()).project, initial.project);
  draft = (await tool('check_draft', { draftId: draft.id })).data;
  assert.ok(draft.checks.limitations.length >= 3); assert.equal(draft.checkedVersion, draft.version);
  // Submitting without having looked at the required times names exactly what is missing.
  const gate = await tool('submit_draft', { draftId: draft.id, expectedVersion: draft.version, summary: '未看画面' }, 'MISSING_FRAMES');
  assert.match(gate.data.message, /缺 t=0/);
  assert.match(gate.data.message, /0\.5/);
  assert.ok(gate.data.details.coverage.every(c => c.capturedTimes.length === 0));
  // First pass: one contact sheet, while every frame stays saved as evidence.
  const images = await tool('render_frames', { draftId: draft.id });
  assert.equal(images.result.content.filter(c => c.type === 'image').length, 1, 'one sheet instead of nine images');
  assert.equal(images.data.sheets.length, 1);
  assert.equal(images.data.frames.length, 9, 'the default batch covers every required time of the three shots');
  assert.ok(images.data.coverage.every(c => c.missingRequiredTimes.length === 0));
  assert.equal(images.data.artifacts.length, 10, 'nine frames plus the sheet are saved');
  assert.equal(images.data.draftVersion, draft.version);
  const sheet = await readFile(images.data.artifacts.find(a => a.name === 'contact-sheet.png').path);
  assert.equal(sheet.subarray(1, 4).toString(), 'PNG');
  assert.equal(sheet.readUInt32BE(16), 1280); assert.equal(sheet.readUInt32BE(20), 3 * 180);
  const png = await readFile(images.data.artifacts[0].path); assert.equal(png.subarray(1, 4).toString(), 'PNG');
  assert.equal(png.readUInt32BE(16), 1280); assert.equal(png.readUInt32BE(20), 720); assert.ok(png.length > 10000);
  // Details on demand: individual frames come back as images.
  const detail = await tool('render_frames', { draftId: draft.id, view: 'frames', frames: [{ shotId: plan.shots[0].id, progress: 0 }] });
  assert.equal(detail.result.content.filter(c => c.type === 'image').length, 1);
  assert.equal(detail.data.sheets.length, 0);
  draft = (await tool('submit_draft', { draftId: draft.id, expectedVersion: draft.version, summary: '根据新剧本创建访客和三镜头，按固定机位约束安排走位。', unresolved: ['对白时长和精细表演需要后续验证。'] })).data;
  pass('novel script/actor/shot IDs, isolated edits, contact sheet plus per-frame evidence and sampled check report');
  const exported = (await tool('export_artifacts', { draftId: draft.id, formats: videoFormats })).data;
  const completed = await done(exported.id); assert.equal(completed.status, 'completed', JSON.stringify(completed.error));
  assert.equal(completed.artifacts.length, videoFormats.length + 1);
  const byName = name => completed.artifacts.find(a => a.name === name).path;
  const restored = JSON.parse(await readFile(byName('previzcam-project.json'), 'utf8')); assert.deepEqual(restored.shots, plan.shots);
  const archive = unzipSync(new Uint8Array(await readFile(byName('previzcam-storyboards.zip')))); assert.equal(Object.keys(archive).filter(n => n.endsWith('.png')).length, 9);
  const report = JSON.parse(await readFile(byName('review-report.json'), 'utf8')); assert.equal(report.source.draftVersion, draft.version); assert.ok(report.limitations.length);
  if (!skipVideo) {
    const movie = await readFile(byName('previzcam-preview.webm')); assert.equal(movie.subarray(0, 4).toString('hex'), '1a45dfa3'); assert.ok(movie.length > 10000);
  }
  assert.deepEqual((await context()).project, initial.project); await idle();
  pass(`editable project, nine storyboard frames, timeline and versioned manifest${skipVideo ? ' (video skipped)' : ' plus a complete 12-second WebM'}`);
  if (!skipVideo) {
    const cancelled = (await tool('export_artifacts', { draftId: draft.id, formats: ['video'] })).data;
    await wait(350); await tool('cancel_job', { jobId: cancelled.id }); const cancelResult = await done(cancelled.id); assert.equal(cancelResult.status, 'cancelled'); assert.ok(!cancelResult.artifacts); await idle();
    const hidden = (await tool('export_artifacts', { draftId: draft.id, formats: ['video'] })).data;
    await wait(300);
    // Headless Chrome keeps pages visible even when another tab is brought forward.
    // Exercise the real application's visibility handler with a synthetic browser state.
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
    const hiddenResult = await done(hidden.id); assert.equal(hiddenResult.status, 'failed'); assert.equal(hiddenResult.error.code, 'PAGE_HIDDEN');
    await page.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); }); await idle();
    pass('cancelled recordings and simulated page-hidden events deliver no partial output');
  }
  // The page is the only renderer: a request waits for it instead of guessing with sleeps.
  // Human preview is a busy state too, and unlike a video export it is deterministic here.
  await page.locator(`[data-review="${draft.id}"]`).click();
  await page.waitForSelector('#agent-preview-monitor canvas');
  assert.equal((await context()).activity, 'review', 'the page must report the human preview as busy');
  const waiting = tool('create_draft', { label: '等待空闲后创建' });
  await wait(600);
  await page.locator('#agent-back').click();
  const waited = (await waiting).data;
  assert.equal(waited.label, '等待空闲后创建', 'the draft must be created once the workbench is idle again');
  await tool('discard_draft', { draftId: waited.id });
  await idle();
  pass('agent requests wait for a busy workbench and then apply instead of failing');
  await page.locator(`[data-review="${draft.id}"]`).click(); await page.waitForSelector('#agent-preview-monitor canvas');
  await page.locator('#agent-preview-play').click();
  // The clock advances on requestAnimationFrame, so poll instead of sampling once:
  // a fixed short wait is a race against the first frame.
  await page.waitForFunction(() => Number(document.getElementById('agent-preview-time').value) > 0, { timeout: 10000 });
  assert.deepEqual((await context()).project, initial.project); await page.screenshot({ path: `${out}/review-desktop.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: `${out}/review-mobile.png`, fullPage: true });
  assert.equal(await page.locator('#agent-dialog').evaluate(el => el.scrollWidth <= el.clientWidth + 1), true);
  await page.setViewportSize({ width: 1440, height: 960 }); await page.locator('#agent-apply').click();
  const applied = await context(); assert.deepEqual(applied.project.shots, plan.shots); assert.deepEqual(applied.project.actors, plan.actors);
  await page.locator('#agent-close').click(); await page.locator('#undo').click(); assert.deepEqual((await context()).project, initial.project);
  await wait(650); await page.reload(); await page.waitForSelector('body[data-ready="true"]');
  // Reload creates a new workspace incarnation and reads the last saved project.
  await page.locator('#open-agent').click(); await page.locator('#agent-port').fill(bridgePort); await page.locator('#agent-connect').click();
  await page.waitForFunction(() => document.querySelector('#agent-connection-state').textContent.includes('已连接'));
  const freshList = await client.callTool({ name: 'list_workspaces', arguments: {} }); const previousWorkspace = workspaceId; workspaceId = freshList.structuredContent.workspaces[0].workspaceId;
  assert.notEqual(workspaceId, previousWorkspace); assert.deepEqual((await context()).project, initial.project);
  pass('responsive read-only playback, one apply/undo, persistence and new workspace after reload');
  const stale = (await tool('create_draft', { label: 'stale test' })).data;
  await page.locator('#agent-close').click(); const position = page.locator('[data-vector="position"][data-axis="0"]'); await position.fill('2.5'); await position.press('Tab');
  assert.equal((await tool('get_draft', { draftId: stale.id })).data.stale, true);
  await tool('check_draft', { draftId: stale.id }, 'STALE_DRAFT');
  await tool('export_artifacts', { expectedRevision: initial.revision, formats: ['project'] }, 'STALE_REVISION');
  pass('human edits invalidate older drafts and stale active exports');
  // A completed package from the previous tab is still available from the MCP process.
  const old = await client.callTool({ name: 'get_job', arguments: { workspaceId: previousWorkspace, jobId: completed.id } }); assert.equal(old.structuredContent.status, 'completed');
  if (!skipVideo) {
    const now = await context(), disconnectJob = (await tool('export_artifacts', { expectedRevision: now.revision, formats: ['video'] })).data;
    await wait(300); await page.locator('#open-agent').click(); await page.locator('#agent-connect').click(); await wait(100);
    const disconnected = await done(disconnectJob.id); assert.equal(disconnected.status, 'failed'); assert.equal(disconnected.error.code, 'WORKSPACE_DISCONNECTED');
    pass('disconnect failure, durable completed package references, no browser exceptions');
  } else pass('durable completed package references and no browser exceptions (video skipped)');
  console.log(JSON.stringify({ artifacts: completed.artifacts, screenshots: [`${out}/review-desktop.png`, `${out}/review-mobile.png`] }, null, 2));
} catch (error) {
  console.error(error, '\nSERVER:', serverLog, '\nBROWSER:', errors);
  if (page && !page.isClosed()) await page.screenshot({ path: `${out}/failure.png`, fullPage: true }).catch(() => {});
  process.exitCode = 1;
} finally { await browser?.close(); await client.close(); await transport.close(); }
