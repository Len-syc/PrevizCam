import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createProject, createEmptyProject, isEmptyWorkspace, validateProject, materialList, clone, sampleCamera, shotAt, applyCameraPlan, cameraPlan, sampledTimeline, policyWarnings, captureToKeyframes, requiredTimes, requiredFrames, missingTimes } from '../preview/core.mjs';
const script = JSON.parse(await readFile(new URL('../assets/script.json', import.meta.url), 'utf8'));
const project = () => createProject(script);

test('required observation times cover start/middle/end plus every camera and blocking key', () => {
  const p = project();
  assert.deepEqual(requiredTimes(p, p.shots[0]), [0, .18, .5, 1]);
  assert.deepEqual(requiredTimes(p, p.shots[1]), [0, .5, 1]);
  const all = requiredFrames(p);
  assert.equal(all.length, 10, 'four times for the walked shot, three for each of the two static ones');
  assert.deepEqual([...new Set(all.map(f => f.shotId))], p.shots.map(s => s.id));
  assert.deepEqual(missingTimes([0, .18, .5, 1], [0, .5]), [.18, 1]);
  assert.deepEqual(missingTimes([0, .18, .5, 1], [0, .18, .5, 1]), []);
  // Moving cameras add their own keys, so a moving shot needs those times too.
  const moving = project(), camera = moving.cameras[0];
  camera.mode = 'linear'; camera.keyframes = [{ ...clone(camera.keyframes[0]), t: 0 }, { ...clone(camera.keyframes[0]), t: .7 }, { ...clone(camera.keyframes[0]), t: 1 }];
  assert.deepEqual(requiredTimes(moving, moving.shots[1]), [0, .5, .7, 1]);
});

test('empty project passes validation with one camera, no model and no script', () => {
  const p = createEmptyProject('测试项目');
  assert.equal(p.name, '测试项目');
  assert.equal(p.cameras.length, 1);
  assert.equal(p.actors.length, 0);
  assert.equal(p.shots.length, 0);
  assert.equal(p.script, null);
  assert.equal(p.scene.modelName, '');
  assert.equal(p.scene.source, 'bundled');
  validateProject(p);
  assert.equal(createEmptyProject('  ').name, '新建项目');
});
test('isEmptyWorkspace accepts a pristine workspace and rejects any real content', () => {
  const fresh = () => createEmptyProject('x');
  assert.equal(isEmptyWorkspace(fresh()), true, 'default camera only');
  for (const change of [
    p => p.shots.push({ id: 'S1' }),
    p => p.actors.push({ id: 'A1' }),
    p => p.script = { shots: [{ id: 'G1' }] },
    p => p.scene.source = 'embedded',
    p => p.scene.anchors.push({ id: 'anchor-1' }),
  ]) {
    const p = fresh(); change(p);
    assert.equal(isEmptyWorkspace(p), false, `content guard: ${change.toString().slice(0, 40)}`);
  }
  // Script present but without shots still counts as empty; embedded model does not.
  const bareScript = fresh(); bareScript.script = { title: '仅标题' };
  assert.equal(isEmptyWorkspace(bareScript), true);
});
test('capture samples normalize to strictly increasing keyframes with real endpoints', () => {
  const samples = [
    { seconds: 0, position: [0, 2, 0], target: [0, 1, -5], fov: 40 },
    { seconds: .03, position: [0.01, 2, 0], target: [0, 1, -5], fov: 40 },  // 密集采样被抽稀
    { seconds: 2, position: [4, 2, 0], target: [0, 1, -5], fov: 40 },
    { seconds: 4, position: [8, 2, 0], target: [0, 1, -5], fov: 40 },
  ];
  const keys = captureToKeyframes(samples, 24);
  assert.equal(keys[0].t, 0);
  assert.equal(keys.at(-1).t, 1);
  assert.deepEqual(keys.at(-1).position, [8, 2, 0]);
  for (let i = 1; i < keys.length; i++) assert.ok(keys[i].t > keys[i - 1].t);
  // 24fps 抽稀：0.03s 处的采样距首点不足一帧，应被丢弃
  assert.equal(keys.length, 3);
  assert.throws(() => captureToKeyframes([samples[0]], 24), /至少/);
  assert.throws(() => captureToKeyframes([{ seconds: 0, position: [0, 0, 0], target: [0, 0, -1], fov: 40 }, { seconds: 0.01, position: [0, 0, 0], target: [0, 0, -1], fov: 40 }], 24), /太短/);
});

