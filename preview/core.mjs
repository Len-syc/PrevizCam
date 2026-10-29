// Pure project, camera and timeline logic. Coordinates: metres, right-handed, +Y up.
export const VERSION = 1;
export const clone = value => structuredClone(value);
export const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
export const distance = (a, b) => Math.hypot(...a.map((v, i) => v - b[i]));
export const lerp = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
export const lensToFov = mm => 2 * Math.atan(20.25 / (2 * mm)) * 180 / Math.PI;
export const fovToLens = fov => 20.25 / (2 * Math.tan(fov * Math.PI / 360));
export const uid = prefix => `${prefix}_${globalThis.crypto.randomUUID().slice(0, 8)}`;
const vec = value => Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 500;
const fail = message => { throw new Error(message); };
const castIds = cast => Array.isArray(cast) ? cast.map(c => typeof c === 'string' ? c : c.id || c.characterId).filter(Boolean) : cast && typeof cast === 'object' ? Object.keys(cast) : [];

export function materialList(script) {
  if (!script || !Array.isArray(script.shots)) fail('剧本需要包含 shots 数组。请导入统一审阅稿 JSON。');
  return script.shots.flatMap(group => (group.materials || []).map(m => ({
    id: m.id, groupId: group.id, title: group.title || m.id,
    action: m.action || group.picture || '', sceneId: m.locationId || group.locationId,
    cast: castIds(m.cast || group.cast),
    duration: m.useSeconds || m.useFrames / (script.format?.fps || 24) || 5,
    sourceRange: [m.startFrame / (script.format?.fps || 24), m.endFrame / (script.format?.fps || 24)],
    motionPolicy: script.cameraPolicy ? 'static' : 'unspecified',
  })));
}

export function createProject(script) {
  const camera = { id: 'CAM_GATE_A', name: 'A · 山门接待', locked: false, mode: 'static',
    keyframes: [{ t: 0, position: [-2.8, 2.15, -6.15], target: [0.35, 1.25, -3.6], fov: lensToFov(30) }] };
  const actors = [
    { id: 'CHAR_DINGXIAN', name: '丁显', color: '#b96555', height: 1.76, position: [-1.0, 0.43, -3.1], facing: 90 },
    { id: 'CHAR_ABBOT', name: '住持', color: '#bda779', height: 1.67, position: [1.1, 0.43, -3.7], facing: -90 },
    { id: 'CHAR_QINGRAN', name: '清然', color: '#7f9d9d', height: 1.53, position: [0.2, 0.43, -4.9], facing: -40 },
  ];
  const selected = ['Q3_S4_M1', 'Q3_S4_M2', 'Q4_S1_M1'];
  const shots = materialList(script).filter(m => selected.includes(m.id)).map(m => ({ ...m, cameraId: camera.id, blocking: {} }));
  const shotNames = { Q3_S4_M1: '跨门报喜', Q3_S4_M2: '行揖收束', Q4_S1_M1: '住持答话，示意引路' };
  shots.forEach(s => s.title = shotNames[s.id]);
  if (shots[0]) shots[0].blocking.CHAR_DINGXIAN = [
    { t: 0, position: [-1.0, 0.43, -2.4] }, { t: 0.18, position: actors[0].position.slice() }, { t: 1, position: actors[0].position.slice() },
  ];
  return {
    type: 'previzcam.project', version: VERSION, name: '武夷茶故事 · 山门预演',
    format: { fps: 24, width: 1280, height: 720 },
    scene: { id: 'LOC_GATE', name: '寺门与院廊', modelName: 'temple-gate.glb', source: 'bundled',
      transform: { scale: 1, rotationY: 0, offset: [0, 0, 0] },
      anchors: [
        { id: 'gate_center', name: '门洞中心', position: [0, 1.5, 0] },
        { id: 'reception', name: '接待区', position: [0.35, 0.43, -3.6] },
        { id: 'steps', name: '台阶前', position: [0, 0.15, 1.7] },
      ], annotations: {}, calibration: '示例尺寸；请按实际拍摄需求确认',
    },
    cameras: [camera, { ...clone(camera), id: 'CAM_GATE_B', name: 'B · 广角备选', keyframes: [{ t: 0, position: [-3.9, 2.65, -6.1], target: [0.35, 1.1, -3.6], fov: lensToFov(24) }] }],
    actors, shots, script: clone(script),
  };
}

