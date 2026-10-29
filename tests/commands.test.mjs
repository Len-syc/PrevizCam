import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createProject, clone } from '../preview/core.mjs';
import { ProjectCommands, previsPlan, applyPrevisPlan } from '../preview/commands.mjs';
const script = JSON.parse(await readFile(new URL('../assets/script.json', import.meta.url), 'utf8'));
function fixture() {
  let active = createProject(script); const history = [];
  const commands = new ProjectCommands({ getProject: () => active, applyProject: next => { history.push(clone(active)); active = next; commands.changed(); } });
  return { commands, history, current: () => active, edit: fn => { fn(active); commands.changed(); } };
}
test('complete novel scene plan stays isolated until checked, submitted and accepted as one history item', () => {
  const f = fixture(), original = clone(f.current()), d = f.commands.create();
  const plan = d.plan;
  plan.actors.push({ id: 'CHAR_VISITOR', name: '访客', color: '#556677', height: 1.7, facing: 45, position: [0, .43, -3] });
  plan.shots = plan.shots.map((shot, i) => ({ ...shot, id: `NEW_SHOT_${i}`, cast: ['CHAR_VISITOR'], blocking: { CHAR_VISITOR: [{ t: 0, position: [0, .43, -3] }, { t: 1, position: [1, .43, -3] }] } }));
  const updated = f.commands.update(d.id, plan, d.version);
  assert.deepEqual(f.current(), original); assert.equal(f.history.length, 0);
  assert.throws(() => f.commands.accept(d.id, updated.version), { code: 'CHECK_REQUIRED' });
  f.commands.checked(d.id, updated.version, []); f.commands.submit(d.id, updated.version, '新增访客和三镜头。');
  assert.deepEqual(f.current(), original); f.commands.accept(d.id, updated.version);
  assert.equal(f.current().shots[0].id, 'NEW_SHOT_0'); assert.equal(f.history.length, 1); assert.deepEqual(f.history[0], original);
  assert.throws(() => f.commands.accept(d.id, updated.version), { code: 'DRAFT_APPLIED' });
});
test('failed full-plan update is atomic, with valid references and normalized timing enforced', () => {
  const { commands } = fixture(), d = commands.create(), before = commands.describe(d.id);
  for (const mutate of [
    p => p.shots[0].cameraId = 'missing', p => p.shots[0].cast.push('missing'),
    p => p.cameras[0].keyframes[0].t = .2, p => p.shots[0].duration = .02,
    p => p.sceneId = 'OTHER_SCENE', p => p.actors[0].position = [Infinity, 0, 0],
  ]) {
    const plan = clone(d.plan); mutate(plan); assert.throws(() => commands.update(d.id, plan, d.version)); assert.deepEqual(commands.describe(d.id), before);
  }
});
test('locked cameras survive reordered JSON but cannot be changed, removed or unlocked', () => {
  const p = createProject(script); p.cameras[0].locked = true;
  const plan = previsPlan(p); plan.cameras[0] = Object.fromEntries(Object.entries(plan.cameras[0]).reverse()); assert.doesNotThrow(() => applyPrevisPlan(p, plan));
  for (const mutate of [p => p.cameras[0].locked = false, p => p.cameras[0].name = 'changed', p => { p.cameras.shift(); p.shots.forEach(s => s.cameraId = p.cameras[0].id); }]) {
    const bad = previsPlan(p); mutate(bad); assert.throws(() => applyPrevisPlan(p, bad), { code: 'LOCKED_CAMERA' });
  }
});
test('manual edits and undo-like restores invalidate every older draft without silent rebasing', () => {
  const f = fixture(), original = clone(f.current()), d = f.commands.create(); f.commands.checked(d.id, d.version, []); f.commands.submit(d.id, d.version, 'ready');
  f.edit(p => p.name = '用户手动修改'); assert.equal(f.commands.describe(d.id).stale, true);
  assert.throws(() => f.commands.accept(d.id, d.version), { code: 'STALE_DRAFT' });
  f.edit(p => Object.assign(p, original)); assert.throws(() => f.commands.candidate(d.id), { code: 'STALE_DRAFT' });
  const fresh = f.commands.create(); assert.equal(fresh.stale, false);
});
test('optimistic draft versions and check invalidation prevent applying a different reviewed version', () => {
  const { commands } = fixture(), d = commands.create(); commands.checked(d.id, 1, []); commands.submit(d.id, 1, 'reviewed');
  const next = commands.update(d.id, d.plan, 1); assert.equal(next.checkedVersion, null); assert.equal(next.status, 'editing');
  assert.throws(() => commands.update(d.id, d.plan, 1), { code: 'DRAFT_CONFLICT' });
  assert.throws(() => commands.checked(d.id, 1, []), { code: 'DRAFT_CONFLICT' });
  assert.throws(() => commands.submit(d.id, next.version, 'unchecked'), { code: 'CHECK_REQUIRED' });
});
test('fixed-camera policy cannot be bypassed through whole-plan edits', () => {
  const p = createProject(script), plan = previsPlan(p); plan.shots[0].motionPolicy = 'unspecified';
  assert.throws(() => applyPrevisPlan(p, plan), { code: 'MOTION_POLICY' });
  const moving = previsPlan(p); moving.cameras[0].mode = 'linear'; moving.cameras[0].keyframes.push({ ...clone(moving.cameras[0].keyframes[0]), t: 1 });
  assert.throws(() => applyPrevisPlan(p, moving), { code: 'MOTION_POLICY' });
});
test('the timeline order is the plan order, so reordering and inserting need no append-only workaround', () => {
  const f = fixture(), original = clone(f.current()), d = f.commands.create(), ids = d.plan.shots.map(s => s.id);
  const plan = clone(d.plan); plan.shots = [...plan.shots].reverse();
  let updated = f.commands.update(d.id, plan, d.version);
  assert.deepEqual(f.commands.candidate(d.id).shots.map(s => s.id), [...ids].reverse());
  assert.deepEqual(f.current(), original, 'reordering stays inside the draft');
  const inserted = clone(plan);
  inserted.shots = [{ ...clone(plan.shots[0]), id: 'SHOT_OPENING', title: '插入的开场' }, ...plan.shots];
  updated = f.commands.update(d.id, inserted, updated.version);
  assert.equal(f.commands.candidate(d.id).shots[0].id, 'SHOT_OPENING');
  f.commands.checked(d.id, updated.version, []);
  f.commands.submit(d.id, updated.version, '主镜在前、覆盖在后，并插入开场。');
  f.commands.accept(d.id, updated.version);
  assert.deepEqual(f.current().shots.map(s => s.id), inserted.shots.map(s => s.id));
});
