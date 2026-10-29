import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { BrowserBridge } from './bridge.mjs';
import { ArtifactStore } from './artifacts.mjs';

const port = Number(process.env.PREVIZCAM_BRIDGE_PORT || 8900);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PREVIZCAM_BRIDGE_PORT must be 1024–65535');
const origins = (process.env.PREVIZCAM_ALLOWED_ORIGINS || 'http://127.0.0.1:8899').split(',').map(s => s.trim());
for (const origin of origins) {
  const url = new URL(origin);
  if (url.origin !== origin || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.protocol !== 'http:') throw new Error('Only explicit loopback HTTP site origins are supported');
}
const store = new ArtifactStore(process.env.PREVIZCAM_OUTPUT_DIR || fileURLToPath(new URL('../outputs/previzcam/', import.meta.url)));
const jobs = new Map(), saving = new Map();
const bridge = new BrowserBridge({ port, origins, onDisconnect(workspaceId) {
  for (const job of jobs.values()) if (job.workspaceId === workspaceId && !['completed', 'failed', 'cancelled'].includes(job.status)) {
    job.status = 'failed'; job.error = { code: 'WORKSPACE_DISCONNECTED', message: '页面断开，导出已中止。' };
  }
} });
const server = new McpServer({ name: 'previzcam', version: '1.0.0' }, { instructions: 'PrevizCam controls an explicitly connected local browser workspace. Work only in drafts. Call check_draft then submit_draft; the user applies in the website. Re-read after stale/conflict/disconnect errors. Geometry checks are sampled, not proof of continuous collision freedom.' });
const workspace = { workspaceId: z.string().min(1).max(100) }, draft = { ...workspace, draftId: z.string().uuid() };
const version = z.number().int().positive();
const vector = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);
const actorKey = z.object({ t: z.number().min(0).max(1), position: vector });
const camera = z.object({ id: z.string(), name: z.string(), locked: z.boolean(), mode: z.enum(['static', 'linear', 'smooth']), keyframes: z.array(actorKey.extend({ target: vector, fov: z.number().min(5).max(140) })).min(1).max(500) }).passthrough();
const actor = z.object({ id: z.string(), name: z.string(), color: z.string(), height: z.number(), facing: z.number(), position: vector }).passthrough();
const shot = z.object({ id: z.string(), title: z.string(), sceneId: z.string(), cameraId: z.string(), duration: z.number(), cast: z.array(z.string()), action: z.string(), motionPolicy: z.enum(['static', 'unspecified']), blocking: z.record(z.string(), z.array(actorKey)) }).passthrough();
const plan = z.object({ type: z.literal('previzcam.previs-plan'), version: z.literal(1), sceneId: z.string(), script: z.object({ shots: z.array(z.record(z.string(), z.unknown())) }).passthrough(), actors: z.array(actor).max(100), cameras: z.array(camera).min(1).max(100), shots: z.array(shot).max(500) }).strict();
const textResult = data => ({ content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data });
const errorResult = error => ({ isError: true, content: [{ type: 'text', text: JSON.stringify({ code: error.code || 'COMMAND_FAILED', message: error.message,
  ...(Number.isFinite(error.retryAfterMs) ? { retryAfterMs: error.retryAfterMs } : {}), ...(error.details ? { details: error.details } : {}) }) }] });