// A project without a model or script: one default camera, nothing else.
// scene.source stays 'bundled' so validateProject accepts it; the app only
// installs a model when project.modelBytes exists.
export function createEmptyProject(name = '新建项目') {
  const camera = { id: 'CAM_MAIN', name: '主机位', locked: false, mode: 'static',
    keyframes: [{ t: 0, position: [-2.8, 2.15, -6.15], target: [0.35, 1.25, -3.6], fov: lensToFov(30) }] };
  return {
    type: 'previzcam.project', version: VERSION, name: String(name).trim() || '新建项目',
    format: { fps: 24, width: 1280, height: 720 },
    scene: { id: 'LOC_MAIN', name: '默认场景', modelName: '', source: 'bundled',
      transform: { scale: 1, rotationY: 0, offset: [0, 0, 0] },
      anchors: [], annotations: {}, calibration: '尚未导入模型；请先在「项目」菜单导入 GLB 并校准尺寸。' },
    cameras: [camera], actors: [], shots: [], script: null,
  };
}

// Turn a live capture into motion-camera keyframes: samples carry real
// seconds; they are normalized to t in 0..1 and thinned to a small set.
export function captureToKeyframes(samples, fps = 24) {
  if (!Array.isArray(samples) || samples.length < 2) fail('录制至少需要两个采样点。');
  const span = samples.at(-1).seconds - samples[0].seconds;
  if (!(span > 1 / fps)) fail('录制时长太短，请至少拖动一帧的时间。');
  const frameStep = 1 / fps;
  const kept = [];
  for (const sample of samples) {
    const t = clamp((sample.seconds - samples[0].seconds) / span, 0, 1);
    if (kept.length && Math.abs(t - kept.at(-1).t) < frameStep / span) continue;
    kept.push({ t, position: sample.position.slice(), target: sample.target.slice(), fov: sample.fov });
  }
  if (kept.length === 1) kept.push({ ...clone(kept[0]), t: 1 });
  kept[0].t = 0; kept.at(-1).t = 1;
  return kept;
}

function cubic(p0, p1, p2, p3, t) {
  return p1.map((v, i) => 0.5 * ((2 * v) + (-p0[i] + p2[i]) * t +
    (2 * p0[i] - 5 * v + 4 * p2[i] - p3[i]) * t * t +
    (-p0[i] + 3 * v - 3 * p2[i] + p3[i]) * t * t * t));
}
export function sampleTrack(keys, t, smooth = false) {
  if (keys.length === 1 || t <= keys[0].t) return clone(keys[0]);
  if (t >= keys.at(-1).t) return clone(keys.at(-1));
  const index = keys.findIndex((key, i) => keys[i + 1] && t >= key.t && t < keys[i + 1].t);
  const a = keys[index], b = keys[index + 1], f = (t - a.t) / (b.t - a.t);
  const out = { t };
  for (const key of ['position', 'target']) if (a[key]) {
    out[key] = smooth ? cubic(keys[Math.max(0, index - 1)][key], a[key], b[key], keys[Math.min(keys.length - 1, index + 2)][key], f) : lerp(a[key], b[key], f);
  }
  if (a.fov !== undefined) out.fov = a.fov + (b.fov - a.fov) * f;
  return out;
}
export const sampleCamera = (camera, t) => sampleTrack(camera.keyframes, camera.mode === 'static' ? 0 : clamp(t, 0, 1), camera.mode === 'smooth');
export const totalDuration = shots => shots.reduce((sum, s) => sum + s.duration, 0);
export function shotAt(shots, time) {
  if (!shots.length) return null;
  const t = clamp(time, 0, totalDuration(shots));
  let start = 0;
  for (let i = 0; i < shots.length; i++) {
    const shot = shots[i];
    if (t < start + shot.duration || i === shots.length - 1) return { shot, index: i, start, localTime: t - start, progress: clamp((t - start) / shot.duration, 0, 1) };
    start += shot.duration;
  }
}
export function timecode(seconds, fps = 24) {
  const frames = Math.round(Math.max(0, seconds) * fps);
  return [Math.floor(frames / fps / 60), Math.floor(frames / fps) % 60, frames % fps].map(v => String(v).padStart(2, '0')).join(':');
}

