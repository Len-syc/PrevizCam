import * as THREE from 'three';
import { OrbitControls } from '../vendor/controls/OrbitControls.js';
import { TransformControls } from '../vendor/controls/TransformControls.js';
import { GLTFLoader } from '../vendor/loaders/GLTFLoader.js';
import { sampleCamera, sampleTrack, distance, policyWarnings } from './core.mjs';

const v3 = a => new THREE.Vector3().fromArray(a);
const round = a => a.map(x => Math.round(x * 10000) / 10000);
function layer(group, number = 1) { group.traverse(o => o.layers.set(number)); return group; }
function dispose(group) {
  group.traverse(o => { o.geometry?.dispose(); for (const m of (Array.isArray(o.material) ? o.material : [o.material])) {
    if (!m) continue;
    for (const val of Object.values(m)) if (val?.isTexture) val.dispose();
    m.dispose();
  } });
  group.removeFromParent();
}
function label(text, color = '#e9f1f3') {
  const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d');
  ctx.font = '500 32px Microsoft YaHei, sans-serif'; canvas.width = Math.min(420, Math.max(100, ctx.measureText(text.slice(0, 20)).width + 28)); canvas.height = 56;
  ctx.fillStyle = 'rgba(24,36,44,.91)'; ctx.beginPath(); ctx.roundRect(0, 0, canvas.width, 56, 9); ctx.fill();
  ctx.font = '500 32px Microsoft YaHei, sans-serif'; ctx.fillStyle = color; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(text.slice(0, 20), canvas.width / 2, 29, canvas.width - 24);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas), depthTest: false, sizeAttenuation: false }));
  sprite.scale.set(canvas.width / 1900, 56 / 1900, 1); sprite.renderOrder = 10; return layer(sprite);
}
const groupingRules = [
  ['approach', '门外铺地与石阶', /approach|step|threshold/i],
  ['ground', '庭院地面', /courtyard.*paver|courtyard.*grout|foundation|plinth/i],
  ['roof', '屋顶与瓦面', /roof|tile|ridge|eave|rafter/i],
  ['gate', '山门与门框', /gate|door|entrance/i],
  ['walls', '围墙与立柱', /wall|pier|pillar|column/i],
  ['windows', '窗与格栅', /window|lattice/i],
  ['plants', '植物与景石', /plant|leaf|leaves|rock|stone cluster|bamboo/i],
  ['furniture', '石凳与灯笼', /bench|lantern|stool/i],
];

