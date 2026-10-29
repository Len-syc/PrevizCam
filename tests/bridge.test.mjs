import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserBridge } from '../mcp/bridge.mjs';
import { ArtifactStore } from '../mcp/artifacts.mjs';
const { WebSocket } = createRequire(new URL('../mcp/package.json', import.meta.url))('ws');
async function connect(bridge, id = 'test-workspace') {
  const socket = new WebSocket(`ws://127.0.0.1:${bridge.port}/bridge`, { origin: 'http://127.0.0.1:8899' });
  await once(socket, 'open'); const response = once(socket, 'message'); socket.send(JSON.stringify({ kind: 'hello', protocol: 1, workspaceId: id, name: 'Test', revision: 'v1' })); await response; return socket;
}
test('bridge enforces exact origin and routes commands to the requested tab only', async t => {
  const bridge = await new BrowserBridge({ port: 0 }).start(); t.after(() => bridge.close());
  const unauthorized = new WebSocket(`ws://127.0.0.1:${bridge.port}/bridge`, { origin: 'http://malicious.example' });
  const [error] = await once(unauthorized, 'error'); assert.match(error.message, /403/);
  const a = await connect(bridge, 'tab-a'), b = await connect(bridge, 'tab-b');
  assert.equal(bridge.list().length, 2);
  await assert.rejects(bridge.call('unknown', 'get_context'), { code: 'WORKSPACE_NOT_FOUND' });
  const got = once(a, 'message'), request = bridge.call('tab-a', 'get_context');
  const [bytes] = await got, message = JSON.parse(bytes);
  b.send(JSON.stringify({ kind: 'result', id: message.id, result: { from: 'wrong' } }));
  a.send(JSON.stringify({ kind: 'result', id: message.id, result: { from: 'tab-a' } }));
  assert.deepEqual(await request, { from: 'tab-a' });
});
test('disconnect rejects pending operations and removes that workspace', async t => {
  const bridge = await new BrowserBridge({ port: 0 }).start(); t.after(() => bridge.close());
  const socket = await connect(bridge); const result = bridge.call('test-workspace', 'render_frames');
  const assertion = assert.rejects(result, { code: 'WORKSPACE_DISCONNECTED' }); socket.close(); await assertion; assert.equal(bridge.list().length, 0);
});
test('timeout cancels a browser request rather than replaying it', async t => {
  const bridge = await new BrowserBridge({ port: 0, timeout: 60 }).start(); t.after(() => bridge.close());
  const socket = await connect(bridge); const messages = []; socket.on('message', bytes => messages.push(JSON.parse(bytes)));
  await assert.rejects(bridge.call('test-workspace', 'update_draft'), { code: 'REQUEST_TIMEOUT' });
  await new Promise(resolve => setTimeout(resolve, 20)); assert.deepEqual(messages.map(m => m.kind), ['request', 'cancelRequest']);
});
test('artifacts are versioned packages with hashes; traversal and invalid batches produce no files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'previzcam-artifacts-')), store = new ArtifactStore(directory);
  const input = { name: 'review.json', mimeType: 'application/json', data: Buffer.from('{"ok":true}').toString('base64') };
  const saved = await store.save([input], { workspaceId: 'tab', source: { kind: 'draft', draftVersion: 3 } });
  assert.equal(await readFile(saved.artifacts[0].path, 'utf8'), '{"ok":true}');
  assert.equal(JSON.parse(await readFile(saved.manifestPath, 'utf8')).source.draftVersion, 3); assert.equal(saved.artifacts[0].sha256.length, 64);
  const before = await readdir(directory);
  await assert.rejects(store.save([input, { ...input, name: '../escape.json' }], {}));
  await assert.rejects(store.save([input, input], {}));
  await assert.rejects(store.save([{ ...input, data: '???=' }], {}));
  assert.deepEqual(await readdir(directory), before);
});