const BUSY_RETRIES = 3, delay = ms => new Promise(resolve => setTimeout(resolve, ms));
// The page waits for itself and reports the reason; if it is still busy we queue here
// instead of failing, so the agent never has to invent a sleep interval.
async function callBridge(workspaceId, method, args) {
  for (let attempt = 0; ; attempt++) {
    try { return await bridge.call(workspaceId, method, args); }
    catch (error) {
      if (error.code !== 'WORKSPACE_BUSY' || attempt >= BUSY_RETRIES) throw error;
      await delay(Math.min(Number(error.retryAfterMs) || 20000, 30000));
    }
  }
}
function tool(name, description, schema, readOnly, fn) {
  server.registerTool(name, { description, inputSchema: z.object(schema).strict(), annotations: { readOnlyHint: readOnly, destructiveHint: false, openWorldHint: false } }, async args => {
    try { return await fn(args); }
    catch (e) { return errorResult(e); }
  });
}
const relay = method => async args => textResult(await callBridge(args.workspaceId, method, args));
tool('list_workspaces', 'List explicitly connected browser tabs. Select a workspaceId; never assume the first tab is the intended project.', {}, true, async () => textResult({ workspaces: bridge.list() }));
tool('get_context', 'Read the active project, revision, spatial context and draft list. Geometry remains in the browser. Default spatial context is a summary: semantic groups, bounds, anchors, actors, shots, cameras and mesh counts. Pass spatial.detail "full" with meshQuery / meshGroup / meshLimit / meshOffset / meshSort to page through individual meshes. Returns an example previs plan.', {
  ...workspace,
  spatial: z.object({ detail: z.enum(['summary', 'full']).optional(), meshQuery: z.string().max(200).optional(), meshGroup: z.string().max(100).optional(),
    meshLimit: z.number().int().min(1).max(200).optional(), meshOffset: z.number().int().min(0).optional(), meshSort: z.enum(['size', 'name']).optional() }).strict().optional(),
}, true, relay('get_context'));
tool('create_draft', 'Clone the current project into an independent, session-local draft. No active project changes.', { ...workspace, label: z.string().max(160).optional() }, false, relay('create_draft'));
tool('get_draft', 'Read a full draft, version, check results and stale status.', draft, true, relay('get_draft'));
tool('update_draft', 'Atomically replace the whole previs plan. Use expectedVersion from get_draft. Preserve locked cameras and static camera policies. Scene/model/format are fixed.', { ...draft, expectedVersion: version, plan }, false, relay('update_draft'));
tool('check_draft', 'Validate the current draft against the real loaded geometry. Returns sampled issues and explicit limitations. Required before submission.', draft, true, relay('check_draft'));
tool('render_frames', 'Render actual PNG frames from a draft. progress is normalized 0..1 within each shot, 1–12 frames per call. Omit frames to cover every required observation time (start/middle/end plus camera and blocking keys) of as many whole shots as fit; coverage reports required, captured and still-missing times per shot. Default view "auto" returns one contact sheet when several frames render and lists the saved per-frame artifacts; view "frames" returns each image, "sheet" forces the sheet.', {
  ...draft, view: z.enum(['auto', 'sheet', 'frames']).default('auto'),
  frames: z.array(z.object({ shotId: z.string(), progress: z.number().min(0).max(1) })).min(1).max(12).optional(),
}, true, async args => {
  const result = await callBridge(args.workspaceId, 'render_frames', args);
  const { files, ...metadata } = result, saved = await store.save(files, metadata);
  const sheetNames = new Set((result.sheets || []).map(sheet => sheet.name));
  // The contact sheet replaces N images on the wire; every frame stays a saved artifact.
  const shown = args.view === 'frames' ? files.filter(file => !sheetNames.has(file.name))
    : sheetNames.size ? files.filter(file => sheetNames.has(file.name)) : files;
  const note = args.view !== 'frames' && sheetNames.size && result.frames.length > 1
    ? `已回传接触表；${result.frames.length} 张单帧已保存为 artifacts。需要逐张看细节时用 view:"frames"，复核时可直接引用这些文件名。`
    : undefined;
  const payload = { ...metadata, ...saved, ...(note ? { note } : {}) };
  return { ...textResult(payload), content: [
    { type: 'text', text: JSON.stringify(payload) },
    ...shown.map(file => ({ type: 'image', mimeType: file.mimeType, data: file.data })),
  ] };
});
tool('submit_draft', 'Submit the checked draft for human review in the website. Does NOT apply. Include an honest change summary and unresolved visual/narrative issues.', { ...draft, expectedVersion: version, summary: z.string().min(1).max(5000), unresolved: z.array(z.string().max(1000)).max(50).default([]) }, false, relay('submit_draft'));
tool('discard_draft', 'Discard an unwanted draft without changing the active project.', draft, false, relay('discard_draft'));
tool('export_artifacts', 'Start an asynchronous export from a frozen active revision or a draft. Formats: project, storyboard, timeline, report, video. WebM requires a visible page and at most five minutes. Poll get_job.', {
  ...workspace, draftId: z.string().uuid().optional(), expectedRevision: z.string().optional(),
  formats: z.array(z.enum(['project', 'storyboard', 'timeline', 'report', 'video'])).min(1).max(5).default(['project', 'storyboard', 'timeline', 'report']),
}, false, async args => {
  if (!args.draftId && !args.expectedRevision) throw Object.assign(new Error('导出正式项目需要 get_context 返回的 expectedRevision。'), { code: 'REVISION_REQUIRED' });
  const job = await bridge.call(args.workspaceId, 'export_artifacts', args); jobs.set(`${args.workspaceId}:${job.id}`, job); return textResult(job);
});
tool('get_job', 'Read export progress, failure/cancellation, or completed artifact paths and checksums. Completed packages remain available after browser disconnect.', { ...workspace, jobId: z.string().uuid() }, true, async args => {
  const key = `${args.workspaceId}:${args.jobId}`, known = jobs.get(key);
  if (known && ['completed', 'failed', 'cancelled'].includes(known.status)) return textResult(known);
  if (saving.has(key)) return textResult(await saving.get(key));
  const result = await bridge.call(args.workspaceId, 'get_job', args);
  if (result.status !== 'completed') { jobs.set(key, result); return textResult(result); }
  const save = (async () => {
    const { files, ...metadata } = result;
    const saved = { ...metadata, ...await store.save(files, metadata) }; jobs.set(key, saved); return saved;
  })();
  saving.set(key, save);
  try { return textResult(await save); } finally { saving.delete(key); }
});
tool('cancel_job', 'Cancel a running export. No partial package is delivered.', { ...workspace, jobId: z.string().uuid() }, false, async args => {
  const key = `${args.workspaceId}:${args.jobId}`, known = jobs.get(key);
  if (known && ['completed', 'failed', 'cancelled'].includes(known.status)) return textResult(known);
  const result = await bridge.call(args.workspaceId, 'cancel_job', args); jobs.set(key, result); return textResult(result);
});
server.registerResource('previs-contract', 'previzcam://reference/previs-contract', { mimeType: 'text/markdown', description: 'Coordinate conventions, input/output contract and workflow examples.' }, async uri => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: await readFile(new URL('./CONTRACT.md', import.meta.url), 'utf8') }] }));

let closing = false;
async function shutdown() { if (closing) return; closing = true; await bridge.close(); await server.close(); }
try {
  await bridge.start();
  await server.connect(new StdioServerTransport());
  console.error(`PrevizCam MCP ready; browser bridge 127.0.0.1:${port}; allowed site ${origins.join(', ')}`);
  process.stdin.on('end', () => { void shutdown(); });
  process.on('SIGINT', () => { void shutdown(); }); process.on('SIGTERM', () => { void shutdown(); });
} catch (error) { console.error(`PrevizCam MCP failed: ${error.message}`); await bridge.close(); process.exitCode = 1; }