export class SceneView {
  constructor(stage, monitor, callbacks) {
    this.callbacks = callbacks; this.stage = stage; this.monitor = monitor; this.scene = new THREE.Scene(); this.scene.background = new THREE.Color('#aebfc5');
    this.scene.add(new THREE.HemisphereLight('#e5f3ff', '#8a7e70', 2.5));
    const sun = new THREE.DirectionalLight('#fff2d9', 3.0); sun.position.set(-4, 12, 8); this.scene.add(sun);
    const fill = new THREE.DirectionalLight('#c5e4ff', 1.0); fill.position.set(5, 5, -6); this.scene.add(fill);
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.film = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    for (const r of [this.renderer, this.film]) { r.outputColorSpace = THREE.SRGBColorSpace; r.toneMapping = THREE.ACESFilmicToneMapping; r.toneMappingExposure = 1.05; }
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.6)); this.film.setPixelRatio(1); this.film.setSize(1280, 720, false);
    stage.append(this.renderer.domElement); monitor.prepend(this.film.domElement);
    this.renderer.domElement.setAttribute('aria-label', '三维场景总览，可拖动旋转，滚轮缩放');
    this.film.domElement.setAttribute('aria-label', '当前拍摄相机的画面');
    this.overview = new THREE.PerspectiveCamera(44, 1, .05, 1000); this.overview.layers.enable(1);
    this.camera = new THREE.PerspectiveCamera(35, 16 / 9, .05, 1000);
    this.controls = new OrbitControls(this.overview, this.renderer.domElement); this.controls.enableDamping = true; this.controls.dampingFactor = .12;
    this.controls.minDistance = .25; this.controls.maxDistance = 200;
    this.model = new THREE.Group(); this.scene.add(this.model);
    this.groups = []; this.meshes = []; this.solidBoxes = []; this.meshIndex = [];
    this.actors = new THREE.Group(); this.scene.add(this.actors);
    this.helpers = new THREE.Group(); this.scene.add(this.helpers);
    const grid = new THREE.GridHelper(40, 40, '#758d98', '#8ea5ae'); grid.position.y = -.22; layer(grid); this.scene.add(grid);
    this.handle = new THREE.Object3D(); this.scene.add(this.handle);
    this.transform = new TransformControls(this.overview, this.renderer.domElement); this.transform.setSize(.7); this.transform.setMode('translate');
    this.transform.getRaycaster().layers.set(1);
    layer(this.transform.getHelper()); this.scene.add(this.transform.getHelper());
    this.transform.addEventListener('dragging-changed', e => {
      this.controls.enabled = !e.value; this.dragging = e.value;
      if (e.value) callbacks.dragStart(); else callbacks.dragEnd();
    });
    this.transform.addEventListener('objectChange', () => { if (this.dragging) callbacks.drag(round(this.handle.position.toArray())); });
    this.raycaster = new THREE.Raycaster(); this.pointer = new THREE.Vector2();
    let pointerDown;
    this.renderer.domElement.addEventListener('pointerdown', e => { pointerDown = [e.clientX, e.clientY]; });
    this.renderer.domElement.addEventListener('pointerup', e => {
      if (this.transform.dragging || this.transform.axis || !pointerDown || Math.hypot(e.clientX - pointerDown[0], e.clientY - pointerDown[1]) > 5) return;
      const rect = this.renderer.domElement.getBoundingClientRect();
      this.pointer.set((e.clientX - rect.left) / rect.width * 2 - 1, -(e.clientY - rect.top) / rect.height * 2 + 1);
      this.raycaster.layers.enableAll(); this.raycaster.setFromCamera(this.pointer, this.overview);
      const candidates = this.raycaster.intersectObjects([...this.actors.children, ...this.helpers.children], true);
      for (const hit of candidates) {
        let o = hit.object;
        while (o && !o.userData.select) o = o.parent;
        if (o?.userData.select) { callbacks.select(o.userData.select); return; }
      }
      if (this.pickAnchor) {
        const hit = this.raycaster.intersectObject(this.model, true)[0];
        if (hit) { this.pickAnchor = false; callbacks.addAnchor(round(hit.point.toArray())); }
      }
    });
    this.resizeObserver = new ResizeObserver(() => this.resize()); this.resizeObserver.observe(stage);
    this.resetOverview();
  }
  resize() {
    const w = this.stage.clientWidth, h = this.stage.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false); this.overview.aspect = w / h; this.overview.updateProjectionMatrix();
  }
  resetOverview(top = false) {
    const box = this.bounds || new THREE.Box3(v3([-6, 0, -10]), v3([6, 5, 2]));
    const center = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3());
    const radius = Math.max(size.x, size.y, size.z, 4);
    this.controls.target.copy(center); this.overview.position.copy(center).add(v3(top ? [0, radius * 1.5, .001] : [radius * .88, radius * .95, radius * 1.05]));
    this.overview.up.set(0, 1, 0); this.controls.update();
  }
  async parseModel(data) {
    const manager = new THREE.LoadingManager();
    manager.setURLModifier(url => { if (!/^(blob:|data:)/i.test(url)) throw new Error('GLB 含外部资源。请将纹理和缓冲区内嵌后重新导出。'); return url; });
    const loader = new GLTFLoader(manager);
    let gltf;
    try { gltf = await loader.parseAsync(data, ''); }
    catch (error) { if (/DRACO|Meshopt|KTX2/i.test(error.message)) throw new Error('模型使用了尚未配置的压缩格式。请导出未压缩、纹理内嵌的 GLB。'); throw error; }
    let count = 0; gltf.scene.traverse(n => { if (n.isMesh) count++; });
    if (!count) { dispose(gltf.scene); throw new Error('模型中没有可显示的网格。'); }
    return { root: gltf.scene, cameras: gltf.cameras.map(c => ({ name: c.name, type: c.type })), count };
  }
  installModel(parsed, project) {
    for (const child of [...this.model.children]) dispose(child);
    this.model.add(parsed.root); this.importedCameras = parsed.cameras; this.meshCount = parsed.count;
    const importedHelpers = []; parsed.root.traverse(o => { if (o.isCamera || o.isLight) importedHelpers.push(o); });
    importedHelpers.forEach(o => o.removeFromParent());
    this.calibrate(project); this.resetOverview();
  }
  calibrate(project) {
    const t = project.scene.transform;
    this.model.scale.setScalar(t.scale); this.model.rotation.y = THREE.MathUtils.degToRad(t.rotationY); this.model.position.fromArray(t.offset);
    this.model.updateMatrixWorld(true); this.bounds = new THREE.Box3().setFromObject(this.model);
    this.rebuildSemantics(project);
  }
  rebuildSemantics(project) {
    const groups = new Map(); this.meshes = []; this.solidBoxes = []; this.meshIndex = [];
    this.model.traverse(o => {
      if (!o.isMesh) return;
      this.meshes.push(o);
      const found = groupingRules.find(rule => rule[2].test(o.name));
      const key = found?.[0] || 'other';
      if (!groups.has(key)) groups.set(key, { id: key, name: project.scene.annotations[key] || found?.[1] || '其他结构', nodeNames: [], box: new THREE.Box3() });
      const group = groups.get(key), box = new THREE.Box3().setFromObject(o);
      group.nodeNames.push(o.name); group.box.union(box);
      if (/wall|pillar|pier|column|(?:door|front)[_ ]panel|post/i.test(o.name)) this.solidBoxes.push({ name: o.name, box });
      // One pass builds the whole mesh index, so a context read never re-measures 1000+ meshes.
      const size = box.getSize(new THREE.Vector3());
      this.meshIndex.push({ id: `mesh_${this.meshIndex.length}`, name: o.name, parent: o.parent?.name || null,
        worldPosition: round(o.getWorldPosition(new THREE.Vector3()).toArray()),
        bounds: { min: round(box.min.toArray()), max: round(box.max.toArray()) },
        semanticGroup: key, volume: box.isEmpty() ? 0 : Math.round(size.x * size.y * size.z * 10000) / 10000 });
    });
    this.groups = [...groups.values()];
  }
  buildActors(project) {
    for (const a of [...this.actors.children]) dispose(a);
    for (const actor of project.actors) {
      const group = new THREE.Group(); group.name = actor.id; group.userData.select = { type: 'actor', id: actor.id };
      const material = new THREE.MeshStandardMaterial({ color: actor.color, roughness: .85 });
      const headMaterial = new THREE.MeshStandardMaterial({ color: '#d5c3ad', roughness: .9 });
      const h = actor.height;
      const body = new THREE.Mesh(new THREE.CylinderGeometry(h * .105, h * .16, h * .65, 16), material); body.position.y = h * .445; group.add(body);
      const neck = new THREE.Mesh(new THREE.CylinderGeometry(h * .04, h * .04, h * .10, 12), headMaterial); neck.position.y = h * .8; group.add(neck);
      const head = new THREE.Mesh(new THREE.SphereGeometry(h * .085, 18, 12), headMaterial); head.position.y = h * .91; group.add(head);
      const nose = new THREE.Mesh(new THREE.SphereGeometry(h * .026, 8, 6), headMaterial); nose.position.set(0, h * .91, h * .08); group.add(nose);
      for (const sign of [-1, 1]) {
        const foot = new THREE.Mesh(new THREE.BoxGeometry(h * .09, h * .13, h * .15), material); foot.position.set(sign * h * .065, h * .065, h * .025); group.add(foot);
        const arm = new THREE.Mesh(new THREE.CapsuleGeometry(h * .045, h * .28, 3, 8), material); arm.position.set(sign * h * .145, h * .59, 0); arm.rotation.z = sign * .12; group.add(arm);
      }
      const name = label(actor.name); name.position.y = h + .32; group.add(name);
      group.position.fromArray(actor.position); group.rotation.y = THREE.MathUtils.degToRad(actor.facing); this.actors.add(group);
    }
  }
  buildHelpers(project, selection, progress = 0, shot = null) {
    this.cameraHandles = [];
    for (const h of [...this.helpers.children]) dispose(h);
    for (const [index, c] of project.cameras.entries()) {
      const pose = sampleCamera(c, progress), selected = selection?.type === 'camera' && selection.id === c.id;
      const color = selected ? '#f4c88b' : '#748f9a';
      const group = new THREE.Group(); group.position.fromArray(pose.position); group.lookAt(v3(pose.target)); group.userData.select = { type: 'camera', id: c.id };
      const body = new THREE.Mesh(new THREE.BoxGeometry(.25, .19, .32), new THREE.MeshBasicMaterial({ color })); group.add(body);
      const lens = new THREE.Mesh(new THREE.CylinderGeometry(.08, .11, .15, 12), new THREE.MeshBasicMaterial({ color })); lens.rotation.x = Math.PI / 2; lens.position.z = .22; group.add(lens);
      const name = label(`${String(index + 1).padStart(2, '0')}  ${c.name}`, color); name.position.y = .45; group.add(name);
      layer(group); this.helpers.add(group);
      const helperCam = new THREE.PerspectiveCamera(pose.fov, 16 / 9, .15, selected ? 2.2 : .8);
      helperCam.position.fromArray(pose.position); helperCam.lookAt(v3(pose.target)); helperCam.updateMatrixWorld();
      const frustum = new THREE.CameraHelper(helperCam); frustum.setColors(new THREE.Color(color), new THREE.Color(color), new THREE.Color(color), new THREE.Color(color), new THREE.Color(color)); layer(frustum); this.helpers.add(frustum);
      const handles = { id: c.id, group, helperCam, frustum }; this.cameraHandles.push(handles);
      if (selected) {
        const target = new THREE.Mesh(new THREE.OctahedronGeometry(.10), new THREE.MeshBasicMaterial({ color: '#79c6c2', depthTest: false })); target.position.fromArray(pose.target); layer(target); this.helpers.add(target);
        const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([v3(pose.position), v3(pose.target)]), new THREE.LineDashedMaterial({ color: '#d8bb8a', dashSize: .12, gapSize: .08, transparent: true, opacity: .6 })); line.computeLineDistances(); layer(line); this.helpers.add(line);
        handles.target = target; handles.line = line;
      }
      if (c.mode !== 'static') {
        const points = Array.from({ length: 81 }, (_, i) => v3(sampleCamera(c, i / 80).position));
        const path = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), new THREE.LineBasicMaterial({ color, transparent: true, opacity: .95 })); layer(path); this.helpers.add(path);
        c.keyframes.forEach((k, i) => {
          const point = new THREE.Mesh(new THREE.SphereGeometry(.1, 10, 8), new THREE.MeshBasicMaterial({ color })); point.position.fromArray(k.position); point.userData.select = { type: 'camera', id: c.id, keyIndex: i }; layer(point); this.helpers.add(point);
        });
        const mid = points[40], dir = points[42].clone().sub(mid);
        if (dir.length() > .001) { const arrow = new THREE.ArrowHelper(dir.normalize(), mid, .55, color, .2, .12); layer(arrow); this.helpers.add(arrow); }
      }
    }
    for (const anchor of project.scene.anchors) {
      const item = new THREE.Mesh(new THREE.OctahedronGeometry(.10), new THREE.MeshBasicMaterial({ color: '#70b5b3' }));
      item.position.fromArray(anchor.position); item.userData.select = { type: 'anchor', id: anchor.id }; layer(item); this.helpers.add(item);
    }
    if (shot) for (const actor of project.actors) {
      const track = shot.blocking?.[actor.id];
      if (!shot.cast.includes(actor.id) || !track || track.length < 2) continue;
      const points = Array.from({ length: 49 }, (_, i) => v3(sampleTrack(track, i / 48).position));
      const path = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), new THREE.LineBasicMaterial({ color: actor.color, transparent: true, opacity: .9 })); layer(path); this.helpers.add(path);
      track.forEach(k => {
        const point = new THREE.Mesh(new THREE.SphereGeometry(.06, 10, 8), new THREE.MeshBasicMaterial({ color: actor.color })); point.position.fromArray(k.position); layer(point); this.helpers.add(point);
      });
      const mid = points[24], dir = points[26].clone().sub(mid);
      if (dir.length() > .001) { const arrow = new THREE.ArrowHelper(dir.normalize(), mid, .4, actor.color, .16, .09); layer(arrow); this.helpers.add(arrow); }
    }
  }
  setHandle(position, enabled) {
    if (this.dragging) return;
    if (enabled && position) { this.handle.position.fromArray(position); this.transform.attach(this.handle); }
    else this.transform.detach();
  }
  updateActors(project, shot, progress) {
    for (const group of this.actors.children) {
      const actor = project.actors.find(a => a.id === group.name);
      if (!actor) continue;
      group.visible = !shot || shot.cast.includes(actor.id);
      const track = shot?.blocking?.[actor.id];
      group.position.fromArray(track ? sampleTrack(track, progress).position : actor.position);
      group.rotation.y = THREE.MathUtils.degToRad(actor.facing);
    }
  }
  render(project, cameraData, shot, progress) {
    if (cameraData) {
      const p = sampleCamera(cameraData, progress); this.camera.position.fromArray(p.position); this.camera.fov = p.fov; this.camera.lookAt(v3(p.target)); this.camera.updateProjectionMatrix();
    }
    for (const handle of this.cameraHandles || []) {
      const data = project.cameras.find(c => c.id === handle.id); if (!data) continue;
      const pose = sampleCamera(data, progress); handle.group.position.fromArray(pose.position); handle.group.lookAt(v3(pose.target));
      handle.helperCam.position.fromArray(pose.position); handle.helperCam.lookAt(v3(pose.target)); handle.helperCam.fov = pose.fov; handle.helperCam.updateProjectionMatrix(); handle.helperCam.updateMatrixWorld(true); handle.frustum.update();
      if (handle.target) { handle.target.position.fromArray(pose.target); const pos = handle.line.geometry.attributes.position; pos.setXYZ(0, ...pose.position); pos.setXYZ(1, ...pose.target); pos.needsUpdate = true; handle.line.geometry.computeBoundingSphere(); handle.line.computeLineDistances(); }
    }
    this.updateActors(project, shot, progress); this.controls.update();
    this.renderer.render(this.scene, this.overview); this.film.render(this.scene, this.camera);
  }
  // Summary by default: the mesh list is the part that explodes on real models, so it
  // is reported as counts and fetched on demand with filters and paging.
  spatialData(project, options = {}) {
    const detail = options.detail === 'full' ? 'full' : 'summary';
    const total = this.meshIndex.length;
    const query = typeof options.meshQuery === 'string' ? options.meshQuery.trim().toLowerCase() : '';
    const group = typeof options.meshGroup === 'string' && options.meshGroup ? options.meshGroup : null;
    const limit = Math.min(200, Math.max(1, Number.isInteger(options.meshLimit) ? options.meshLimit : 50));
    const offset = Math.max(0, Number.isInteger(options.meshOffset) ? options.meshOffset : 0);
    let matched = this.meshIndex;
    if (group) matched = matched.filter(m => m.semanticGroup === group);
    if (query) matched = matched.filter(m => m.name.toLowerCase().includes(query));
    const sort = options.meshSort === 'name' ? 'name' : 'size';
    const meshes = { detail, total, matched: matched.length, offset, limit, sort,
      filters: { query: query || null, group }, returned: 0, items: [] };
    if (detail === 'full') {
      const ordered = [...matched].sort(sort === 'name' ? (a, b) => a.name.localeCompare(b.name) : (a, b) => b.volume - a.volume);
      meshes.items = ordered.slice(offset, offset + limit);
      meshes.returned = meshes.items.length;
      const next = offset + meshes.items.length;
      meshes.nextOffset = next < matched.length ? next : null;
      meshes.hint = meshes.nextOffset === null
        ? '已经返回全部匹配网格。'
        : `还有 ${matched.length - next} 个网格未返回；用 meshOffset=${meshes.nextOffset} 继续，或用 meshQuery / meshGroup 缩小范围。`;
    } else {
      meshes.groups = [...matched.reduce((counts, m) => counts.set(m.semanticGroup, (counts.get(m.semanticGroup) || 0) + 1), new Map())]
        .map(([id, count]) => ({ id, count })).sort((a, b) => b.count - a.count);
      meshes.hint = total
        ? `默认不列出 ${total} 个网格。需要具体网格时用 detail:"full"，并用 meshQuery 按名称、meshGroup 按语义分组过滤，meshLimit/meshOffset 分页。`
        : '模型没有网格。';
    }
    return {
      type: 'previzcam.spatial-context', version: 1,
      sceneId: project.scene.id, name: project.scene.name,
      format: project.format, aspect: 16 / 9,
      coordinates: { units: 'metres', handedness: 'right', up: '+Y', forward: '-Z', positions: 'world', angles: 'degrees', fov: 'vertical', keyframeTime: 'normalized 0..1 within each shot' },
      transform: project.scene.transform, bounds: { min: round(this.bounds.min.toArray()), max: round(this.bounds.max.toArray()) },
      objects: this.groups.map(g => ({ id: g.id, name: project.scene.annotations[g.id] || g.name, nodeCount: g.nodeNames.length, bounds: { min: round(g.box.min.toArray()), max: round(g.box.max.toArray()) }, note: '分组包围盒仅描述范围，不能当作实心障碍物；门洞可能位于范围内。' })),
      meshes,
      obstacleHints: this.solidBoxes.filter(s => !/roof|tile|ridge|eave|gable|cap/i.test(s.name)).map(s => ({ name: s.name, bounds: { min: round(s.box.min.toArray()), max: round(s.box.max.toArray()) }, approximation: '单个命名墙体或立柱的轴对齐包围盒，可能高估占据范围，不是完整碰撞地图。' })),
      anchors: project.scene.anchors, actors: project.actors, shots: project.shots, cameras: project.cameras,
      assumptions: ['语义分组由模型名称规则推断，请人工校正。', project.scene.calibration, '人物为占位模型，走位不表示精细表演。', '未提供可行走区域或完整碰撞网格，AI 候选轨迹必须回到网站检查。'],
      outputContract: { type: 'previzcam.camera-plan', version: 1, sceneId: project.scene.id, cameras: [{ id: 'CAM_NEW', name: '新机位', mode: 'static', locked: false, keyframes: [{ ...sampleCamera(project.cameras[0], 0), t: 0 }] }], assignments: project.shots.map(s => ({ shotId: s.id, cameraId: 'CAM_NEW' })) },
    };
  }
  validate(project) {
    const messages = policyWarnings(project); this.model.updateMatrixWorld(true);
    const ray = new THREE.Raycaster(); ray.layers.set(0);
    const add = (shotId, message, time, level = 'warning') => {
      if (!messages.some(m => m.shotId === shotId && m.message === message)) messages.push({ shotId, message, time, level });
    };
    const obstructed = (from, to) => {
      const direction = to.clone().sub(from), length = direction.length(); if (length < .01) return null;
      ray.set(from, direction.normalize()); ray.near = .02; ray.far = Math.max(.02, length - .04);
      return ray.intersectObjects(this.meshes, false)[0];
    };
    for (const shot of project.shots) {
      const c = project.cameras.find(item => item.id === shot.cameraId);
      const roughLength = Array.from({ length: 40 }, (_, i) => distance(sampleCamera(c, i / 40).position, sampleCamera(c, (i + 1) / 40).position)).reduce((a, b) => a + b, 0);
      const steps = c.mode === 'static' && !Object.keys(shot.blocking).length ? 1 : Math.min(300, Math.max(24, Math.ceil(roughLength / .1), Math.ceil(shot.duration * 5)));
      let last;
      for (let i = 0; i <= steps; i++) {
        const t = i / steps, pose = sampleCamera(c, t), position = v3(pose.position), time = +(t * shot.duration).toFixed(2);
        if (distance(pose.position, pose.target) < .05) add(shot.id, '相机位置与注视点过近，朝向可能跳变。', time, 'error');
        if (this.solidBoxes.some(s => s.box.containsPoint(position))) add(shot.id, '相机进入墙体或立柱的包围范围。', time, 'error');
        if (last && distance(last.position, pose.position) > .001) {
          const hit = obstructed(v3(last.position), position) || obstructed(position, v3(last.position));
          if (hit) add(shot.id, `相机路径穿过模型：${hit.object.name}`, time, 'error');
          if (distance(last.position, pose.position) / (shot.duration / steps) > 3) add(shot.id, '移动速度超过 3 m/s，请确认节奏。', time);
        }
        const probe = new THREE.PerspectiveCamera(pose.fov, 16 / 9, .05, 1000); probe.position.copy(position); probe.lookAt(v3(pose.target)); probe.updateMatrixWorld(true);
        for (const actor of project.actors.filter(a => shot.cast.includes(a.id))) {
          const base = shot.blocking[actor.id] ? sampleTrack(shot.blocking[actor.id], t).position : actor.position;
          const eye = v3(base).add(v3([0, actor.height * .9, 0])), chest = v3(base).add(v3([0, actor.height * .55, 0]));
          const ndc = eye.clone().project(probe);
          if (Math.abs(ndc.x) > .96 || Math.abs(ndc.y) > .96 || ndc.z < -1 || ndc.z > 1) add(shot.id, `${actor.name}头部接近画框边缘或出画。`, time);
          const headHit = obstructed(position, eye), bodyHit = obstructed(position, chest);
          if (headHit && bodyHit) add(shot.id, `${actor.name}被场景遮挡：${headHit.object.name}`, time, 'error');
          else if (headHit || bodyHit) add(shot.id, `${actor.name}部分被场景遮挡：${(headHit || bodyHit).object.name}`, time);
        }
        last = pose;
      }
    }
    return messages;
  }
}
