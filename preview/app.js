import { SceneView } from './scene.js';
import { clone, clamp, uid, createProject, createEmptyProject, isEmptyWorkspace, validateProject, materialList, sampleCamera, sampleTrack, shotAt, totalDuration, timecode, lensToFov, fovToLens, cameraPlan, applyCameraPlan, sampledTimeline, policyWarnings, captureToKeyframes } from './core.mjs';
import { listProjects, loadProject, saveProject, removeProject, loadActiveId, saveActiveId, migrateLegacyWorkspace, download, toBase64, fromBase64 } from './storage.mjs';
import { zipSync, strToU8 } from '../vendor/libs/fflate.module.js';
import { ProjectCommands, editProject, refuse } from './commands.mjs';
import { AgentWorkspace } from './agent-workspace.js';

const $ = id => document.getElementById(id);
// 等待下一帧让“正在检查…”先渲染出来；rAF 被节流时（如自动化环境）用 setTimeout 兜底
const nextFrame = () => new Promise(resolve => {
  let done = false;
  const once = () => { if (!done) { done = true; resolve(); } };
  requestAnimationFrame(once);
  setTimeout(once, 80);
});
const esc = value => String(value ?? '').replace(/[&<>"']/g, s => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[s]));
const fmt = value => Number(value.toFixed(3));
const vectorFields = (key, name, values) => `<span class="field-label">${name} · m</span><div class="vector">${values.map((value, i) => `<label>${'XYZ'[i]}<input aria-label="${name} ${'XYZ'[i]}" type="number" step="0.05" data-vector="${key}" data-axis="${i}" value="${fmt(value)}"></label>`).join('')}</div>`;
const field = (id, label, value, type = 'text', extra = '') => `<div class="field"><label for="${id}">${label}</label><input id="${id}" type="${type}" value="${esc(value)}" ${extra}></div>`;
let project, projectArchiveId = null, modelBytes = null, bundledBytes, view, currentTime = 0, playing = false, lastTick = 0;
let selection = { type: 'camera', id: 'CAM_GATE_A' }, keyIndex = 0, handleMode = 'position';
let history = [], future = [], dragBefore, saveTimer, toastTimer, recorder, recordingCancelled = false, exporting = false, ready = false;
let cameraCapture = null; // { cameraId, shotId, samples, startedAt } while recording a camera path.
let lastShotId;
let commands, agentWorkspace;
const current = () => shotAt(project?.shots || [], currentTime);
const currentCamera = () => project.cameras.find(c => c.id === (playing || exporting || selection.type !== 'camera' ? current()?.shot.cameraId : selection.id)) || project.cameras[0];
const snapshot = () => ({ project: clone(project), modelBytes });
function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 4200); $('status-message').textContent = message; }
function dialog(title, body, kicker = 'PREVIZCAM / WORKSPACE') {
  pause(); $('dialog-title').textContent = title; $('dialog-kicker').textContent = kicker; $('dialog-body').innerHTML = body;
  if (!$('dialog').open) $('dialog').showModal();
}
function closeDialog() { if (recorder || exporting) return; $('dialog').close(); }
function guard(fn) { return async (...args) => { try { await fn(...args); } catch (error) { console.error(error); toast(error.message); } }; }
function on(id, fn, event = 'click') { $(id)?.addEventListener(event, guard(fn)); }
function scheduleSave() {
  commands?.changed();
  clearTimeout(saveTimer); $('save-state').textContent = '正在保存…';
  saveTimer = setTimeout(async () => {
    try {
      if (!projectArchiveId) { $('save-state').textContent = '未入档 · 请在「项目」菜单新建项目'; return; }
      await saveProject({ id: projectArchiveId, project, modelBytes });
      await saveActiveId(projectArchiveId);
      $('save-state').textContent = '已保存到本机';
      renderMenuProjects();
      if (!$('welcome').hidden) renderWelcome();
    }
    catch { $('save-state').textContent = '本机保存失败'; toast('浏览器存储不可用或空间不足，请下载预演项目。'); }
  }, 500);
}
function pushHistory(before) { history.push(before); if (history.length > 40) history.shift(); future = []; }
function commit(label, change) {
  if (exporting || agentWorkspace?.reviewing) return;
  pause(); const before = snapshot(); let next;
  try { next = editProject(project, change); }
  catch (error) { toast(error.message); renderInspector(); return false; }
  pushHistory(before); project = next; refresh(); scheduleSave(); $('status-message').textContent = label; return true;
}
async function restoreSnapshot(state) {
  validateProject(state.project);
  if (state.modelBytes !== modelBytes) {
    const parsed = await view.parseModel(state.modelBytes || bundledBytes); view.installModel(parsed, state.project);
  }
  project = state.project; modelBytes = state.modelBytes; currentTime = clamp(currentTime, 0, totalDuration(project.shots)); refresh(); scheduleSave();
}
async function undo() { if (!history.length || exporting) return; pause(); const next = history.at(-1), before = snapshot(); await restoreSnapshot(next); history.pop(); future.push(before); $('undo').disabled = !history.length; $('redo').disabled = !future.length; }
async function redo() { if (!future.length || exporting) return; pause(); const next = future.at(-1), before = snapshot(); await restoreSnapshot(next); future.pop(); history.push(before); $('undo').disabled = !history.length; $('redo').disabled = !future.length; }
function pause() { const wasPlaying = playing; playing = false; $('play').textContent = '▶'; $('play').setAttribute('aria-label', '播放预演'); if (wasPlaying && ready && !exporting) renderInspector(); }
function play() {
  if (!project.shots.length || exporting) return;
  if (playing) { pause(); renderInspector(); return; }
  if (currentTime >= totalDuration(project.shots)) currentTime = 0;
  playing = true; selection = { type: 'camera', id: current().shot.cameraId }; lastTick = performance.now();
  $('play').textContent = 'Ⅱ'; $('play').setAttribute('aria-label', '暂停预演'); view.transform.detach(); renderLists(); renderInspector();
}
function chooseShot(id) {
  pause(); const index = project.shots.findIndex(s => s.id === id); if (index < 0) return;
  currentTime = totalDuration(project.shots.slice(0, index)); selection = { type: 'camera', id: project.shots[index].cameraId }; keyIndex = 0; refresh(false);
}
function choose(target) {
  if (exporting) return;
  pause(); selection = { type: target.type, id: target.id }; keyIndex = target.keyIndex ?? 0;
  if (target.type === 'camera') {
    const camera = currentCamera(), frame = camera.keyframes[keyIndex];
    if (target.keyIndex != null && current()) currentTime = current().start + frame.t * current().shot.duration;
  }
  refresh(false);
}
function refresh(rebuild = true) {
  if (!project.cameras.some(c => c.id === selection.id) && selection.type === 'camera') selection.id = current()?.shot.cameraId || project.cameras[0].id;
  if (selection.type === 'actor' && !project.actors.some(a => a.id === selection.id) || selection.type === 'anchor' && !project.scene.anchors.some(a => a.id === selection.id)) selection = { type: 'camera', id: project.cameras[0].id };
  currentTime = clamp(currentTime, 0, totalDuration(project.shots));
  keyIndex = clamp(keyIndex, 0, currentCamera().keyframes.length - 1);
  if (rebuild) { view.calibrate(project); view.buildActors(project); }
  view.buildHelpers(project, selection, current()?.progress || 0, current()?.shot || null); renderLists(); renderTimeline(); renderInspector(); updateTransport();
  $('project-name').textContent = project.name; $('fps-label').textContent = project.format.fps;
  $('asset-name').textContent = project.scene.modelName || '尚未导入模型'; $('asset-stats').textContent = view.meshCount ? `${view.meshCount} 网格 → ${view.groups.length} 个语义分组` : '从「项目」菜单导入 GLB 模型';
  $('undo').disabled = !history.length; $('redo').disabled = !future.length;
  if (rebuild) { $('validation-badge').textContent = '待检查'; $('validation-badge').className = 'validation-badge'; }
}
function renderLists() {
  const shot = current()?.shot;
  document.querySelector('.pane-caption>span').textContent = project.scene.name;
  document.querySelector('.script-note p').textContent = project.script?.cameraPolicy ? '定镜头为主，保持同轴构图。人物自然运动，镜头之间硬切。' : '当前剧本未声明统一摄影约束，请逐镜确认机位与接续。';
  $('shot-count').textContent = String(project.shots.length).padStart(2, '0');
  $('shot-list').innerHTML = project.shots.map((s, i) => {
    const c = project.cameras.find(c => c.id === s.cameraId), active = shot?.id === s.id;
    return `<button class="shot-card ${active ? 'active' : ''}" data-shot="${esc(s.id)}" aria-pressed="${active}"><span class="shot-meta"><span>${String(i + 1).padStart(2, '0')} / ${esc(s.id)}</span><span>${fmt(s.duration)}s</span></span><span class="shot-name">${esc(s.title)}</span><span class="shot-foot"><span class="chip">${c.mode === 'static' ? '固定' : '运镜'}</span><span>${esc(c.name.split('·')[0])}</span><span>${Object.keys(s.blocking).length ? '含走位' : '定机位'}</span></span></button>`;
  }).join('') || '<div class="empty-state">还没有镜头。点击“添加”，从当前场景的剧本段落开始。</div>';
  $('camera-list').innerHTML = project.cameras.map(c => `<button class="resource-item ${selection.type === 'camera' && selection.id === c.id ? 'active' : ''}" data-camera="${esc(c.id)}"><svg viewBox="0 0 24 24"><path d="M3 6h12v12H3zM15 10l6-4v12l-6-4"/></svg><span>${esc(c.name)}</span><small>${c.locked ? '锁定' : project.shots.filter(s => s.cameraId === c.id).length + ' 镜'}</small></button>`).join('');
  $('actor-list').innerHTML = project.actors.map(a => `<button class="resource-item ${selection.type === 'actor' && selection.id === a.id ? 'active' : ''}" data-actor="${esc(a.id)}"><i class="item-dot" style="background:${a.color}"></i><span>${esc(a.name)}</span><small>${a.height}m</small></button>`).join('');
  $('anchor-list').innerHTML = project.scene.anchors.map(a => `<button class="resource-item ${selection.type === 'anchor' && selection.id === a.id ? 'active' : ''}" data-anchor="${esc(a.id)}"><span>◇</span><span>${esc(a.name)}</span></button>`).join('');
  $('group-list').innerHTML = view.groups.map(g => `<button class="resource-item" data-group="${esc(g.id)}"><span>${esc(project.scene.annotations[g.id] || g.name)}</span><small>${g.nodeNames.length}</small></button>`).join('');
}
function renderTimeline() {
  const total = totalDuration(project.shots); $('scrubber').max = total || 1; $('scrubber').step = 1 / project.format.fps; $('scrubber').disabled = !project.shots.length;
  $('total-time').textContent = timecode(total, project.format.fps); $('play').disabled = !project.shots.length;
  $('time-ruler').innerHTML = Array.from({ length: 7 }, (_, i) => `<span>${fmt(total * i / 6)}s</span>`).join('');
  $('timeline-clips').innerHTML = project.shots.map(s => `<button class="timeline-clip ${Object.keys(s.blocking).length ? 'has-blocking' : ''}" data-shot="${esc(s.id)}" style="flex:${s.duration}" title="${esc(s.title)} · ${fmt(s.duration)}s"><span>${esc(s.id)}</span><small>${fmt(s.duration)}s</small></button>`).join('');
}
function renderInspector() {
  const active = current(), shot = active?.shot, camera = currentCamera();
  let html = '';
  if (selection.type === 'camera') {
    const k = camera.keyframes[keyIndex] || camera.keyframes[0];
    html = `<div class="inspector-title"><strong>摄影机设置</strong><span class="chip">${camera.mode === 'static' ? '固定机位' : '运动机位'}</span></div>
      <label class="inline-check"><input id="camera-lock" type="checkbox" ${camera.locked ? 'checked' : ''}>锁定机位与参数</label>
      <fieldset ${camera.locked || playing ? 'disabled' : ''}>
      ${field('camera-name', '相机名称', camera.name)}
      <div class="field-row"><div class="field"><label for="camera-mode">运动方式</label><select id="camera-mode"><option value="static" ${camera.mode === 'static' ? 'selected' : ''}>固定</option><option value="linear" ${camera.mode === 'linear' ? 'selected' : ''}>直线 / 分段</option><option value="smooth" ${camera.mode === 'smooth' ? 'selected' : ''}>平滑曲线</option></select></div>${field('camera-lens', '等效焦距 · mm', fmt(fovToLens(k.fov)), 'number', 'min="4" max="230" step="1"')}</div>
      ${camera.mode !== 'static' ? `<span class="field-label">路径关键点 · 当前镜头内</span><div class="keyframe-list">${camera.keyframes.map((f, i) => `<button data-key="${i}" class="${i === keyIndex ? 'active' : ''}">${fmt(f.t * (shot?.duration || 1))}s</button>`).join('')}<button id="add-key">＋</button></div>` : ''}
      ${vectorFields('position', '相机位置', k.position)}${vectorFields('target', '注视点', k.target)}
      <div class="compact-actions"><button data-handle="position" class="${handleMode === 'position' ? 'active' : ''}">拖动相机</button><button data-handle="target" class="${handleMode === 'target' ? 'active' : ''}">拖动注视点</button></div>
      <div class="field"><label for="look-at">注视场景锚点 / 人物</label><select id="look-at"><option value="">选择注视目标…</option>${project.scene.anchors.map(a => `<option value="anchor:${esc(a.id)}">${esc(a.name)}</option>`).join('')}${project.actors.map(a => `<option value="actor:${esc(a.id)}">${esc(a.name)} · 眼睛位置</option>`).join('')}</select></div>
      <div class="form-actions"><button id="camera-from-view">使用当前观察视角</button>${camera.mode !== 'static' && keyIndex > 0 && keyIndex < camera.keyframes.length - 1 ? '<button id="delete-key">删除此关键点</button>' : ''}</div>
      <div class="form-actions"><button id="record-camera" class="${cameraCapture ? 'capture-active' : ''}" title="录制拖动的相机路径为新镜头">● 录制相机</button><span class="field-help" style="margin:0">录制会新建一个镜头，拖动相机即按真实时间记录运镜，结束后可播放。</span></div></fieldset>
      <div class="form-actions"><button id="duplicate-camera">复制相机</button><button id="delete-camera" class="danger-button" ${camera.locked ? 'disabled' : ''}>删除相机</button></div>
      ${shot?.motionPolicy === 'static' && camera.mode !== 'static' ? '<p class="notice">本段剧本要求固定机位。当前运镜属于修改方案，请检查叙事是否需要。</p>' : ''}`;
  } else if (selection.type === 'actor') {
    const actor = project.actors.find(a => a.id === selection.id), track = shot?.blocking[actor.id];
    const position = track ? sampleTrack(track, active.progress).position : actor.position;
    html = `<div class="inspector-title"><strong>人物占位与走位</strong><span class="chip">${esc(actor.id)}</span></div>${field('actor-name', '人物名称', actor.name)}${field('actor-id', '关联剧本人物 ID', actor.id)}<div class="field-row">${field('actor-height', '身高 · m', actor.height, 'number', 'min="0.1" max="10" step="0.01"')}${field('actor-facing', '朝向 · °', actor.facing, 'number', 'step="5"')}</div><div class="field"><label for="actor-color">占位颜色</label><input type="color" id="actor-color" value="${actor.color}"></div>${vectorFields('actor', '脚底位置', position)}<p class="field-help">${shot ? `拖动人物或修改坐标，将在本镜 ${fmt(active.localTime)}s 记录走位关键点。` : '添加镜头后可以记录人物走位。'}占位只表示空间关系，不模拟行揖、口型或精细表演。</p>${track ? `<div class="keyframe-list">${track.map(k => `<button data-actor-time="${k.t}">${fmt(k.t * shot.duration)}s</button>`).join('')}</div><button id="clear-blocking" class="small-button">清除此镜走位</button>` : ''}<div class="form-actions"><button id="delete-actor" class="danger-button">删除占位</button></div>`;
  } else {
    const a = project.scene.anchors.find(a => a.id === selection.id);
    html = `<div class="inspector-title"><strong>空间锚点</strong><span class="chip">${esc(a.id)}</span></div>${field('anchor-name', '锚点名称', a.name)}${vectorFields('anchor', '锚点位置', a.position)}<p class="field-help">锚点是给 AI 使用的稳定空间参照。可代表门口、人物落脚点或构图中心。</p><button id="delete-anchor" class="danger-button">删除锚点</button>`;
  }
  if (shot) html += `<div class="divider"></div><span class="small-kicker">SHOT / ${esc(shot.id)}</span>${field('shot-title', '镜头名称', shot.title)}<div class="field-row">${field('shot-duration', '镜头时长 · 秒', shot.duration, 'number', `min="${1 / project.format.fps}" max="600" step="${1 / project.format.fps}"`)}<div class="field"><label for="shot-camera">拍摄相机</label><select id="shot-camera">${project.cameras.map(c => `<option value="${esc(c.id)}" ${c.id === shot.cameraId ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div></div><div class="form-actions"><button id="shot-up" ${active.index === 0 ? 'disabled' : ''}>前移</button><button id="shot-down" ${active.index === project.shots.length - 1 ? 'disabled' : ''}>后移</button><button id="delete-shot" class="danger-button">移除镜头</button></div>`;
  $('inspector').innerHTML = html;
  bindInspector(); updateHandle();
}
function writeActorPosition(next, position) {
  const a = next.actors.find(a => a.id === selection.id), active = current();
  if (!active) { a.position = position; return; }
  const shot = next.shots.find(s => s.id === active.shot.id), t = fmt(active.progress);
  const keys = shot.blocking[a.id] || [{ t: 0, position: a.position.slice() }, { t: 1, position: a.position.slice() }];
  const key = keys.find(k => Math.abs(k.t - t) < .002);
  if (key) key.position = position; else keys.push({ t, position });
  shot.blocking[a.id] = keys.sort((a, b) => a.t - b.t);
}
function editPosition(next, position, mode = handleMode) {
  if (selection.type === 'camera') {
    const camera = next.cameras.find(c => c.id === selection.id); if (camera.locked) return;
    camera.keyframes[keyIndex][mode] = position;
  } else if (selection.type === 'actor') writeActorPosition(next, position);
  else next.scene.anchors.find(a => a.id === selection.id).position = position;
}
function updateHandle() {
  if (playing || exporting) { view.setHandle(null, false); return; }
  let pos, enabled = true;
  if (selection.type === 'camera') { const c = currentCamera(); pos = c.keyframes[keyIndex]?.[handleMode]; enabled = !c.locked; }
  else if (selection.type === 'actor') { const a = project.actors.find(a => a.id === selection.id), track = current()?.shot.blocking[a.id]; pos = track ? sampleTrack(track, current().progress).position : a.position; }
  else pos = project.scene.anchors.find(a => a.id === selection.id).position;
  view.setHandle(pos, enabled);
}
function bindInspector() {
  const editCam = (label, fn) => commit(label, p => { const c = p.cameras.find(c => c.id === selection.id); if (c.locked) throw new Error('相机已锁定。'); fn(c); });
  on('camera-lock', e => commit('修改相机锁定', p => p.cameras.find(c => c.id === selection.id).locked = e.target.checked), 'change');
  on('camera-name', e => editCam('重命名相机', c => c.name = e.target.value.trim()), 'change');
  on('camera-lens', e => editCam('修改焦距', c => c.keyframes[keyIndex].fov = lensToFov(Number(e.target.value))), 'change');
  on('camera-mode', e => editCam('修改运动方式', c => {
    const pose = sampleCamera(c, current()?.progress || 0); c.mode = e.target.value;
    if (c.mode === 'static') { c.keyframes = [{ ...pose, t: 0 }]; keyIndex = 0; }
    else if (c.keyframes.length === 1) c.keyframes.push({ ...clone(c.keyframes[0]), t: 1 });
  }), 'change');
  on('camera-from-view', () => editCam('从观察视角设置机位', c => { c.keyframes[keyIndex].position = view.overview.position.toArray(); c.keyframes[keyIndex].target = view.controls.target.toArray(); c.keyframes[keyIndex].fov = view.overview.fov; }));
  on('record-camera', () => cameraCapture ? stopCameraCapture() : startCameraCapture());
  on('look-at', e => { if (!e.target.value) return; const [type, id] = e.target.value.split(':');
    editCam('设置注视目标', c => {
      if (type === 'anchor') c.keyframes[keyIndex].target = clone(project.scene.anchors.find(a => a.id === id).position);
      else { const a = project.actors.find(a => a.id === id), track = current()?.shot.blocking[id]; const pos = track ? sampleTrack(track, current().progress).position : a.position; c.keyframes[keyIndex].target = [pos[0], pos[1] + a.height * .9, pos[2]]; }
    });
  }, 'change');
  on('duplicate-camera', () => { const id = uid('CAM'); commit('复制相机', p => { const c = clone(currentCamera()); c.id = id; c.name += ' 副本'; c.locked = false; p.cameras.push(c); }); choose({ type: 'camera', id }); });
  on('delete-camera', () => { const c = currentCamera(); if (project.cameras.length === 1) return toast('至少保留一个相机。'); if (project.shots.some(s => s.cameraId === c.id)) return toast('这个相机仍用于镜头。请先为这些镜头选择其他相机。'); commit('删除相机', p => { p.cameras = p.cameras.filter(v => v.id !== c.id); }); });
  on('add-key', () => editCam('添加路径关键点', c => { const t = fmt(current()?.progress || 0); if (c.keyframes.some(k => Math.abs(k.t - t) < .002)) throw new Error('此时刻已有关键点。先拖动时间轴到镜头中间。'); const pose = sampleCamera(c, t); c.keyframes.push({ ...pose, t }); c.keyframes.sort((a, b) => a.t - b.t); keyIndex = c.keyframes.findIndex(k => k.t === t); }));
  on('delete-key', () => editCam('删除路径关键点', c => { c.keyframes.splice(keyIndex, 1); keyIndex = Math.max(0, keyIndex - 1); }));
  for (const [id, prop, numeric] of [['actor-name', 'name'], ['actor-height', 'height', true], ['actor-facing', 'facing', true], ['actor-color', 'color']]) on(id, e => commit('修改人物占位', p => p.actors.find(a => a.id === selection.id)[prop] = numeric ? Number(e.target.value) : e.target.value), 'change');
  on('actor-id', e => { const oldId = selection.id, newId = e.target.value.trim(); if (commit('关联剧本人物', p => { p.actors.find(a => a.id === oldId).id = newId; for (const s of p.shots) { s.cast = s.cast.map(id => id === oldId ? newId : id); if (s.blocking[oldId]) { s.blocking[newId] = s.blocking[oldId]; delete s.blocking[oldId]; } } })) choose({ type: 'actor', id: newId }); }, 'change');
  on('clear-blocking', () => commit('清除当前镜头走位', p => delete p.shots.find(s => s.id === current().shot.id).blocking[selection.id]));
  on('delete-actor', () => commit('删除人物占位', p => { p.actors = p.actors.filter(a => a.id !== selection.id); for (const s of p.shots) delete s.blocking[selection.id]; }));
  on('anchor-name', e => commit('重命名锚点', p => p.scene.anchors.find(a => a.id === selection.id).name = e.target.value.trim()), 'change');
  on('delete-anchor', () => commit('删除锚点', p => p.scene.anchors = p.scene.anchors.filter(a => a.id !== selection.id)));
  for (const [id, prop, num] of [['shot-title', 'title'], ['shot-duration', 'duration', true], ['shot-camera', 'cameraId']]) on(id, e => { const sid = current().shot.id; if (commit('修改镜头', p => p.shots.find(s => s.id === sid)[prop] = num ? Math.round(Number(e.target.value) * p.format.fps) / p.format.fps : e.target.value)) chooseShot(sid); }, 'change');
  const moveShot = delta => { const id = current().shot.id, i = current().index; commit('调整镜头顺序', p => { const [s] = p.shots.splice(i, 1); p.shots.splice(i + delta, 0, s); }); chooseShot(id); };
  on('shot-up', () => moveShot(-1)); on('shot-down', () => moveShot(1));
  on('delete-shot', () => { const id = current().shot.id; commit('移除镜头', p => p.shots = p.shots.filter(s => s.id !== id)); });
  $('inspector').querySelectorAll('[data-vector]').forEach(el => el.addEventListener('change', () => {
    const key = el.dataset.vector, values = [...$('inspector').querySelectorAll(`[data-vector="${key}"]`)].map(e => Number(e.value));
    if (commit('修改空间位置', p => editPosition(p, values, key)) && cameraCapture) recordCaptureSample();
  }));
}

function updateTransport() {
  const active = current(); $('scrubber').value = currentTime; $('playhead-time').textContent = timecode(currentTime, project.format.fps);
  $('monitor-time').textContent = timecode(active?.localTime || 0, project.format.fps); $('monitor-camera').textContent = currentCamera().name;
  $('timeline-selected').textContent = active ? `${active.index + 1} / ${project.shots.length} 镜` : '尚无镜头';
  for (const element of document.querySelectorAll('[data-shot]')) { const isActive = element.dataset.shot === active?.shot.id; element.classList.toggle('active', isActive); element.setAttribute('aria-pressed', String(isActive)); }
  if (lastShotId !== active?.shot.id) {
    lastShotId = active?.shot.id;
    $('context-id').textContent = active?.shot.id || 'NO SHOT'; $('context-title').textContent = active?.shot.title || '添加一个镜头'; $('context-action').textContent = active?.shot.action || '先选择剧本段落，再为镜头分配拍摄相机。';
    if (playing) { selection = { type: 'camera', id: active.shot.cameraId }; keyIndex = 0; renderLists(); renderInspector(); view.buildHelpers(project, selection, active.progress, active.shot); }
  } else if (active) { $('context-title').textContent = active.shot.title; $('context-action').textContent = active.shot.action; }
}
// Live camera capture: create a shot, then record the dragged camera as
// motion keyframes with real-time t values. Works on the selected camera.
function startCameraCapture() {
  if (exporting || agentWorkspace?.reviewing) return;
  if (cameraCapture) return;
  if (selection.type !== 'camera') return toast('请先在摄影机列表选择要录制的相机。');
  const camera = project.cameras.find(c => c.id === selection.id);
  if (!camera) return toast('相机不存在。');
  if (camera.locked) return toast('相机已锁定，请先解锁再录制。');
  const shotId = uid('SHOT');
  const ok = commit('开始录制相机', p => {
    const source = p.cameras.find(c => c.id === camera.id);
    p.shots.push({ id: shotId, title: '录制镜头', sourceId: shotId, sceneId: p.scene.id, cast: [], action: '拖动录制的一段运镜。',
      duration: 1 / p.format.fps, motionPolicy: 'unspecified', cameraId: source.id, blocking: {} });
  });
  if (!ok) return;
  cameraCapture = { cameraId: camera.id, shotId, samples: [], startedAt: performance.now() };
  currentTime = totalDuration(project.shots.slice(0, project.shots.findIndex(s => s.id === shotId)));
  selection = { type: 'camera', id: camera.id }; keyIndex = 0;
  chooseShot(shotId);
  view.transform.detach();
  $('capture-indicator').hidden = false;
  updateCaptureUI();
  toast('录制中：在视口拖动相机与注视点，路径按真实时间记录。');
}
function recordCaptureSample() {
  if (!cameraCapture) return;
  const camera = project.cameras.find(c => c.id === cameraCapture.cameraId); if (!camera) return;
  const pose = sampleCamera(camera, 0);
  cameraCapture.samples.push({ seconds: (performance.now() - cameraCapture.startedAt) / 1000, position: pose.position.slice(), target: pose.target.slice(), fov: pose.fov });
  updateCaptureUI();
}
async function stopCameraCapture() {
  if (!cameraCapture) return;
  const capture = cameraCapture; cameraCapture = null;
  $('capture-indicator').hidden = true;
  updateCaptureUI();
  const pose = sampleCamera(project.cameras.find(c => c.id === capture.cameraId), 0);
  const samples = [...capture.samples, { seconds: (performance.now() - capture.startedAt) / 1000, position: pose.position.slice(), target: pose.target.slice(), fov: pose.fov }];
  let keyframes, duration;
  try { keyframes = captureToKeyframes(samples, project.format.fps); duration = samples.at(-1).seconds; }
  catch (error) {
    // Nothing usable was recorded: drop the placeholder shot instead of keeping a broken one.
    if (commit('放弃录制', p => p.shots = p.shots.filter(s => s.id !== capture.shotId))) chooseShot(project.shots[0]?.id);
    return toast(error.message);
  }
  const rounded = Math.max(1 / project.format.fps, Math.round(duration * project.format.fps) / project.format.fps);
  const tScale = keyframes.at(-1).t;
  if (commit('结束录制相机', p => {
    const camera = p.cameras.find(c => c.id === capture.cameraId);
    camera.mode = 'linear'; camera.locked = false;
    camera.keyframes = keyframes.map(k => ({ ...k, t: k.t / tScale }));
    const shot = p.shots.find(s => s.id === capture.shotId);
    if (shot) shot.duration = rounded;
  })) {
    chooseShot(capture.shotId);
    toast(`录制完成：${fmt(rounded)}s，${keyframes.length} 个关键点。可播放、检查或撤销。`);
  }
}
function cancelCameraCapture() {
  if (!cameraCapture) return;
  const capture = cameraCapture; cameraCapture = null;
  $('capture-indicator').hidden = true;
  updateCaptureUI();
  if (commit('放弃录制', p => p.shots = p.shots.filter(s => s.id !== capture.shotId))) chooseShot(project.shots[0]?.id);
  toast('录制已取消，未记录路径。');
}
function updateCaptureUI() {
  const button = $('record-camera');
  if (!button) return;
  button.textContent = cameraCapture ? '■ 结束录制' : '● 录制相机';
  button.classList.toggle('capture-active', Boolean(cameraCapture));
  button.disabled = exporting || agentWorkspace?.reviewing;
  if (cameraCapture) {
    const seconds = (performance.now() - cameraCapture.startedAt) / 1000;
    $('capture-time').textContent = `${seconds.toFixed(1)}s · ${cameraCapture.samples.length} 点`;
  } else $('capture-time').textContent = '';
}
function openShotPicker() {
  if (!project.script) return toast('当前项目没有剧本。请先在「项目」菜单导入剧本 JSON。');
  const materials = materialList(project.script), available = materials.filter(m => m.sceneId === project.scene.id);
  dialog('从剧本添加镜头', `<p class="dialog-intro">当前场景：${esc(project.scene.name)}（${esc(project.scene.id)}）。按素材段落绑定镜头，避免把跨场景分镜组连接成一条轨迹。</p><div class="source-list">${available.map(m => {
    const exists = project.shots.some(s => s.id === m.id);
    return `<label class="source-item"><input type="checkbox" data-source="${esc(m.id)}" ${exists ? 'checked disabled' : ''}><div><small>${esc(m.id)} · ${m.duration}s ${exists ? '· 已添加' : ''}</small><br><strong>${esc(m.title)}</strong><p>${esc(m.action.slice(0, 130))}</p></div></label>`;
  }).join('') || '<div class="empty-state">剧本没有与当前场景 ID 对应的素材段落。可以在“场景 → 尺寸与场景绑定”中修改绑定。</div>'}</div><p class="field-help">另外 ${materials.length - available.length} 个段落属于其他场景，需载入对应模型并绑定场景后添加。</p><div class="dialog-footer"><button id="confirm-shots" class="button-accent">添加选中镜头</button></div>`);
  on('confirm-shots', () => {
    const ids = [...$('dialog-body').querySelectorAll('[data-source]:checked:not(:disabled)')].map(e => e.dataset.source);
    if (!ids.length) return toast('请先选择尚未添加的段落。');
    if (commit('从剧本添加镜头', p => { for (const m of available.filter(m => ids.includes(m.id))) p.shots.push({ ...clone(m), cameraId: currentCamera().id, blocking: {} }); })) { closeDialog(); chooseShot(ids[0]); }
  });
}
function openAI() {
  dialog('把空间交给 AI，把机位带回来', `<p class="dialog-intro">当前通过导出与粘贴接入 AI，尚未连接云端模型。空间数据包含语义分组、世界坐标、人物、锚点和镜头约束；模型文件保留在本机。</p><h3 class="dialog-step"><span class="step-num">01</span>准备空间数据与任务</h3><div class="form-actions"><button id="export-spatial">下载空间 JSON</button><button id="copy-prompt">复制完整 AI 任务</button><button id="download-prompt">下载 AI 任务文本</button></div><h3 class="dialog-step"><span class="step-num">02</span>粘贴 AI 返回的镜头方案</h3><label class="field-label" for="ai-plan">previzcam.camera-plan · JSON</label><textarea id="ai-plan" class="code-input" spellcheck="false" placeholder='{"type":"previzcam.camera-plan","version":1,"sceneId":"${esc(project.scene.id)}","cameras":[...],"assignments":[...]}'></textarea><div class="form-actions"><button id="fill-plan-example">填入格式示例</button><button id="validate-plan">检查方案</button></div><div id="plan-feedback" aria-live="polite"></div><div class="dialog-footer"><span class="field-help">应用后可撤销；已锁定相机不会被覆盖。</span><button id="apply-plan" class="button-accent" disabled>应用已检查的方案</button></div>`, 'AI / CAMERA PLAN');
  let staged, inputAtCheck;
  // The manual export stays deliberately rich, but bounded: 200 meshes instead of 1000+.
  const manualSpatial = () => view.spatialData(project, { detail: 'full', meshLimit: 200 });
  const prompt = () => `你是三维镜头规划助手。根据以下实际场景空间数据和剧本，生成镜头方案。\n要求：\n1. 仅输出符合 outputContract 的 JSON，不输出代码或解释。\n2. 保留 sceneId 和 assignments 中已有的 shotId，不增加未知场景或角色。\n3. 使用新的相机 ID，尊重 locked 相机和 motionPolicy；static 镜头必须保持位置、注视点、fov 不变，仅含 t=0 的一个关键点。\n4. 对运动镜头使用按 t 严格递增的少量关键点，首尾必须为 0 和 1。t 是镜头内归一化时间，fov 是垂直视场角，坐标为米、右手系、Y 向上。\n5. 语义分组的包围盒不等于实心障碍物，门洞可能在其中。提出候选方案，不能声称已验证无碰撞；方案将返回网站做几何检查。\n6. 注意人物头部安全构图、同轴接续和纸面时长。只有明确允许时才使用运镜。\n7. 网格清单可能被截断，meshes.nextOffset 不为 null 时可用 meshOffset 继续导出。\n\n${JSON.stringify(manualSpatial(), null, 2)}`;
  on('export-spatial', () => download(manualSpatial(), 'scene-context.json'));
  on('copy-prompt', async () => { await navigator.clipboard.writeText(prompt()); toast('AI 任务与空间数据已复制。'); });
  on('download-prompt', () => download(prompt(), 'camera-planning-task.txt', 'text/plain;charset=utf-8'));
  on('fill-plan-example', () => {
    const c = clone(currentCamera()); c.id = 'CAM_AI_EXAMPLE'; c.name = 'AI 格式示例 · 待调整'; c.locked = false;
    $('ai-plan').value = JSON.stringify({ type: 'previzcam.camera-plan', version: 1, sceneId: project.scene.id, cameras: [c], assignments: project.shots.map(s => ({ shotId: s.id, cameraId: c.id })) }, null, 2);
    staged = null; $('apply-plan').disabled = true; $('plan-feedback').textContent = '这是当前机位的格式示例，未调用 AI。';
  });
  on('ai-plan', () => { staged = null; $('apply-plan').disabled = true; $('plan-feedback').textContent = ''; }, 'input');
  on('validate-plan', async () => {
    $('plan-feedback').textContent = '正在检查数据与几何…'; await nextFrame();
    try {
      const raw = $('ai-plan').value.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
      const plan = JSON.parse(raw), next = applyCameraPlan(project, plan), checks = view.validate(next);
      staged = next; inputAtCheck = $('ai-plan').value;
      const errors = checks.filter(m => m.level === 'error');
      $('plan-feedback').innerHTML = `<p class="success-text">格式通过：${plan.cameras.length} 个相机，${plan.assignments.length} 个镜头关联。</p>${checks.length ? `<p class="notice">空间与剧本检查发现 ${checks.length} 项提示${errors.length ? `，其中 ${errors.length} 项为穿模或遮挡` : ''}。应用后可查看并修正。</p>${checks.slice(0, 8).map(m => `<p class="field-help">${esc(m.shotId)} · ${esc(m.message)}</p>`).join('')}` : '<p class="field-help">本轮有限采样未发现明显问题。仍需播放检查构图。</p>'}`;
      $('apply-plan').disabled = false;
    } catch (error) { staged = null; $('apply-plan').disabled = true; $('plan-feedback').innerHTML = `<p class="error-text">${esc(error.message)}</p>`; }
  });
  on('apply-plan', () => {
    if (!staged || inputAtCheck !== $('ai-plan').value) return toast('方案已变化，请重新检查。');
    pushHistory(snapshot()); project = staged; selection = { type: 'camera', id: current()?.shot.cameraId || project.cameras[0].id }; keyIndex = 0; refresh(); scheduleSave(); closeDialog(); toast('镜头方案已应用，可以播放、调整或撤销。');
  });
}
function openCalibration() {
  const tr = project.scene.transform;
  dialog('场景尺寸与剧本绑定', `<p class="dialog-intro">网站统一使用米、右手坐标系、Y 向上。尺寸与方向校准只调整模型，现有相机、人物和锚点需要重新检查。</p>${field('scene-name', '场景名称', project.scene.name)}<div class="field"><label for="scene-binding">对应剧本场景</label><select id="scene-binding">${(project.script?.locations || [{ id: project.scene.id, name: project.scene.name }]).map(l => `<option value="${esc(l.id)}" ${l.id === project.scene.id ? 'selected' : ''}>${esc(l.name)} · ${esc(l.id)}</option>`).join('')}</select></div><div class="field-row">${field('model-scale', '模型缩放 · 1 表示原始尺寸', tr.scale, 'number', 'min="0.0001" step="0.1"')}${field('model-rotation', '绕 Y 轴旋转 · °', tr.rotationY, 'number', 'step="90"')}</div>${vectorFields('offset', '模型偏移', tr.offset)}<p class="notice">更改剧本场景绑定时，会移除当前镜头列表，随后可以添加对应场景的镜头。此操作可撤销。</p><div class="dialog-footer"><button id="apply-calibration" class="button-accent">应用校准</button></div>`);
  on('apply-calibration', () => {
    const id = $('scene-binding').value;
    if (commit('校准场景', p => { p.scene.name = $('scene-name').value.trim(); if (id !== p.scene.id) p.shots = []; p.scene.id = id;
      p.scene.transform = { scale: Number($('model-scale').value), rotationY: Number($('model-rotation').value), offset: [...$('dialog-body').querySelectorAll('[data-vector="offset"]')].map(e => Number(e.value)) };
      p.scene.calibration = '用户已设置模型缩放与朝向；空间锚点和机位仍需核对。';
    })) { view.resetOverview(); closeDialog(); }
  });
}
async function loadModelFile(file) {
  if (!file) return; if (file.size > 100 * 1024 * 1024) throw new Error('第一版支持 100 MB 以内的 GLB。');
  const bytes = await file.arrayBuffer(); if (new DataView(bytes).getUint32(0, true) !== 0x46546c67) throw new Error('请选择有效的 GLB 二进制模型。');
  toast('正在读取模型…'); const parsed = await view.parseModel(bytes), next = clone(project);
  next.scene.source = 'embedded'; next.scene.modelName = file.name; next.scene.annotations = {}; next.scene.anchors = [];
  next.scene.transform = { scale: 1, rotationY: 0, offset: [0, 0, 0] }; next.scene.calibration = '新导入模型，单位、尺度、场景绑定与机位尚待校准。';
  validateProject(next); pushHistory(snapshot()); project = next; modelBytes = bytes; view.installModel(parsed, project); refresh(); scheduleSave();
  toast('模型已导入。请校准尺寸、场景绑定，再检查原有机位。'); openCalibration();
}
async function exportProject() {
  const bundle = clone(project); if (modelBytes) bundle.embeddedModel = { mimeType: 'model/gltf-binary', base64: await toBase64(modelBytes) };
  download(bundle, 'previzcam-project.json'); toast('预演项目已下载，包含剧本、机位、人物与自定义模型。');
}
async function openProjectFile(file, nameOverride) {
  if (!file) return; if (file.size > 150 * 1024 * 1024) throw new Error('项目文件超过 150 MB。');
  const data = JSON.parse((await file.text()).replace(/^\uFEFF/, ''));
  if (nameOverride) data.name = nameOverride; // 文件夹导入：项目名跟文件夹走，文件内容其余保持原样
  validateProject(data);
  let bytes = null;
  if (data.scene.source === 'embedded') { if (!data.embeddedModel?.base64) throw new Error('项目缺少内嵌 GLB，无法还原场景。'); bytes = fromBase64(data.embeddedModel.base64); }
  delete data.embeddedModel;
  const parsed = await view.parseModel(bytes || bundledBytes);
  pushHistory(snapshot()); project = data; modelBytes = bytes; projectArchiveId = uid('PRJ'); view.installModel(parsed, project); currentTime = 0; selection = { type: 'camera', id: project.shots[0]?.cameraId || project.cameras[0].id }; keyIndex = 0;
  refresh(); scheduleSave(); closeWelcome(); toast('项目已打开，自动保存在本机项目列表。');
}
function closeWelcome() { $('welcome').hidden = true; $('stage-instruction').textContent = '拖动旋转 · 右键平移 · 滚轮缩放'; document.querySelector('.menu').open = false; }
async function openArchive(id) {
  const stored = await loadProject(id); if (!stored?.project) { toast('找不到这个本机项目。'); await renderMenuProjects(); return; }
  validateProject(stored.project);
  if (stored.project.scene.source === 'embedded' && !(stored.modelBytes instanceof ArrayBuffer)) throw new Error('存档缺少模型文件');
  const parsed = await view.parseModel(stored.modelBytes || bundledBytes);
  pause(); pushHistory(snapshot()); project = stored.project; modelBytes = stored.modelBytes || null; projectArchiveId = id;
  view.installModel(parsed, project); currentTime = 0; selection = { type: 'camera', id: project.shots[0]?.cameraId || project.cameras[0].id }; keyIndex = 0;
  history = []; future = [];
  refresh(); scheduleSave(); closeWelcome(); renderMenuProjects(); toast(`已打开「${project.name}」。`);
}
async function newProject(name) {
  const next = createEmptyProject(name); validateProject(next);
  const parsed = await view.parseModel(bundledBytes);
  pause(); pushHistory(snapshot()); project = next; modelBytes = null; projectArchiveId = uid('PRJ');
  view.installModel(parsed, project); currentTime = 0; selection = { type: 'camera', id: project.cameras[0].id }; keyIndex = 0;
  history = []; future = [];
  view.model.clear(); view.calibrate(project); view.buildActors(project);
  refresh(); scheduleSave(); closeWelcome(); renderMenuProjects(); toast(`已创建「${project.name}」。请在「项目」菜单导入 GLB 模型。`);
}
async function deleteArchive(id) {
  await removeProject(id);
  if (id === projectArchiveId) projectArchiveId = null;
  await renderMenuProjects(); await renderWelcome(); toast('本机项目已删除。');
}
async function loadDemoProject() {
  const data = await (await fetch('assets/script.json')).json(), next = createProject(data), parsed = await view.parseModel(bundledBytes);
  pause(); pushHistory(snapshot()); project = next; modelBytes = null; projectArchiveId = uid('PRJ'); currentTime = 0; selection = { type: 'camera', id: project.cameras[0].id }; keyIndex = 0;
  view.installModel(parsed, project); history = []; future = [];
  refresh(); scheduleSave(); closeWelcome(); renderMenuProjects(); toast('山门示例已载入，可撤销回原项目。');
}
async function openWelcome() {
  pause(); $('welcome').hidden = false;
  await renderWelcome();
}
async function renderWelcome() {
  const entries = await listProjects().catch(() => []);
  $('welcome-projects').innerHTML = entries.length ? entries.map(e => `<button class="welcome-project" data-welcome-project="${esc(e.id)}"><span class="welcome-project-name">${esc(e.project?.name || '未命名项目')}</span><small>${e.project?.shots?.length || 0} 镜 · ${new Date(e.updatedAt).toLocaleString()}</small></button>`).join('')
    : '<p class="welcome-empty">本机还没有保存的项目。新建一个，或载入示例体验。</p>';
}
async function renderMenuProjects() {
  const entries = await listProjects().catch(() => []);
  $('menu-projects').innerHTML = entries.length ? entries.map(e => `<div class="menu-project"><button data-open-project="${esc(e.id)}" title="${esc(e.project?.name || '')}"><span>${esc(e.project?.name || '未命名项目')}</span><small>${e.project?.shots?.length || 0} 镜</small></button><button class="menu-project-delete" data-delete-project="${esc(e.id)}" aria-label="删除 ${esc(e.project?.name || '')}">✕</button></div>`).join('')
    : '<span class="menu-empty">本机暂无项目</span>';
}
function openNewProjectDialog() {
  dialog('新建项目', `<p class="dialog-intro">创建一个空项目：包含默认相机、空剧本与空镜头表。模型可以稍后从「项目 → 导入 GLB 模型」加入。</p>${field('new-project-name', '项目名称', '新建项目')}<div class="dialog-footer"><button id="confirm-new-project" class="button-accent">创建项目</button></div>`, 'PREVIZCAM / NEW PROJECT');
  on('confirm-new-project', async () => {
    const name = $('new-project-name').value.trim() || '新建项目';
    try { await newProject(name); closeDialog(); } catch (error) { toast(error.message); }
  });
}

// 「打开项目文件夹」：选一个文件夹 → 递归扫描 GLB / 剧本 JSON / 预演项目文件 →
// 弹窗勾选加载。项目在点击「加载选中项」时才创建（名字跟文件夹走），
// 什么都不选直接关闭则不留下任何东西。
const FOLDER_SCAN_LIMIT = 2000, MODEL_SIZE_LIMIT = 100 * 1024 * 1024, SCRIPT_SIZE_LIMIT = 10 * 1024 * 1024, PROJECT_SIZE_LIMIT = 150 * 1024 * 1024;
const fmtSize = bytes => bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;
async function openProjectFolder() {
  if (!window.showDirectoryPicker) return toast('打开项目文件夹需要支持文件系统访问的浏览器，请使用 Chrome 或 Edge。');
  let dir;
  try { dir = await window.showDirectoryPicker(); } catch { return; } // 用户取消选择
  toast('正在扫描文件夹…');
  const scan = { project: [], models: [], scripts: [], byPath: new Map(), total: 0, unrecognized: 0, truncated: false };
  const walk = async (handle, prefix) => {
    for await (const entry of handle.values()) {
      if (scan.total >= FOLDER_SCAN_LIMIT) { scan.truncated = true; return; }
      if (entry.kind === 'directory') { await walk(entry, prefix ? `${prefix}/${entry.name}` : entry.name); if (scan.truncated) return; continue; }
      scan.total++;
      await classifyFolderFile(entry, prefix ? `${prefix}/${entry.name}` : entry.name, scan);
    }
  };
  await walk(dir, '');
  openFolderDialog(dir.name, scan);
}
async function classifyFolderFile(entry, path, scan) {
  const lower = entry.name.toLowerCase();
  const base = { name: entry.name, path, file: await entry.getFile() };
  base.size = base.file.size;
  if (lower.endsWith('.glb')) {
    base.group = 'model'; base.loadable = base.size <= MODEL_SIZE_LIMIT;
    scan.models.push(base);
  } else if (lower.endsWith('.previzcam')) {
    base.group = 'project'; base.loadable = base.size <= PROJECT_SIZE_LIMIT;
    scan.project.push(base);
  } else if (lower.endsWith('.json')) {
    const kind = await classifyJsonFile(base.file);
    if (kind === 'project') { base.group = 'project'; base.loadable = true; scan.project.push(base); }
    else if (kind === 'script') { base.group = 'script'; base.loadable = base.size <= SCRIPT_SIZE_LIMIT; scan.scripts.push(base); }
    else { scan.unrecognized++; return; }
  } else { scan.unrecognized++; return; }
  scan.byPath.set(path, base);
}
async function classifyJsonFile(file) {
  try {
    if (file.size <= SCRIPT_SIZE_LIMIT) {
      const data = JSON.parse((await file.text()).replace(/^\uFEFF/, ''));
      if (data?.type === 'previzcam.project') return 'project';
      if (Array.isArray(data?.shots)) return 'script';
      return null;
    }
    // 项目导出内嵌 base64 模型常超过剧本大小上限：只窥视开头确认类型标记。
    const head = await file.slice(0, 4096).text();
    return head.includes('"previzcam.project"') ? 'project' : null;
  } catch { return null; }
}
function openFolderDialog(folderName, scan) {
  const loadableCount = scan.project.filter(e => e.loadable).length + scan.models.filter(e => e.loadable).length + scan.scripts.filter(e => e.loadable).length;
  const item = entry => `<label class="source-item"><input type="checkbox" data-folder-group="${entry.group}" data-folder-file="${esc(entry.path)}" ${entry.loadable === false ? 'disabled' : ''}><div><small>${esc(entry.path)} · ${fmtSize(entry.size)}${entry.loadable === false ? ' · 超过大小限制' : ''}</small><br><strong>${esc(entry.name)}</strong></div></label>`;
  const group = (title, entries) => entries.length ? `<div class="source-group-title">${title}</div>${entries.map(item).join('')}` : '';
  dialog('打开项目文件夹', `<p class="dialog-intro">文件夹「${esc(folderName)}」共扫描 ${scan.total} 个文件，可加载 ${loadableCount} 项${scan.unrecognized ? `，另有 ${scan.unrecognized} 个未识别文件已跳过` : ''}${scan.truncated ? '；文件数超过扫描上限，结果可能不完整' : ''}。</p><div class="source-list">${group('预演项目文件 · 整体还原一个完整项目', scan.project)}${group('GLB 模型 · 可与剧本同选', scan.models)}${group('剧本 JSON · 可与模型同选', scan.scripts)}</div><p class="field-help">项目文件与模型、剧本互斥；模型和剧本可以同时勾选。什么都不选直接关闭弹窗，不会创建项目。</p><div class="dialog-footer"><button id="confirm-folder-load" class="button-accent">加载选中项</button></div>`, 'PREVIZCAM / OPEN FOLDER');
  on('confirm-folder-load', async () => {
    const body = $('dialog-body');
    const pick = group => { const el = body.querySelector(`[data-folder-group="${group}"]:checked`); return el ? scan.byPath.get(el.dataset.folderFile) : null; };
    const projectEntry = pick('project'), modelEntry = pick('model'), scriptEntry = pick('script');
    if (!projectEntry && !modelEntry && !scriptEntry) return toast('未选择要加载的内容；直接关闭弹窗不会创建项目。');
    closeDialog();
    if (projectEntry) return void await openProjectFile(projectEntry.file, folderName);
    await newProject(folderName);
    if (modelEntry) await loadModelFile(modelEntry.file); // 自带打开校准弹窗
    if (scriptEntry) {
      const data = JSON.parse((await scriptEntry.file.text()).replace(/^\uFEFF/, ''));
      if (commit('导入剧本', p => p.script = data)) {
        toast('剧本已载入，从素材段落中添加需要预演的镜头。');
        if (!modelEntry) openShotPicker(); // 两个都勾时保留校准弹窗，校准完再选镜
      }
    }
  });
}
// 弹窗内的勾选规则：组内单选；项目文件与模型/剧本互斥。dialog-body 是静态容器，
// 监听器在 bindEvents 里只绑一次，状态完全由当前 DOM 推导；取消勾选同样重算禁用。
function onFolderCheckChange(event) {
  const box = event.target.closest('[data-folder-group]');
  if (!box) return;
  const body = $('dialog-body');
  if (box.checked) for (const other of body.querySelectorAll(`[data-folder-group="${box.dataset.folderGroup}"]`)) if (other !== box) other.checked = false;
  const projectChecked = body.querySelector('[data-folder-group="project"]:checked');
  const contentChecked = body.querySelector('[data-folder-group="model"]:checked, [data-folder-group="script"]:checked');
  for (const input of body.querySelectorAll('[data-folder-group]')) {
    if (input.checked) continue;
    input.disabled = projectChecked ? input.dataset.folderGroup !== 'project' : Boolean(contentChecked) && input.dataset.folderGroup === 'project';
  }
}
async function showChecks() {
  dialog('镜头检查', '<p class="dialog-intro">正在采样轨迹并检查遮挡…</p>', 'REVIEW / GEOMETRY & STORY');
  await nextFrame();
  const results = view.validate(project);
  $('validation-badge').textContent = results.length ? `${results.length} 项提示` : '采样通过'; $('validation-badge').className = `validation-badge ${results.length ? 'warning' : 'good'}`;
  $('dialog-body').innerHTML = `<p class="dialog-intro">检查 ${project.shots.length} 个镜头：固定机位约束、相机路径与建筑相交、人物头部出画和场景遮挡。运动按时间与路径长度采样，每镜最多 301 个点；碰撞和遮挡是辅助提示，不代替逐镜预演。</p>${results.length ? results.map(m => `<div class="check-result ${m.level}"><div><code>${esc(m.shotId)}</code><br><small>${m.time == null ? '摄影约束' : '镜内 ' + m.time + 's'}</small></div><div><p>${esc(m.message)}</p><button class="text-button" data-check-shot="${esc(m.shotId)}" data-check-time="${m.time || 0}">定位检查 ↗</button></div></div>`).join('') : '<p class="success-text">本轮有限采样未发现明显问题。</p>'}<p class="field-help">暂不检查人物之间的遮挡、肢体碰撞、台词时长或真实镜头景深。分组包围盒不作为实心墙体。</p>`;
}

const canvasBlob = canvas => new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('无法导出画面。')), 'image/png'));
async function exportFrame() {
  pause(); view.render(project, currentCamera(), current()?.shot, current()?.progress || 0);
  download(await canvasBlob(view.film.domElement), `${current()?.shot.id || 'camera'}-${timecode(current()?.localTime || 0, project.format.fps).replaceAll(':', '-')}.png`);
}
async function exportStoryboard() {
  if (!project.shots.length) return toast('请先添加镜头。');
  if (project.shots.length > 100) return toast('分镜打包每次支持最多 100 个镜头。');
  exporting = true; $('status-message').textContent = '正在生成分镜图…';
  try {
    const files = { 'camera-plan.json': strToU8(JSON.stringify(cameraPlan(project), null, 2)), 'shots.json': strToU8(JSON.stringify(project.shots, null, 2)) };
    for (const [index, shot] of project.shots.entries()) {
      const c = project.cameras.find(c => c.id === shot.cameraId);
      for (const [name, progress] of [['start', 0], ['middle', .5], ['end', 1]]) {
        view.render(project, c, shot, progress);
        const blob = await canvasBlob(view.film.domElement), safeId = shot.id.replace(/[^a-zA-Z0-9_-]/g, '_');
        files[`${String(index + 1).padStart(2, '0')}_${safeId}_${name}.png`] = new Uint8Array(await blob.arrayBuffer());
      }
    }
    download(zipSync(files, { level: 0 }), 'previzcam-storyboards.zip', 'application/zip'); toast('分镜包已导出：每镜首、中、尾三帧及镜头方案。');
  } finally { exporting = false; refresh(false); }
}
async function exportVideo() {
  if (!project.shots.length) return toast('请先添加镜头。');
  const total = totalDuration(project.shots); if (total > 300) return toast('浏览器实时录制每次支持最多 5 分钟。请分段导出。');
  if (!window.MediaRecorder || !view.film.domElement.captureStream) return toast('当前浏览器不支持录制，请导出分镜图或使用 Chrome。');
  const mimeType = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find(type => MediaRecorder.isTypeSupported(type));
  if (!mimeType) throw new Error('当前浏览器没有可用的 WebM 编码器。');
  dialog('导出预演视频', `<p class="dialog-intro">正在以实时速度录制 ${fmt(total)} 秒预演。视频不含辅助线、界面或音频。请保持此页面可见；实际流畅度受浏览器渲染性能影响。</p><div class="record-bar"><span id="record-progress">准备录制…</span><button id="cancel-record">取消录制</button></div>`);
  const previous = { time: currentTime, selection: clone(selection), keyIndex };
  exporting = true; recordingCancelled = false; currentTime = 0; const chunks = [];
  view.transform.detach(); view.render(project, project.cameras.find(c => c.id === project.shots[0].cameraId), project.shots[0], 0);
  const stream = view.film.domElement.captureStream(project.format.fps);
  recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 6000000 });
  recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
  recorder.onstop = () => {
    stream.getTracks().forEach(t => t.stop());
    if (!recordingCancelled && chunks.length) download(new Blob(chunks, { type: mimeType }), 'previzcam-preview.webm');
    recorder = null; exporting = false; currentTime = previous.time; selection = previous.selection; keyIndex = previous.keyIndex;
    $('dialog').close(); refresh(false); toast(recordingCancelled ? '录制已取消。' : '预演视频已导出为 WebM。');
  };
  recorder.onerror = () => { recordingCancelled = true; if (recorder.state !== 'inactive') recorder.stop(); toast('视频编码失败，请改用分镜图导出。'); };
  on('cancel-record', () => { recordingCancelled = true; if (recorder?.state !== 'inactive') recorder.stop(); });
  lastTick = performance.now(); recorder.start(250);
}
function openExport() {
  dialog('导出预演', `<p class="dialog-intro">输出供镜头审核与后续视频制作使用。镜头数据是 PrevizCam 的中间格式，需按目标视频接口适配。</p><div class="export-grid"><button id="export-frame" class="export-card"><span class="mono">01 / PNG</span><strong>当前分镜画面</strong><span>1280 × 720，不含界面与辅助线。</span></button><button id="export-storyboard" class="export-card"><span class="mono">02 / ZIP</span><strong>整组分镜包</strong><span>每镜首、中、尾三帧，附镜头方案与剧本段落。</span></button><button id="export-video" class="export-card"><span class="mono">03 / WEBM</span><strong>预演视频</strong><span>实时录制完整时间轴，保留切镜和人物走位。</span></button><button id="export-cameras" class="export-card"><span class="mono">04 / JSON</span><strong>相机与逐帧轨迹</strong><span>包含位置、注视点、垂直视场角和独立镜头时间。</span></button></div><div class="dialog-footer"><button id="export-plan-only">仅下载可编辑镜头方案</button><button id="export-full-project">下载完整预演项目</button></div>`, 'EXPORT / PREVIS');
  on('export-frame', exportFrame); on('export-storyboard', exportStoryboard); on('export-video', exportVideo);
  on('export-cameras', () => download(sampledTimeline(project), 'camera-timeline.json'));
  on('export-plan-only', () => download(cameraPlan(project), 'camera-plan.json')); on('export-full-project', exportProject);
}
// Draggable panel boundaries: inline grid tracks override the stylesheet,
// sizes persist in localStorage. Skipped under 850px where gutters are hidden.
function bindGutters() {
  const workspace = $('workspace'), media = matchMedia('(max-width: 850px)');
  const restore = key => { try { return localStorage.getItem(key); } catch { return null; } };
  if (!media.matches) {
    const columns = restore('previzcam.columns'), rows = restore('previzcam.rows');
    if (columns) workspace.style.gridTemplateColumns = columns;
    if (rows) workspace.style.gridTemplateRows = rows;
  }
  const persist = () => {
    if (media.matches) return;
    try {
      if (workspace.style.gridTemplateColumns) localStorage.setItem('previzcam.columns', workspace.style.gridTemplateColumns);
      if (workspace.style.gridTemplateRows) localStorage.setItem('previzcam.rows', workspace.style.gridTemplateRows);
    } catch { /* 私密模式等存储不可用时静默跳过 */ }
  };
  const pxTracks = value => (value || '').split(' ').filter(Boolean).map(parseFloat);
  const drag = (element, mode) => {
    element.addEventListener('pointerdown', e => {
      if (media.matches) return;
      e.preventDefault(); element.setPointerCapture(e.pointerId); element.classList.add('dragging');
      const move = event => {
        if (media.matches) return;
        const rect = workspace.getBoundingClientRect(), computed = getComputedStyle(workspace);
        if (mode === 'sidebar' || mode === 'inspector') {
          const columns = pxTracks(computed.gridTemplateColumns);
          if (columns.length < 5) return;
          // The stage column stays flexible (minmax) so it absorbs the change.
          const sidebarWidth = mode === 'sidebar' ? clamp(event.clientX - rect.left, 150, Math.max(220, rect.width * .35)) : columns[0];
          const inspectorWidth = mode === 'inspector' ? clamp(rect.right - event.clientX, 240, Math.max(280, rect.width * .4)) : columns[4];
          workspace.style.gridTemplateColumns = `${Math.round(sidebarWidth)}px 6px minmax(230px, 1fr) 6px ${Math.round(inspectorWidth)}px`;
        } else {
          const rows = pxTracks(computed.gridTemplateRows);
          if (rows.length < 3) return;
          const bottom = clamp(rect.bottom - event.clientY - 6, 120, Math.max(160, rect.height * .5));
          workspace.style.gridTemplateRows = `${Math.round(Math.max(rect.height - 6 - bottom, 220))}px 6px ${Math.round(bottom)}px`;
        }
      };
      const stop = () => { element.classList.remove('dragging'); window.removeEventListener('pointermove', move); persist(); };
      window.addEventListener('pointermove', move);
      element.addEventListener('pointerup', stop, { once: true });
      element.addEventListener('pointercancel', stop, { once: true });
    });
  };
  drag($('gutter-sidebar'), 'sidebar');
  drag($('gutter-inspector'), 'inspector');
  drag($('gutter-timeline'), 'timeline');
}

function bindEvents() {
  on('undo', undo); on('redo', redo); on('play', play);
  on('prev-shot', () => chooseShot(project.shots[Math.max(0, (current()?.index || 0) - 1)]?.id));
  on('next-shot', () => chooseShot(project.shots[Math.min(project.shots.length - 1, (current()?.index || 0) + 1)]?.id));
  on('scrubber', e => {
    if (exporting) return; pause(); currentTime = Number(e.target.value); const active = current();
    if (active && selection.type === 'camera') selection = { type: 'camera', id: active.shot.cameraId };
    keyIndex = 0; refresh(false);
  }, 'input');
  for (const tab of ['shots', 'scene']) on(`tab-${tab}`, () => {
    for (const item of ['shots', 'scene']) { $(`${item}-pane`).hidden = item !== tab; $(`tab-${item}`).classList.toggle('active', item === tab); $(`tab-${item}`).setAttribute('aria-pressed', String(item === tab)); }
  });
  on('view-top', () => view.resetOverview(true)); on('view-reset', () => view.resetOverview());
  on('toggle-guides', e => { const enabled = e.target.getAttribute('aria-pressed') !== 'true'; e.target.setAttribute('aria-pressed', String(enabled)); enabled ? view.overview.layers.enable(1) : view.overview.layers.disable(1); });
  on('add-camera', () => {
    const id = uid('CAM'); commit('新增相机', p => p.cameras.push({ id, name: `机位 ${p.cameras.length + 1}`, mode: 'static', locked: false, keyframes: [{ t: 0, position: view.overview.position.toArray(), target: view.controls.target.toArray(), fov: view.overview.fov }] })); choose({ type: 'camera', id });
  });
  on('add-actor', () => {
    const id = uid('CHAR'); commit('新增人物占位', p => { p.actors.push({ id, name: '新人物', color: '#89b7b4', height: 1.7, position: [0, .43, -3], facing: 0 }); const shot = p.shots.find(s => s.id === current()?.shot.id); if (shot) shot.cast.push(id); }); choose({ type: 'actor', id });
  });
  on('add-anchor', () => { pause(); view.pickAnchor = true; toast('请点击模型表面放置锚点；按 Esc 取消。'); $('stage-instruction').textContent = '标记模式 · 点击模型表面放置锚点'; view.transform.detach(); });
  on('add-shot', openShotPicker); on('open-ai', openAI); on('calibrate', openCalibration); on('validate', showChecks); on('open-export', openExport); on('snapshot', exportFrame);
  on('capture-cancel', cancelCameraCapture);
  on('expand-monitor', () => $('monitor').requestFullscreen());
  on('show-script', () => { const s = current()?.shot; if (!s) return; dialog(s.title, `<p class="dialog-intro"><span class="mono">${esc(s.id)}</span> · ${s.duration}s · ${esc(s.sceneId)}</p><p style="line-height:2">${esc(s.action)}</p><p class="notice">${s.motionPolicy === 'static' ? '剧本摄影约束：定镜头为主，保持机位、焦距与构图稳定。' : '本段未声明固定机位约束。'}</p><p class="field-help">这是剧本的纸面时长。占位走位由预演项目设置，尚未验证对白和动作能否在该时长内完成。</p>`); });
  on('dialog-close', closeDialog);
  $('dialog').addEventListener('cancel', e => { if (exporting) e.preventDefault(); });
  on('dialog-body', onFolderCheckChange, 'change');
  for (const type of ['model', 'script', 'project']) on(`import-${type}`, () => { document.querySelector('.menu').open = false; $(`${type}-file`).click(); });
  on('model-file', async e => { pause(); const file = e.target.files[0]; e.target.value = ''; await loadModelFile(file); }, 'change');
  on('project-file', async e => { pause(); const file = e.target.files[0]; e.target.value = ''; await openProjectFile(file); }, 'change');
  on('script-file', async e => {
    const file = e.target.files[0]; e.target.value = ''; if (!file) return;
    if (file.size > 10 * 1024 * 1024) throw new Error('剧本 JSON 请控制在 10 MB 以内。');
    const data = JSON.parse((await file.text()).replace(/^\uFEFF/, '')); materialList(data);
    if (commit('导入剧本', p => p.script = data)) { toast('剧本已载入，从素材段落中添加需要预演的镜头。'); openShotPicker(); }
  }, 'change');
  on('save-project', exportProject);
  bindGutters();
  on('new-project', async () => { document.querySelector('.menu').open = false; openNewProjectDialog(); });
  on('open-folder', async () => { document.querySelector('.menu').open = false; await openProjectFolder(); });
  on('load-demo', loadDemoProject);
  on('welcome-new', () => { $('welcome').hidden = true; openNewProjectDialog(); });
  on('welcome-open', () => { $('project-file').click(); });
  on('welcome-demo', loadDemoProject);
  document.addEventListener('click', guard(async e => {
    const open = e.target.closest('[data-welcome-project]'), entry = e.target.closest('[data-open-project]'), drop = e.target.closest('[data-delete-project]');
    if (open) await openArchive(open.dataset.welcomeProject);
    if (entry) { document.querySelector('.menu').open = false; await openArchive(entry.dataset.openProject); }
    if (drop) await deleteArchive(drop.dataset.deleteProject);
  }));
  on('reset-demo', async () => { document.querySelector('.menu').open = false; await loadDemoProject(); });
  document.addEventListener('click', guard(async e => {
    if (exporting) return;
    const b = e.target.closest('button'); if (!b || b.disabled) return;
    if (b.dataset.shot) chooseShot(b.dataset.shot);
    if (b.dataset.camera) choose({ type: 'camera', id: b.dataset.camera });
    if (b.dataset.actor) choose({ type: 'actor', id: b.dataset.actor });
    if (b.dataset.anchor) choose({ type: 'anchor', id: b.dataset.anchor });
    if (b.dataset.key != null) { keyIndex = Number(b.dataset.key); const active = current(); if (active) { const progress = currentCamera().keyframes[keyIndex].t; currentTime = active.start + progress * active.shot.duration; if (progress === 1 && active.index < project.shots.length - 1) currentTime -= 1e-7; } refresh(false); }
    if (b.dataset.actorTime != null) { const active = current(); currentTime = active.start + Number(b.dataset.actorTime) * active.shot.duration; if (Number(b.dataset.actorTime) === 1 && active.index < project.shots.length - 1) currentTime -= 1e-7; refresh(false); }
    if (b.dataset.handle) { handleMode = b.dataset.handle; renderInspector(); }
    if (b.dataset.checkShot) { const id = b.dataset.checkShot, time = Number(b.dataset.checkTime); closeDialog(); chooseShot(id); currentTime += Math.min(time, current().shot.duration - 1e-7); refresh(false); }
    if (b.dataset.group) {
      const group = view.groups.find(g => g.id === b.dataset.group);
      dialog('标注空间对象', `${field('group-name', 'AI 使用的语义名称', project.scene.annotations[group.id] || group.name)}<p class="field-help">${group.nodeNames.length} 个网格；包围盒只表示整体范围，不等于实心障碍物。</p><div class="field"><label for="group-nodes">模型节点（只读）</label><textarea id="group-nodes" rows="7" readonly>${esc(group.nodeNames.slice(0, 100).join('\n'))}</textarea></div><div class="dialog-footer"><button id="save-group" class="button-accent">保存标注</button></div>`);
      on('save-group', () => { if (commit('修改空间标注', p => p.scene.annotations[group.id] = $('group-name').value.trim())) closeDialog(); });
    }
  }));
  document.addEventListener('keydown', guard(async e => {
    if (!ready || exporting || agentWorkspace?.dialog.open || e.target.closest('input,textarea,select,[contenteditable=true]')) return;
    if (e.key === 'Escape') { if (cameraCapture) { cancelCameraCapture(); return; } view.pickAnchor = false; $('stage-instruction').textContent = '拖动旋转 · 右键平移 · 滚轮缩放'; updateHandle(); }
    if ($('dialog').open) return;
    if (e.code === 'Space' && !e.target.closest('button')) { e.preventDefault(); play(); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? await redo() : await undo(); }
  }));
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { if (recorder) { recordingCancelled = true; if (recorder.state !== 'inactive') recorder.stop(); } pause(); }
  });
}

function animate(timestamp) {
  requestAnimationFrame(animate); if (!ready) return;
  const delta = Math.max(0, (timestamp - lastTick) / 1000); lastTick = timestamp;
  if (playing || recorder) {
    currentTime = Math.min(totalDuration(project.shots), currentTime + delta);
    if (recorder && $('record-progress')) $('record-progress').textContent = `${timecode(currentTime, project.format.fps)} / ${timecode(totalDuration(project.shots), project.format.fps)}`;
    if (currentTime >= totalDuration(project.shots)) { pause(); if (recorder?.state === 'recording') recorder.stop(); }
    updateTransport();
  }
  if (exporting && !recorder) return;
  // Helpers update with the live camera; the film camera renders only layer zero.
  view.render(project, currentCamera(), current()?.shot, current()?.progress || 0);
  if (!view.dragging && !playing) updateHandle();
}

async function init() {
  try { bundledBytes = await (await fetch('assets/temple-gate.glb')).arrayBuffer(); }
  catch { bundledBytes = null; }
  view = new SceneView($('stage'), $('monitor'), {
    select: choose,
    addAnchor: position => { const id = uid('anchor'); commit('添加空间锚点', p => p.scene.anchors.push({ id, name: `锚点 ${p.scene.anchors.length + 1}`, position })); choose({ type: 'anchor', id }); $('stage-instruction').textContent = '拖动旋转 · 右键平移 · 滚轮缩放'; },
    dragStart: () => {
      pause(); dragBefore = snapshot();
      if (cameraCapture) recordCaptureSample();
    },
    drag: position => {
      editPosition(project, position); view.buildHelpers(project, selection, current()?.progress || 0, current()?.shot || null);
      if (cameraCapture) recordCaptureSample();
    },
    dragEnd: () => {
      if (cameraCapture) { dragBefore = null; refresh(); return; } // 录制模式：采样已即时记录，历史在结束时统一提交
      if (!dragBefore) return;
      try { validateProject(project); pushHistory(dragBefore); scheduleSave(); }
      catch (error) { project = dragBefore.project; toast(error.message); }
      dragBefore = null; refresh();
    },
  });
  // Start with an empty workspace: nothing loads until the user picks one.
  project = createEmptyProject(); view.calibrate(project); view.buildActors(project);
  commands = new ProjectCommands({ getProject: () => project, applyProject: next => {
    if (exporting || view.dragging) refuse('WORKSPACE_BUSY', '请先结束当前编辑或导出。');
    validateProject(next); pause(); pushHistory(snapshot()); project = next; currentTime = 0;
    selection = { type: 'camera', id: project.shots[0]?.cameraId || project.cameras[0].id }; keyIndex = 0;
    refresh(); scheduleSave();
  } });
  agentWorkspace = new AgentWorkspace({ commands, getProject: () => project, getBytes: () => modelBytes || bundledBytes,
    spatialData: (value, options) => view.spatialData(value, options), toast,
    pause: () => { pause(); view.transform.detach(); view.pickAnchor = false; },
    assertReady: () => { if (!ready || view.dragging) refuse('WORKSPACE_BUSY', '场景尚未就绪或用户正在拖动编辑，请稍后重试。', { retryAfterMs: 2000 }); },
    createEmpty: async (name, replace) => {
      if (!name) refuse('INVALID_NAME', '项目名称不能为空。');
      if (!isEmptyWorkspace(project) && !replace) refuse('PROJECT_EXISTS', `当前项目「${project.name}」已有内容，未被替换。请与用户确认后带 replace: true 重试。`);
      await newProject(name);
      return { name: project.name, revision: commands.revision };
    },
  });
  bindEvents(); ready = true; refresh(); $('loading').hidden = true; $('save-state').textContent = '未打开项目';
  document.body.dataset.ready = 'true';
  lastTick = performance.now(); requestAnimationFrame(animate);
  await migrateLegacyWorkspace();
  // Reopen the project this browser was last editing instead of silently starting empty.
  // A missing or unreadable archive is not fatal: the welcome card still works.
  try {
    const activeId = await loadActiveId();
    if (activeId) await openArchive(activeId);
    else $('save-state').textContent = '未打开项目';
  } catch (error) { console.warn('未能恢复上次项目', error); $('save-state').textContent = '未打开项目'; }
  await renderMenuProjects();
  await openWelcome();
}
init().catch(error => {
  console.error(error); $('loading').innerHTML = `<strong>工作台未能打开</strong><small>${esc(error.message)}</small><small>请使用支持 WebGL 2 的浏览器，并通过 127.0.0.1:8899 打开。</small>`; $('save-state').textContent = '打开失败';
});