test('actual screenplay binds material locations, not the parent group location', () => {
  const p = project(); validateProject(p);
  assert.deepEqual(p.shots.map(s => s.id), ['Q3_S4_M1', 'Q3_S4_M2', 'Q4_S1_M1']);
  assert.deepEqual(p.shots.map(s => s.duration), [5, 1, 6]);
  assert.ok(p.shots.every(s => s.sceneId === 'LOC_GATE' && s.motionPolicy === 'static'));
  assert.ok(p.shots[0].cast.includes('CHAR_DINGXIAN'));
  assert.equal(materialList(script).find(m => m.id === 'Q2_S3_M1').sceneId, 'LOC_GATE');
});
test('timeline hard-cuts exactly at shot boundaries and holds the final frame', () => {
  const p = project();
  assert.equal(shotAt(p.shots, 4.999).shot.id, 'Q3_S4_M1');
  assert.equal(shotAt(p.shots, 5).shot.id, 'Q3_S4_M2');
  assert.equal(shotAt(p.shots, 6).shot.id, 'Q4_S1_M1');
  assert.equal(shotAt(p.shots, 12).progress, 1);
  assert.equal(shotAt([], 0), null);
});
test('fixed camera stays identical while blocking can move', () => {
  const p = project(), c = p.cameras[0];
  assert.deepEqual(sampleCamera(c, 0), sampleCamera(c, .8));
  assert.notDeepEqual(p.shots[0].blocking.CHAR_DINGXIAN[0].position, p.shots[0].blocking.CHAR_DINGXIAN[1].position);
});
test('piecewise movement respects non-uniform key times and does not mutate keys', () => {
  const c = clone(project().cameras[0]); c.mode = 'linear';
  c.keyframes = [0, .2, 1].map((t, i) => ({ ...clone(c.keyframes[0]), t, position: [i * 10, 2, 0], target: [0, 1, -5] }));
  const original = clone(c);
  assert.equal(sampleCamera(c, .1).position[0], 5);
  assert.equal(sampleCamera(c, .6).position[0], 15);
  c.mode = 'smooth'; assert.deepEqual(sampleCamera(c, 1).position, [20, 2, 0]);
  assert.deepEqual(c.keyframes, original.keyframes);
});
test('invalid plan is atomic and locked cameras cannot be overwritten', () => {
  const p = project(), before = clone(p), plan = cameraPlan(p);
  plan.cameras[0].keyframes[0].position = [NaN, 0, 0];
  assert.throws(() => applyCameraPlan(p, plan), /位置/); assert.deepEqual(p, before);
  p.cameras[0].locked = true;
  assert.throws(() => applyCameraPlan(p, cameraPlan(p)), /锁定/);
});
test('plan references, duplicate assignments and collinear target degeneracy are rejected', () => {
  const p = project(), bad = cameraPlan(p); bad.assignments[0].cameraId = 'MISSING';
  assert.throws(() => applyCameraPlan(p, bad), /引用/);
  const duplicate = cameraPlan(p); duplicate.assignments.push(clone(duplicate.assignments[0]));
  assert.throws(() => applyCameraPlan(p, duplicate), /重复/);
  const coincident = project(); coincident.cameras[0].keyframes[0].target = coincident.cameras[0].keyframes[0].position.slice();
  assert.throws(() => validateProject(coincident), /重合/);
});
test('no multi-key static cameras, broken endpoints or reversed times', () => {
  const p = project(); p.cameras[0].keyframes.push({ ...clone(p.cameras[0].keyframes[0]), t: 1 });
  assert.throws(() => validateProject(p), /固定机位/);
  p.cameras[0].mode = 'smooth'; p.cameras[0].keyframes[1].t = .8;
  assert.throws(() => validateProject(p), /首尾/);
});
test('motion policy warnings survive export, and frame times match 24fps', () => {
  const p = project(); p.cameras[0].mode = 'linear'; p.cameras[0].keyframes.push({ ...clone(p.cameras[0].keyframes[0]), t: 1, position: [4, 2, -5] });
  validateProject(p); assert.equal(policyWarnings(p).length, 3);
  const sampled = sampledTimeline(p);
  assert.equal(sampled.shots[0].samples.length, 121);
  assert.equal(sampled.shots[1].startSeconds, 5);
  assert.equal(sampled.shots[0].samples.at(-1).time, 5);
  assert.deepEqual(sampled.shots[0].samples.at(-1).position, [4, 2, -5]);
});