// Every time an agent must actually look at before judging a shot: start, middle,
// end plus every camera and blocking key, normalized 0..1 inside the shot.
export function requiredTimes(project, shot) {
  const camera = project.cameras.find(c => c.id === shot.cameraId);
  const times = new Set([0, .5, 1]);
  for (const key of camera?.keyframes || []) times.add(key.t);
  for (const keys of Object.values(shot.blocking || {})) for (const key of keys) times.add(key.t);
  return [...times].filter(t => Number.isFinite(t) && t >= 0 && t <= 1).sort((a, b) => a - b);
}
export function requiredFrames(project) {
  return project.shots.flatMap(shot => requiredTimes(project, shot).map(progress => ({ shotId: shot.id, progress })));
}
export const missingTimes = (required, captured) =>
  required.filter(t => !captured.some(other => Math.abs(t - other) < 1e-6));

function validateKeys(keys, camera = true) {
  if (!Array.isArray(keys) || !keys.length || keys.length > 500) fail('关键点需要 1–500 项。');
  let previous = -1;
  for (const k of keys) {
    if (!Number.isFinite(k.t) || k.t < 0 || k.t > 1 || k.t <= previous) fail('关键点 t 必须在 0–1 之间严格递增。');
    if (!vec(k.position) || k.position.some(v => Math.abs(v) > 1e5)) fail('位置需要三个有限数值，单位为米。');
    if (camera && (!vec(k.target) || k.target.some(v => Math.abs(v) > 1e5) || distance(k.position, k.target) < 0.01)) fail('注视点必须有效，且不能与相机位置重合。');
    if (camera && (!Number.isFinite(k.fov) || k.fov < 5 || k.fov > 140)) fail('垂直视场角 fov 必须为 5–140 度。');
    previous = k.t;
  }
  if (keys[0].t !== 0) fail('第一个关键点的 t 必须为 0。');
}
function unique(items, label) {
  const ids = new Set();
  for (const item of items) {
    if (!text(item.id) || ids.has(item.id) || ['__proto__', 'constructor', 'prototype'].includes(item.id)) fail(`${label} ID 无效或重复。`);
    ids.add(item.id);
  }
  return ids;
}
export function validateProject(p) {
  if (!p || p.type !== 'previzcam.project' || p.version !== VERSION) fail('不是支持的 PrevizCam 项目（version: 1）。');
  if (!text(p.name) || !text(p.scene?.id) || !text(p.scene?.name)) fail('项目和场景必须有名称及 ID。');
  if (!['bundled', 'embedded'].includes(p.scene.source)) fail('模型来源无效。');
  const tr = p.scene.transform;
  if (!tr || !Number.isFinite(tr.scale) || tr.scale <= 0 || tr.scale > 10000 || !Number.isFinite(tr.rotationY) || !vec(tr.offset)) fail('场景缩放、旋转或偏移无效。');
  if (!p.format || ![24, 25, 30, 60].includes(p.format.fps) || p.format.width !== 1280 || p.format.height !== 720) fail('第一版项目使用 1280×720、16:9，帧率为 24/25/30/60。');
  if (!Array.isArray(p.cameras) || !p.cameras.length || p.cameras.length > 100) fail('项目需要 1–100 个相机。');
  const cameras = unique(p.cameras, '相机');
  for (const c of p.cameras) {
    if (!text(c.name) || !['static', 'linear', 'smooth'].includes(c.mode) || typeof c.locked !== 'boolean') fail('相机名称、模式或锁定状态无效。');
    validateKeys(c.keyframes);
    if (c.mode === 'static' && c.keyframes.length !== 1) fail('固定机位只能有一个关键点。');
    if (c.mode !== 'static' && (c.keyframes.length < 2 || c.keyframes.at(-1).t !== 1)) fail('运动相机需要首尾关键点 t=0 和 t=1。');
  }
  if (!Array.isArray(p.actors) || p.actors.length > 100) fail('人物列表无效。');
  const actors = unique(p.actors, '人物');
  for (const a of p.actors) if (!text(a.name) || !vec(a.position) || !Number.isFinite(a.height) || a.height < 0.1 || a.height > 10 || !Number.isFinite(a.facing) || !/^#[\da-f]{6}$/i.test(a.color)) fail('人物位置、身高、朝向或颜色无效。');
  if (!Array.isArray(p.scene.anchors) || p.scene.anchors.length > 500) fail('锚点列表无效。');
  unique(p.scene.anchors, '锚点');
  for (const a of p.scene.anchors) if (!text(a.name) || !vec(a.position)) fail('锚点位置或名称无效。');
  if (!p.scene.annotations || typeof p.scene.annotations !== 'object' || Array.isArray(p.scene.annotations)) fail('空间标注无效。');
  for (const v of Object.values(p.scene.annotations)) if (typeof v !== 'string' || v.length > 500) fail('空间标注名称无效。');
  if (!Array.isArray(p.shots) || p.shots.length > 500) fail('镜头列表无效。');
  unique(p.shots, '镜头');
  for (const s of p.shots) {
    if (!text(s.title) || s.sceneId !== p.scene.id || !cameras.has(s.cameraId)) fail(`镜头 ${s.id} 的场景或相机引用无效。`);
    if (!Number.isFinite(s.duration) || s.duration < 1 / p.format.fps || s.duration > 600) fail('镜头时长应在一帧到 600 秒之间。');
    if (Math.abs(s.duration * p.format.fps - Math.round(s.duration * p.format.fps)) > 0.0001) fail('镜头时长必须对应整数帧。');
    if (!Array.isArray(s.cast) || s.cast.some(id => !text(id))) fail('镜头人物列表无效。');
    if (typeof s.action !== 'string' || !['static', 'unspecified'].includes(s.motionPolicy)) fail('镜头说明或摄影约束无效。');
    if (!s.blocking || typeof s.blocking !== 'object' || Array.isArray(s.blocking)) fail('人物走位数据无效。');
    for (const [id, keys] of Object.entries(s.blocking)) {
      if (!actors.has(id)) fail(`走位引用了不存在的人物：${id}`);
      validateKeys(keys, false);
    }
  }
  if (p.script) materialList(p.script);
  return p;
}

// Imports are staged and validated as a whole; a bad plan never partially updates a project.
export function applyCameraPlan(project, plan) {
  if (!plan || plan.type !== 'previzcam.camera-plan' || plan.version !== VERSION || plan.sceneId !== project.scene.id) fail('镜头方案类型、版本或场景 ID 不匹配。');
  if (!Array.isArray(plan.cameras) || !Array.isArray(plan.assignments) || !plan.cameras.length || !plan.assignments.length) fail('方案需要非空 cameras 和 assignments 数组。');
  unique(plan.cameras, '方案相机');
  const next = clone(project);
  for (const camera of plan.cameras) {
    const index = next.cameras.findIndex(c => c.id === camera.id);
    if (index >= 0 && next.cameras[index].locked) fail(`相机「${next.cameras[index].name}」已锁定。请解锁或使用新的 ID。`);
    if (index >= 0) next.cameras[index] = clone(camera); else next.cameras.push(clone(camera));
  }
  const assigned = new Set();
  for (const a of plan.assignments) {
    const shot = next.shots.find(s => s.id === a.shotId);
    if (!shot || assigned.has(a.shotId)) fail(`镜头引用不存在或重复：${a.shotId}`);
    assigned.add(a.shotId);
    shot.cameraId = a.cameraId;
  }
  validateProject(next);
  return next;
}
export function cameraPlan(project) {
  return { type: 'previzcam.camera-plan', version: VERSION, sceneId: project.scene.id, cameras: clone(project.cameras), assignments: project.shots.map(s => ({ shotId: s.id, cameraId: s.cameraId })) };
}
export function sampledTimeline(project) {
  const fps = project.format.fps;
  let start = 0;
  return { type: 'previzcam.sampled-timeline', version: VERSION, units: 'metres', up: '+Y', handedness: 'right', aspect: 16 / 9, fps,
    shots: project.shots.map(s => {
      const camera = project.cameras.find(c => c.id === s.cameraId);
      const frames = Math.max(1, Math.round(s.duration * fps));
      const out = { id: s.id, sourceId: s.sourceId || s.id, duration: s.duration, startSeconds: start, cameraId: s.cameraId, cutIn: true,
        samples: Array.from({ length: frames + 1 }, (_, i) => ({ time: i * s.duration / frames, ...sampleCamera(camera, i / frames) })) };
      start += s.duration;
      return out;
    }),
  };
}
export function policyWarnings(project) {
  return project.shots.flatMap(s => {
    const c = project.cameras.find(c => c.id === s.cameraId);
    const warnings = [];
    if (s.motionPolicy === 'static' && c.mode !== 'static') warnings.push({ level: 'warning', shotId: s.id, message: '剧本要求固定机位，当前设置了运镜。' });
    const missing = s.cast.filter(id => !project.actors.some(a => a.id === id));
    if (missing.length) warnings.push({ level: 'warning', shotId: s.id, message: `缺少人物占位：${missing.join('、')}` });
    return warnings;
  });
}
