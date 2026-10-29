// draw3d · 3D 绘图编辑器
// 基础几何体 + 轮廓挤出建模 + 变换/材质编辑 + 关键帧动画（含视频导出）+ USDZ/GLB/OBJ/STL 模型导出
import * as THREE from "three";
import { OrbitControls } from "./vendor/controls/OrbitControls.js";
import { TransformControls } from "./vendor/controls/TransformControls.js";
import { GLTFExporter } from "./vendor/exporters/GLTFExporter.js";
import { OBJExporter } from "./vendor/exporters/OBJExporter.js";
import { STLExporter } from "./vendor/exporters/STLExporter.js";
import { USDZExporter } from "./vendor/exporters/USDZExporter.js";
import { Muxer, ArrayBufferTarget } from "./vendor/libs/mp4-muxer.mjs";
import { LineSegments2 } from "./vendor/lines/LineSegments2.js";
import { Line2 } from "./vendor/lines/Line2.js";
import { LineGeometry } from "./vendor/lines/LineGeometry.js";
import { LineSegmentsGeometry } from "./vendor/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "./vendor/lines/LineMaterial.js";
// 抽出的纯函数模块（无场景状态）：文字轮廓引擎、几何处理、随机扰动数学
import { Brush, Evaluator, SUBTRACTION } from "./vendor/libs/three-bvh-csg.module.js";
import {
  textCanvas, textToShapes,
  collectFaceTriangles, offsetPositions, trimGeometryForFaces,
  jitterOffset, strokeSegmentsToTubes,
  faceBasis, paintGroups, renderPaintCanvas, textStrokeSize,
  textureCanvas, lineCurvePoints, polylineToSegments,
} from "./main.js";
import { initScriptMode } from "./script.js";

var $ = function (id) { return document.getElementById(id); };

// 莫兰迪物体配色，新物体依次取色
var OBJECT_COLORS = ["#A8B5A2", "#C2A9A1", "#9FB0BE", "#C9BC9C", "#A99FB5", "#8FA5A3"];
var KIND_LABELS = { box: "立方体", sphere: "球体", cylinder: "圆柱", cone: "圆锥", torus: "圆环", plane: "平面板", extrude: "挤出体", text3d: "立体文字", text2d: "贴面文字", group: "组合", csg: "布尔体", line: "线条", trough: "水槽" };
var STORAGE_KEY = "draw3d-scene";
var DEFAULT_TRANSITION = 1.5; // 关键帧默认过渡秒数

// ---------- 基础工具 ----------

var toastTimer = null;
function toast(msg) {
  var t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { t.classList.remove("show"); }, 2600);
}

function download(blob, filename) {
  var a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
}

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

// ---------- 场景 ----------

var viewport = $("viewport");
var renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.VSMShadowMap; // VSM 支持真实模糊（shadow.radius）
viewport.appendChild(renderer.domElement);

var scene = new THREE.Scene();
// 背景、雾、地面、阴影都由「场景显示」设置驱动，见 applyViewSettings()
var GROUND_CLEAR = 0xE7E4DD;
var sceneFog = new THREE.Fog("#E7E4DD", 40, 90);

var camera = new THREE.PerspectiveCamera(50, 1, 0.1, 200);
camera.position.set(6, 5, 8);

var controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.target.set(0, 0.6, 0);

// 三光布置（按"渲染色≈材质色"实测校准，整体亮度随「光照强度」滑杆等比缩放）：
// 半球光=基础量；主平行光（右前上，方向刻意偏 x）+ 侧向补光（左后上）——
// 四个侧面朝向不同光源、亮度各异，棱角清晰可辨
var hemiLight = new THREE.HemisphereLight(0xffffff, 0xd8d5cd, 1.95);
scene.add(hemiLight);
var dirLight = new THREE.DirectionalLight(0xffffff, 1.05);
var fillLight = new THREE.DirectionalLight(0xfff6e8, 0.42);
fillLight.position.set(-5, 7, -9);
scene.add(fillLight);
dirLight.position.set(8, 14, 6);
dirLight.castShadow = true;
dirLight.shadow.mapSize.set(2048, 2048);
dirLight.shadow.camera.left = -18;
dirLight.shadow.camera.right = 18;
dirLight.shadow.camera.top = 18;
dirLight.shadow.camera.bottom = -18;
dirLight.shadow.bias = -0.0002;
dirLight.shadow.blurSamples = 12;
scene.add(dirLight);

// 平面无填充，只显示轴线和网格；地面网格仅作为隐形接影面存在
var shadowOnlyMaterial = new THREE.ShadowMaterial({ opacity: 0.28 });
var ground = new THREE.Mesh(new THREE.PlaneGeometry(120, 120), shadowOnlyMaterial);
ground.rotation.x = -Math.PI / 2;
ground.position.y = -0.001;
ground.receiveShadow = true;
scene.add(ground);
// 粗一点，颜色深一点
var grid = new THREE.GridHelper(40, 40, 0x000000, 0xFFFFFF);
scene.add(grid);

// 屏幕空间背景幕布：正交相机单独一层，16:9 居中，不随主相机转动
var bgScene = new THREE.Scene();
var bgCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
var bgMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial({ toneMapped: false }));
bgMesh.visible = false;
bgScene.add(bgMesh);
var bgTexture = null;

// 用户物体统一放在 content 组里：模型导出、关键帧、序列化都只针对它
var content = new THREE.Group();
content.name = "draw3d";
scene.add(content);

var tc = new TransformControls(camera, renderer.domElement);
scene.add(tc.getHelper());

// 随机扰动范围可视化：仅选中且启用扰动时显示，播放/导出前会取消选中，因此不会进视频
var jitterHelper = new THREE.LineSegments(
  new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)),
  new THREE.LineBasicMaterial({ color: "#B98E84" })
);
jitterHelper.visible = false;
scene.add(jitterHelper);

function resize() {
  var w = viewport.clientWidth, h = viewport.clientHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  updateBgLayout();
  updateLineResolutions(w, h); // fat-lines 线宽按像素计
}
new ResizeObserver(resize).observe(viewport);
resize();

// 手动清屏 + 先画背景层再画主场景；实时录制与离线导出复用同一渲染序列
renderer.autoClear = false;
function renderFrame() {
  renderer.setClearColor(view.ground && !bgTexture ? GROUND_CLEAR : 0xffffff);
  renderer.clear();
  if (bgTexture) {
    renderer.render(bgScene, bgCamera);
    renderer.clearDepth();
  }
  renderer.render(scene, camera);
}
// ---------- 视角快切：正 / 侧 / 顶 / 斜 45°，短动画过渡 ----------
var VIEW_DIRS = {
  front: new THREE.Vector3(0, 0, 1),                    // 正视：从前方平视
  side: new THREE.Vector3(1, 0, 0),                     // 侧视：从右侧平视
  top: new THREE.Vector3(0.02, 1, 0).normalize(),       // 俯视：正上方（微偏避开极点奇异）
  iso: new THREE.Vector3(6, 4.4, 8).normalize(),        // 斜 45°：与启动默认视角一致
};
var viewTween = null;

function switchView(name) {
  if (sketching || playback || exporting) return; // 画板/播放/导出期间视角被各自流程接管
  var dist = camera.position.distanceTo(controls.target);
  var fromDir = camera.position.clone().sub(controls.target).normalize();
  var toDir = VIEW_DIRS[name];
  var t0 = performance.now();
  viewTween = function (now) {
    var k = Math.min(1, (now - t0) / 280);
    k = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2; // easeInOutQuad
    // 方向插值后归一再放回原距离：绕目标球面转过去，中途不穿越目标
    var dir = fromDir.clone().lerp(toDir, k).normalize();
    camera.position.copy(controls.target).addScaledVector(dir, dist);
    if (k >= 1) viewTween = null;
  };
}

document.querySelectorAll("#view-switch button").forEach(function (b) {
  b.addEventListener("click", function () { switchView(b.dataset.view); });
});

window.__actDbg = function () {
  return {
    layersTabHeaders: Array.prototype.map.call(document.querySelectorAll("#tab-layers section h2"), function (h) { return h.childNodes[0].textContent.trim(); }),
    sceneTabHeaders: Array.prototype.map.call(document.querySelectorAll("#tab-scene section h2"), function (h) { return h.childNodes[0].textContent.trim(); }),
    activeKf: activeKf,
    actions: (activeKf !== -1 && keyframes[activeKf]) ? keyframes[activeKf].actions : null,
    timelineDuration: typeof timelineDuration === "function" ? timelineDuration() : null,
    applyTimelineAt: typeof applyTimelineAt === "function" ? applyTimelineAt : null,
    playbackPhase: playback ? (playback.actionState ? "actions" : "transition") : null,
    objPos: function (id) { var o = findTopObject(id); return o ? o.position.toArray().map(function (x) { return +x.toFixed(3); }) : null; },
    objScale: function (id) { var o = findTopObject(id); return o ? o.scale.toArray().map(function (x) { return +x.toFixed(3); }) : null; },
    objOpacity: function (id) { var o = findTopObject(id); return o && o.material ? +o.material.opacity.toFixed(3) : null; },
    objEmissive: function (id) { var o = findTopObject(id); return o && o.material && o.material.emissive ? +o.material.emissiveIntensity.toFixed(3) : null; },
    objStrokeColor: function (id) { var o = findTopObject(id), c = null; if (o) o.traverse(function (x) { if (!c && x.userData && x.userData.helper === "stroke") c = "#" + x.material.color.getHexString(); }); return c; },
    activeTab: function () { var t = document.querySelector(".panel .tab.active"); return t ? t.getAttribute("data-tab") : null; },
  };
};
renderer.setAnimationLoop(function () {
  if (exporting) return; // 离线导出期间由导出流程自己驱动渲染
  if (isActiveFrameLocked()) controls.enabled = false; // 只拦不放：见 isActiveFrameLocked 旁注释
  if (playback) stepPlayback();
  if (nextStep) stepNextStep();
  if (viewTween) viewTween(performance.now());
  scaleLineHandles();
  controls.update();
  updateJitterHelper();
  updateSelectionOutlines();
  // 扰动只在渲染瞬间临时叠加、渲染后立即还原，物体真实坐标始终干净；「下一步」的单段过渡
  // 跟完整播放共用同一份预览效果（水面流动、扰动），播放中的那个时钟对象叫什么字段都行，
  // 只要有 globalStart 就能算经过时间
  var previewClock = playback || nextStep;
  if (previewClock) applyJitterForRender((performance.now() - previewClock.globalStart) / 1000);
  if (previewClock) updateFlowTextures((performance.now() - previewClock.globalStart) / 1000); // 水面流动仅播放/下一步时
  renderFrame();
  if (recordCopy) recordCopy(); // 实时录制兜底：把 16:9 区域拷贝到导出画布
  restoreJitter();
});

// ---------- 随机扰动（仅播放/导出时生效） ----------

function ensureJitter(obj) {
  if (!obj.userData.jitter) {
    obj.userData.jitter = { enabled: false, box: [0.3, 0.3, 0.3], speed: 1, randomness: 0.5 };
  }
  return obj.userData.jitter;
}

var _jitterSaved = [];
var _jitterOff = new THREE.Vector3();

function applyJitterForRender(t) {
  content.children.forEach(function (o) {
    var j = o.userData.jitter;
    if (!j || !j.enabled) return;
    _jitterSaved.push({ o: o, x: o.position.x, y: o.position.y, z: o.position.z });
    o.position.add(jitterOffset(o, t, _jitterOff));
  });
}

function restoreJitter() {
  for (var i = 0; i < _jitterSaved.length; i++) {
    var s = _jitterSaved[i];
    s.o.position.set(s.x, s.y, s.z);
  }
  _jitterSaved.length = 0;
}

function updateJitterHelper() {
  var j = selection.length === 1 && selected && selected.userData.jitter;
  var show = !!(j && j.enabled) && !playback && !exporting && !drawing && !sketching;
  jitterHelper.visible = show;
  if (!show) return;
  jitterHelper.position.copy(selected.position);
  jitterHelper.scale.set(
    Math.max(0.01, j.box[0] * 2),
    Math.max(0.01, j.box[1] * 2),
    Math.max(0.01, j.box[2] * 2)
  );
}

// ---------- 场景显示设置（阴影 / 平面 / 背景图） ----------

var VIEW_KEY = "draw3d-view";
var DEFAULT_BG = "PPTbackground.jpeg"; // 项目目录内的默认背景图
// bg: "default"（默认图）| "none"（纯白）| dataURL（用户上传）
var view = { shadow: true, ground: true, bg: "default", anchor: "center", fps: 60, res: "1080", lightCfg: { intensity: 1, gloss: 0.25 }, shadowCfg: { intensity: 0.28, blur: 0.35, dist: 0.45 } };

function applyViewSettings() {
  renderer.shadowMap.enabled = view.shadow;
  dirLight.castShadow = view.shadow;
  grid.visible = view.ground;
  ground.visible = view.shadow; // 地面只承担接影，无填充
  scene.fog = (view.ground && !bgTexture) ? sceneFog : null;
  // 切换 shadowMap 后需要重编译材质着色器，否则旧阴影残留
  scene.traverse(function (o) { if (o.material) o.material.needsUpdate = true; });
  $("opt-shadow").checked = view.shadow;
  $("shadow-config").hidden = !view.shadow;
  var lc = view.lightCfg;
  hemiLight.intensity = 1.95 * lc.intensity;
  dirLight.intensity = 1.05 * lc.intensity;
  fillLight.intensity = 0.42 * lc.intensity;
  $("light-int").value = lc.intensity;
  $("light-int-val").textContent = lc.intensity.toFixed(2);
  $("light-gloss").value = lc.gloss;
  $("light-gloss-val").textContent = lc.gloss.toFixed(2);
  var sc = view.shadowCfg;
  shadowOnlyMaterial.opacity = sc.intensity;
  dirLight.shadow.radius = sc.blur * 12;             // VSM 模糊半径：0=完全锐利，2=极度弥散
  dirLight.position.set(10, 30 - 24 * sc.dist, 3);   // 灯位越低影子越长；x/z 差大→侧面明暗分明
  $("shadow-int").value = sc.intensity;
  $("shadow-int-val").textContent = sc.intensity.toFixed(2);
  $("shadow-blur").value = sc.blur;
  $("shadow-blur-val").textContent = sc.blur.toFixed(2);
  $("shadow-dist").value = sc.dist;
  $("shadow-dist-val").textContent = sc.dist.toFixed(2);
  $("opt-ground").checked = view.ground;
  $("prop-anchor").value = view.anchor || "center";
  $("record-fps").value = view.fps || 60;
  $("record-res").value = view.res || "1080";
}

function saveViewSettings() {
  try {
    localStorage.setItem(VIEW_KEY, JSON.stringify(view));
  } catch (e) {
    toast("背景图片较大，本次生效但无法保存到浏览器");
  }
}

var exportRect = { x: 0, y: 0, w: 16, h: 9 }; // 16:9 导出区域（CSS 像素，视口居中 contain）

function updateBgLayout() {
  var w = viewport.clientWidth || 1, h = viewport.clientHeight || 1;
  var canvasAspect = w / h, screenAspect = 16 / 9;
  // 幕布保持 16:9 完整居中（contain），露出的边为纯白
  if (canvasAspect >= screenAspect) bgMesh.scale.set(screenAspect / canvasAspect, 1, 1);
  else bgMesh.scale.set(1, canvasAspect / screenAspect, 1);
  // 导出区域与幕布同一块 16:9：更新虚线指示框（DOM 层，不会进画布像素）
  var fw = Math.min(w, h * screenAspect);
  var fh = fw / screenAspect;
  exportRect = { x: (w - fw) / 2, y: (h - fh) / 2, w: fw, h: fh };
  var frame = $("export-frame");
  frame.style.left = exportRect.x + "px";
  frame.style.top = exportRect.y + "px";
  frame.style.width = exportRect.w + "px";
  frame.style.height = exportRect.h + "px";
  // 图片在幕布内按 cover 居中裁切，不变形
  if (bgTexture && bgTexture.image) {
    var imgAspect = bgTexture.image.width / bgTexture.image.height;
    if (imgAspect >= screenAspect) {
      bgTexture.repeat.set(screenAspect / imgAspect, 1);
      bgTexture.offset.set((1 - screenAspect / imgAspect) / 2, 0);
    } else {
      bgTexture.repeat.set(1, imgAspect / screenAspect);
      bgTexture.offset.set(0, (1 - imgAspect / screenAspect) / 2);
    }
  }
}

function setBackground(mode) {
  if (bgTexture) { bgTexture.dispose(); bgTexture = null; }
  bgMesh.visible = false;
  view.bg = mode || "none";
  applyViewSettings();
  saveViewSettings();
  if (view.bg === "none") return;
  var url = view.bg === "default" ? DEFAULT_BG : view.bg;
  new THREE.TextureLoader().load(url, function (tex) {
    tex.colorSpace = THREE.SRGBColorSpace;
    bgTexture = tex;
    bgMesh.material.map = tex;
    bgMesh.material.needsUpdate = true;
    bgMesh.visible = true;
    updateBgLayout();
    applyViewSettings(); // 雾的开关依赖 bgTexture 状态
  }, undefined, function () {
    view.bg = "none";
    applyViewSettings();
    toast("背景图片加载失败");
  });
}

$("opt-shadow").addEventListener("change", function () {
  view.shadow = this.checked;
  applyViewSettings();
  saveViewSettings();
});
$("opt-ground").addEventListener("change", function () {
  view.ground = this.checked;
  applyViewSettings();
  saveViewSettings();
});
$("light-int").addEventListener("input", function () {
  view.lightCfg.intensity = parseFloat(this.value);
  applyViewSettings();
});
$("light-int").addEventListener("change", saveViewSettings);
$("light-gloss").addEventListener("input", function () {
  view.lightCfg.gloss = parseFloat(this.value);
  content.traverse(function (c) { if (c.isMesh && c.userData && c.userData.id != null) applyTexture(c); });
  applyViewSettings();
});
$("light-gloss").addEventListener("change", saveViewSettings);
[["shadow-int", "intensity"], ["shadow-blur", "blur"], ["shadow-dist", "dist"]].forEach(function (p) {
  $(p[0]).addEventListener("input", function () {
    view.shadowCfg[p[1]] = parseFloat(this.value);
    applyViewSettings();
  });
  $(p[0]).addEventListener("change", saveViewSettings);
});
$("btn-bg-pick").addEventListener("click", function () { $("bg-file").click(); });
$("btn-bg-default").addEventListener("click", function () {
  setBackground("default");
  toast("已使用默认背景图");
});
$("btn-bg-white").addEventListener("click", function () {
  setBackground("none");
  toast("已切换为纯白背景");
});
$("bg-file").addEventListener("change", function () {
  var file = this.files && this.files[0];
  this.value = "";
  if (!file) return;
  if (file.size > 8 * 1024 * 1024) { toast("图片不能超过 8MB"); return; }
  var reader = new FileReader();
  reader.onload = function () {
    setBackground(reader.result);
    toast("背景图片已设置");
  };
  reader.onerror = function () { toast("读取图片失败"); };
  reader.readAsDataURL(file);
});
$("record-fps").addEventListener("change", function () {
  view.fps = Math.min(120, Math.max(10, parseInt(this.value, 10) || 60));
  this.value = view.fps;
  saveViewSettings();
});
$("record-res").addEventListener("change", function () {
  view.res = this.value === "4k" ? "4k" : "1080";
  saveViewSettings();
});

// 右侧面板 tab 切换；选中物体时自动跳到「属性」
function selectTab(id) {
  document.querySelectorAll(".panel .tab").forEach(function (b) {
    b.classList.toggle("active", b.getAttribute("data-tab") === id);
  });
  document.querySelectorAll(".panel .tab-page").forEach(function (p) {
    p.classList.toggle("active", p.id === id);
  });
}
document.querySelectorAll(".panel .tab").forEach(function (b) {
  b.addEventListener("click", function () { selectTab(b.getAttribute("data-tab")); });
});

// ---------- 物体边框 / 面样式（fat-lines 支持像素级线宽与虚线） ----------

function ensureStroke(mesh) {
  if (!mesh.userData.stroke) {
    mesh.userData.stroke = { enabled: false, color: "#43423D", width: 2, style: "solid" };
  }
  return mesh.userData.stroke;
}

function lineStyleParams(style) {
  if (style === "dashed") return { dashed: true, dashSize: 0.12, gapSize: 0.08 };
  if (style === "dotted") return { dashed: true, dashSize: 0.02, gapSize: 0.07 };
  return { dashed: false, dashSize: 1, gapSize: 0 };
}

function buildLineMaterial(cfg) {
  var p = lineStyleParams(cfg.style);
  var m = new LineMaterial({
    color: new THREE.Color(cfg.color).getHex(),
    linewidth: cfg.width,
    dashed: p.dashed,
    dashSize: p.dashSize,
    gapSize: p.gapSize,
  });
  m.resolution.set(viewport.clientWidth || 1, viewport.clientHeight || 1);
  return m;
}

// LineMaterial 线宽以像素计，依赖画布分辨率；resize 与离线导出时都要刷新
function updateLineResolutions(w, h) {
  content.traverse(function (c) {
    if (c.material && c.material.isLineMaterial) c.material.resolution.set(w, h);
  });
}

function removeHelperChildren(obj, kinds) {
  obj.children.slice().forEach(function (c) {
    if (c.userData && kinds.indexOf(c.userData.helper) !== -1) {
      obj.remove(c);
      if (c.geometry) c.geometry.dispose();
      if (c.material) {
        if (c.material.map) c.material.map.dispose(); // 涂画贴图随覆层释放
        c.material.dispose();
      }
    }
  });
}

// 物体边框：几何硬边（>20°折角）描线
function applyStroke(mesh) {
  if (!mesh.isMesh || mesh.userData.kind === "line") return; // 线条本身就是线，无边框
  removeHelperChildren(mesh, ["stroke"]);
  var s = mesh.userData.stroke;
  if (!s || !s.enabled) return;
  // 用基础几何算边框：保持完整轮廓，不受面剔除影响
  var edges = new THREE.EdgesGeometry(mesh.userData.baseGeo || mesh.geometry, 20);
  if (!edges.attributes.position || !edges.attributes.position.count) { edges.dispose(); return; }
  var geo = new LineSegmentsGeometry().fromEdgesGeometry(edges);
  edges.dispose();
  var line = new LineSegments2(geo, buildLineMaterial(s));
  line.computeLineDistances();
  line.userData = { helper: "stroke", baseColor: s.color }; // baseColor：闪烁动作把描线调亮后靠它复位
  line.raycast = function () {}; // 不参与拾取
  mesh.add(line);
}

// 设置网格几何：保存基础几何为唯一真值，显示几何随面样式重建
function setMeshGeometry(mesh, geo) {
  if (mesh.userData.baseGeo && mesh.userData.baseGeo !== geo) mesh.userData.baseGeo.dispose();
  if (mesh.geometry && mesh.geometry !== mesh.userData.baseGeo && mesh.geometry !== geo) mesh.geometry.dispose();
  mesh.userData.baseGeo = geo;
  refreshDecorations(mesh);
}

// 面样式：从基础几何重建覆层网格与边界描线，并把显示几何换成剔面后的版本
function applyFaceStyles(mesh) {
  if (!mesh.isMesh) return;
  removeHelperChildren(mesh, ["face", "face-stroke"]);
  var base = mesh.userData.baseGeo || mesh.geometry;
  var faces = mesh.userData.faces || [];
  // 显示几何：剔除样式/删除面的原三角形（半透明覆层与空洞才能透出后方）
  var display = trimGeometryForFaces(base, faces);
  if (mesh.geometry && mesh.geometry !== base && mesh.geometry !== display) mesh.geometry.dispose();
  mesh.geometry = display;
  faces.forEach(function (f, fi) {
    if (f.deleted) return; // 删除面：只留空洞，不加覆层
    var data = collectFaceTriangles(base, f.n, f.d);
    if (!data.count) return;
    var g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(offsetPositions(data.positions, f.n, 0.002), 3));
    g.computeVertexNormals();
    // 面局部 uv（基向量投影归一），供面纹理贴图
    var fb = faceBasis(f.n);
    var fuv = [], fp = new THREE.Vector3();
    var fuMin = Infinity, fuMax = -Infinity, fvMin = Infinity, fvMax = -Infinity;
    for (var fvi = 0; fvi < data.positions.length; fvi += 3) {
      fp.set(data.positions[fvi], data.positions[fvi + 1], data.positions[fvi + 2]).sub(data.centroid);
      var fu = fp.dot(fb.U), fv = fp.dot(fb.V);
      fuv.push(fu, fv);
      fuMin = Math.min(fuMin, fu); fuMax = Math.max(fuMax, fu);
      fvMin = Math.min(fvMin, fv); fvMax = Math.max(fvMax, fv);
    }
    var fur = Math.max(fuMax - fuMin, 1e-6), fvr = Math.max(fvMax - fvMin, 1e-6);
    var fuvArr = new Float32Array(fuv.length);
    for (var fk = 0; fk < fuv.length; fk += 2) {
      fuvArr[fk] = (fuv[fk] - fuMin) / fur;
      fuvArr[fk + 1] = (fuv[fk + 1] - fvMin) / fvr;
    }
    g.setAttribute("uv", new THREE.Float32BufferAttribute(fuvArr, 2));
    var decal = new THREE.Mesh(g, new THREE.MeshStandardMaterial({
      color: f.color, roughness: 0.65, metalness: 0.05,
      transparent: f.opacity < 1, opacity: f.opacity,
      depthWrite: f.opacity >= 1,
      side: THREE.DoubleSide,
    }));
    if (f.texture) applyTextureToMaterial(decal.material, f.texture, true, f.opacity);
    decal.userData = { helper: "face", faceIndex: fi }; // 记录下标供选面时回选
    mesh.add(decal);
    if (f.stroke && f.stroke.enabled && data.boundary.length) {
      var lg = new LineSegmentsGeometry();
      lg.setPositions(offsetPositions(data.boundary, f.n, 0.006));
      var line = new LineSegments2(lg, buildLineMaterial(f.stroke));
      line.computeLineDistances();
      line.userData = { helper: "face-stroke", baseColor: f.stroke.color }; // baseColor：闪烁动作调亮后靠它复位
      line.raycast = function () {};
      mesh.add(line);
    }
  });
}

function refreshDecorations(mesh) {
  if (mesh.userData && mesh.userData.kind === "line") return; // 线条无边框/面样式/涂画
  applyStroke(mesh);
  applyFaceStyles(mesh);
  applySketch(mesh);
  // 选中态描边贴的是几何硬边，水槽壁厚/底厚、线条端点这类编辑会重建几何（rebuildTrough/
  // rebuildLine），不刷新的话描边还停在旧形状上；这类重建只发生在该物体是当前唯一选中时
  if (mesh === selected) applySelOutline(mesh, true, true);
}

// ---------- 物体创建 / 序列化 ----------

var seq = 0;            // 持久物体 ID 计数：撤销/关键帧/存档都以它对齐
var selection = [];     // 全部选中的物体
var selected = null;    // 主选中（= selection 最后一个）：属性面板与变换手柄的对象
var keyframes = [];

// ---------- 场景：每个场景独立拥有一整套图层/物体/关键帧动画/撤销历史 ----------
// 当前场景的内容"活"在下面的 content/layers/keyframes/undoStack 等全局状态里，跟没有多场景
// 概念之前完全一样；切走的场景整份数据存进 sceneStore，只有元数据（id/名字）留在 scenes 里
var scenes = [{ id: 1, name: "场景 1" }];
var activeSceneId = 1;
var sceneSeq = 1;      // 场景 id 计数，用它拼名字不会因为删过场景而撞车
var sceneStore = {};   // { [id]: serialize() 结果 }：非活跃场景的完整数据
var sceneUndo = {};    // { [id]: { stack, index } }：每个场景独立撤销历史，仅本次会话有效（跟撤销栈本身的规则一致，刷新页面就重置）

// ---------- 图层：每个 content 直属物体归属一个图层，可整层选中/显隐/锁定/增删 ----------
var layers = [{ id: 1, name: "图层 1", visible: true, locked: false }];
var layerSeq = 1;          // 图层 id 计数
var activeLayerId = 1;     // 当前图层：新建物体归入此层

function findLayer(id) {
  for (var i = 0; i < layers.length; i++) if (layers[i].id === id) return layers[i];
  return null;
}
// 关键帧存在性与图层显隐是两套独立的可见性开关，取交集：
// 图层隐藏 → 一定不可见；帧里不存在该物体 → 也一定不可见；两者都满足才显示
function layerVisibleOf(o) {
  var l = findLayer(o.userData.layer);
  return !l || l.visible;
}
function objVisibleForFrame(o, existsInFrame) {
  return existsInFrame && layerVisibleOf(o);
}
function ensureObjectLayer(o) {
  if (!findLayer(o.userData.layer)) o.userData.layer = layers[0].id; // 无效/缺失归到首层
  return o.userData.layer;
}
function objectsInLayer(id) {
  return content.children.filter(function (o) { return o.userData.layer === id; });
}
// 归到 content 直属层级（组合成员/贴附文字上溯到顶层物体）
function topLevelOf(o) {
  while (o.parent && o.parent !== content) o = o.parent;
  return o;
}
// 物体是否可选中/操作：所属图层需可见且未锁定，且当前定位的帧本身没被锁定
function isSelectable(o) {
  if (isActiveFrameLocked()) return false;
  var top = topLevelOf(o);
  var l = findLayer(top.userData.layer);
  return !!(l && l.visible && !l.locked);
}

// 水槽：镂空立方体，外壳边长与 box 基准一致（1.2），靠 CSG 相减挖空——外壳减去一个四周
// 收进"壁厚"、顶部一定敞口（顶部本就没有盖）、底部从"底厚"这个高度往上一路挖穿的内腔。
// 壁厚/底厚是局部单位（随物体整体缩放等比例变化，跟其他形体"尺寸靠 scale 缩放"的规则一致）。
var TROUGH_SIZE = 1.2;
var TROUGH_WALL_DEFAULT = 0.18;
var TROUGH_BOTTOM_DEFAULT = 0.18;
function buildTroughGeometry(params) {
  var p = params || {};
  var half = TROUGH_SIZE / 2;
  var wall = Math.min(Math.max(p.wall != null ? p.wall : TROUGH_WALL_DEFAULT, 0.02), half - 0.02);
  var bottom = Math.min(Math.max(p.bottom != null ? p.bottom : TROUGH_BOTTOM_DEFAULT, 0), TROUGH_SIZE - 0.1);
  var outer = new THREE.BoxGeometry(TROUGH_SIZE, TROUGH_SIZE, TROUGH_SIZE);
  var innerYMin = -half + bottom, innerYMax = half + 0.05; // 顶部略超出，确保挖穿不留顶盖
  var innerH = innerYMax - innerYMin;
  var inner = new THREE.BoxGeometry(TROUGH_SIZE - wall * 2, innerH, TROUGH_SIZE - wall * 2);
  inner.translate(0, (innerYMin + innerYMax) / 2, 0);
  var brushA = new Brush(outer), brushB = new Brush(inner);
  brushA.updateMatrixWorld(true);
  brushB.updateMatrixWorld(true);
  var evaluator = new Evaluator();
  evaluator.attributes = ["position", "normal"]; // 无 uv：与"布尔体"一致，纹理系统已兼容跳过贴图
  var result = evaluator.evaluate(brushA, brushB, SUBTRACTION);
  outer.dispose();
  inner.dispose();
  var g = result.geometry;
  if (g.index) g = g.toNonIndexed();
  if (!g.attributes.normal) g.computeVertexNormals();
  return g;
}
// 壁厚/底厚变更后重建几何（不影响 mesh.scale/位置/材质/贴画等其余状态）
function rebuildTrough(obj) {
  var g = buildTroughGeometry(obj.userData.params);
  if (obj.geometry) obj.geometry.dispose();
  obj.geometry = g;
  obj.userData.baseGeo = g;
  if (obj === selected) applySelOutline(obj, true, true); // 几何变了，选中描边跟着重贴，不然停在旧形状
}

function buildGeometry(kind, params) {
  switch (kind) {
    case "box": return new THREE.BoxGeometry(1.2, 1.2, 1.2);
    case "trough": return buildTroughGeometry(params);
    case "sphere": return new THREE.SphereGeometry(0.75, 48, 32);
    case "cylinder": return new THREE.CylinderGeometry(0.6, 0.6, 1.4, 48);
    case "cone": return new THREE.ConeGeometry(0.7, 1.4, 48);
    case "torus": return new THREE.TorusGeometry(0.65, 0.24, 24, 64);
    case "plane": return new THREE.BoxGeometry(1.8, 0.06, 1.3);
    case "text3d": {
      var shapes = textToShapes(params.text || "文字");
      if (!shapes.length) throw new Error("无法从文字生成轮廓");
      var tg = new THREE.ExtrudeGeometry(shapes, { depth: params.depth || 0.25, bevelEnabled: false, curveSegments: 8 });
      tg.center(); // 居中后由 restOnGround 落地，文字立面朝 +Z（界面 Y 方向）
      return tg;
    }
    case "text2d": {
      var c = textCanvas(params.text || "文字", 128, 6);
      return new THREE.PlaneGeometry(c.width / c.height, 1);
    }
    case "extrude": {
      var shape = new THREE.Shape();
      if (params.path) {
        // 新格式：顶点数组，每个顶点可带 cp（到下一顶点这条边的二次贝塞尔控制点）
        var path = params.path;
        shape.moveTo(path[0].x, path[0].y);
        for (var i = 0; i < path.length; i++) {
          var a = path[i], b = path[(i + 1) % path.length];
          if (a.cp) shape.quadraticCurveTo(a.cp[0], a.cp[1], b.x, b.y);
          else shape.lineTo(b.x, b.y);
        }
      } else {
        // 兼容旧存档：纯直线多边形
        params.points.forEach(function (p, i) {
          if (i) shape.lineTo(p[0], p[1]); else shape.moveTo(p[0], p[1]);
        });
      }
      // curveSegments 默认仅 12，曲线边会有明显棱边；64 段后弦高误差缩小两个数量级，视觉上即纯弧
      var geo = new THREE.ExtrudeGeometry(shape, { depth: params.depth, bevelEnabled: false, curveSegments: 64 });
      geo.rotateX(-Math.PI / 2); // 轮廓画在地面 XZ，挤出方向转为 +Y
      return geo;
    }
    case "csg": {
      // 布尔运算结果：从存储的扁平数组重建（非索引）
      var cg = new THREE.BufferGeometry();
      cg.setAttribute("position", new THREE.Float32BufferAttribute(params.geo.position, 3));
      if (params.geo.normal) cg.setAttribute("normal", new THREE.Float32BufferAttribute(params.geo.normal, 3));
      else cg.computeVertexNormals();
      return cg;
    }
  }
}

// 线条物体：Line2 胖线（世界单位线宽，非圆柱几何）；params = { pts:[{p,smooth}], width }
function createLineObject(params, id) {
  if (id == null) id = ++seq; else seq = Math.max(seq, id);
  var mat = new LineMaterial({
    color: OBJECT_COLORS[(id - 1) % OBJECT_COLORS.length],
    linewidth: Math.max(0.5, params.width || 4) * 0.01,
    worldUnits: true, // 世界单位：像真实的"有粗细的棒子"
  });
  mat.resolution.set(viewport.clientWidth || 1, viewport.clientHeight || 1);
  var geo = new LineGeometry();
  geo.setPositions(lineCurvePoints(params.pts));
  var line = new Line2(geo, mat);
  line.computeLineDistances();
  line.name = "obj_" + id;
  line.userData = { id: id, kind: "line", params: params, baseGeo: geo, layer: activeLayerId, opacity: 1 };
  content.add(line);
  return line;
}

// 节点变动后重建线条几何与手柄
function rebuildLine(obj) {
  var g = new LineGeometry();
  g.setPositions(lineCurvePoints(obj.userData.params.pts));
  if (obj.geometry) obj.geometry.dispose();
  obj.geometry = g;
  obj.userData.baseGeo = g;
  obj.computeLineDistances();
  refreshLineHandles();
}

function createObject(kind, params, id) {
  if (kind === "line") return createLineObject(params, id);
  if (id == null) id = ++seq; else seq = Math.max(seq, id);
  // 双面材质：删除/透明某面后往里看，对面内壁仍显示同色（单面会因背面剔除而"透明"）
  var material = new THREE.MeshStandardMaterial({
    color: OBJECT_COLORS[(id - 1) % OBJECT_COLORS.length],
    roughness: 0.65,
    metalness: 0.05,
    side: THREE.DoubleSide,
  });
  if (kind === "text2d") {
    // 白字透明底画布贴图，material.color 直接给文字染色
    var tex = new THREE.CanvasTexture(textCanvas(params.text || "文字", 128, 6));
    tex.colorSpace = THREE.SRGBColorSpace;
    material.map = tex;
    material.transparent = true;
    material.alphaTest = 0.05;
  }
  var geo = buildGeometry(kind, params);
  var mesh = new THREE.Mesh(geo, material);
  if (kind !== "text2d") applyTextureToMaterial(material, null, true, 1); // 统一材质基线（轻抛光）；贴面文字有自己的文字贴图
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = "obj_" + id; // 唯一名：GLB 动画轨道按名字绑定节点
  mesh.userData = { id: id, kind: kind, params: params || {}, baseGeo: geo, layer: activeLayerId, opacity: 1 };
  content.add(mesh);
  return mesh;
}

function restOnGround(mesh) {
  mesh.geometry.computeBoundingBox();
  mesh.position.y = -mesh.geometry.boundingBox.min.y;
}

function addPrimitive(kind) {
  var mesh = createObject(kind, {});
  restOnGround(mesh);
  // 轻微错开，避免连续添加完全重叠
  var n = content.children.length - 1;
  mesh.position.x += (n % 5) * 0.5 - 1;
  mesh.position.z += Math.floor(n / 5) * 0.5;
  select(mesh);
  snapshot("添加" + KIND_LABELS[kind]);
  toast("已添加" + KIND_LABELS[kind]);
}

// ---------- 项目文件导入 / 导出（整场景 + 关键帧 + 显示设置）----------

// 项目文件 = 全部场景的完整备份（跟视频/模型导出只导出当前场景不同——那两个本来就只读取
// content/keyframes 这个"活着"的场景，天然没受影响；项目文件是给"整个工作区"做备份/搬家用的，
// 既然场景是比"一份存档"更大的容器，导出项目就该是全部场景，而不是切场景时随手丢掉的那几份）
function serializeProject() {
  captureActiveScene(); // 确保当前场景在 sceneStore 里是最新内容，再一起打包
  return {
    v: 2, scenes: scenes, activeSceneId: activeSceneId, sceneSeq: sceneSeq, store: sceneStore,
    view: { shadow: view.shadow, ground: view.ground, bg: view.bg, anchor: view.anchor, fps: view.fps, res: view.res, shadowCfg: view.shadowCfg, lightCfg: view.lightCfg },
  };
}

$("btn-project-save").addEventListener("click", function () {
  var json = JSON.stringify(serializeProject());
  download(new Blob([json], { type: "application/json" }), "draw3d-project.json");
  toast("项目已导出为 JSON");
});

$("btn-project-open").addEventListener("click", function () { $("project-file").click(); });
$("project-file").addEventListener("change", function () {
  var file = this.files && this.files[0];
  this.value = "";
  if (!file) return;
  var reader = new FileReader();
  reader.onerror = function () { toast("读取文件失败"); };
  reader.onload = function () {
    var data;
    try { data = JSON.parse(reader.result); } catch (e) { toast("不是有效的项目文件"); return; }
    var isMultiScene = !!(data && data.v === 2 && Array.isArray(data.scenes) && data.scenes.length && data.store);
    var isLegacy = !!(data && Array.isArray(data.objects));
    if (!isMultiScene && !isLegacy) { toast("项目文件格式不正确"); return; }
    // 项目文件是全部场景的备份，导入即整体替换当前工作区——不像场景内部的编辑那样能一步步撤销，
    // 这里如实告知，不要跟场景内部"可撤销"的措辞混着用
    if (!confirm("导入项目将替换全部场景，此操作不可撤销，继续？")) return;
    exitDrawMode();
    if (typeof setFaceMode === "function") setFaceMode(false);
    if (isMultiScene) {
      scenes = data.scenes;
      sceneSeq = data.sceneSeq || scenes.reduce(function (m, s) { return Math.max(m, s.id); }, 0);
      sceneStore = data.store;
      sceneUndo = {};
      activeSceneId = findScene(data.activeSceneId) ? data.activeSceneId : scenes[0].id;
      restore(sceneStore[activeSceneId] || {});
    } else {
      // 旧版单场景项目文件：整体替换为唯一一个场景，行为等同过去"导入项目"
      restore(data);
      scenes = [{ id: 1, name: "场景 1" }];
      sceneSeq = 1;
      activeSceneId = 1;
      sceneStore = { 1: serialize() };
      sceneUndo = {};
    }
    if (data.view) {
      view.anchor = data.view.anchor || "center";
      view.fps = Math.min(120, Math.max(10, parseInt(data.view.fps, 10) || 60));
      view.res = data.view.res === "4k" ? "4k" : "1080";
      if (data.view.lightCfg) view.lightCfg = data.view.lightCfg;
      view.shadow = data.view.shadow !== false;
      view.ground = data.view.ground !== false;
      if (data.view.shadowCfg) view.shadowCfg = data.view.shadowCfg;
      applyViewSettings();
      setBackground(data.view.bg || "default");
    }
    undoStack = [{ json: JSON.stringify(serialize()), label: "导入项目" }];
    undoIndex = 0;
    refreshUndoRedoTips();
    renderScenes();
    persistAll();
    toast("项目已导入");
  };
  reader.readAsText(file);
});

function serializeObject(o) {
  var item = {
    id: o.userData.id,
    kind: o.userData.kind,
    params: o.userData.params,
    p: o.position.toArray(),
    q: o.quaternion.toArray(),
    s: o.scale.toArray(),
    jitter: o.userData.jitter || null,
    lockRatio: !!o.userData.lockRatio,
    layer: o.userData.layer,
  };
  // 子物体（组合成员、贴附文字）存父级局部变换；边框线/面覆层等 helper 不序列化，由样式数据重建
  var kids = o.children.filter(function (c) { return c.userData && c.userData.kind && !c.userData.helper; });
  if (kids.length) item.children = kids.map(serializeObject);
  if (o.userData.kind !== "group") {
    item.color = "#" + o.material.color.getHexString();
    item.metalness = o.material.metalness != null ? o.material.metalness : 0;
    item.roughness = o.material.roughness != null ? o.material.roughness : 0.65;
    item.opacity = o.userData.opacity != null ? o.userData.opacity : 1; // 用户设定值（非纹理计算后的最终材质透明度）
    item.stroke = o.userData.stroke || null;
    item.faces = o.userData.faces || null;
    item.sketch = o.userData.sketch || null;
    item.texture = o.userData.texture || null;
  }
  if (o.userData.mirror) item.mirror = o.userData.mirror;
  if (o.userData.appear === "cut") item.appear = "cut"; // 默认 fade，只在非默认时写盘
  return item;
}

function serialize() {
  return {
    v: 1, seq: seq,
    layers: layers.map(function (l) { return { id: l.id, name: l.name, visible: l.visible, locked: !!l.locked }; }),
    layerSeq: layerSeq, activeLayerId: activeLayerId,
    objects: content.children.map(serializeObject), keyframes: keyframes,
    alignLock: alignLock, distLock: distLock, // 对齐/分布锁：随存档/项目文件/撤销一起走，导入后原样恢复
    activeKf: activeKf, // 当前定位在哪一帧也要留痕：撤销"从帧5切到帧6"这个动作本身要能连帧一起退回去
  };
}

function createGroupObject(id) {
  if (id == null) id = ++seq; else seq = Math.max(seq, id);
  var g = new THREE.Group();
  g.userData = { id: id, kind: "group", params: {}, layer: activeLayerId };
  g.name = "obj_" + id;
  content.add(g);
  return g;
}

// 从序列化条目重建物体（含组合递归）；parent 省略时挂在 content
function instantiateObject(item, parent) {
  // 未知类型（如旧存档里已移除的导入模型 "mesh"）跳过，避免整场景加载失败
  if (item.kind !== "group" && !KIND_LABELS[item.kind]) return null;
  var obj;
  if (item.kind === "group") {
    obj = createGroupObject(item.id);
  } else {
    obj = createObject(item.kind, item.params, item.id);
    obj.material.color.set(item.color);
    obj.userData.opacity = item.opacity != null ? item.opacity : 1;
    obj.material.opacity = obj.userData.opacity;
    obj.material.transparent = obj.userData.opacity < 1 || !!obj.material.map;
    if (item.kind !== "line") { // 线条用 LineMaterial，标准材质属性不适用
      obj.material.metalness = item.metalness;
      obj.material.roughness = item.roughness;
      if (item.stroke) obj.userData.stroke = item.stroke;
      if (item.faces) obj.userData.faces = item.faces;
      if (item.sketch) obj.userData.sketch = item.sketch;
      if (item.texture) obj.userData.texture = item.texture;
      applyTexture(obj); // 纹理拥有粗糙度/透明度等属性的最终解释权（含用户物体透明度 baseOpacity）
    }
  }
  if (item.mirror) obj.userData.mirror = item.mirror;
  if (item.appear === "cut") obj.userData.appear = "cut";
  obj.position.fromArray(item.p);
  obj.quaternion.fromArray(item.q);
  obj.scale.fromArray(item.s);
  if (item.jitter) obj.userData.jitter = item.jitter;
  obj.userData.lockRatio = !!item.lockRatio;
  if (item.layer != null) obj.userData.layer = item.layer;
  if (parent && parent !== content) parent.add(obj); // add 会自动从 content 摘除
  (item.children || []).forEach(function (c) { instantiateObject(c, obj); }); // 组合成员 / 贴附文字
  if (obj.isMesh) refreshDecorations(obj);
  return obj;
}

function restore(data) {
  select(null);
  while (content.children.length) removeObject(content.children[0]);
  seq = data.seq || 0;
  if (Array.isArray(data.layers) && data.layers.length) {
    layers = data.layers.map(function (l) { return { id: l.id, name: l.name, visible: l.visible !== false, locked: !!l.locked }; });
    layerSeq = data.layerSeq || layers.reduce(function (m, l) { return Math.max(m, l.id); }, 0);
    activeLayerId = findLayer(data.activeLayerId) ? data.activeLayerId : layers[0].id;
  } else {
    layers = [{ id: 1, name: "图层 1", visible: true, locked: false }]; // 旧存档无图层：建默认层
    layerSeq = 1; activeLayerId = 1;
  }
  (data.objects || []).forEach(function (item) { instantiateObject(item, content); });
  content.children.forEach(function (o) { o.visible = findLayer(ensureObjectLayer(o)).visible; });
  keyframes = data.keyframes || [];
  // 定位到哪一帧也是要撤销/重做/导入还原的状态，不能留着调用前的旧值——renderKeyframes 内部
  // 的 ensureActiveKf 只负责把这个值兜底夹进合法范围，不负责决定它该是多少
  activeKf = data.activeKf != null ? data.activeKf : -1;
  renderKeyframes();
  renderLayers();
  // 上面重建物体时位置/旋转/缩放已经跟 data.objects 对上了，但镜头视角（camera.position/
  // controls.target）不属于任何"物体"、不会跟着走——不重新套用这一帧的视角，撤销"切到帧6"
  // 这个动作时就会出现"选中态回到帧5了，但画面还停在帧6视角"的错位（踩过坑）。顺带也补上
  // existsHere/可见性：instantiateObject 不负责算这个，只有 applyKeyframe 会算。
  if (activeKf !== -1 && keyframes[activeKf]) applyKeyframe(keyframes[activeKf]);
  syncFrameLockControls(); // 撤销/重做/导入后可能正落在一个锁定帧上，重新校准镜头能不能动
  // 对齐/分布锁：成员 id 在上面已重建完毕，直接按存档数据恢复；曾经"仅当前会话有效、不
  // 序列化"，改成随存档走之后撤销/导入都不会再把这状态弄丢
  alignLock = data.alignLock || null;
  distLock = data.distLock || null;
  alignArmed = !!alignLock;
  distArmed = !!distLock;
  refreshLockButtons();
}

function removeObject(obj) {
  (obj.parent || content).remove(obj); // 贴附文字等子物体从各自父级摘除
  obj.traverse(function (c) {
    if (c.userData && c.userData.baseGeo) c.userData.baseGeo.dispose();
    if (c.geometry) c.geometry.dispose();
    if (c.material) {
      if (c.material.map) c.material.map.dispose();
      c.material.dispose();
    }
  });
}

// ---------- 撤销 / 重做 / 自动保存 ----------

var undoStack = []; // 每项 { json, label }：label 描述"做了这一步之后"的这个动作是什么
var undoIndex = -1;
var DEFAULT_SNAPSHOT_LABEL = "编辑";

// label 是这一步操作的人话描述（"移动物体""改颜色"…），用于撤销/重做按钮悬浮提示和操作提示；
// 不传则退回通用的"编辑"，不强求给全部 67 处调用点都手写文案
function snapshot(label) {
  syncMirrors(); // 镜像组：把被编辑成员的内容同步到其余成员
  writeBackActiveFrame(); // 定位在某帧时，任何编辑都直接保存进该帧
  var data = serialize();
  var json = JSON.stringify(data);
  undoStack.length = undoIndex + 1;
  undoStack.push({ json: json, label: label || DEFAULT_SNAPSHOT_LABEL });
  if (undoStack.length > 60) undoStack.shift();
  undoIndex = undoStack.length - 1;
  sceneStore[activeSceneId] = data; // 当前场景在多场景存档里的副本随每次快照保持最新
  persistAll();
  renderLayers(); // 物体增删/换层后刷新图层计数
  refreshUndoRedoTips();
}

// 悬浮提示随时反映"点一下会撤销/重做什么"；按钮用的是 data-tip（见 .btn-icon 悬浮提示 CSS）
function refreshUndoRedoTips() {
  var undoEntry = undoIndex >= 0 ? undoStack[undoIndex] : null;
  var redoEntry = undoIndex + 1 < undoStack.length ? undoStack[undoIndex + 1] : null;
  $("btn-undo").setAttribute("data-tip", "撤销 (Ctrl+Z)" + (undoEntry ? "：" + undoEntry.label : ""));
  $("btn-redo").setAttribute("data-tip", "重做 (Ctrl+Y)" + (redoEntry ? "：" + redoEntry.label : ""));
}

// 撤销/重做左上角提示条，跟底部通用 toast 分开一路（用户明确要求"左上角"，避免跟别的提示抢位置）
var undoToastTimer;
function undoToast(msg) {
  var t = $("undo-toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(undoToastTimer);
  undoToastTimer = setTimeout(function () { t.classList.remove("show"); }, 2200);
}

function applyHistory(index) {
  if (index < 0 || index >= undoStack.length) return;
  if (drawing) exitDrawMode(); // 撤销/重做会重建物体，先退出轮廓编辑避免悬空引用
  // 定位到哪一帧（activeKf）、镜头视角随每次 snapshot 一起入档，restore() 会把它们按存档值
  // 恢复——这样"从帧5切到帧6"这个动作本身也可撤销，撤销后正确退回帧5的数据、选中态、视角。
  var isUndo = index < undoIndex;
  var actedEntry = isUndo ? undoStack[undoIndex] : undoStack[index]; // 撤销：退的是当前这步；重做：进的是目标那步
  undoIndex = index;
  restore(JSON.parse(undoStack[undoIndex].json));
  sceneStore[activeSceneId] = serialize(); // 撤销/重做也要同步多场景存档里当前这份，不然切场景再切回来会看到撤销前的旧状态
  persistAll();
  refreshUndoRedoTips();
  if (actedEntry) undoToast((isUndo ? "已撤销：" : "已重做：") + actedEntry.label);
}

// ---------- 场景管理：新建/复制/删除/切换，每个场景独立图层+物体+关键帧+撤销历史 ----------

function findScene(id) {
  for (var i = 0; i < scenes.length; i++) if (scenes[i].id === id) return scenes[i];
  return null;
}

// 把多场景存档整体写入 localStorage；scenes 只是元数据，真正的内容在 sceneStore 里
function persistAll() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      v: 2, scenes: scenes, activeSceneId: activeSceneId, sceneSeq: sceneSeq, store: sceneStore,
    }));
  } catch (e) { /* 存储满时忽略 */ }
}

// 把当前"活着"的场景数据存回 sceneStore/sceneUndo，供切走之后随时切回来
function captureActiveScene() {
  sceneStore[activeSceneId] = serialize();
  sceneUndo[activeSceneId] = { stack: undoStack, index: undoIndex };
}

// 把某个场景的数据/撤销历史装载成当前"活"的状态；没有独立撤销历史的（比如刚新建）给一条起点
function loadScene(id) {
  restore(sceneStore[id] || {});
  var u = sceneUndo[id];
  if (u) { undoStack = u.stack; undoIndex = u.index; }
  else {
    undoStack = [{ json: JSON.stringify(serialize()), label: "打开场景" }];
    undoIndex = 0;
    sceneUndo[id] = { stack: undoStack, index: undoIndex };
  }
  refreshUndoRedoTips();
}

function renderScenes() {
  var list = $("scene-list");
  if (!list) return;
  list.innerHTML = "";
  scenes.forEach(function (s) {
    var row = document.createElement("div");
    row.className = "layer-row" + (s.id === activeSceneId ? " active" : "");
    row.title = "点击切换到此场景";
    row.addEventListener("click", function () { switchScene(s.id); });

    var name = document.createElement("span");
    name.className = "layer-name";
    name.textContent = s.name;
    name.title = "双击重命名";
    name.addEventListener("dblclick", function (e) { e.stopPropagation(); renameScene(s.id); });
    row.appendChild(name);

    var count = document.createElement("span");
    count.className = "layer-count";
    var objCount = s.id === activeSceneId ? content.children.length : ((sceneStore[s.id] && sceneStore[s.id].objects) || []).length;
    count.textContent = objCount;
    row.appendChild(count);

    var dup = document.createElement("button");
    dup.className = "layer-dup";
    dup.innerHTML = ICON_DUP;
    dup.title = "复制此场景（新建一个内容完全一样的场景，可在此基础上再改）";
    dup.addEventListener("click", function (e) { e.stopPropagation(); duplicateScene(s.id); });
    row.appendChild(dup);

    var del = document.createElement("button");
    del.className = "layer-del";
    del.innerHTML = ICON_DEL;
    del.title = "删除此场景";
    del.addEventListener("click", function (e) { e.stopPropagation(); deleteScene(s.id); });
    row.appendChild(del);

    list.appendChild(row);
  });
}

function switchScene(id) {
  if (playback || exporting) { toast("正在播放或导出中"); return; }
  if (id === activeSceneId || !findScene(id)) return;
  exitDrawMode();
  exitSketch();
  if (typeof setFaceMode === "function") setFaceMode(false);
  captureActiveScene(); // 先把要离开的这个场景存好（含它自己的撤销历史），再切走
  activeSceneId = id;
  loadScene(id);
  renderScenes();
  persistAll();
  toast("已切换到「" + findScene(id).name + "」");
}

function newScene() {
  if (playback || exporting) { toast("正在播放或导出中"); return; }
  exitDrawMode();
  exitSketch();
  if (typeof setFaceMode === "function") setFaceMode(false);
  captureActiveScene();
  var id = ++sceneSeq;
  scenes.push({ id: id, name: "场景 " + id });
  sceneStore[id] = {}; // 全新空场景：restore({}) 等价于清空画布、默认图层、无关键帧
  activeSceneId = id;
  loadScene(id);
  renderScenes();
  persistAll();
  toast("已新建场景，画布已清空");
}

function duplicateScene(id) {
  if (playback || exporting) { toast("正在播放或导出中"); return; }
  var src = findScene(id);
  if (!src) return;
  exitDrawMode();
  exitSketch();
  if (typeof setFaceMode === "function") setFaceMode(false);
  if (id === activeSceneId) captureActiveScene(); // 确保 sceneStore 里是这个场景的最新内容
  var newId = ++sceneSeq;
  scenes.push({ id: newId, name: src.name + " 副本" });
  sceneStore[newId] = JSON.parse(JSON.stringify(sceneStore[id] || {})); // 深拷贝，跟原场景互不影响
  activeSceneId = newId;
  loadScene(newId);
  renderScenes();
  persistAll();
  toast("已复制「" + src.name + "」，可在副本上继续修改");
}

function deleteScene(id) {
  if (playback || exporting) { toast("正在播放或导出中"); return; }
  var s = findScene(id);
  if (!s) return;
  if (scenes.length <= 1) { toast("至少保留一个场景"); return; }
  if (!confirm("删除场景「" + s.name + "」？此操作不可撤销。")) return;
  exitDrawMode();
  exitSketch();
  if (typeof setFaceMode === "function") setFaceMode(false);
  var idx = scenes.findIndex(function (x) { return x.id === id; });
  scenes.splice(idx, 1);
  delete sceneStore[id];
  delete sceneUndo[id];
  if (activeSceneId === id) {
    var fallback = scenes[Math.min(idx, scenes.length - 1)];
    activeSceneId = fallback.id;
    loadScene(fallback.id);
  }
  renderScenes();
  persistAll();
  toast("已删除「" + s.name + "」");
}

function renameScene(id) {
  var s = findScene(id);
  if (!s) return;
  var name = prompt("场景名称：", s.name);
  if (name == null) return;
  name = name.trim();
  if (!name) return;
  s.name = name;
  renderScenes();
  persistAll();
}

$("btn-scene-add").addEventListener("click", newScene);

// ---------- 选择与变换 ----------

var raycaster = new THREE.Raycaster();
var pointer = new THREE.Vector2();

// 选中态描边：贴着物体真实几何硬边画一圈醒目粗线，视觉上跟「边框」功能长得一样，
// 但完全是预览层——不写 userData.stroke、不参与序列化/导出，取消选中即整块移除。
// 直接复用 applyStroke 同一套硬边提取 + fat-line 管线（EdgesGeometry → LineSegmentsGeometry
// → LineSegments2），只是用独立的 helper 标记（"selOutline"）和固定配色，互不干扰真实边框。
var SEL_OUTLINE_MAIN = { color: "#FFFFDD", width: 3, style: "solid" }; // 主选中：--primary-dark，更粗更深
var SEL_OUTLINE_SUB = { color: "#FFFFDD", width: 2, style: "solid" };  // 次选中：--primary，稍细
function applySelOutline(mesh, on, main) {
  if (!mesh.isMesh || mesh.userData.kind === "line") return; // 线条本身就是线，无需再描边
  removeHelperChildren(mesh, ["selOutline"]);
  if (!on) return;
  var edges = new THREE.EdgesGeometry(mesh.userData.baseGeo || mesh.geometry, 20);
  if (!edges.attributes.position || !edges.attributes.position.count) { edges.dispose(); return; }
  var geo = new LineSegmentsGeometry().fromEdgesGeometry(edges);
  edges.dispose();
  var line = new LineSegments2(geo, buildLineMaterial(main ? SEL_OUTLINE_MAIN : SEL_OUTLINE_SUB));
  line.computeLineDistances();
  line.userData = { helper: "selOutline" };
  line.raycast = function () {}; // 不参与拾取，纯展示
  mesh.add(line);
}

// 选中高亮：明显的发光（主选中更亮）+ 上面这圈描边。emissive 用主色调，一眼可辨
function applyHighlight(obj, on) {
  var main = obj === selected;
  obj.traverse(function (c) {
    if (!c.isMesh || !c.material.emissive) return;
    if (c.userData && c.userData.helper) return; // helper（涂料覆层/描边等）不参与高亮，不许改它们的材质
    applySelOutline(c, on, main);
    if (on) {
      c.material.emissive.setHex(main ? 0x6B5FA0 : 0x6B5FA0);
      c.material.emissiveIntensity = main ? 0.55 : 0.45;
    } else {
      var t = c.userData && c.userData.texture;
      if (t && t.type === "glow") {
        // 「发光」纹理的 emissive 是内容不是高亮，取消选中时恢复而不是清零
        c.material.emissive.copy(c.material.color);
        c.material.emissiveIntensity = ((t.params && t.params.inten) == null ? 0.6 : t.params.inten) * 1.2;
      } else {
        c.material.emissive.setHex(0x000000);
        c.material.emissiveIntensity = 1;
      }
    }
  });
}

// 选中描边现在是贴几何的逐物体 selOutline（见 applySelOutline），会自动跟着每个物体的
// 变换走，不需要每帧重算；这里只在播放/导出/画笔/画板这些"不该露出编辑态"的场景里临时
// 隐藏一下（选中通常这时也已经被清空，这里是双保险，成本很低——只扫选中的物体，不扫全场景）
function updateSelectionOutlines() {
  var show = !(playback || exporting || drawing || sketching);
  selection.forEach(function (o) {
    o.traverse(function (c) {
      if (c.userData && c.userData.helper === "selOutline") c.visible = show;
    });
  });
}

// 多选整体变换：手柄挂在选区包围盒中心的隐形枢轴上，拖动时按初始相对矩阵带动全部成员
var multiPivot = new THREE.Object3D();
scene.add(multiPivot);
var pivotStarts = null;
var _pm = new THREE.Matrix4(), _pmInv = new THREE.Matrix4();

function refreshMultiPivot() {
  if (selection.length < 2) { pivotStarts = null; return; }
  var box = new THREE.Box3();
  selection.forEach(function (o) { box.expandByObject(o); });
  box.getCenter(multiPivot.position);
  multiPivot.quaternion.identity();
  multiPivot.scale.set(1, 1, 1);
  multiPivot.updateMatrixWorld(true);
  _pmInv.copy(multiPivot.matrixWorld).invert();
  pivotStarts = selection.map(function (o) {
    o.updateMatrixWorld(true);
    return { o: o, rel: new THREE.Matrix4().multiplyMatrices(_pmInv, o.matrixWorld) };
  });
}

function applyMultiTransform() {
  if (!pivotStarts) return;
  multiPivot.updateMatrixWorld(true);
  pivotStarts.forEach(function (it) {
    _pm.multiplyMatrices(multiPivot.matrixWorld, it.rel);
    _pm.decompose(it.o.position, it.o.quaternion, it.o.scale);
  });
}

function setSelection(list, keepFace) {
  if (!keepFace) clearFaceSelection();
  selection.forEach(function (o) { applyHighlight(o, false); });
  selection = [];
  (list || []).forEach(function (o) {
    if (o && selection.indexOf(o) === -1) selection.push(o);
  });
  selected = selection.length ? selection[selection.length - 1] : null; // 先定主选中，applyHighlight 才能区分主/次
  selection.forEach(function (o) { applyHighlight(o, true); });
  if (selection.length === 1) {
    tc.attach(selected);
    pivotStarts = null;
  } else if (selection.length > 1) {
    refreshMultiPivot();
    tc.attach(multiPivot); // 多选：整体移动/旋转/缩放
  } else {
    tc.detach();
    pivotStarts = null;
  }
  updateSelectionOutlines();
  refreshLineHandles();
  refreshProps();
}

function select(mesh, keepFace) { setSelection(mesh ? [mesh] : [], keepFace); }

function toggleSelect(mesh) {
  if (!mesh) return;
  var list = selection.slice();
  var idx = list.indexOf(mesh);
  if (idx === -1) list.push(mesh); else list.splice(idx, 1);
  setSelection(list);
}

// ---------- 图层操作 ----------

var ICON_EYE_ON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>';
var ICON_EYE_OFF = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c6.5 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.5 13.5 0 0 0 2 11s3.5 7 10 7a9.12 9.12 0 0 0 5.39-1.61"/><path d="M9.9 9.9a3 3 0 1 0 4.2 4.2"/><path d="M2 2l20 20"/></svg>';
// 锁定=实心黑锁（醒目）；解锁=空心开锁（浅淡）
var ICON_LOCK_ON = '<svg viewBox="0 0 256 256" fill="currentColor" stroke="none"><path d="M208,80H176V56a48,48,0,0,0-96,0V80H48A16,16,0,0,0,32,96V208a16,16,0,0,0,16,16H208a16,16,0,0,0,16-16V96A16,16,0,0,0,208,80ZM96,56a32,32,0,0,1,64,0V80H96Zm40,116a8,8,0,0,1-16,0V152a8,8,0,0,1,16,0Z"/></svg>';
var ICON_LOCK_OFF = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.5-2"/></svg>';

function setActiveLayer(id) { activeLayerId = id; renderLayers(); }

function addLayer() {
  var l = { id: ++layerSeq, name: "图层 " + (layers.length + 1), visible: true };
  layers.push(l);
  activeLayerId = l.id;
  renderLayers();
  snapshot("新建图层");
  toast("已新建「" + l.name + "」，新物体将归入此层");
}

function deleteLayer(id) {
  if (layers.length <= 1) { toast("至少保留一个图层"); return; }
  var idx = layers.findIndex(function (l) { return l.id === id; });
  var fallback = layers[idx === 0 ? 1 : 0]; // 物体迁往的目标图层
  var moved = objectsInLayer(id);
  moved.forEach(function (o) { o.userData.layer = fallback.id; o.visible = fallback.visible; });
  layers.splice(idx, 1);
  if (activeLayerId === id) activeLayerId = layers[0].id;
  renderLayers();
  snapshot("删除图层");
  toast("图层已删除" + (moved.length ? "，" + moved.length + " 个物体移至「" + fallback.name + "」" : ""));
}

function toggleLayerVisible(id) {
  var l = findLayer(id);
  l.visible = !l.visible;
  objectsInLayer(id).forEach(function (o) { o.visible = l.visible; });
  if (!l.visible) deselectLayer(id); // 隐藏时取消其选中
  renderLayers();
  snapshot((l.visible ? "显示" : "隐藏") + "图层");
}

function toggleLayerLock(id) {
  var l = findLayer(id);
  l.locked = !l.locked;
  if (l.locked) deselectLayer(id); // 锁定时取消其选中（不可再操作）
  renderLayers();
  snapshot((l.locked ? "锁定" : "解锁") + "图层");
  toast(l.locked ? "「" + l.name + "」已锁定，无法选中/操作" : "「" + l.name + "」已解锁");
}

// 取消选中属于某图层的物体（隐藏/锁定后调用）
function deselectLayer(id) {
  if (selection.some(function (o) { return topLevelOf(o).userData.layer === id; })) {
    setSelection(selection.filter(function (o) { return topLevelOf(o).userData.layer !== id; }));
  }
}

function renameLayer(id) {
  var l = findLayer(id);
  var name = prompt("图层名称：", l.name);
  if (name == null) return;
  name = name.trim();
  if (!name) return;
  l.name = name;
  renderLayers();
  snapshot("重命名图层");
}

function selectLayerObjects(id) {
  setActiveLayer(id);
  var l = findLayer(id);
  if (l.locked) { toast("图层已锁定，无法选中"); return; }
  if (!l.visible) { toast("图层已隐藏，无法选中"); return; }
  var objs = objectsInLayer(id);
  if (!objs.length) { toast("该图层还没有物体"); return; }
  exitDrawMode();
  if (faceMode) setFaceMode(false);
  setSelection(objs);
}

function moveSelectionToLayer(id) {
  if (!selection.length) return;
  var l = findLayer(id);
  selection.forEach(function (o) { o.userData.layer = id; o.visible = l.visible; });
  renderLayers();
  snapshot("移动图层");
  toast("已移入「" + l.name + "」");
}

// 属性面板的「图层」下拉：把选中物体移入某层，值取主选中所属层
function refreshLayerSelect() {
  var sel = $("prop-layer");
  if (!sel) return;
  sel.innerHTML = "";
  layers.forEach(function (l) {
    var opt = document.createElement("option");
    opt.value = l.id;
    opt.textContent = l.name;
    sel.appendChild(opt);
  });
  if (selected) sel.value = selected.userData.layer;
}

function renderLayers() {
  var list = $("layer-list");
  if (!list) return;
  list.innerHTML = "";
  layers.forEach(function (l) {
    var row = document.createElement("div");
    row.className = "layer-row" + (l.id === activeLayerId ? " active" : "");
    row.title = "点击选中此图层的物体并设为当前层";
    row.addEventListener("click", function () { selectLayerObjects(l.id); });

    var eye = document.createElement("button");
    eye.className = "layer-eye" + (l.visible ? "" : " off");
    eye.innerHTML = l.visible ? ICON_EYE_ON : ICON_EYE_OFF;
    eye.title = l.visible ? "隐藏图层" : "显示图层";
    eye.addEventListener("click", function (e) { e.stopPropagation(); toggleLayerVisible(l.id); });
    row.appendChild(eye);

    var lock = document.createElement("button");
    lock.className = "layer-lock" + (l.locked ? " on" : "");
    lock.innerHTML = l.locked ? ICON_LOCK_ON : ICON_LOCK_OFF;
    lock.title = l.locked ? "解锁图层" : "锁定图层（可见但不可选/操作）";
    lock.addEventListener("click", function (e) { e.stopPropagation(); toggleLayerLock(l.id); });
    row.appendChild(lock);

    var name = document.createElement("span");
    name.className = "layer-name";
    name.textContent = l.name;
    name.title = "双击重命名";
    name.addEventListener("dblclick", function (e) { e.stopPropagation(); renameLayer(l.id); });
    row.appendChild(name);

    var count = document.createElement("span");
    count.className = "layer-count";
    count.textContent = objectsInLayer(l.id).length;
    row.appendChild(count);

    var del = document.createElement("button");
    del.className = "layer-del";
    del.innerHTML = ICON_DEL;
    del.title = "删除图层（物体移到其他图层）";
    del.addEventListener("click", function (e) { e.stopPropagation(); deleteLayer(l.id); });
    row.appendChild(del);

    list.appendChild(row);
  });
  refreshLayerSelect();
}

function raycastContent(clientX, clientY) {
  var rect = renderer.domElement.getBoundingClientRect();
  pointer.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
  var hits = raycaster.intersectObjects(content.children, true); // 递归：组合/贴附子物体也可命中
  return hits.length ? hits[0] : null;
}

// 命中对象归属：贴面文字可单独选中，其余上溯到 content 直属物体
function resolvePick(obj) {
  if (obj.userData && obj.userData.kind === "text2d" && obj.parent && obj.parent !== content
      && obj.parent.userData && obj.parent.userData.kind !== "group") {
    return obj;
  }
  return topLevelOf(obj);
}

function pickAt(clientX, clientY) {
  var rect = renderer.domElement.getBoundingClientRect();
  pointer.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
  var hits = raycaster.intersectObjects(content.children, true); // 按距离排序
  // 从近到远跳过不可选（隐藏/锁定图层）的物体，选中它后面第一个可选物体
  for (var i = 0; i < hits.length; i++) {
    var obj = resolvePick(hits[i].object);
    if (isSelectable(obj)) return obj;
  }
  return null;
}

var dragStartScale = null; // 缩放拖动起点，锁定比例时用于强制等比

tc.addEventListener("dragging-changed", function (e) {
  controls.enabled = !e.value;
  if (e.value) {
    dragStartScale = selected ? selected.scale.clone() : null;
    captureLockCenters(); // 对齐/分布锁：以拖拽起点为位移基准
  } else {
    dragStartScale = null;
    if (tc.object === multiPivot) refreshMultiPivot(); // 归一枢轴，避免多次拖动叠出剪切
    var modeLabel = { translate: "移动物体", rotate: "旋转物体", scale: "缩放物体" }[tc.getMode()] || "变换物体";
    snapshot(modeLabel);
    refreshProps();
  }
});

// 拖动过程中：多选带动整组；单选做吸附/等比，并实时刷新输入框
tc.addEventListener("objectChange", function () {
  if (tc.object === multiPivot) {
    applyMultiTransform();
    enforceLocks(selection.map(function (o) { return o.userData.id; })); // 多选拖动也维持锁（成员不全时）
    return;
  }
  // 锚点吸附按世界坐标算增量，只对 content 直属物体生效（贴附子物体跳过）
  if (snapOn && tc.mode === "translate" && selected && selected.parent === content) applyAnchorSnap(selected);
  if (tc.mode === "scale" && selected && selected.userData.lockRatio && dragStartScale) applyUniformScale(selected);
  if (selected) enforceLocks([selected.userData.id]); // 对齐/分布锁实时跟随
  if (selectedLine()) refreshLineHandles();
  refreshTransformFields();
});

// 锁定比例：取本次拖动中变化最大的轴作为倍率，三轴同步
function applyUniformScale(obj) {
  var s = obj.scale, s0 = dragStartScale;
  if (s0.x < 1e-9 || s0.y < 1e-9 || s0.z < 1e-9) return;
  var factor = s.x / s0.x;
  if (Math.abs(s.y / s0.y - 1) > Math.abs(factor - 1)) factor = s.y / s0.y;
  if (Math.abs(s.z / s0.z - 1) > Math.abs(factor - 1)) factor = s.z / s0.z;
  s.set(s0.x * factor, s0.y * factor, s0.z * factor);
}

var SNAP_STEP = 0.25;
var _box = new THREE.Box3(), _anchor = new THREE.Vector3(), _snapped = new THREE.Vector3();

// 基准点：物体世界包围盒的中心或某个面的中点
function anchorPoint(box, target) {
  box.getCenter(target);
  switch (view.anchor) {
    case "bottom": target.y = box.min.y; break;
    case "top": target.y = box.max.y; break;
    case "left": target.x = box.min.x; break;
    case "right": target.x = box.max.x; break;
    case "back": target.z = box.min.z; break;
    case "front": target.z = box.max.z; break;
  }
  return target;
}

// TransformControls 只会吸物体原点，这里改为把基准点对齐到网格：位置补上基准点到最近格点的差值
function applyAnchorSnap(obj) {
  obj.updateMatrixWorld(true);
  _box.setFromObject(obj);
  anchorPoint(_box, _anchor);
  _snapped.set(
    Math.round(_anchor.x / SNAP_STEP) * SNAP_STEP,
    Math.round(_anchor.y / SNAP_STEP) * SNAP_STEP,
    Math.round(_anchor.z / SNAP_STEP) * SNAP_STEP
  );
  obj.position.add(_snapped.sub(_anchor));
}

function setTransformMode(mode) {
  tc.setMode(mode);
  ["translate", "rotate", "scale"].forEach(function (m) {
    $("mode-" + m).classList.toggle("active", m === mode);
  });
}

var snapOn = false;
function toggleSnap() {
  snapOn = !snapOn;
  // 平移吸附走 applyAnchorSnap（支持选基准点），这里只管旋转和缩放
  tc.setRotationSnap(snapOn ? THREE.MathUtils.degToRad(15) : null);
  tc.setScaleSnap(snapOn ? 0.1 : null);
  $("toggle-snap").classList.toggle("active", snapOn);
  toast(snapOn ? "吸附已开启（0.25 格 / 15° / 0.1 倍，基准可在属性面板选）" : "吸附已关闭");
}

// ---------- 属性面板 ----------

// 物体自身包围盒（本地系、未含自身变换）：网格取几何包围盒，组合取子物体相对组的合并盒
var _lb = new THREE.Box3(), _lbTmp = new THREE.Box3(), _m4a = new THREE.Matrix4(), _m4b = new THREE.Matrix4();
function localBounds(obj) {
  if (obj.userData.kind === "group") {
    _lb.makeEmpty();
    obj.updateMatrixWorld(true);
    _m4a.copy(obj.matrixWorld).invert();
    obj.traverse(function (c) {
      if (!c.isMesh) return;
      if (!c.geometry.boundingBox) c.geometry.computeBoundingBox();
      _lbTmp.copy(c.geometry.boundingBox).applyMatrix4(_m4b.multiplyMatrices(_m4a, c.matrixWorld));
      _lb.union(_lbTmp);
    });
    return _lb;
  }
  if (!obj.geometry.boundingBox) obj.geometry.computeBoundingBox();
  return obj.geometry.boundingBox;
}

// 物体自身尺寸：本地包围盒 × 缩放，与旋转无关
function localSize(obj, target) {
  return localBounds(obj).getSize(target).multiply(obj.scale);
}

// 尺寸/坐标的界面单位：1 界面单位 = 0.01 场景单位（整数显示）
var UI_UNIT = 100;

function setFieldValue(id, v) {
  var input = $(id);
  if (document.activeElement === input) return; // 正在输入时不回写覆盖
  input.value = Math.round(v * UI_UNIT);
}

function refreshTransformFields() {
  if (!selected) return;
  var size = localSize(selected, _va);
  setFieldValue("prop-size-x", size.x);
  setFieldValue("prop-size-z", size.z);
  setFieldValue("prop-size-y", size.y);
  setFieldValue("prop-pos-x", selected.position.x);
  setFieldValue("prop-pos-y", selected.position.y);
  setFieldValue("prop-pos-z", selected.position.z);
}

// 收集物体的"样式网格"：网格自身，组合下钻到成员；不含 helper 描线/覆层和贴附的独立子物体
function collectStyleMeshes(o, out) {
  out = out || [];
  if (o.userData.kind === "group") {
    o.children.forEach(function (c) {
      if (c.userData && c.userData.kind) collectStyleMeshes(c, out);
    });
  } else if (o.isMesh) {
    out.push(o);
  }
  return out;
}

function eachSelectedMesh(fn) {
  selection.forEach(function (o) { collectStyleMeshes(o).forEach(fn); });
}

function firstMaterial(obj) {
  var meshes = collectStyleMeshes(obj);
  return meshes.length ? meshes[0].material : null;
}

function refreshProps() {
  var n = selection.length;
  $("prop-empty").hidden = n !== 0;
  $("prop-body").hidden = n === 0; // 多选也显示属性：值取主选中，修改作用于全部
  // 「批量操作」整块的显隐：多选(≥2)才有相减/对齐/分布；单选一个组合也要露出解除组合，
  // 所以这块不能简单等于 n<2——用跟组合按钮同一个 allGroups 判断
  var allGroups = n > 0 && selection.every(function (o) { return o.userData.kind === "group"; });
  $("prop-section-ops").hidden = !(n >= 2 || allGroups);
  $("multi-body").hidden = n < 2;
  $("align-field").hidden = n < 2;
  $("dist-field").hidden = n < 2;
  if (!n) { renderActions(); return; }
  $("multi-count").textContent = n >= 2 ? "已选 " + n + " 个 · 属性与手柄作用于全部，对齐以最后选中为基准" : "";
  $("prop-pos-field").hidden = n > 1; // 多选时坐标交给整体拖动与对齐
  var kind = selected.userData.kind;
  // 组合/解除组合合并成一个按钮：整个选区全是组合 → 解除组合；选中 ≥2 个物体（含混选）→ 组合；
  // 单选一个非组合物体则两者都不适用，按钮直接隐藏
  var groupBtn = $("btn-group-toggle");
  if (allGroups) {
    $("prop-group-field").hidden = false;
    groupBtn.textContent = "解除组合 (Ctrl+Shift+G)";
    groupBtn.dataset.mode = "ungroup";
  } else if (n >= 2) {
    $("prop-group-field").hidden = false;
    groupBtn.textContent = "组合 (Ctrl+G)";
    groupBtn.dataset.mode = "group";
  } else {
    $("prop-group-field").hidden = true;
  }
  $("prop-name").textContent = n === 1
    ? KIND_LABELS[kind] + " · " + selected.name
    : "已选 " + n + " 个物体";
  refreshTransformFields();
  refreshLayerSelect();
  refreshTextureUI();
  refreshLineProps();
  refreshTroughProps();
  $("prop-lock").checked = !!selected.userData.lockRatio;
  var m = firstMaterial(selected);
  if (m) $("prop-color").value = "#" + m.color.getHexString();
  $("prop-opacity-field").hidden = kind === "text2d" || kind === "group";
  var opv = selected.userData.opacity != null ? selected.userData.opacity : 1;
  $("prop-opacity").value = opv;
  $("prop-opacity-val").textContent = opv.toFixed(2);
  $("prop-appear-field").hidden = n > 1; // 出现动画是单个顶层物体的属性，多选时不清楚作用于谁
  $("prop-appear").value = selected.userData.appear === "cut" ? "cut" : "fade";
  $("btn-opacity-allframes").hidden = n > 1 || kind === "group" || kind === "text2d" || keyframes.length < 2;
  // 「动画」整块两个控件都不适用时（没有关键帧、或多选、或组合/贴面文字）就把整块连标题一起藏起来，
  // 不留一个只有空标题的空区块
  $("prop-section-animation").hidden = $("prop-appear-field").hidden && $("btn-opacity-allframes").hidden;
  var sm = collectStyleMeshes(selected)[0];
  var st = sm && sm.userData.stroke;
  $("stroke-on").checked = !!(st && st.enabled);
  $("stroke-config").hidden = !(st && st.enabled);
  $("stroke-color").value = st ? st.color : "#43423D";
  $("stroke-width").value = st ? st.width : 2;
  $("stroke-style").value = st ? st.style : "solid";
  var j = ensureJitter(selected);
  $("jit-enabled").checked = j.enabled;
  $("jit-config").hidden = !j.enabled;
  $("jit-box-x").value = j.box[0];
  $("jit-box-z").value = j.box[2];
  $("jit-box-y").value = j.box[1];
  $("jit-speed").value = j.speed;
  $("jit-speed-val").textContent = j.speed.toFixed(1);
  $("jit-rand").value = j.randomness;
  $("jit-rand-val").textContent = j.randomness.toFixed(2);
  renderActions(); // "给选中物体加动作"的可用性跟着选中状态走
}

// 对选中集合内所有样式网格的材质批量操作
function eachSelectedMaterial(fn) {
  eachSelectedMesh(function (m) { fn(m.material); });
}

$("prop-color").addEventListener("input", function () {
  var v = this.value;
  eachSelectedMaterial(function (m) { m.color.set(v); });
});
$("prop-color").addEventListener("change", function () { snapshot("改颜色"); });

$("prop-opacity").addEventListener("input", function () {
  var v = parseFloat(this.value);
  $("prop-opacity-val").textContent = v.toFixed(2);
  eachSelectedMesh(function (m) { setMeshOpacity(m, v); });
});
$("prop-opacity").addEventListener("change", function () { snapshot("改透明度"); });

$("prop-appear").addEventListener("change", function () {
  if (!selected) return;
  selected.userData.appear = this.value === "cut" ? "cut" : "fade";
  snapshot("改出现动画");
});

// 旋转/缩放/颜色/透明度默认只写回当前所在帧（帧编辑模型）；此按钮把选中物体现在的这几项
// 直接同步进它的全部关键帧——**位置不同步**（每帧里这个物体可以在不同地方，这是"移动"动画
// 的基础，不能被这个按钮覆盖掉）、**镜头视角也不同步**（这个按钮只管这一个物体自己，不碰
// kf.camera）。形状（线宽/水槽壁厚底厚等）和材质纹理本来就存在物体自己身上、不是按帧记录的，
// 天然已经全帧统一，不需要这个按钮管。
// 该物体原本不存在的帧则直接用它当前的位置/旋转/缩放新增一条记录，让它不再时隐时现，
// 而是在全部帧里都出现（不需要的话，用户仍可在具体某帧删除/移动它，恢复局部出现）
$("btn-opacity-allframes").addEventListener("click", function () {
  if (!selected || keyframes.length < 2) return;
  var id = selected.userData.id;
  var m = firstMaterial(selected);
  if (!m) return;
  var hex = "#" + m.color.getHexString();
  var op = selected.userData.opacity != null ? selected.userData.opacity : 1;
  var p = selected.position.toArray(), q = selected.quaternion.toArray(), s = selected.scale.toArray();
  var synced = 0, added = 0;
  keyframes.forEach(function (kf) {
    var st = kf.objects[id];
    if (st) { st.q = q; st.s = s; st.c = hex; st.op = op; synced++; } // 位置(p)不动
    else { kf.objects[id] = { p: p, q: q, s: s, c: hex, op: op }; added++; } // 全新出现的帧没有旧位置可保留，只能用当前位置
  });
  selected.userData.existsHere = true;
  selected.visible = objVisibleForFrame(selected, true);
  snapshot("应用到全部帧");
  toast(added
    ? ("已同步旋转/缩放/颜色/透明度到 " + synced + " 帧，另有 " + added + " 帧原本没有该物体，已让它在这些帧中出现")
    : ("已把当前旋转/缩放/颜色/透明度同步到全部 " + synced + " 个关键帧（位置与镜头不受影响）"));
});

// 应用颜色到全部选中（供色板与拾色器共用）
function applyColorToSelection(hex) {
  if (!selection.length) return;
  eachSelectedMaterial(function (m) { m.color.set(hex); });
  $("prop-color").value = hex;
  snapshot("改颜色");
}

// 常见色板（取自素材色板图，6 列 × 5 行）：4 行彩色由亮到暗 + 1 行中性
var PALETTE = [
  "#5CB8E8", "#68F0DC", "#8CE04C", "#FCE94F", "#FF8A7A", "#FF8CC0", "#D2D2D2",
  "#0098E4", "#18D6C4", "#5CCB40", "#FDC820", "#FF5A44", "#F53CA0", "#808080",
  "#0068AC", "#009C8C", "#1FA800", "#FF9800", "#E42214", "#D42078", "#4E4E4E",
  "#06426E", "#00584E", "#0A5A0A", "#E06800", "#B41200", "#8C1450", "#000000",
];
(function buildSwatches() {
  var box = $("prop-swatches");
  PALETTE.forEach(function (hex) {
    var b = document.createElement("button");
    b.style.background = hex;
    b.title = hex;
    b.addEventListener("click", function () { applyColorToSelection(hex); });
    box.appendChild(b);
  });
})();

// ---------- 材质纹理：预设 + 可调参数（物体级与面级共用一套引擎） ----------
var TEXTURES = {
  none: { label: "无", params: [] },
  glass: { label: "玻璃", params: [{ key: "turbid", label: "浑浊度", def: 0.15 }] },
  water: { label: "水", params: [
    { key: "wave", label: "波纹强度", def: 0.6 },
    { key: "murk", label: "浑浊杂质", def: 0.35 },
    { key: "alpha", label: "透明度", def: 0.55 },
    { key: "scale", label: "密集度", def: 0.35 },
    { key: "flow", label: "流动（播放/导出时）", def: true, bool: true },
  ] },
  metal: { label: "金属", params: [
    { key: "polish", label: "抛光度", def: 0.8 },
    { key: "brushed", label: "拉丝强度", def: 0.5 },
  ] },
  frosted: { label: "磨砂", params: [{ key: "rough", label: "粗糙度", def: 0.9 }] },
  wood: { label: "木纹", params: [
    { key: "rings", label: "年轮密度", def: 0.5 },
    { key: "grain", label: "纹理深浅", def: 0.6 },
    { key: "scale", label: "密集度", def: 0.35 },
  ] },
  marble: { label: "大理石", params: [
    { key: "veins", label: "纹路密度", def: 0.55 },
    { key: "contrast", label: "对比度", def: 0.6 },
    { key: "scale", label: "密集度", def: 0.35 },
  ] },
  glow: { label: "发光", params: [
    { key: "inten", label: "强度", def: 0.6 },
    { key: "pattern", label: "纹理起伏", def: 0.5 },
  ] },
};

function defaultTextureCfg(type) {
  var cfg = { type: type, params: {} };
  TEXTURES[type].params.forEach(function (p) { cfg.params[p.key] = p.def; });
  return cfg;
}

// 金属需要环境贴图才有反射（无 envMap 的纯金属渲染为黑）。生成一个简易的
// 天光渐变立方体环境，只挂在金属/玻璃材质上，不设 scene.environment 以免破坏灯光校准
var _envTex = null;
function envTexture() {
  if (_envTex) return _envTex;
  var faces = [];
  for (var i = 0; i < 6; i++) {
    var c = document.createElement("canvas");
    c.width = c.height = 64;
    var ctx = c.getContext("2d");
    var g = ctx.createLinearGradient(0, 0, 0, 64);
    if (i === 2) { g.addColorStop(0, "#ffffff"); g.addColorStop(1, "#f2efe8"); }        // 上：亮天
    else if (i === 3) { g.addColorStop(0, "#6e6a60"); g.addColorStop(1, "#5a564e"); }   // 下：深地
    else { // 四周：天空 → 明亮地平线带 → 深地面（对比线让反射清晰可辨）
      g.addColorStop(0, "#fbfaf6");
      g.addColorStop(0.48, "#efe9da");
      g.addColorStop(0.52, "#fff6e2");
      g.addColorStop(0.56, "#8d887c");
      g.addColorStop(1, "#6e6a60");
    }
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
    faces.push(c);
  }
  _envTex = new THREE.CubeTexture(faces);
  _envTex.colorSpace = THREE.SRGBColorSpace;
  _envTex.needsUpdate = true;
  return _envTex;
}

// 程序化贴图缓存（按类型+参数），水的流动贴图记入 flowMaps 供播放时推进 offset
var _texMapCache = {};
var flowMaps = [];
function texMap(type, params) {
  var key = type + "|" + JSON.stringify(params);
  if (!_texMapCache[key]) {
    var tex = new THREE.CanvasTexture(textureCanvas(type, params || {}));
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    var rep = 1 + (params && params.scale != null ? params.scale : 0) * 3; // 密集度 → 平铺重复
    tex.repeat.set(rep, rep);
    _texMapCache[key] = tex;
    if (type === "water" && params && params.flow) flowMaps.push(tex);
  }
  return _texMapCache[key];
}

// 播放/导出时推进水面流动；t=0 复位
function updateFlowTextures(t) {
  flowMaps.forEach(function (map) { map.offset.set((t * 0.18) % 1, (t * 0.07) % 1); });
}

// 把纹理配置落到材质上。baseOpacity：面级纹理与面自身透明度相乘
// 纹理自身携带的透明度系数（不含用户物体透明度）。唯一定义处——
// applyTextureToMaterial 和动画轻量透明度路径 applyFrameOpacity 都调它，改一处两处生效。
function textureOpacityFactor(cfg) {
  var type = cfg && TEXTURES[cfg.type] ? cfg.type : "none";
  var p = (cfg && cfg.params) || {};
  if (type === "glass") return 0.32 + 0.5 * (p.turbid == null ? 0.15 : p.turbid);
  if (type === "water") return Math.max(0.2, 1 - 0.75 * (p.alpha == null ? 0.55 : p.alpha));
  if (type === "frosted") return 0.9;
  return 1;
}

function applyTextureToMaterial(m, cfg, hasUV, baseOpacity) {
  var prevMap = m.map, prevEnvMap = m.envMap, prevEmissiveMap = m.emissiveMap;
  m.map = null;
  m.emissiveMap = null;
  // 基线=轻抛光：弱环境反射让普通物体转动时也有光泽流动，强度由「表面光泽」全局滑杆控制
  m.envMap = envTexture();
  m.envMapIntensity = view.lightCfg.gloss;
  m.roughness = 0.55;
  m.metalness = 0.05;
  m.emissive.setHex(0x000000);
  m.emissiveIntensity = 1;
  var op = (baseOpacity == null ? 1 : baseOpacity) * textureOpacityFactor(cfg);
  var type = cfg && TEXTURES[cfg.type] ? cfg.type : "none";
  var p = (cfg && cfg.params) || {};
  if (type === "glass") {
    m.roughness = 0.03 + 0.45 * (p.turbid == null ? 0.15 : p.turbid);
    m.metalness = 0;
    m.envMap = envTexture();
    m.envMapIntensity = 1.2;
    if (hasUV) m.map = texMap("glass", p); // 雾斑/气泡/擦痕
  } else if (type === "water") {
    m.roughness = 0.05 + 0.45 * (p.murk == null ? 0.35 : p.murk);
    m.envMap = envTexture();
    m.envMapIntensity = 0.7;
    if (hasUV) m.map = texMap("water", p);
  } else if (type === "metal") {
    m.metalness = 1;
    m.roughness = 0.05 + (1 - (p.polish == null ? 0.8 : p.polish)) * 0.7;
    m.envMap = envTexture();
    m.envMapIntensity = 1.5;
    if (hasUV && (p.brushed == null ? 0.5 : p.brushed) > 0.02) m.map = texMap("metal", p); // 拉丝条痕（灰度乘色）
  } else if (type === "frosted") {
    m.roughness = p.rough == null ? 0.9 : p.rough;
    m.metalness = 0;
    m.envMapIntensity = 0.06; // 磨砂哑光（透明度系数见 textureOpacityFactor）
    if (hasUV) m.map = texMap("frosted", p); // 喷砂颗粒
  } else if (type === "wood") {
    if (hasUV) m.map = texMap("wood", p);
    m.roughness = 0.8;
    m.envMapIntensity = 0.08; // 木头哑光
  } else if (type === "marble") {
    if (hasUV) m.map = texMap("marble", p);
    m.roughness = 0.35;
  } else if (type === "glow") {
    m.emissive.copy(m.color);
    m.emissiveIntensity = (p.inten == null ? 0.6 : p.inten) * 1.6;
    if (hasUV) m.emissiveMap = texMap("glow", p); // 熔岩式明暗斑块
  }
  m.transparent = op < 1; // 半透明才开混合
  m.opacity = op;
  m.depthWrite = op >= 1;
  // 只有贴图身份真的变了才需要重编译着色器；纯改颜色/透明度每帧都会走到这里，
  // 不加这个判断动画播放时每帧强制 needsUpdate 会很卡（曾经的教训）
  if (m.map !== prevMap || m.envMap !== prevEnvMap || m.emissiveMap !== prevEmissiveMap) m.needsUpdate = true;
}

// 动画/播放专用的轻量透明度路径：只调 opacity/transparent/depthWrite，不碰贴图，
// 每帧调用零开销（不触发着色器重编译）。属性面板的透明度滑杆用完整路径 setMeshOpacity。
function applyFrameOpacity(o, v) {
  if (o.userData.kind === "text2d") return;
  o.userData.opacity = v;
  var m = o.material;
  if (!m) return;
  var factor = o.userData.kind === "line" ? 1 : textureOpacityFactor(o.userData.texture);
  var op = v * factor;
  m.opacity = op;
  m.transparent = op < 1;
  m.depthWrite = op >= 1;
}

// 物体"出现/消失"淡入淡出：factor 0→1 表示从无到有（乘在该物体各真实网格自己的
// 透明度上，含组合成员、含贴面文字——不走 applyFrameOpacity 是因为那个函数为其他
// 用途特意跳过贴面文字，这里需要统一处理）
function applyExistenceOpacity(o, factor) {
  collectStyleMeshes(o).forEach(function (m) {
    if (!m.material) return;
    var authored = m.userData.opacity != null ? m.userData.opacity : 1;
    var texFactor = (m.userData.kind === "line" || m.userData.kind === "text2d") ? 1 : textureOpacityFactor(m.userData.texture);
    var op = authored * texFactor * factor;
    m.material.opacity = op;
    // 贴面文字的 transparent 恒为 true（配合 alphaTest 做文字镂空），不能按透明度切换，
    // 否则淡入满值时 transparent 被关掉，镂空的混合边缘会变样
    if (m.userData.kind !== "text2d") {
      m.material.transparent = op < 1;
      m.material.depthWrite = op >= 1;
    }
  });
}

// 物体级纹理（贴面文字有自己的文字贴图，跳过）
function applyTexture(mesh) {
  if (!mesh.isMesh || mesh.userData.kind === "text2d" || mesh.userData.kind === "line") return;
  var hasUV = !!(mesh.geometry && mesh.geometry.attributes.uv);
  var op = mesh.userData.opacity != null ? mesh.userData.opacity : 1;
  applyTextureToMaterial(mesh.material, mesh.userData.texture, hasUV, op);
}

// 物体透明度（0=完全不可见）：line 直接设材质，其余交给纹理系统统一计算最终 opacity
function setMeshOpacity(mesh, v) {
  if (mesh.userData.kind === "text2d") return; // 贴面文字用自己的透明底逻辑，不受物体透明度控制
  mesh.userData.opacity = v;
  if (mesh.userData.kind === "line") {
    mesh.material.opacity = v;
    mesh.material.transparent = v < 1;
    mesh.material.needsUpdate = true;
  } else {
    applyTexture(mesh);
  }
}

function buildTextureSelect(sel) {
  Object.keys(TEXTURES).forEach(function (k) {
    var o = document.createElement("option");
    o.value = k;
    o.textContent = TEXTURES[k].label;
    sel.appendChild(o);
  });
}
buildTextureSelect($("prop-texture"));
buildTextureSelect($("face-texture"));

// 参数区：滑杆（0-1）与开关，改动即回调
function renderTextureParams(container, cfg, onChange) {
  container.innerHTML = "";
  if (!cfg || !TEXTURES[cfg.type] || !TEXTURES[cfg.type].params.length) return;
  TEXTURES[cfg.type].params.forEach(function (p) {
    if (p.bool) {
      var lab = document.createElement("label");
      lab.className = "check";
      var cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = !!cfg.params[p.key];
      cb.addEventListener("change", function () { cfg.params[p.key] = cb.checked; onChange(); });
      lab.appendChild(cb);
      lab.appendChild(document.createTextNode(p.label));
      container.appendChild(lab);
      return;
    }
    var field = document.createElement("div");
    field.className = "field slider";
    var label = document.createElement("label");
    var valSpan = document.createElement("span");
    valSpan.textContent = " " + (cfg.params[p.key] == null ? p.def : cfg.params[p.key]).toFixed(2);
    label.textContent = p.label;
    label.appendChild(valSpan);
    var input = document.createElement("input");
    input.type = "range";
    input.min = "0"; input.max = "1"; input.step = "0.05";
    input.value = cfg.params[p.key] == null ? p.def : cfg.params[p.key];
    input.addEventListener("input", function () {
      cfg.params[p.key] = parseFloat(input.value);
      valSpan.textContent = " " + cfg.params[p.key].toFixed(2);
      onChange();
    });
    field.appendChild(label);
    field.appendChild(input);
    container.appendChild(field);
  });
}

// 物体纹理 UI：下拉换类型（默认参数），参数改动应用到全部选中
function applyObjTextureToSelection() {
  var cfg = selected && selected.userData.texture;
  eachSelectedMesh(function (m) {
    // 持有者保留原引用（参数滑杆闭包在改它），其余成员深拷贝
    if (m.userData.texture !== cfg) m.userData.texture = cfg ? JSON.parse(JSON.stringify(cfg)) : null;
    applyTexture(m);
  });
  snapshot("改纹理");
}
var COLORED_MAP_TEXTURES = { wood: 1, marble: 1, water: 1 }; // 贴图自带真实颜色，物体色设白避免染混
$("prop-texture").addEventListener("change", function () {
  if (!selection.length || !selected) return;
  selected.userData.texture = this.value === "none" ? null : defaultTextureCfg(this.value);
  if (COLORED_MAP_TEXTURES[this.value]) {
    eachSelectedMaterial(function (m) { m.color.set("#ffffff"); });
    $("prop-color").value = "#ffffff";
  }
  renderTextureParams($("texture-params"), selected.userData.texture, applyObjTextureToSelection);
  applyObjTextureToSelection();
});

function refreshTextureUI() {
  var cfg = selected && selected.isMesh && selected.userData.texture;
  $("prop-texture").value = cfg ? cfg.type : "none";
  renderTextureParams($("texture-params"), cfg || null, applyObjTextureToSelection);
}

$("btn-pos-zero").addEventListener("click", function () {
  if (!selected) return;
  captureLockCenters();
  selected.position.set(0, 0, 0);
  enforceLocks([selected.userData.id]);
  snapshot("坐标归零");
  refreshTransformFields();
  toast("已归零到原点");
});

var SIZE_RESET_UI = 10; // 归一目标：长宽高各 10（界面单位）
$("btn-size-reset").addEventListener("click", function () {
  if (!selection.length) return;
  var target = SIZE_RESET_UI / UI_UNIT; // 界面单位 → 场景单位
  selection.forEach(function (o) {
    var size = localBounds(o).getSize(_vb);
    ["x", "y", "z"].forEach(function (ax) {
      if (size[ax] > 1e-6) o.scale[ax] = target / size[ax]; // 三轴独立设，忽略锁定比例
    });
  });
  if (selection.length > 1) refreshMultiPivot();
  snapshot("尺寸归一");
  refreshTransformFields();
  toast("尺寸已归一为 " + SIZE_RESET_UI);
});

// 物体边框（多选统一应用）
$("stroke-on").addEventListener("change", function () {
  if (!selection.length) return;
  var on = this.checked;
  eachSelectedMesh(function (m) {
    ensureStroke(m).enabled = on;
    applyStroke(m);
  });
  $("stroke-config").hidden = !on;
  snapshot((on ? "开启" : "关闭") + "边框");
});
function bindStrokeControl(id, key, parse) {
  $(id).addEventListener("change", function () {
    if (!selection.length) return;
    var v = parse ? parse(this.value) : this.value;
    if (key === "width") this.value = v;
    eachSelectedMesh(function (m) {
      ensureStroke(m)[key] = v;
      if (m.userData.stroke.enabled) applyStroke(m);
    });
    snapshot("改边框");
  });
}
bindStrokeControl("stroke-color", "color");
bindStrokeControl("stroke-width", "width", function (v) { return Math.min(12, Math.max(0.5, parseFloat(v) || 2)); });
bindStrokeControl("stroke-style", "style");

// 尺寸编辑：换算成对应轴的缩放（基于本地包围盒，与旋转无关）；多选时统一设置
function bindSizeInput(id, axis) {
  $(id).addEventListener("change", function () {
    var v = parseFloat(this.value) / UI_UNIT; // 界面整数单位 → 场景单位
    if (!selection.length || !(v > 0.001)) { refreshTransformFields(); return; }
    selection.forEach(function (o) {
      var base = localBounds(o).getSize(_vb)[axis];
      if (base < 1e-6) return;
      var newScale = v / base;
      if (o.userData.lockRatio && o.scale[axis] > 1e-9) {
        o.scale.multiplyScalar(newScale / o.scale[axis]); // 锁定比例：三轴联动
      } else {
        o.scale[axis] = newScale;
      }
    });
    if (selection.length > 1) refreshMultiPivot();
    snapshot("改尺寸");
    refreshTransformFields();
  });
}
bindSizeInput("prop-size-x", "x");
bindSizeInput("prop-size-z", "z");
bindSizeInput("prop-size-y", "y");

function bindPosInput(id, axis) {
  $(id).addEventListener("change", function () {
    if (!selected) return;
    var v = parseFloat(this.value) / UI_UNIT; // 界面整数单位 → 场景单位
    if (isNaN(v)) { refreshTransformFields(); return; }
    captureLockCenters(); // 修改前捕获基准，供对齐/分布锁算位移
    selected.position[axis] = v;
    enforceLocks([selected.userData.id]);
    snapshot("改坐标");
  });
}
bindPosInput("prop-pos-x", "x");
bindPosInput("prop-pos-y", "y");
bindPosInput("prop-pos-z", "z");

$("prop-anchor").addEventListener("change", function () {
  view.anchor = this.value;
  saveViewSettings();
  toast("吸附基准：" + this.options[this.selectedIndex].text);
});

$("prop-lock").addEventListener("change", function () {
  if (!selection.length) return;
  var on = this.checked;
  selection.forEach(function (o) { o.userData.lockRatio = on; });
  snapshot((on ? "开启" : "关闭") + "锁定比例");
});

// 随机扰动配置（多选时统一应用到全部选中）
$("jit-enabled").addEventListener("change", function () {
  if (!selection.length) return;
  var on = this.checked;
  selection.forEach(function (o) { ensureJitter(o).enabled = on; });
  $("jit-config").hidden = !on;
  snapshot((on ? "开启" : "关闭") + "随机扰动");
});
function bindJitterBox(id, axis) {
  $(id).addEventListener("change", function () {
    if (!selection.length) return;
    var v = Math.min(50, Math.max(0, parseFloat(this.value) || 0));
    selection.forEach(function (o) { ensureJitter(o).box[axis] = v; });
    this.value = v;
    snapshot("改扰动范围");
  });
}
bindJitterBox("jit-box-x", 0);
bindJitterBox("jit-box-z", 2);
bindJitterBox("jit-box-y", 1);
function bindJitterSlider(id, key, digits) {
  $(id).addEventListener("input", function () {
    if (!selection.length) return;
    var v = parseFloat(this.value);
    selection.forEach(function (o) { ensureJitter(o)[key] = v; });
    $(id + "-val").textContent = v.toFixed(digits);
  });
  $(id).addEventListener("change", function () { snapshot("改扰动" + (key === "speed" ? "速度" : "随机度")); });
}
bindJitterSlider("jit-speed", "speed", 1);
bindJitterSlider("jit-rand", "randomness", 2);

// ---------- 组合 / 解组 / 文字 ----------

function groupSelection() {
  if (selection.length < 2) { toast("先多选至少 2 个物体再组合"); return; }
  var box = new THREE.Box3();
  selection.forEach(function (o) { box.expandByObject(o); });
  var g = createGroupObject();
  box.getCenter(g.position); // 组的轴心放在整体包围盒中心
  g.updateMatrixWorld(true);
  selection.slice().forEach(function (o) { g.attach(o); }); // attach 保持世界位置不变
  select(g);
  snapshot("组合物体");
  toast("已组合为一个物体，可整体变换");
}

// 解除组合：把组内子物体提回 content（保持世界变换），删除空组，改选中这些子物体
function ungroupSelection() {
  var groups = selection.filter(function (o) { return o.userData.kind === "group"; });
  if (!groups.length) { toast("先选中一个组合"); return; }
  var freed = [];
  groups.forEach(function (g) {
    g.children.slice().forEach(function (c) {
      if (c.userData && c.userData.kind) { content.attach(c); freed.push(c); } // attach 保持世界位置
    });
    removeObject(g);
  });
  setSelection(freed);
  snapshot("解除组合");
  toast("已解除组合");
}

$("btn-group-toggle").addEventListener("click", function () {
  if (this.dataset.mode === "ungroup") ungroupSelection(); else groupSelection();
});

// ---------- 布尔相减：先选物体挖去后选物体的形状（three-bvh-csg） ----------
// 仅支持闭合实体网格；结果烘焙为 "csg" 类型（几何以扁平数组入 params，随存档/撤销/导出）
var CSG_KINDS = { box: 1, sphere: 1, cylinder: 1, cone: 1, torus: 1, extrude: 1, text3d: 1, csg: 1, trough: 1 };

function subtractSelection() {
  if (selection.length !== 2) { toast("先选中恰好 2 个物体（先选被减的，后选要挖去的）"); return; }
  var a = selection[0], b = selection[1];
  if (!CSG_KINDS[a.userData.kind] || !CSG_KINDS[b.userData.kind]) {
    toast("相减只支持实体（基础几何/挤出体/立体文字/布尔体/水槽），不支持组合、平面板和贴面文字");
    return;
  }
  a.updateMatrixWorld(true);
  b.updateMatrixWorld(true);
  var result;
  try {
    // 把世界变换烘进几何顶点（BufferGeometry.applyMatrix4），Brush 保持单位变换，
    // 求值结果即世界空间。注意不能用 Brush(Object3D).applyMatrix4——那只改物体变换
    // 不改顶点，缩放/位移会丢（踩过坑：相减后退回默认尺寸并跑回原点）。
    var gA = (a.userData.baseGeo || a.geometry).clone();
    var gB = (b.userData.baseGeo || b.geometry).clone();
    gA.applyMatrix4(a.matrixWorld);
    gB.applyMatrix4(b.matrixWorld);
    var brushA = new Brush(gA);
    var brushB = new Brush(gB);
    brushA.updateMatrixWorld(true);
    brushB.updateMatrixWorld(true);
    var evaluator = new Evaluator();
    evaluator.attributes = ["position", "normal"]; // 只保留两几何都有的属性
    result = evaluator.evaluate(brushA, brushB, SUBTRACTION);
    gA.dispose();
    gB.dispose();
  } catch (e) {
    toast("相减失败：" + (e.message || e));
    return;
  }
  var g = result.geometry;
  if (!g.attributes.position || !g.attributes.position.count) { toast("相减结果为空（两物体不相交或被完全挖掉）"); return; }
  if (g.index) g = g.toNonIndexed();
  // 结果几何在世界空间：以包围盒中心为新物体原点
  g.computeBoundingBox();
  var center = g.boundingBox.getCenter(new THREE.Vector3());
  g.translate(-center.x, -center.y, -center.z);
  var colorHex = "#" + a.material.color.getHexString();
  var params = {
    geo: {
      position: Array.from(g.attributes.position.array),
      normal: g.attributes.normal ? Array.from(g.attributes.normal.array) : null,
    },
  };
  removeObject(a);
  removeObject(b);
  var obj = createObject("csg", params);
  obj.material.color.set(colorHex);
  obj.position.copy(center);
  select(obj);
  snapshot("布尔相减");
  toast("已相减：生成布尔体（" + Math.round(g.attributes.position.count / 3) + " 三角面）");
}
$("btn-subtract").addEventListener("click", subtractSelection);
$("btn-layer-add").addEventListener("click", addLayer);
$("prop-layer").addEventListener("change", function () { moveSelectionToLayer(parseInt(this.value, 10)); });

function addText(kind) {
  exitDrawMode();
  // 贴面文字的挂接目标：优先选中的面（选面工具），其次当前选中物体的顶面
  var attach = null;
  if (kind === "text2d") {
    if (selectedFace) {
      var fm = selectedFace.mesh;
      var data = collectFaceTriangles(fm.geometry, selectedFace.n, selectedFace.d);
      if (data.count) {
        fm.updateMatrixWorld(true);
        attach = {
          parent: fm,
          pos: fm.localToWorld(data.centroid.clone()),
          normal: new THREE.Vector3().fromArray(selectedFace.n).transformDirection(fm.matrixWorld),
        };
      }
    } else if (selected) {
      var box = new THREE.Box3().setFromObject(selected);
      if (!box.isEmpty()) {
        var top = box.getCenter(new THREE.Vector3());
        top.y = box.max.y;
        attach = { parent: selected, pos: top, normal: new THREE.Vector3(0, 1, 0) };
      }
    }
  }
  var input = prompt(kind === "text3d" ? "立体文字内容（支持中文）：" : "贴面文字内容（支持中文）：", "飞天闪客");
  if (input == null) return;
  var text = input.trim();
  if (!text) return;
  var mesh;
  try {
    mesh = createObject(kind, kind === "text3d" ? { text: text, depth: 0.25 } : { text: text });
  } catch (e) {
    toast("文字生成失败：" + e.message);
    return;
  }
  if (attach) {
    // 贴到目标面：沿法线抬 0.01 防深度冲突，文字正面朝向法线，随后挂为子物体随父级移动
    mesh.position.copy(attach.pos).addScaledVector(attach.normal, 0.01);
    mesh.lookAt(_va.copy(attach.pos).addScaledVector(attach.normal, 2));
    mesh.scale.setScalar(0.5);
    attach.parent.attach(mesh); // attach 保持世界变换并转为父级局部坐标
    select(mesh);
    snapshot("添加" + KIND_LABELS[kind]);
    toast("文字已贴到所选表面，将随该物体移动");
    return;
  }
  restOnGround(mesh);
  select(mesh);
  snapshot("添加" + KIND_LABELS[kind]);
  toast("已添加" + KIND_LABELS[kind] + "，选中后可在属性面板改内容");
}

$("tool-text3d").addEventListener("click", function () { addText("text3d"); });
$("tool-text2d").addEventListener("click", function () { addText("text2d"); });

// ---------- 钢笔工具：下点 → 顶点/弧度编辑 → 挤出 ----------
// phase "place"：逐点下点；闭合后进入 phase "edit"：拖顶点（支持吸附）、
// 拖边中点手柄弯出二次贝塞尔弧度、单击边线加节点、Alt+点顶点删除；
// 「完成挤出」才真正生成 3D。钢笔模式下点选已有挤出体可重新进入编辑。

var groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
var vertexGeo = new THREE.SphereGeometry(0.075, 12, 8);
var midGeo = new THREE.SphereGeometry(0.055, 12, 8);
var vertexMat = new THREE.MeshBasicMaterial({ color: "#736B85" });
var midMat = new THREE.MeshBasicMaterial({ color: "#B98E84" });
var outlineMat = new THREE.LineBasicMaterial({ color: "#5F586F" });

var drawing = null;
// drawing = { phase, verts: [{pos: Vector3, cp: Vector3|null}], cursor,
//             group, line, handles: [], midHandles: [], dragging, editingMesh }
// vert.cp 是该顶点到下一顶点这条边的二次贝塞尔控制点（世界坐标，null=直线）

function groundPoint(clientX, clientY) {
  var rect = renderer.domElement.getBoundingClientRect();
  pointer.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
  var hit = new THREE.Vector3();
  return raycaster.ray.intersectPlane(groundPlane, hit) ? hit : null;
}

function snapGround(p) {
  if (snapOn) {
    p.x = Math.round(p.x / SNAP_STEP) * SNAP_STEP;
    p.z = Math.round(p.z / SNAP_STEP) * SNAP_STEP;
  }
  return p;
}

function enterDrawMode() {
  if (drawing) return;
  exitSketch();
  if (lineMode) setLineMode(false);
  if (marqueeMode) setMarqueeMode(false);
  if (faceMode) setFaceMode(false);
  select(null);
  drawing = {
    phase: "place", verts: [], cursor: null,
    group: new THREE.Group(), line: null,
    handles: [], midHandles: [], dragging: null, editingMesh: null,
  };
  scene.add(drawing.group);
  $("tool-draw").classList.add("active");
  $("draw-actions").classList.add("show");
  updateDrawUI();
}

function exitDrawMode() {
  if (!drawing) return;
  if (drawing.editingMesh) drawing.editingMesh.visible = true;
  if (drawing.line) drawing.line.geometry.dispose();
  scene.remove(drawing.group);
  drawing = null;
  controls.enabled = true;
  $("tool-draw").classList.remove("active");
  $("draw-actions").classList.remove("show");
  $("hintbar").textContent = "左键选择 · 拖动旋转视角 · 滚轮缩放 · 右键平移 · W/E/R 切换移动/旋转/缩放";
}

function updateDrawUI() {
  if (!drawing) return;
  if (drawing.phase === "place") {
    $("draw-hint").textContent = "逐点点击画轮廓 · 回车/双击/点回起点闭合 · 点已有挤出体可重新编辑";
    $("btn-draw-finish").textContent = "闭合";
    $("hintbar").textContent = "绘制模式：在地面逐点点击画轮廓（至少 3 点），闭合后进入顶点编辑 · Esc 取消 · 拖动仍可旋转视角";
  } else {
    $("draw-hint").textContent = "拖顶点移动 · 拖边中点弯曲 · 单击边线加节点 · Alt+点顶点删除";
    $("btn-draw-finish").textContent = "完成挤出";
    $("hintbar").textContent = "轮廓编辑：拖动顶点/边中点手柄（支持网格吸附）· 单击边线加节点 · Alt+点击顶点删除 · 回车或「完成挤出」生成 3D · Esc 取消";
  }
}

// —— 路径几何辅助 ——

function edgeVerts(i) {
  return [drawing.verts[i], drawing.verts[(i + 1) % drawing.verts.length]];
}

function quadPoint(a, cp, b, t, target) {
  var u = 1 - t;
  return target.set(
    u * u * a.x + 2 * u * t * cp.x + t * t * b.x,
    0,
    u * u * a.z + 2 * u * t * cp.z + t * t * b.z
  );
}

function sampleEdgeInto(i, out) {
  var pair = edgeVerts(i), a = pair[0], b = pair[1];
  if (!a.cp) { out.push(a.pos.clone()); return; }
  for (var s = 0; s < 24; s++) out.push(quadPoint(a.pos, a.cp, b.pos, s / 24, new THREE.Vector3()));
}

function edgeMidpoint(i, target) {
  var pair = edgeVerts(i), a = pair[0], b = pair[1];
  if (a.cp) return quadPoint(a.pos, a.cp, b.pos, 0.5, target);
  return target.copy(a.pos).add(b.pos).multiplyScalar(0.5);
}

function syncHandles(list, count, geo, mat, type) {
  while (list.length < count) {
    var h = new THREE.Mesh(geo, mat);
    h.userData = { handle: type, index: list.length };
    drawing.group.add(h);
    list.push(h);
  }
  while (list.length > count) drawing.group.remove(list.pop());
}

function refreshDrawVisuals() {
  var d = drawing;
  if (d.line) { d.group.remove(d.line); d.line.geometry.dispose(); d.line = null; }
  var pts = [];
  if (d.phase === "place") {
    d.verts.forEach(function (v) { pts.push(v.pos); });
    if (d.cursor) pts.push(d.cursor);
  } else {
    for (var i = 0; i < d.verts.length; i++) sampleEdgeInto(i, pts);
    if (d.verts.length) pts.push(d.verts[0].pos.clone());
  }
  if (pts.length >= 2) {
    var geo = new THREE.BufferGeometry().setFromPoints(
      pts.map(function (p) { return new THREE.Vector3(p.x, 0.03, p.z); })
    );
    d.line = new THREE.Line(geo, outlineMat);
    d.group.add(d.line);
  }
  syncHandles(d.handles, d.verts.length, vertexGeo, vertexMat, "vert");
  d.handles.forEach(function (h, i) {
    h.position.copy(d.verts[i].pos).setY(0.03);
    h.userData.index = i;
  });
  syncHandles(d.midHandles, d.phase === "edit" ? d.verts.length : 0, midGeo, midMat, "mid");
  d.midHandles.forEach(function (h, i) {
    edgeMidpoint(i, h.position);
    h.position.y = 0.03;
    h.userData.index = i;
  });
}

function pickHandle(clientX, clientY) {
  var rect = renderer.domElement.getBoundingClientRect();
  pointer.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
  var hits = raycaster.intersectObjects(drawing.handles.concat(drawing.midHandles), false);
  return hits.length ? hits[0].object : null;
}

// —— 下点与闭合 ——

function addDrawPoint(p) {
  if (drawing.verts.length >= 3 && p.distanceTo(drawing.verts[0].pos) < 0.18) { closePath(); return; }
  drawing.verts.push({ pos: p.clone().setY(0), cp: null });
  refreshDrawVisuals();
}

function closePath() {
  if (!drawing || drawing.phase !== "place") return;
  // 去掉双击等造成的近距离重复点（含首尾重合）
  var verts = [];
  drawing.verts.forEach(function (v) {
    if (!verts.length || v.pos.distanceTo(verts[verts.length - 1].pos) > 0.05) verts.push(v);
  });
  while (verts.length > 1 && verts[0].pos.distanceTo(verts[verts.length - 1].pos) < 0.05) verts.pop();
  if (verts.length < 3) { toast("至少需要 3 个不重合的点才能闭合"); return; }
  drawing.verts = verts;
  drawing.cursor = null;
  drawing.phase = "edit";
  refreshDrawVisuals();
  updateDrawUI();
}

// —— 顶点编辑 ——

function insertVertexNear(p) {
  var d = drawing, n = d.verts.length;
  for (var v = 0; v < n; v++) {
    if (p.distanceTo(d.verts[v].pos) < 0.15) return; // 离顶点太近不加，防双击重复插点
  }
  var best = null;
  var tmp = new THREE.Vector3(), seg = new THREE.Line3();
  for (var i = 0; i < n; i++) {
    var pair = edgeVerts(i), a = pair[0], b = pair[1];
    if (!a.cp) {
      seg.set(a.pos, b.pos);
      seg.closestPointToPoint(p, true, tmp);
      var dist = tmp.distanceTo(p);
      if (!best || dist < best.dist) {
        var t = a.pos.distanceTo(tmp) / Math.max(1e-9, a.pos.distanceTo(b.pos));
        best = { edge: i, t: t, dist: dist, point: tmp.clone() };
      }
    } else {
      for (var s = 1; s < 32; s++) {
        quadPoint(a.pos, a.cp, b.pos, s / 32, tmp);
        var dist2 = tmp.distanceTo(p);
        if (!best || dist2 < best.dist) best = { edge: i, t: s / 32, dist: dist2, point: tmp.clone() };
      }
    }
  }
  if (!best || best.dist > 0.2) return;
  var pair2 = edgeVerts(best.edge), a2 = pair2[0], b2 = pair2[1];
  if (!a2.cp) {
    d.verts.splice(best.edge + 1, 0, { pos: best.point.setY(0), cp: null });
  } else {
    // de Casteljau 在 t 处拆分二次贝塞尔，两段各自保持原曲线形状
    var t2 = best.t;
    var q0 = a2.pos.clone().lerp(a2.cp, t2);
    var q1 = a2.cp.clone().lerp(b2.pos, t2);
    var pt = q0.clone().lerp(q1, t2);
    d.verts.splice(best.edge + 1, 0, { pos: pt.setY(0), cp: q1 });
    a2.cp = q0;
  }
  refreshDrawVisuals();
  toast("已添加节点");
}

function deleteVertex(index) {
  if (drawing.verts.length <= 3) { toast("至少保留 3 个顶点"); return; }
  var prev = (index - 1 + drawing.verts.length) % drawing.verts.length;
  drawing.verts[prev].cp = null; // 相邻两条边并成一条直线
  drawing.verts.splice(index, 1);
  refreshDrawVisuals();
}

// —— 重新编辑已有挤出体 ——

function startEditExisting(mesh) {
  var params = mesh.userData.params;
  mesh.updateMatrixWorld(true);
  var toWorld = function (x, y) {
    var w = mesh.localToWorld(new THREE.Vector3(x, 0, -y));
    return new THREE.Vector3(w.x, 0, w.z);
  };
  drawing.editingMesh = mesh;
  drawing.phase = "edit";
  drawing.verts = (params.path
    ? params.path.map(function (p) {
        return { pos: toWorld(p.x, p.y), cp: p.cp ? toWorld(p.cp[0], p.cp[1]) : null };
      })
    : params.points.map(function (p) {
        return { pos: toWorld(p[0], p[1]), cp: null };
      }));
  $("draw-depth").value = params.depth;
  mesh.visible = false;
  tc.detach();
  refreshDrawVisuals();
  updateDrawUI();
  toast("正在编辑该图形的轮廓，完成后重新挤出");
}

// —— 完成挤出 ——

function finishShape() {
  var d = drawing;
  if (!d || d.phase !== "edit" || d.verts.length < 3) return;
  var depth = Math.min(20, Math.max(0.02, parseFloat($("draw-depth").value) || 0.4));
  var cx = 0, cz = 0;
  d.verts.forEach(function (v) { cx += v.pos.x; cz += v.pos.z; });
  cx /= d.verts.length; cz /= d.verts.length;
  // 轮廓以质心为原点存储（shape 空间 y = -世界 z 偏移），变换轴心落在形状中间
  var path = d.verts.map(function (v) {
    return {
      x: v.pos.x - cx,
      y: -(v.pos.z - cz),
      cp: v.cp ? [v.cp.x - cx, -(v.cp.z - cz)] : null,
    };
  });
  var params = { path: path, depth: depth };
  var mesh = d.editingMesh;
  if (mesh) {
    // 原位重建：保持 id/材质/关键帧关联，世界轮廓已烘焙进新几何，变换归零
    // 轮廓变了，旧的面样式（按平面记录）不再适用，清掉
    mesh.userData.params = params;
    mesh.userData.faces = null;
    setMeshGeometry(mesh, buildGeometry("extrude", params));
    mesh.position.x = cx;
    mesh.position.z = cz;
    mesh.rotation.set(0, 0, 0);
    mesh.scale.set(1, 1, 1);
    mesh.visible = true;
  } else {
    mesh = createObject("extrude", params);
    mesh.position.set(cx, 0, cz);
  }
  exitDrawMode();
  select(mesh);
  snapshot(d && d.editingMesh ? "改轮廓" : "挤出自定义形状");
  toast(d && d.editingMesh ? "轮廓已更新" : "已挤出自定义形状（厚度 " + depth + "）");
}

function drawPrimaryAction() {
  if (!drawing) return;
  if (drawing.phase === "place") closePath();
  else finishShape();
}

// ---------- 指针事件（选择 / 下点 / 手柄拖动，区分点击与拖动视角） ----------

var downPos = null;

renderer.domElement.addEventListener("pointerdown", function (e) {
  if (e.button !== 0) return;
  if (sketching) { sketchDown(e); return; } // 画板模式：左键绘制
  if (!playback && !exporting && selectedLine()) {
    var lh = pickLineHandle(e.clientX, e.clientY);
    if (lh) {
      downPos = null;
      if (lh.userData.lh === "node") {
        if (e.altKey) { deleteLineNode(lh.userData.index); return; }
        lineDragging = { obj: selectedLine(), index: lh.userData.index, plane: new THREE.Plane(new THREE.Vector3(0, 1, 0), -lh.position.y) };
        controls.enabled = false;
        try { renderer.domElement.setPointerCapture(e.pointerId); } catch (err) { /* 合成指针无捕获目标时忽略 */ }
      } else {
        insertLineNode(lh.userData.index);
      }
      return;
    }
  }
  downPos = { x: e.clientX, y: e.clientY };
  if (drawing && drawing.phase === "edit" && !playback && !exporting) {
    var h = pickHandle(e.clientX, e.clientY);
    if (h) {
      downPos = null;
      if (e.altKey && h.userData.handle === "vert") { deleteVertex(h.userData.index); return; }
      drawing.dragging = { type: h.userData.handle, index: h.userData.index };
      controls.enabled = false;
      renderer.domElement.setPointerCapture(e.pointerId);
    }
  }
});

renderer.domElement.addEventListener("pointermove", function (e) {
  if (sketching) { sketchMove(e); return; } // 画笔/拖文字/悬停光标
  if (lineDragging) {
    var lrect = renderer.domElement.getBoundingClientRect();
    pointer.set(((e.clientX - lrect.left) / lrect.width) * 2 - 1, -((e.clientY - lrect.top) / lrect.height) * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    var lhit = new THREE.Vector3();
    if (raycaster.ray.intersectPlane(lineDragging.plane, lhit)) {
      var lp = lineDragging.obj.worldToLocal(lhit.clone());
      var node = lineDragging.obj.userData.params.pts[lineDragging.index];
      node.p = [lp.x, node.p[1], lp.z]; // 水平面内拖动，竖直坐标用输入框改
      rebuildLine(lineDragging.obj);
    }
    return;
  }
  if (marqueeMode && !drawing && downPos && !tc.dragging) {
    if (marqueeBox || Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y) > 5) updateMarquee(e);
    return;
  }
  if (!drawing) return;
  if (drawing.dragging) {
    var p = groundPoint(e.clientX, e.clientY);
    if (!p) return;
    snapGround(p).setY(0);
    var drag = drawing.dragging;
    if (drag.type === "vert") {
      drawing.verts[drag.index].pos.copy(p);
    } else {
      var pair = edgeVerts(drag.index), a = pair[0], b = pair[1];
      // 手柄即曲线中点：CP = 2M − (P0+P1)/2；拖回直线中点附近则恢复直线
      var straightMid = a.pos.clone().add(b.pos).multiplyScalar(0.5);
      if (p.distanceTo(straightMid) < 0.06) a.cp = null;
      else a.cp = new THREE.Vector3(2 * p.x - straightMid.x, 0, 2 * p.z - straightMid.z);
    }
    refreshDrawVisuals();
    return;
  }
  if (drawing.phase === "place" && drawing.verts.length) {
    var c = groundPoint(e.clientX, e.clientY);
    if (c) { drawing.cursor = snapGround(c).setY(0); refreshDrawVisuals(); }
  }
});

renderer.domElement.addEventListener("pointerup", function (e) {
  if (e.button !== 0) return;
  if (sketching) { if (sketching.active || sketching.dragText) sketchUp(); return; }
  if (lineDragging) {
    lineDragging = null;
    controls.enabled = true;
    refreshLineProps();
    snapshot("改线条节点");
    return;
  }
  if (drawing && drawing.dragging) {
    drawing.dragging = null;
    controls.enabled = true;
    return;
  }
  if (marqueeBox) {
    var picked = objectsInScreenRect(marqueeBox);
    hideMarquee();
    downPos = null;
    setSelection(e.shiftKey ? selection.concat(picked) : picked);
    return;
  }
  if (!downPos) return;
  var moved = Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y);
  downPos = null;
  if (moved > 5 || tc.dragging || playback || exporting) return; // 是拖动视角/手柄，不是点击
  if (drawing) {
    if (drawing.phase === "place") {
      if (!drawing.verts.length) {
        // 还没下点时点中已有挤出体 → 重新编辑它
        var hit = pickAt(e.clientX, e.clientY);
        if (hit && hit.userData.kind === "extrude") { startEditExisting(hit); return; }
      }
      var p = groundPoint(e.clientX, e.clientY);
      if (p) addDrawPoint(snapGround(p).setY(0));
    } else {
      var q = groundPoint(e.clientX, e.clientY);
      if (q) insertVertexNear(q.setY(0));
    }
    return;
  }
  if (lineMode) {
    var lpnt = groundPoint(e.clientX, e.clientY);
    if (!lpnt) return;
    snapGround(lpnt);
    if (!lineStart) { lineStart = lpnt.clone(); toast("再点击终点完成线条"); return; }
    var lineObj = createObject("line", {
      pts: [
        { p: [lineStart.x, 0.02, lineStart.z], smooth: false },
        { p: [lpnt.x, 0.02, lpnt.z], smooth: false },
      ],
      width: 4,
    });
    setLineMode(false);
    select(lineObj);
    snapshot("添加线条");
    toast("线条已创建：拖节点调形，双击线上加节点");
    return;
  }
  if (faceMode) {
    handleFacePick(e.clientX, e.clientY);
    return;
  }
  var hit = pickAt(e.clientX, e.clientY);
  if (e.shiftKey || marqueeMode) {
    // 连续多选：点物体累加/取消；框选模式点空白清空（Shift 点空白不清）
    if (hit) toggleSelect(hit);
    else if (!e.shiftKey) select(null);
  } else {
    select(hit);
  }
});

renderer.domElement.addEventListener("dblclick", function (e) {
  if (drawing && drawing.phase === "place") { closePath(); return; }
  if (selectedLine()) {
    var lh = pickLineHandle(e.clientX, e.clientY);
    if (lh && lh.userData.lh === "node") {
      var pts = selectedLine().userData.params.pts;
      var i = lh.userData.index;
      if (i === 0 || i === pts.length - 1) { toast("端点无弯曲，双击中间节点切换"); return; }
      pts[i].smooth = !pts[i].smooth;
      rebuildLine(selectedLine());
      snapshot("改线条节点");
      toast(pts[i].smooth ? "节点已设为平滑过渡" : "节点已设为折角");
    }
  }
});

// ---------- 关键帧动画 ----------

// preserveAbsence=true：跳过 existsHere===false 的物体（写回某一帧时，不能把"这一帧本不存在"
// 的物体重新写进去，否则编辑别的东西会悄悄把它带回来，抹掉出现/消失动画）
function captureKeyframe(preserveAbsence) {
  var objects = {};
  content.children.forEach(function (o) {
    if (preserveAbsence && o.userData.existsHere === false) return;
    var st = { p: o.position.toArray(), q: o.quaternion.toArray(), s: o.scale.toArray() };
    if (o.userData.kind !== "group" && o.material) {
      st.c = "#" + o.material.color.getHexString();
      st.op = o.userData.opacity != null ? o.userData.opacity : 1;
    }
    objects[o.userData.id] = st;
  });
  return {
    duration: DEFAULT_TRANSITION,
    camera: { p: camera.position.toArray(), t: controls.target.toArray() },
    objects: objects,
  };
}

// 镜头锁定链：camLock=true 的帧视角跟随上一帧，连续锁定则一路上溯到链首帧
function effectiveCameraOf(kf) {
  var i = keyframes.indexOf(kf);
  if (i === -1) return kf.camera; // 播放前姿态等临时帧
  while (i > 0 && keyframes[i].camLock) i--;
  return keyframes[i].camera;
}

function applyKeyframe(kf) {
  content.children.forEach(function (o) {
    var st = kf.objects[o.userData.id];
    o.userData.existsHere = !!st; // 记录"这个物体属不属于当前展示的这一帧"，供写回时判断
    o.visible = objVisibleForFrame(o, !!st);
    if (!st) return;
    o.position.fromArray(st.p);
    o.quaternion.fromArray(st.q);
    o.scale.fromArray(st.s);
    if (st.c != null && o.material) o.material.color.set(st.c);
    if (st.op != null) applyFrameOpacity(o, st.op);
  });
  var cam = effectiveCameraOf(kf);
  camera.position.fromArray(cam.p);
  controls.target.fromArray(cam.t);
  controls.update();
}

// 当前定位到的关键帧（-1 = 不在任何帧上）。定位后所有编辑直接写回该帧（类似幻灯片编辑）
var activeKf = -1;
// 当前定位到当前帧动作列表里的哪一条（-1 = 无）。动作区的「播放」只播这一条，
// 「下一步」跳到下一条并播它（不出当前帧）；行高亮显示定位，点行即定位
var activeAction = -1;
function renderKfHighlight() {
  var items = $("kf-list").children;
  for (var k = 0; k < items.length; k++) items[k].classList.toggle("active", k === activeKf);
}
function markActiveKf(i) {
  activeKf = i;
  renderKfHighlight();
  renderActions(); // 动作列表跟着"当前定位在哪一帧"走
}

// 帧锁定：锁定的帧定位上去之后视角和物体都不能动，防止误操作。isSelectable/writeBackActiveFrame
// 两处兜底拦截编辑；这里只负责镜头——只主动禁用（设 false），从不主动启用，因为
// controls.enabled 还被播放/导出/画板/变换手柄等好几处场景临时借用，抢着置 true 会互相打架；
// 每帧渲染循环都会重新拦一次，稳赢：只要还锁着，别处刚置的 true 下一帧就被摁回 false。
function isActiveFrameLocked() {
  return activeKf !== -1 && !!(keyframes[activeKf] && keyframes[activeKf].locked);
}
function syncFrameLockControls() {
  controls.enabled = !isActiveFrameLocked();
}

function writeBackActiveFrame() {
  if (activeKf === -1 || !keyframes[activeKf]) return;
  if (keyframes[activeKf].locked) return; // 锁定帧禁止写回，兜底防误改（正常情况下也选不中物体）
  // 主动选中一个"这一帧本不存在"的物体并编辑它，视为明确意图：让它从这一帧开始存在
  selection.forEach(function (o) { o.userData.existsHere = true; });
  // 原地更新而非整体替换：帧列表各行（过渡输入框等）闭包持有帧对象引用，
  // 替换对象会让它们改到孤儿数据上，表现为过渡时长"自己变回去"
  var fresh = captureKeyframe(true); // 保留"不属于这一帧"的物体缺席，不被顺手带回来
  var kf = keyframes[activeKf];
  if (!kf.camLock) kf.camera = fresh.camera; // 锁定帧的视角由链首决定，本帧相机数据不更新
  kf.objects = fresh.objects;
  // duration 保持用户设置不变
}

// 相机拖动（一次完整拖拽只在松手时触发一次 "end"，不是逐像素触发）现在也计一步撤销，
// 跟变换手柄拖物体、拖线条节点这些"一次拖拽=一步历史"的操作保持同一套规则——早期版本图
// 省事只做 writeBackActiveFrame+存 localStorage、不进 undoStack，结果切到别的帧后撤销会
// 直接跳过这次调镜头，回到"进这一帧时"而不是"调完镜头、离开这一帧前"那一刻（踩过坑，
// 用户反馈"撤销的时候镜头视角没有跟着退回去"）。
controls.addEventListener("end", function () {
  if (activeKf === -1 || playback || exporting) return;
  snapshot("改镜头视角");
});

function locateKf(i) {
  if (playback || exporting || !keyframes[i]) return;
  applyKeyframe(keyframes[i]);
  // 定位后若选中物体在这一帧不存在（已被隐藏），取消选中，避免变换手柄挂在看不见的物体上
  if (selection.some(function (o) { return !o.visible; })) {
    setSelection(selection.filter(function (o) { return o.visible; }));
  }
  markActiveKf(i);
  if (keyframes[i].locked) setSelection([]); // 锁定帧不允许选中/操作任何物体
  syncFrameLockControls(); // 处理"从锁定帧切到未锁定帧"要立即放开镜头的情况
  snapshot("定位到帧 " + (i + 1));
  refreshProps();
  toast(keyframes[i].locked ? "已定位到帧 " + (i + 1) + "（已锁定，视角与物体均不可编辑）" : "已定位到帧 " + (i + 1) + "，编辑将直接保存进此帧");
}

// 列表拖拽把手排序通用件（关键帧列表 / 动作列表共用）：拖动行跟随指针，其余行平滑让位
// （transform 过渡），松手滑入目标槽位后调 onCommit(from, to) 提交数据修改；
// from===to 表示未移动，回调只需重渲染清掉临时位移
function startListDrag(e, li, index, listEl, onCommit) {
  if (playback || exporting) return;
  e.preventDefault();
  var grip = e.currentTarget;
  var items = Array.prototype.slice.call(listEl.children);
  var mids = items.map(function (el) {
    var r = el.getBoundingClientRect();
    return r.top + r.height / 2;
  });
  var H = li.offsetHeight + 6; // 行高 + 行间距
  var startY = e.clientY;
  var target = index;
  li.classList.add("kf-dragging");
  items.forEach(function (el) { if (el !== li) el.classList.add("kf-anim"); });
  grip.setPointerCapture(e.pointerId);

  function onMove(ev) {
    li.style.transform = "translateY(" + (ev.clientY - startY) + "px)";
    var c = 0;
    for (var k = 0; k < items.length; k++) {
      if (k !== index && ev.clientY > mids[k]) c++;
    }
    target = c;
    items.forEach(function (el, k) {
      if (k === index) return;
      var shift = 0;
      if (k > index && k <= target) shift = -H;
      else if (k < index && k >= target) shift = H;
      el.style.transform = shift ? "translateY(" + shift + "px)" : "";
    });
  }

  function onUp() {
    grip.removeEventListener("pointermove", onMove);
    grip.removeEventListener("pointerup", onUp);
    grip.removeEventListener("pointercancel", onUp);
    li.classList.remove("kf-dragging");
    li.classList.add("kf-anim");
    li.style.transform = "translateY(" + (target - index) * H + "px)"; // 滑入目标槽位
    setTimeout(function () { onCommit(index, target); }, 170);
  }

  grip.addEventListener("pointermove", onMove);
  grip.addEventListener("pointerup", onUp);
  grip.addEventListener("pointercancel", onUp);
}

var ICON_DEL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>';
var ICON_DUP = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
var ICON_GRIP = '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><circle cx="9" cy="5.5" r="1.6"/><circle cx="15" cy="5.5" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18.5" r="1.6"/><circle cx="15" cy="18.5" r="1.6"/></svg>';
var ICON_LINK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>';

// 只要存在关键帧，必须始终有一帧处于选中：默认第一帧。软定位——只标记不套用帧画面，
// 当前画面保留，下一次编辑就写入该帧（杜绝"无帧选中时编辑、点帧后编辑丢失"）。
function ensureActiveKf() {
  if (!keyframes.length) { activeKf = -1; return; }
  if (activeKf < 0 || activeKf >= keyframes.length) activeKf = 0;
}

function renderKeyframes() {
  ensureActiveKf();
  var list = $("kf-list");
  list.innerHTML = "";
  if (!keyframes.length) {
    var empty = document.createElement("li");
    empty.className = "kf-empty";
    empty.textContent = "还没有关键帧";
    list.appendChild(empty);
    renderActions();
    return;
  }
  keyframes.forEach(function (kf, i) {
    var li = document.createElement("li");
    li.title = "点击定位到此帧，之后的编辑直接保存进这一帧";
    li.addEventListener("click", function () { locateKf(i); });
    var grip = document.createElement("span");
    grip.className = "kf-grip";
    grip.title = "拖拽调整顺序";
    grip.innerHTML = ICON_GRIP;
    grip.addEventListener("click", function (e) { e.stopPropagation(); }); // 拖完不触发行定位
    grip.addEventListener("pointerdown", function (e) {
      if (e.button !== 0) return;
      e.stopPropagation();
      startListDrag(e, li, i, $("kf-list"), function (from, to) {
        if (from !== to) {
          var kf = keyframes.splice(from, 1)[0];
          keyframes.splice(to, 0, kf);
          if (activeKf === from) activeKf = to;
          else if (from < activeKf && activeKf <= to) activeKf--;
          else if (to <= activeKf && activeKf < from) activeKf++;
          renderKeyframes();
          snapshot("调整帧顺序");
          toast("已移动到第 " + (to + 1) + " 位");
        } else {
          renderKeyframes(); // 未移动，清掉临时位移
        }
      });
    });
    li.appendChild(grip);
    var name = document.createElement("span");
    name.className = "kf-name";
    name.textContent = "帧 " + (i + 1);
    li.appendChild(name);
    if (i > 0) {
      var dur = document.createElement("span");
      dur.className = "kf-dur";
      dur.innerHTML = "过渡";
      var input = document.createElement("input");
      input.type = "number";
      input.min = "0.2"; input.max = "30"; input.step = "0.1";
      input.value = kf.duration;
      input.addEventListener("click", function (e) { e.stopPropagation(); });
      input.addEventListener("change", function () {
        kf.duration = Math.min(30, Math.max(0.2, parseFloat(this.value) || DEFAULT_TRANSITION));
        this.value = kf.duration;
        snapshot("改过渡时长");
      });
      dur.appendChild(input);
      dur.appendChild(document.createTextNode("s"));
      li.appendChild(dur);
    }
    var actions = [
      [ICON_DUP, "复制此帧（插入到下一位）", function () {
        keyframes.splice(i + 1, 0, JSON.parse(JSON.stringify(kf)));
        if (activeKf > i) activeKf++;
        renderKeyframes();
        snapshot("复制帧 " + (i + 1));
        toast("已复制为帧 " + (i + 2));
      }],
    ];
    actions.push([ICON_DEL, "删除此帧", function () {
      keyframes.splice(i, 1);
      if (activeKf === i) {
        // 删除当前所在帧：硬定位到邻帧（套用其画面），保证始终有帧被选中
        activeKf = Math.min(i, keyframes.length - 1);
        if (activeKf >= 0) applyKeyframe(keyframes[activeKf]);
      } else if (activeKf > i) activeKf--;
      syncFrameLockControls(); // 删的可能正是锁定帧，落到邻帧要重新算镜头能不能动
      renderKeyframes();
      snapshot("删除帧 " + (i + 1));
    }]);
    actions.forEach(function (def) {
      var b = document.createElement("button");
      b.innerHTML = def[0];
      b.title = def[1];
      b.addEventListener("click", function (e) {
        e.stopPropagation(); // 不触发行点击定位
        def[2]();
      });
      li.appendChild(b);
    });
    // 帧锁定：锁定后定位到此帧时视角和物体都不可编辑，防止回顾/演示时手滑改动内容
    var frameLock = document.createElement("button");
    frameLock.className = "kf-lock" + (kf.locked ? " on" : "");
    frameLock.title = kf.locked
      ? "此帧已锁定：定位到这一帧时视角和物体都无法编辑（点击解锁）"
      : "锁定此帧：定位到这一帧时视角和物体都不能被改动";
    frameLock.innerHTML = kf.locked ? ICON_LOCK_ON : ICON_LOCK_OFF;
    frameLock.addEventListener("click", function (e) {
      e.stopPropagation();
      kf.locked = !kf.locked;
      if (activeKf === i) {
        if (kf.locked) select(null);
        syncFrameLockControls();
      }
      renderKeyframes();
      snapshot((kf.locked ? "锁定" : "解锁") + "帧 " + (i + 1));
      toast(kf.locked ? "已锁定帧 " + (i + 1) + "：视角与物体均不可编辑" : "已解锁帧 " + (i + 1));
    });
    li.appendChild(frameLock);
    // 最右侧：镜头锁定连接线（视角与上一帧保持一致；上一帧也锁定时继续向上取实际视角）
    if (i > 0) {
      var link = document.createElement("button");
      link.className = "kf-link" + (kf.camLock ? " on" : "");
      link.title = kf.camLock
        ? "镜头已锁定：此帧视角与上一帧一致，播放时镜头不动（点击解除）"
        : "锁定镜头：让此帧视角与上一帧保持一致";
      link.innerHTML = ICON_LINK;
      link.addEventListener("click", function (e) {
        e.stopPropagation();
        kf.camLock = !kf.camLock;
        renderKeyframes();
        snapshot((kf.camLock ? "锁定" : "解除") + "帧 " + (i + 1) + " 镜头锁定");
        if (activeKf === i) applyKeyframe(kf); // 正位于此帧：立即切到生效视角
        toast(kf.camLock ? "已锁定：帧 " + (i + 1) + " 视角跟随帧 " + i : "已解除镜头锁定");
      });
      li.appendChild(link);
    } else {
      var slot = document.createElement("span");
      slot.className = "kf-link spacer"; // 首帧占位对齐
      li.appendChild(slot);
    }
    list.appendChild(li);
  });
  renderKfHighlight();
  renderActions();
}

// 物体动作列表：显示"当前定位的这一帧"上挂的动作，顺序即播放顺序。这里定义在
// 当前帧有动作时始终定位一条（默认第一条；切帧/删动作后越界自动落回），没有动作则为 -1
function ensureActiveAction() {
  var kf = activeKf !== -1 ? keyframes[activeKf] : null;
  var n = kf && kf.actions ? kf.actions.length : 0;
  if (!n) { activeAction = -1; return; }
  if (activeAction < 0 || activeAction >= n) activeAction = 0;
}

// ACTION_DEFS/findTopObject（后面 stepPlayback 附近）之后才用得到，靠函数声明整体提升不受影响
function renderActions() {
  var addField = $("action-add-field");
  var emptyHint = $("action-empty-hint");
  var list = $("action-list");
  if (!addField || !list) return;
  var kf = activeKf !== -1 ? keyframes[activeKf] : null;
  var canAdd = !!kf && selection.length === 1 && !!selected && !!(kf.objects && kf.objects[selected.userData.id]);
  addField.hidden = !canAdd;
  var actions = kf ? (kf.actions || []) : [];
  emptyHint.hidden = canAdd || actions.length > 0;
  emptyHint.textContent = !kf
    ? "选中一个物体、且已定位到某一帧，才能添加动作。"
    : "选中该帧里的一个物体，才能给它添加动作。";
  list.innerHTML = "";
  ensureActiveAction();
  if (!kf) { syncActionPlayButtons(); return; }
  actions.forEach(function (a, i) {
    var li = document.createElement("li");
    if (i === activeAction) li.classList.add("active"); // 当前定位的动作
    li.title = "点击定位到此动作，「播放」只播这一条";
    li.addEventListener("click", function () {
      if (i === activeAction) return;
      activeAction = i;
      renderActions();
    });
    // 左侧拖拽把手：跟关键帧行同一套拖拽排序（startListDrag 通用件）
    var grip = document.createElement("span");
    grip.className = "kf-grip";
    grip.title = "拖拽调整顺序";
    grip.innerHTML = ICON_GRIP;
    grip.addEventListener("click", function (e) { e.stopPropagation(); });
    grip.addEventListener("pointerdown", function (e) {
      if (e.button !== 0) return;
      e.stopPropagation();
      startListDrag(e, li, i, list, function (from, to) {
        if (from !== to) {
          actions.splice(to, 0, actions.splice(from, 1)[0]);
          // 定位跟随被拖的行（跟关键帧的 activeKf 修正同一套换算）
          if (activeAction === from) activeAction = to;
          else if (from < activeAction && activeAction <= to) activeAction--;
          else if (to <= activeAction && activeAction < from) activeAction++;
          snapshot("调整动作顺序");
        }
        renderActions(); // 移动与否都重渲染：清掉拖拽的临时位移
      });
    });
    li.appendChild(grip);

    var obj = findTopObject(a.objId);
    var name = document.createElement("span");
    name.className = "kf-name";
    name.textContent = (i + 1) + ". " + (obj ? (KIND_LABELS[obj.userData.kind] + " · " + obj.name) : "（物体已不存在）");
    name.title = name.textContent; // 行内空间有限名称会截断，悬浮看全名
    li.appendChild(name);

    // 动作类型：行内下拉直接改
    var typeSel = document.createElement("select");
    typeSel.className = "action-type";
    Object.keys(ACTION_DEFS).forEach(function (k) {
      var opt = document.createElement("option");
      opt.value = k;
      opt.textContent = ACTION_DEFS[k].label;
      typeSel.appendChild(opt);
    });
    typeSel.value = a.type;
    typeSel.addEventListener("click", function (e) { e.stopPropagation(); });
    typeSel.addEventListener("change", function () {
      a.type = this.value;
      snapshot("改动作类型");
      renderActions(); // 时间默认值跟新类型走（未手动设过时长的前提下）
    });
    li.appendChild(typeSel);

    var del = document.createElement("button");
    del.innerHTML = ICON_DEL;
    del.title = "删除此动作";
    del.addEventListener("click", function (e) {
      e.stopPropagation();
      actions.splice(i, 1);
      renderActions();
      snapshot("删除动作");
    });
    li.appendChild(del);

    // 每个动作的参数：时间（单遍秒数）/ 次数（重复遍数）/ 幅度（强度系数）。
    // 缺省即默认值（旧存档没有这几个字段也能正常读取）；参数单独占第二行（一行塞不下）
    var params = document.createElement("div");
    params.className = "action-params";
    [
      { label: "时间", key: "duration", val: a.duration || ACTION_DEFS[a.type].duration, min: 0.1, max: 30, step: 0.1, tip: "单遍时长（秒）；次数 >1 时总时长 = 单遍 × 次数" },
      { label: "次数", key: "count", val: a.count || 1, min: 1, max: 20, step: 1, tip: "重复播放次数" },
      { label: "幅度", key: "amp", val: a.amp == null ? 1 : a.amp, min: 0.1, max: 5, step: 0.1, tip: "强度系数：抖动/弹跳/缩放的动作幅度，闪烁的亮度（1 为原默认）" },
    ].forEach(function (def) {
      var field = document.createElement("span");
      field.className = "kf-dur";
      field.title = def.tip;
      field.textContent = def.label;
      var input = document.createElement("input");
      input.type = "number";
      input.min = def.min; input.max = def.max; input.step = def.step;
      input.value = def.val;
      input.addEventListener("click", function (e) { e.stopPropagation(); });
      input.addEventListener("change", function () {
        var v = Math.min(def.max, Math.max(def.min, parseFloat(this.value) || def.val));
        if (def.step === 1) v = Math.round(v); // 次数为整数
        this.value = v;
        a[def.key] = v;
        snapshot("改动作" + def.label);
      });
      field.appendChild(input);
      params.appendChild(field);
    });
    // 启动时机（第一个动作无此项）：默认「等播完」——上一个动作结束后再播；
    // 选「开始后」则在上一个动作开始后 N 秒启动（0 = 与上一个同步并行）
    if (i > 0) {
      var dField = document.createElement("span");
      dField.className = "kf-dur";
      dField.title = "下一个动作在上一个动作开始后多少秒启动；「等播完」= 上一个结束后再播（默认）；0 秒 = 与上一个同步";
      dField.textContent = "启动";
      var dSel = document.createElement("select");
      dSel.className = "action-delay";
      [["after", "等播完"], ["delay", "开始后"]].forEach(function (pair) {
        var o = document.createElement("option");
        o.value = pair[0];
        o.textContent = pair[1];
        dSel.appendChild(o);
      });
      dSel.value = a.delay != null ? "delay" : "after";
      var dInput = document.createElement("input");
      dInput.type = "number";
      dInput.min = "0"; dInput.max = "30"; dInput.step = "0.1";
      dInput.value = a.delay != null ? a.delay : 0;
      dInput.style.display = a.delay != null ? "" : "none";
      dSel.addEventListener("click", function (e) { e.stopPropagation(); });
      dInput.addEventListener("click", function (e) { e.stopPropagation(); });
      dSel.addEventListener("change", function () {
        if (this.value === "after") {
          delete a.delay;
          dInput.style.display = "none";
        } else {
          a.delay = Math.min(30, Math.max(0, parseFloat(dInput.value) || 0));
          dInput.value = a.delay;
          dInput.style.display = "";
        }
        snapshot("改动作启动");
      });
      dInput.addEventListener("change", function () {
        a.delay = Math.min(30, Math.max(0, parseFloat(this.value) || 0));
        this.value = a.delay;
        snapshot("改动作启动");
      });
      dField.appendChild(dSel);
      dField.appendChild(dInput);
      params.appendChild(dField);
    }
    li.appendChild(params);

    list.appendChild(li);
  });
  syncActionPlayButtons();
}

$("btn-action-add").addEventListener("click", function () {
  if (activeKf === -1 || !keyframes[activeKf]) return;
  if (selection.length !== 1 || !selected) return;
  var kf = keyframes[activeKf];
  if (!kf.objects[selected.userData.id]) { toast("这个物体在当前帧不存在，无法添加动作"); return; }
  var type = $("action-type-select").value;
  if (!kf.actions) kf.actions = [];
  kf.actions.push({ objId: selected.userData.id, type: type });
  renderActions();
  snapshot("添加动作：" + ACTION_DEFS[type].label);
  toast("已添加动作：" + ACTION_DEFS[type].label);
});

$("btn-add-keyframe").addEventListener("click", function () {
  keyframes.push(captureKeyframe());
  // 新帧是当前场景的完整快照，场景里现存的一切都属于这一帧——刷新存在标记与可见性，
  // 否则之前定位在某帧时被隐藏的物体，会在这个新帧里继续误判为"不存在"
  content.children.forEach(function (o) { o.userData.existsHere = true; o.visible = objVisibleForFrame(o, true); });
  activeKf = keyframes.length - 1; // 先定位到新帧，快照的写回就落在新帧上，不碰前一帧
  renderKeyframes();
  snapshot("记录关键帧 " + keyframes.length);
  toast("已记录关键帧 " + keyframes.length + "（含相机视角）");
});

// 播放：关键帧之间位置 lerp、旋转 slerp、相机位置与视点 lerp，缓入缓出
var playback = null; // { start, segments, index, onDone }
var _va = new THREE.Vector3(), _vb = new THREE.Vector3();
var _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion();

var prePlayPose = null; // 播放前的现场：播放是预览，结束后恢复
var prePlayActiveKf = -1;

// 恢复播放/导出前的编辑现场：若当时正定位在某一帧，直接重新套用那一帧的数据
// （正确重算每个物体的存在性/可见性）；不能用播放前拍的"完整快照"覆盖——那份快照
// 是不分存在与否的全量截取，连当时因不属于该帧而隐藏的物体也会被当场救活，
// 之后随手一编辑就会被写回帧数据，物体从此"哪帧都有了"（真实踩过的坑）。
// 只有播放前根本没定位在任何帧（自由编辑态）时，才退回这份快照本身。
function restoreEditingPose(pose, atFrame) {
  if (atFrame !== -1 && keyframes[atFrame]) applyKeyframe(keyframes[atFrame]);
  else if (pose) applyKeyframe(pose);
}

function restorePlaybackPose() {
  restoreEditingPose(prePlayPose, prePlayActiveKf);
  prePlayPose = null;
  markActiveKf(prePlayActiveKf); // 回到播放前所在的帧
  prePlayActiveKf = -1;
  refreshProps();
}

function startPlayback(onDone, fromIndex) {
  if (keyframes.length < 2) { toast("至少需要 2 个关键帧才能播放"); return false; }
  var start = fromIndex == null ? 0 : Math.min(Math.max(fromIndex, 0), keyframes.length - 1);
  if (start >= keyframes.length - 1) { toast("已经是最后一帧，没有可以往后播放的内容"); return false; }
  exitSketch();
  select(null);
  exitDrawMode();
  controls.enabled = false;
  prePlayActiveKf = activeKf;
  prePlayPose = captureKeyframe();
  applyKeyframe(keyframes[start]);
  markActiveKf(start);
  playback = { t0: performance.now(), globalStart: performance.now(), index: start + 1, onDone: onDone || null };
  $("btn-play").hidden = true;
  $("btn-stop").hidden = false;
  syncActionPlayButtons();
  return true;
}

function stopPlayback(finished) {
  if (!playback) return;
  var onDone = playback.onDone;
  playback = null;
  controls.enabled = true;
  updateFlowTextures(0); // 停止播放复位水面
  $("btn-play").hidden = false;
  $("btn-stop").hidden = true;
  syncActionPlayButtons();
  if (finished) applyKeyframe(keyframes[keyframes.length - 1]); // 录制流程需要末帧画面收尾
  if (onDone) onDone(restorePlaybackPose); // 录制：等编码器停了再恢复现场
  else restorePlaybackPose();
}

var _cola = new THREE.Color(), _colb = new THREE.Color();
// 物体在某一帧"存在/不存在"由该帧 objects 表里有没有这个 id 决定（帧即幻灯片模型的自然延伸）。
// 两帧间过渡时按三种情况处理：
//   两帧都存在 → 原有的位置/旋转/缩放/颜色/透明度正常插值；
//   只在目标帧存在（出现）/只在起始帧存在（消失）→ 按物体的「出现动画」设置：
//     fade（默认）：原地淡入/淡出（透明度 0↔目标值），期间一直可见；
//     cut：全程隐藏，直到过渡终点（t=1，即到达那一帧的瞬间）才突然显示/消失；
//   两帧都不存在 → 隐藏，其余不处理。
function lerpFrames(a, b, t) {
  var k = easeInOutCubic(t);
  content.children.forEach(function (o) {
    var sa = a.objects[o.userData.id], sb = b.objects[o.userData.id];
    if (sa && sb) {
      o.visible = objVisibleForFrame(o, true);
      o.position.copy(_va.fromArray(sa.p).lerp(_vb.fromArray(sb.p), k));
      o.quaternion.copy(_qa.fromArray(sa.q).slerp(_qb.fromArray(sb.q), k));
      o.scale.copy(_va.fromArray(sa.s).lerp(_vb.fromArray(sb.s), k));
      if (sa.c != null && sb.c != null && o.material) o.material.color.copy(_cola.set(sa.c).lerp(_colb.set(sb.c), k));
      if (sa.op != null && sb.op != null) applyFrameOpacity(o, sa.op + (sb.op - sa.op) * k);
      return;
    }
    if (!sa && !sb) { o.visible = false; return; }
    var appearing = !sa && !!sb;
    var target = appearing ? sb : sa; // 出现用目标帧数据就位；消失用起始帧数据保持原位
    o.position.fromArray(target.p);
    o.quaternion.fromArray(target.q);
    o.scale.fromArray(target.s);
    if (target.c != null && o.material) o.material.color.set(target.c);
    var mode = o.userData.appear === "cut" ? "cut" : "fade";
    if (mode === "cut") {
      var reveal = appearing ? k >= 1 : k < 1;
      o.visible = objVisibleForFrame(o, reveal);
      if (reveal && target.op != null) applyFrameOpacity(o, target.op);
      return;
    }
    o.visible = objVisibleForFrame(o, true);
    // factor 是"存在程度"0→1；每个真实网格自己的透明度（含各组合成员）在
    // applyExistenceOpacity 内部已经乘过一次，这里不能再乘 target.op，否则透明度被平方
    var factor = appearing ? k : (1 - k);
    applyExistenceOpacity(o, factor);
  });
  // 镜头按锁定链解析：同链两帧解析到同一相机 → 视角静止，只有物体在动
  var ca = effectiveCameraOf(a), cb = effectiveCameraOf(b);
  camera.position.copy(_va.fromArray(ca.p).lerp(_vb.fromArray(cb.p), k));
  controls.target.copy(_va.fromArray(ca.t).lerp(_vb.fromArray(cb.t), k));
}

// ---------- 物体动作（Keynote 风格 build）----------
// 挂在某一帧上的一组"到达这一帧之后再播"的小动画，按数组顺序依次播放（不是同时），
// 全部播完才继续往下一帧过渡。跟"关键帧间插值"是两套独立机制：关键帧插值決定物体在
// 不同帧之间怎么过渡，动作只在"已经到达某一帧、过渡结束"之后原地表演，播完自动清零。
var ACTION_DEFS = {
  shake: { label: "抖动", duration: 0.5 },
  flash: { label: "闪烁", duration: 0.6 },
  bounce: { label: "弹跳", duration: 0.6 },
  pulse: { label: "脉冲缩放", duration: 0.5 },
};
// 单个动作的总时长 = 单遍时长 × 次数。所有调用点（实时播放 / 下一步 / 时间线分段与总时长）
// 拿的都是这个总值，次数改动天然反映到播放节奏和视频长度里
function actionDuration(a) { return (a.duration || ACTION_DEFS[a.type].duration) * (a.count || 1); }
function findTopObject(id) {
  for (var i = 0; i < content.children.length; i++) if (content.children[i].userData.id === id) return content.children[i];
  return null;
}
// 这一帧里"存在且能表演"的动作：目标物体不存在于这一帧就跳过（帧编辑模型下这是自然约束）
function playableActions(kf) {
  return (kf.actions || []).filter(function (a) { return kf.objects[a.objId]; });
}
// 每个动作只叠加自己的增量通道（抖动改 x/z、弹跳加 y、脉冲乘缩放、闪烁调亮度），
// 不在开头复位物体——复位由调度器统一做（stepActionSchedule 每 tick 先把活跃动作的目标
// 物体恢复到帧数据一次，applyActionScheduleAt 走 applyKeyframe 整帧复位），之后各动作
// 的增量按列表顺序叠加，所以并行动作在同一物体上是"组合"而不是"互相覆盖"
// （抖动+弹跳同步 = 边抖边跳）。t: 0→1 是整个动作（含全部次数）的全局进度；次数 >1
// 时先换算成单遍内进度 ct（每遍从 0 重新起振，全局收尾 t=1 时 ct 也精确落到 1）。
// amp 是幅度系数（默认 1，乘进各公式）
function applyActionFrame(action, kf, t) {
  var o = findTopObject(action.objId);
  var st = kf.objects[action.objId];
  if (!o || !st) return;
  var n = action.count || 1;
  var ct = n > 1 ? (t >= 1 ? 1 : (t * n) % 1) : t;
  var amp = action.amp == null ? 1 : action.amp;
  if (action.type === "shake") {
    var decay = 1 - ct;
    o.position.x += Math.sin(ct * 10 * Math.PI * 2) * 0.12 * amp * decay;
    o.position.z += Math.cos(ct * 13 * Math.PI * 2) * 0.07 * amp * decay;
  } else if (action.type === "bounce") {
    o.position.y += Math.abs(Math.sin(ct * Math.PI)) * 0.3 * amp;
  } else if (action.type === "pulse") {
    o.scale.multiplyScalar(1 + Math.sin(ct * Math.PI) * 0.25 * amp);
  } else if (action.type === "flash") {
    applyFlashBrightness(o, ct, amp, st);
  }
}
// 闪烁：亮度脉冲（不碰透明度）。dip 是 0→1→0 的三次平滑脉冲、首尾都为 0——旧版用
// 0.5+0.5·sin 从 0.5 起步，进入动作瞬间透明度骤变，视觉上"开头多闪一下"（用户反馈）。
var _flashWhite = new THREE.Color(0xffffff), _flashC = new THREE.Color();
function applyFlashBrightness(o, ct, amp, st) {
  var dip = 0.5 - 0.5 * Math.cos(ct * 3 * Math.PI * 2);
  var mix = dip * Math.min(1, amp); // 颜色向白混合的比例（描线/线条用）
  // 网格本体：emissive 脉冲发亮（加色发亮，而不是变透明）。基线：发光纹理物体的
  // emissive 是内容本身（inten×1.6），在它的基础上叠加；普通物体基线为 0
  collectStyleMeshes(o).forEach(function (m) {
    if (!m.material || !m.material.emissive) return;
    var tex = m.userData.texture;
    var base = (tex && tex.type === "glow")
      ? (((tex.params && tex.params.inten) == null ? 0.6 : tex.params.inten) * 1.6)
      : 0;
    if (dip > 0 || base > 0) {
      m.material.emissive.copy(m.material.color);
      m.material.emissiveIntensity = base + dip * amp * 1.5;
    } else {
      m.material.emissive.setHex(0x000000); // 复位到动作前状态（普通物体 emissive 黑）
      m.material.emissiveIntensity = 1;
    }
  });
  // 边框/面边框描线跟着发亮：颜色向白混合，基线色在 helper.userData.baseColor
  o.traverse(function (c) {
    if (!c.userData || (c.userData.helper !== "stroke" && c.userData.helper !== "face-stroke")) return;
    if (!c.material || !c.material.isLineMaterial) return;
    c.material.color.copy(_flashC.set(c.userData.baseColor || "#43423D")).lerp(_flashWhite, mix);
  });
  // 线条物体：本体就是线（collectStyleMeshes 不含），同样调亮；基线色取帧记录的颜色
  if (o.userData.kind === "line" && o.material && o.material.isLineMaterial && st && st.c) {
    o.material.color.copy(_flashC.set(st.c)).lerp(_flashWhite, mix);
  }
}
// 单个动作播完后精确复位到该帧的真实数据，避免正弦波动画收尾时的浮点误差残留、
// 或者叠加下一个动作时产生漂移（下一帧的过渡插值本来就会用存档数据兜底，这里是锦上添花）
function restoreActionTarget(action, kf) {
  var o = findTopObject(action.objId);
  var st = kf.objects[action.objId];
  if (!o || !st) return;
  o.position.fromArray(st.p);
  o.scale.fromArray(st.s);
  if (st.op != null) applyFrameOpacity(o, st.op);
  applyFlashBrightness(o, 0, 0, st); // 闪烁的亮度/描线发光复位（dip=0 即回基线）
}

// ---------- 动作调度：每个动作相对"动作阶段开始"有自己的启动时刻，可串行可并行 ----------
// 第 i 个动作（i≥1）的启动时机由 a.delay 决定：
//   delay == null（默认"等播完"）→ 上一个动作结束后再播（旧版严格串行行为）；
//   delay = N 秒 → 在上一个动作"开始后" N 秒启动（N=0 即与上一个同步并行）。
// start 链按可播序列依次推算；阶段总时长 = max(start + duration)。
// 并行时各动作的增量通道叠加组合（stepActionSchedule 每 tick 先把目标物体复位到帧数据、
// 再按列表顺序叠加各动作增量）：抖动+弹跳同步 = 边抖边跳；同一通道（如两个脉冲）
// 按列表顺序复合。
function actionSchedule(kf) {
  var items = [];
  var prevStart = 0, prevDur = 0;
  playableActions(kf).forEach(function (a, i) {
    var dur = actionDuration(a);
    var start = i === 0 ? 0 : (a.delay != null ? prevStart + a.delay : prevStart + prevDur);
    items.push({ action: a, start: start, duration: dur, restored: false });
    prevStart = start; prevDur = dur;
  });
  var total = 0;
  items.forEach(function (it) { total = Math.max(total, it.start + it.duration); });
  return { kf: kf, items: items, total: total };
}

// 实时播放的增量步进：先把本 tick 活跃动作的目标物体复位到帧数据（去重、每物体一次），
// 再按列表顺序叠加各动作增量（并行组合而非互相覆盖）；刚结束的动作精确复位一次
// （restored 标记防重复），它若与其他动作同物体，复位也发生在活跃增量叠加之前
function stepActionSchedule(sch, elapsed) {
  var active = [];
  sch.items.forEach(function (it) {
    var lt = elapsed - it.start;
    if (lt < 0) return; // 还没轮到
    var t = lt / it.duration;
    if (t >= 1) {
      if (!it.restored) { restoreActionTarget(it.action, sch.kf); it.restored = true; }
      return;
    }
    active.push({ it: it, t: t });
  });
  var resetIds = {};
  active.forEach(function (a) {
    var id = a.it.action.objId;
    if (resetIds[id]) return;
    resetIds[id] = true;
    restoreActionTarget(a.it.action, sch.kf);
  });
  active.forEach(function (a) { applyActionFrame(a.it.action, sch.kf, a.t); });
}

// 离线导出（无状态路径）：先整帧复位（applyKeyframe 精确回到帧数据，清掉任何已结束动作
// 的残留），再只 apply 当前时刻活跃的动作——每次调用都从存档完整重算，与调用顺序无关
function applyActionScheduleAt(sch, localSec) {
  applyKeyframe(sch.kf);
  sch.items.forEach(function (it) {
    var lt = localSec - it.start;
    if (lt < 0 || lt >= it.duration) return;
    applyActionFrame(it.action, sch.kf, lt / it.duration);
  });
}

function stepPlayback() {
  if (playback.actionState) { stepPlaybackActions(); return; }
  var kf = keyframes[playback.index];
  var elapsed = (performance.now() - playback.t0) / 1000;
  var t = Math.min(1, elapsed / kf.duration);
  lerpFrames(keyframes[playback.index - 1], kf, t);
  if (t >= 1) {
    var sch = actionSchedule(kf);
    if (sch.total > 0) { sch.t0 = performance.now(); playback.actionState = sch; }
    else advancePlaybackFrame();
  }
}
function stepPlaybackActions() {
  var sch = playback.actionState;
  var elapsed = (performance.now() - sch.t0) / 1000;
  stepActionSchedule(sch, elapsed);
  if (elapsed >= sch.total) {
    playback.actionState = null;
    // 动作预览（actionsOnly）：动作演完即结束，不往下一帧走
    if (playback.actionsOnly) stopPlayback(false);
    else advancePlaybackFrame();
  }
}
function advancePlaybackFrame() {
  playback.index++;
  playback.t0 = performance.now();
  if (playback.index >= keyframes.length) stopPlayback(true);
  else markActiveKf(playback.index); // 高亮当前过渡的目标帧
}

// 从当前选中的帧开始往后播放（而不是每次都从第一帧播）；没有选中任何帧时（自由编辑态）才从头播
// 「物体动作」区的播放/下一步按钮跟这里共用同一套入口
function playFromActiveFrame() {
  if (playback || exporting || nextStep) { toast("正在播放或导出中"); return; }
  startPlayback(null, activeKf === -1 ? 0 : activeKf);
}
$("btn-play").addEventListener("click", playFromActiveFrame);
$("btn-stop").addEventListener("click", function () { stopPlayback(false); });

// 动作区「播放」：只演当前定位的那一条动作（不过渡、不切帧，演完回到当前帧现场）
function playActiveAction() {
  if (playback || exporting || nextStep) { toast("正在播放或导出中"); return; }
  var kf = activeKf !== -1 ? keyframes[activeKf] : null;
  if (!kf) { toast("请先点一帧定位"); return; }
  var actions = kf.actions || [];
  if (!actions.length) { toast("当前帧没有动作"); return; }
  ensureActiveAction();
  var act = actions[activeAction];
  if (!act) return;
  if (!kf.objects[act.objId]) { toast("该动作的物体在当前帧不存在，无法播放"); return; }
  exitSketch();
  select(null);
  exitDrawMode();
  controls.enabled = false;
  prePlayActiveKf = activeKf;
  prePlayPose = captureKeyframe();
  applyKeyframe(kf); // 从该帧精确数据开演
  playback = {
    t0: performance.now(), globalStart: performance.now(), index: activeKf + 1, onDone: null,
    actionsOnly: true, // 演完动作即停（stepPlaybackActions 里判断，不走 advancePlaybackFrame）
    // 单条动作的调试播放：调度表只放这一条，从 0 开始（delay 语义不参与单播）
    actionState: { kf: kf, items: [{ action: act, start: 0, duration: actionDuration(act), restored: false }], total: actionDuration(act), t0: performance.now() },
  };
  $("btn-play").hidden = true;
  $("btn-stop").hidden = false;
  syncActionPlayButtons();
}
$("btn-action-play").addEventListener("click", playActiveAction);
// 动作区「下一步」：定位跳到当前帧的下一个动作并播放它（不出当前帧）
$("btn-action-next").addEventListener("click", function () {
  if (playback || exporting || nextStep) { toast("正在播放或导出中"); return; }
  var kf = activeKf !== -1 ? keyframes[activeKf] : null;
  if (!kf) { toast("请先点一帧定位"); return; }
  var actions = kf.actions || [];
  if (!actions.length) { toast("当前帧没有动作"); return; }
  ensureActiveAction();
  if (activeAction >= actions.length - 1) { toast("已经是最后一个动作"); return; }
  activeAction++;
  renderActions(); // 高亮先跳过去
  playActiveAction(); // 再播它
});

// 物体动作区两个按钮的可用状态：播放/导出/翻页中禁用；都要求当前帧有动作，
// 「下一步」还要求当前定位的动作后面还有下一个
function syncActionPlayButtons() {
  var bp = $("btn-action-play"), bn = $("btn-action-next");
  if (!bp || !bn) return;
  var busy = !!(playback || exporting || nextStep);
  var kf = activeKf !== -1 ? keyframes[activeKf] : null;
  var n = kf && kf.actions ? kf.actions.length : 0;
  bp.disabled = busy || !n;
  bn.disabled = busy || !n || activeAction >= n - 1;
}

// 「下一步」：像 PPT 翻页——只播当前帧到下一帧这一段过渡，播完直接落在下一帧上，
// 不像「播放」那样预览完还要复原到播放前的现场（prePlayPose 那一套完全不涉及）
var nextStep = null; // { from, to, t0, globalStart }
function stepNextStep() {
  if (nextStep.actionState) { stepNextStepActions(); return; }
  var a = keyframes[nextStep.from], b = keyframes[nextStep.to];
  var elapsed = (performance.now() - nextStep.t0) / 1000;
  var t = Math.min(1, elapsed / b.duration);
  lerpFrames(a, b, t);
  if (t >= 1) {
    var sch = actionSchedule(b);
    if (sch.total > 0) { sch.t0 = performance.now(); nextStep.actionState = sch; }
    else finishNextStep();
  }
}
function stepNextStepActions() {
  var sch = nextStep.actionState;
  var elapsed = (performance.now() - sch.t0) / 1000;
  stepActionSchedule(sch, elapsed);
  if (elapsed >= sch.total) {
    nextStep.actionState = null;
    finishNextStep();
  }
}
function finishNextStep() {
  var to = nextStep.to;
  nextStep = null;
  $("btn-next").disabled = false;
  updateFlowTextures(0); // 停止时复位水面，和播放结束一致
  locateKf(to); // 复用定位逻辑：精确落在目标帧数据上、按目标帧锁定状态收紧选中/镜头、写历史
  syncActionPlayButtons();
}
function playNextStep() {
  if (playback || exporting || nextStep) { toast("正在播放或导出中"); return; }
  if (activeKf === -1) { toast("请先点一帧定位"); return; }
  if (activeKf >= keyframes.length - 1) { toast("已经是最后一帧"); return; }
  exitSketch();
  select(null);
  exitDrawMode();
  controls.enabled = false; // 过渡期间镜头也在动，不让用户手动转视角打架；结束由 locateKf 按目标帧收放
  nextStep = { from: activeKf, to: activeKf + 1, t0: performance.now(), globalStart: performance.now() };
  $("btn-next").disabled = true;
  syncActionPlayButtons();
}
$("btn-next").addEventListener("click", playNextStep);

// 视频导出（只导出 16:9 框内内容，1920×1080）：
// 首选离线逐帧渲染——确定性时钟逐帧求插值、渲染、WebCodecs 编码、mp4-muxer 封装，
// 每一帧必然存在且时间戳精确等距，丝滑程度与页面播放一致；
// 浏览器不支持 WebCodecs 时退回 MediaRecorder 实时录制（可能丢帧）
var recordCopy = null;
var exporting = false;

// 把整条时间线拆成按顺序排列的"过渡"和"动作阶段"分段——导出逐帧渲染跟 timelineDuration
// 共用同一份分段。动作阶段是该帧全部动作的并发调度（actionSchedule），阶段时长
// = max(各动作 start + duration)，delay/并行产生的时间天然算进视频总长
function timelineSegments() {
  var segs = [];
  for (var i = 1; i < keyframes.length; i++) {
    var kf = keyframes[i];
    segs.push({ type: "transition", from: keyframes[i - 1], to: kf, duration: kf.duration });
    var sch = actionSchedule(kf);
    if (sch.total > 0) segs.push({ type: "actions", schedule: sch, duration: sch.total });
  }
  return segs;
}

function timelineDuration() {
  var total = 0;
  timelineSegments().forEach(function (s) { total += s.duration; });
  return total;
}

// 按时间线绝对时刻 t（秒）求整体状态，与实时播放同一插值/缓动/动作效果；每次调用都是从
// 存档数据完整重算这一分段该有的样子（不依赖上一次调用留下的状态），逐帧顺序导出时天然正确
function applyTimelineAt(t) {
  var segs = timelineSegments();
  var acc = 0;
  for (var i = 0; i < segs.length; i++) {
    var s = segs[i];
    if (t <= acc + s.duration || i === segs.length - 1) {
      if (s.type === "transition") {
        lerpFrames(s.from, s.to, Math.min(1, Math.max(0, (t - acc) / s.duration)));
      } else {
        // 动作阶段：秒数定位（先整帧复位再只 apply 活跃动作，无状态重算）
        applyActionScheduleAt(s.schedule, Math.min(s.duration, Math.max(0, t - acc)));
      }
      return;
    }
    acc += s.duration;
  }
}

function pickEncoderConfig(fps, res) {
  if (!window.VideoEncoder || !window.VideoFrame) return Promise.resolve(null);
  var is4k = res === "4k";
  var W = is4k ? 3840 : 1920, H = is4k ? 2160 : 1080;
  // H.264 从高到低逐个探测；4K@60 需要 Level 5.2（avc1.640034）
  var codecs = is4k
    ? ["avc1.640034", "avc1.640033", "avc1.64002A"]
    : ["avc1.640033", "avc1.64002A", "avc1.4D4029", "avc1.42E01F"];
  var tryNext = function (i) {
    if (i >= codecs.length) return null;
    var config = { codec: codecs[i], width: W, height: H, framerate: fps, bitrate: is4k ? 40000000 : 12000000 };
    return VideoEncoder.isConfigSupported(config)
      .then(function (r) { return r.supported ? config : tryNext(i + 1); })
      .catch(function () { return tryNext(i + 1); });
  };
  return Promise.resolve(tryNext(0));
}

async function exportVideoOffline(config, fps) {
  exporting = true;
  $("btn-record").disabled = true;
  var hintOld = $("hintbar").textContent;
  select(null);
  exitDrawMode();
  controls.enabled = false;
  jitterHelper.visible = false; // 主循环已暂停，显式隐藏扰动边框，确保不进视频
  var preExportPose = captureKeyframe(); // 导出是预览性质：结束后恢复现场
  var preExportActiveKf = activeKf;
  // 统一以 4K（3840×2160）渲染：输出 1080p 时降采样编码（2× 超采样抗锯齿，
  // 边缘平滑接近编辑器 Retina 观感）；输出 4K 时原生编码
  var RW = 3840, RH = 2160;
  var encodeW = config.width, encodeH = config.height;
  var needDownscale = encodeW !== RW;
  var scaleCanvas = null, scaleCtx = null;
  if (needDownscale) {
    scaleCanvas = document.createElement("canvas");
    scaleCanvas.width = encodeW;
    scaleCanvas.height = encodeH;
    scaleCtx = scaleCanvas.getContext("2d");
    scaleCtx.imageSmoothingQuality = "high";
  }
  var oldRatio = renderer.getPixelRatio();
  renderer.setPixelRatio(1);
  renderer.setSize(RW, RH, false);
  camera.aspect = 16 / 9;
  camera.updateProjectionMatrix();
  bgMesh.scale.set(1, 1, 1);
  updateLineResolutions(RW, RH);
  // 像素线宽（描线/面描线）在 4K 渲染下要 ×2 才保持与 1080 基准相同的画面占比；
  // worldUnits 的线（线条工具）是世界单位宽，不缩放
  var lineWidthScaled = [];
  content.traverse(function (c) {
    if (c.material && c.material.isLineMaterial && !c.material.worldUnits) {
      lineWidthScaled.push([c.material, c.material.linewidth]);
      c.material.linewidth *= RW / 1920;
    }
  });
  try {
    var muxer = new Muxer({
      target: new ArrayBufferTarget(),
      video: { codec: "avc", width: encodeW, height: encodeH, frameRate: fps },
      fastStart: "in-memory",
    });
    var encoderError = null;
    var encoder = new VideoEncoder({
      output: function (chunk, meta) { muxer.addVideoChunk(chunk, meta); },
      error: function (e) { encoderError = e; },
    });
    encoder.configure(config);
    var frames = Math.max(2, Math.round(timelineDuration() * fps) + 1);
    for (var i = 0; i < frames; i++) {
      if (encoderError) throw encoderError;
      applyTimelineAt(i / fps);
      controls.update();
      applyJitterForRender(i / fps);
      updateFlowTextures(i / fps); // 离线导出同样推进水面流动
      renderFrame();
      var frameSrc = renderer.domElement;
      if (needDownscale) {
        scaleCtx.drawImage(renderer.domElement, 0, 0, encodeW, encodeH); // 4K → 1080p 降采样
        frameSrc = scaleCanvas;
      }
      var vf = new VideoFrame(frameSrc, {
        timestamp: Math.round(i * 1e6 / fps),
        duration: Math.round(1e6 / fps),
      });
      restoreJitter();
      encoder.encode(vf, { keyFrame: i % (fps * 2) === 0 });
      vf.close();
      while (encoder.encodeQueueSize > 8) {
        await new Promise(function (r) { setTimeout(r, 1); });
      }
      if (i % 5 === 0) {
        $("hintbar").textContent = "正在离线渲染导出视频… " + Math.round((i + 1) * 100 / frames) + "%";
        await new Promise(function (r) { setTimeout(r, 0); });
      }
    }
    await encoder.flush();
    muxer.finalize();
    download(new Blob([muxer.target.buffer], { type: "video/mp4" }), "draw3d-animation.mp4");
    toast("视频已导出（" + (encodeH >= 2160 ? "4K" : "1080p 超采样") + " " + fps + "fps · 恒定帧率 MP4）");
  } catch (e) {
    toast("导出失败：" + ((e && e.message) || e));
  } finally {
    exporting = false;
    lineWidthScaled.forEach(function (p) { p[0].linewidth = p[1]; }); // 还原像素线宽
    updateFlowTextures(0); // 复位水面
    $("btn-record").disabled = false;
    $("hintbar").textContent = hintOld;
    renderer.setPixelRatio(oldRatio);
    resize(); // 恢复画布尺寸、相机纵横比与背景幕布布局
    controls.enabled = true;
    restoreEditingPose(preExportPose, preExportActiveKf); // 恢复导出前的现场（物体与相机）
    markActiveKf(preExportActiveKf);
  }
}

// 兜底：MediaRecorder 实时录制（播放一遍，逐帧裁剪 16:9 区域）
function exportVideoRealtime(fps) {
  var mime = ["video/mp4;codecs=avc1", "video/webm;codecs=vp9", "video/webm"].find(function (m) {
    return window.MediaRecorder && MediaRecorder.isTypeSupported(m);
  });
  if (!mime) { toast("当前浏览器不支持视频录制"); return; }
  var exportCanvas = document.createElement("canvas");
  exportCanvas.width = 1920;
  exportCanvas.height = 1080;
  var ctx = exportCanvas.getContext("2d");
  var ratio = renderer.getPixelRatio();
  recordCopy = function () {
    ctx.drawImage(
      renderer.domElement,
      exportRect.x * ratio, exportRect.y * ratio, exportRect.w * ratio, exportRect.h * ratio,
      0, 0, exportCanvas.width, exportCanvas.height
    );
  };
  recordCopy();
  var stream = exportCanvas.captureStream(fps);
  var recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 12000000 });
  var chunks = [];
  var pendingRestore = null;
  var cleanup = function () {
    recordCopy = null;
    stream.getTracks().forEach(function (t) { t.stop(); });
    if (pendingRestore) { pendingRestore(); pendingRestore = null; } // 编码器停完再恢复现场，避免恢复画面录进视频
  };
  recorder.ondataavailable = function (e) { if (e.data.size) chunks.push(e.data); };
  recorder.onstop = function () {
    cleanup();
    var ext = mime.indexOf("mp4") !== -1 ? "mp4" : "webm";
    download(new Blob(chunks, { type: mime }), "draw3d-animation." + ext);
    toast("动画视频已导出（实时录制 ." + ext + "）");
  };
  recorder.start();
  toast("开始实时录制（" + fps + "fps）…播放结束自动导出");
  var ok = startPlayback(function (restore) {
    pendingRestore = restore;
    setTimeout(function () { recorder.stop(); }, 250);
  });
  if (!ok) { recorder.onstop = cleanup; recorder.stop(); }
}

$("btn-record").addEventListener("click", function () {
  if (playback || exporting) { toast("正在播放或导出中"); return; }
  if (keyframes.length < 2) { toast("至少需要 2 个关键帧才能导出视频"); return; }
  var fps = view.fps || 60;
  pickEncoderConfig(fps, view.res).then(function (config) {
    if (!config && view.res === "4k") {
      toast("此设备不支持 4K 编码，已回退 1080p（超采样）");
      return pickEncoderConfig(fps, "1080").then(function (c2) {
        if (c2) exportVideoOffline(c2, fps);
        else exportVideoRealtime(fps);
      });
    }
    if (config) exportVideoOffline(config, fps);
    else exportVideoRealtime(fps);
  });
});

// ---------- 模型导出：所见即所得的统一保障 ----------
// 不变式：编辑器 content 里可见的一切，导出时必须三选一——
//   keep  = 本身就是标准网格+材质，原样导出（面覆层、涂料贴图）
//   bake  = 屏幕空间特效（像素粗线），导出前烘焙成等效真实几何（边框/面边框 → 细管）
//   strip = 纯编辑辅助（选中高亮），不属于模型内容
// 新增 helper 类型必须在此登记，未登记的会告警并默认随导出（宁多勿丢）。
var HELPER_EXPORT_POLICY = {
  "face": "keep", "sketch": "keep", "stroke-baked": "keep",
  "stroke": "bake", "face-stroke": "bake",
  "face-sel": "strip", "selOutline": "strip", // 选中态描边纯编辑辅助，导出时剥离
};
var STROKE_BAKE_RADIUS_PER_PX = 0.004; // 像素线宽 → 细管半径（世界单位），按默认视距目测校准

// ---- 导出材质规范化 ----
// 部分导出器（如 USDZExporter）导出贴图材质时把 diffuse/emissive 直连贴图、忽略颜色乘子，
// "蓝色×拉丝贴图"会退化成贴图原色。导出前把颜色烘进贴图像素（multiply，保留 alpha）、
// 颜色临时置白——所有导出器看到的都是自包含贴图，不依赖各家对乘色的支持。恢复函数还原。
function tintTextureForExport(tex, color) {
  var img = tex.image;
  var c = document.createElement("canvas");
  c.width = img.width;
  c.height = img.height;
  var ctx = c.getContext("2d");
  ctx.drawImage(img, 0, 0);
  ctx.globalCompositeOperation = "multiply";
  ctx.fillStyle = "#" + color.getHexString();
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.globalCompositeOperation = "destination-in"; // multiply 丢 alpha，用原图恢复
  ctx.drawImage(img, 0, 0);
  var out = new THREE.CanvasTexture(c);
  out.wrapS = tex.wrapS;
  out.wrapT = tex.wrapT;
  out.repeat.copy(tex.repeat);
  out.offset.copy(tex.offset);
  out.colorSpace = tex.colorSpace;
  out.flipY = tex.flipY;
  return out;
}

function normalizeMaterialsForExport() {
  var swaps = [];
  content.traverse(function (c) {
    if (!c.isMesh || !c.material || c.material.isLineMaterial) return;
    var m = c.material;
    var needMap = m.map && m.color && m.color.getHex() !== 0xffffff;
    var e = m.emissive ? m.emissive.getHex() : 0;
    var needEmis = m.emissiveMap && e !== 0xffffff && e !== 0x000000;
    if (!needMap && !needEmis) return;
    var rec = { m: m, map: m.map, color: m.color.clone(), emissiveMap: m.emissiveMap, emissive: m.emissive ? m.emissive.clone() : null, made: [] };
    if (needMap) {
      var t1 = tintTextureForExport(m.map, m.color);
      m.map = t1;
      m.color.set(0xffffff);
      rec.made.push(t1);
    }
    if (needEmis) {
      var t2 = tintTextureForExport(m.emissiveMap, m.emissive);
      m.emissiveMap = t2;
      m.emissive.set(0xffffff);
      rec.made.push(t2);
    }
    m.needsUpdate = true;
    swaps.push(rec);
  });
  return swaps;
}

// 导出一致性自检：导出前的场景必须满足"导出器安全契约"，违反即告警——
// 新特性若忘了接入导出管线，会在这里被当场抓住，而不是悄悄地所见非所得。
function exportConsistencyCheck() {
  content.traverse(function (c) {
    if (!c.isMesh) return;
    var m = c.material;
    if (!m) return;
    if (m.isLineMaterial) {
      console.warn("draw3d 导出自检：仍有胖线材质网格未替换（" + c.name + "），导出器无法识别");
    } else if (m.map && m.color && m.color.getHex() !== 0xffffff) {
      console.warn("draw3d 导出自检：贴图未烘入颜色乘子（" + c.name + "），USDZ 等导出会丢颜色");
    } else if (m.emissiveMap && m.emissive && m.emissive.getHex() !== 0xffffff && m.emissive.getHex() !== 0x000000) {
      console.warn("draw3d 导出自检：自发光贴图未烘入颜色（" + c.name + "）");
    }
  });
}

// 把物体的边框/面边框烘焙为细管网格（导出临时用，restore 时销毁）
function bakeStrokeMeshes(mesh) {
  var out = [];
  function tubes(segs, cfg) {
    var g = strokeSegmentsToTubes(segs, Math.max(0.5, cfg.width) * STROKE_BAKE_RADIUS_PER_PX, lineStyleParams(cfg.style));
    if (!g) return;
    var m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: new THREE.Color(cfg.color).getHex(), roughness: 0.7, metalness: 0 }));
    m.userData = { helper: "stroke-baked" };
    out.push(m);
  }
  var s = mesh.userData.stroke;
  if (s && s.enabled) {
    var edges = new THREE.EdgesGeometry(mesh.userData.baseGeo || mesh.geometry, 20);
    if (edges.attributes.position && edges.attributes.position.count) tubes(Array.from(edges.attributes.position.array), s);
    edges.dispose();
  }
  (mesh.userData.faces || []).forEach(function (f) {
    if (!f.stroke || !f.stroke.enabled || f.deleted) return;
    var data = collectFaceTriangles(mesh.userData.baseGeo || mesh.geometry, f.n, f.d);
    if (data.boundary.length) tubes(offsetPositions(data.boundary, f.n, 0.006), f.stroke);
  });
  return out;
}

function prepareModelExport() {
  exitSketch();
  var keep = selection.slice();
  select(null);
  scene.updateMatrixWorld(true);
  var stripped = [], baked = [];
  content.traverse(function (c) {
    var h = c.userData && c.userData.helper;
    if (!h) return;
    var policy = HELPER_EXPORT_POLICY[h];
    if (!policy) { console.warn("draw3d: 未登记导出策略的 helper「" + h + "」，默认随导出"); return; }
    if (policy === "strip" || policy === "bake") stripped.push({ p: c.parent, c: c });
  });
  stripped.forEach(function (s) { s.p.remove(s.c); });
  // 线条物体（胖线是屏幕特效几何，导出器不识别）：换成同名细管网格替身
  var lineSwaps = [];
  content.children.filter(function (o) { return o.userData.kind === "line"; }).forEach(function (o) {
    var g = strokeSegmentsToTubes(
      polylineToSegments(lineCurvePoints(o.userData.params.pts)),
      Math.max(0.5, o.userData.params.width || 4) * 0.005, null);
    if (!g) return;
    var sub = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: o.material.color.getHex(), roughness: 0.7, metalness: 0 }));
    sub.name = o.name;
    sub.position.copy(o.position);
    sub.quaternion.copy(o.quaternion);
    sub.scale.copy(o.scale);
    content.remove(o);
    content.add(sub);
    lineSwaps.push({ orig: o, sub: sub });
  });
  var bakeTargets = [];
  content.traverse(function (c) { if (c.isMesh && c.userData && c.userData.id != null) bakeTargets.push(c); });
  bakeTargets.forEach(function (c) {
    bakeStrokeMeshes(c).forEach(function (m) { c.add(m); baked.push({ p: c, c: m }); });
  });
  var matSwaps = normalizeMaterialsForExport();
  exportConsistencyCheck();
  scene.updateMatrixWorld(true);
  return function restore() {
    baked.forEach(function (b) {
      b.p.remove(b.c);
      b.c.geometry.dispose();
      b.c.material.dispose();
    });
    matSwaps.forEach(function (r) {
      r.m.map = r.map;
      r.m.color.copy(r.color);
      if (r.emissive) {
        r.m.emissiveMap = r.emissiveMap;
        r.m.emissive.copy(r.emissive);
      }
      r.made.forEach(function (t) { t.dispose(); });
      r.m.needsUpdate = true;
    });
    lineSwaps.forEach(function (s) {
      content.remove(s.sub);
      s.sub.geometry.dispose();
      s.sub.material.dispose();
      content.add(s.orig);
    });
    stripped.forEach(function (s) { s.p.add(s.c); });
    if (keep.length) setSelection(keep);
  };
}

function requireObjects() {
  if (!content.children.length) { toast("场景是空的，先添加物体"); return false; }
  return true;
}

// GLB 附带关键帧动画轨道（物体位移/旋转/缩放；相机轨迹只在视频导出里体现）
function buildAnimationClips() {
  if (keyframes.length < 2) return [];
  var times = [0];
  for (var i = 1; i < keyframes.length; i++) times.push(times[i - 1] + keyframes[i].duration);
  var tracks = [];
  content.children.forEach(function (o) {
    var id = o.userData.id;
    if (!keyframes.every(function (k) { return k.objects[id]; })) return;
    var pos = [], quat = [], scl = [];
    keyframes.forEach(function (k) {
      pos.push.apply(pos, k.objects[id].p);
      quat.push.apply(quat, k.objects[id].q);
      scl.push.apply(scl, k.objects[id].s);
    });
    tracks.push(new THREE.VectorKeyframeTrack(o.name + ".position", times, pos));
    tracks.push(new THREE.QuaternionKeyframeTrack(o.name + ".quaternion", times, quat));
    tracks.push(new THREE.VectorKeyframeTrack(o.name + ".scale", times, scl));
  });
  return tracks.length ? [new THREE.AnimationClip("draw3d", -1, tracks)] : [];
}

$("btn-export-usdz").addEventListener("click", function () {
  if (!requireObjects()) return;
  var restore = prepareModelExport();
  // USDZ 单位=米。编辑器里物体动辄一两米，Keynote/快速查看会离得很近、透视畸变大；
  // 缩放副本到桌面模型尺寸（最长边 0.3m），观感与苹果自带 3D 素材一致
  var wrapper = new THREE.Group();
  wrapper.add(content.clone(true));
  var box = new THREE.Box3().setFromObject(wrapper);
  var size = box.getSize(new THREE.Vector3());
  var maxDim = Math.max(size.x, size.y, size.z);
  if (maxDim > 1e-6) wrapper.scale.setScalar(0.3 / maxDim);
  wrapper.updateMatrixWorld(true);
  new USDZExporter().parseAsync(wrapper).then(function (data) {
    download(new Blob([data], { type: "model/vnd.usdz+zip" }), "draw3d.usdz");
    toast("USDZ 已导出（iPhone/Mac 可直接快速查看）");
  }).catch(function (e) {
    toast("USDZ 导出失败：" + e.message);
  }).finally(restore);
});

$("btn-export-glb").addEventListener("click", function () {
  if (!requireObjects()) return;
  var clips = buildAnimationClips();
  var restore = prepareModelExport();
  new GLTFExporter().parse(content, function (buffer) {
    restore();
    download(new Blob([buffer], { type: "model/gltf-binary" }), "draw3d.glb");
    toast(clips.length ? "GLB 已导出（含关键帧动画）" : "GLB 已导出");
  }, function (e) {
    restore();
    toast("GLB 导出失败：" + e.message);
  }, { binary: true, animations: clips });
});

$("btn-export-obj").addEventListener("click", function () {
  if (!requireObjects()) return;
  var restore = prepareModelExport();
  try {
    var text = new OBJExporter().parse(content);
    download(new Blob([text], { type: "text/plain" }), "draw3d.obj");
    toast("OBJ 已导出（仅几何体）");
  } finally {
    restore();
  }
});

$("btn-export-stl").addEventListener("click", function () {
  if (!requireObjects()) return;
  var restore = prepareModelExport();
  try {
    var data = new STLExporter().parse(content, { binary: true });
    download(new Blob([data], { type: "model/stl" }), "draw3d.stl");
    toast("STL 已导出（可用于 3D 打印）");
  } finally {
    restore();
  }
});

// ---------- 顶栏操作 ----------

$("btn-undo").addEventListener("click", function () { applyHistory(undoIndex - 1); });
$("btn-redo").addEventListener("click", function () { applyHistory(undoIndex + 1); });

$("btn-duplicate").addEventListener("click", duplicateSelected);
function stripIds(item) {
  item.id = null;
  if (item.children) item.children.forEach(stripIds);
  return item;
}

// 走序列化→实例化的路径，天然支持组合与文字的深拷贝
function cloneObject(src) {
  var copy = instantiateObject(stripIds(JSON.parse(JSON.stringify(serializeObject(src)))), content);
  copy.userData.mirror = null; // 普通复制不继承镜像链接
  copy.position.x += 0.8;
  return copy;
}
function duplicateSelected() {
  if (!selection.length) { toast("先选中物体"); return; }
  var copies = selection.map(cloneObject);
  setSelection(copies);
  snapshot("复制物体");
  if (copies.length > 1) toast("已复制 " + copies.length + " 个物体");
}

// ---------- 镜像复制：副本与原物体保持内容一致（仅位置独立） ----------
// 同组成员共享 userData.mirror 组号；每次快照前，把"被编辑成员"的内容同步给组内其他成员
// （同步 = 序列化源 → 保留目标的 id/位置/图层重建）。链接随存档持久化；删除成员后组内只剩一个则自然失效。
function mirrorDuplicate() {
  if (!selection.length) { toast("先选中物体"); return; }
  var copies = selection.map(function (src) {
    if (!src.userData.mirror) src.userData.mirror = "m" + src.userData.id;
    var copy = cloneObject(src);
    copy.userData.mirror = src.userData.mirror;
    return copy;
  });
  setSelection(copies);
  snapshot("镜像复制");
  toast("已镜像复制：与原物体保持内容同步（位置独立）");
}
$("btn-mirror").addEventListener("click", mirrorDuplicate);

function syncMirrors() {
  if (!selection.length) return;
  var groups = {};
  content.children.forEach(function (o) {
    if (o.userData.mirror) (groups[o.userData.mirror] = groups[o.userData.mirror] || []).push(o);
  });
  Object.keys(groups).forEach(function (key) {
    var members = groups[key];
    if (members.length < 2) return;
    // 源 = 正被编辑的成员（主选中优先）；组内多个成员同时选中时，被选中的各自保持不动
    var src = members.indexOf(selected) !== -1 ? selected
      : members.filter(function (o) { return selection.indexOf(o) !== -1; })[0];
    if (!src) return;
    var item = serializeObject(src);
    members.forEach(function (t) {
      if (t === src || selection.indexOf(t) !== -1) return;
      var it = JSON.parse(JSON.stringify(item));
      stripIds(it);                       // 子物体（贴附文字/组合成员）领新 id
      it.id = t.userData.id;              // 顶层保留目标 id（关键帧/图层引用不断）
      it.p = t.position.toArray();        // 位置独立
      it.layer = t.userData.layer;        // 图层归属独立
      removeObject(t);
      instantiateObject(it, content);
    });
  });
}

$("btn-delete").addEventListener("click", deleteSelected);
function deleteSelected() {
  if (!selection.length) { toast("先选中物体"); return; }
  var doomed = selection.slice();
  select(null);
  doomed.forEach(removeObject);
  snapshot("删除物体");
  if (doomed.length > 1) toast("已删除 " + doomed.length + " 个物体");
}

// ---------- 框选与对齐 / 分布 ----------

var marqueeMode = false;
var marqueeBox = null; // 当前框选矩形（视口 CSS 像素）

function setMarqueeMode(on) {
  if (on) {
    exitSketch();
    exitDrawMode();
    if (lineMode) setLineMode(false);
    if (faceMode) setFaceMode(false);
  }
  marqueeMode = on;
  controls.enableRotate = !on; // 框选模式下左键拖拽是框选，不转视角（中/右键仍可用）
  $("tool-marquee").classList.toggle("active", on);
  $("hintbar").textContent = on
    ? "框选模式：左键拖拽框选（Shift 追加）· 点击物体累加/取消 · 点空白清空 · B 或 Q 退出"
    : "左键选择 · 拖动旋转视角 · 滚轮缩放 · 右键平移 · W/E/R 切换移动/旋转/缩放";
}

function updateMarquee(e) {
  var cr = renderer.domElement.getBoundingClientRect();
  var x0 = downPos.x - cr.left, y0 = downPos.y - cr.top;
  var x1 = e.clientX - cr.left, y1 = e.clientY - cr.top;
  marqueeBox = {
    x: Math.min(x0, x1), y: Math.min(y0, y1),
    w: Math.abs(x1 - x0), h: Math.abs(y1 - y0),
  };
  var el = $("marquee");
  el.hidden = false;
  el.style.left = marqueeBox.x + "px";
  el.style.top = marqueeBox.y + "px";
  el.style.width = marqueeBox.w + "px";
  el.style.height = marqueeBox.h + "px";
}

function hideMarquee() {
  marqueeBox = null;
  $("marquee").hidden = true;
}

// 物体的世界包围盒投影到屏幕后与框选矩形相交即入选
var _corner = new THREE.Vector3();
function objectsInScreenRect(r) {
  var out = [];
  var cr = renderer.domElement.getBoundingClientRect();
  content.children.forEach(function (o) {
    if (!isSelectable(o)) return; // 隐藏/锁定图层的物体不参与框选
    var box = new THREE.Box3().setFromObject(o);
    if (box.isEmpty()) return;
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, anyFront = false;
    for (var i = 0; i < 8; i++) {
      _corner.set(
        i & 1 ? box.max.x : box.min.x,
        i & 2 ? box.max.y : box.min.y,
        i & 4 ? box.max.z : box.min.z
      ).project(camera);
      if (_corner.z < 1) anyFront = true;
      var sx = (_corner.x + 1) / 2 * cr.width;
      var sy = (1 - _corner.y) / 2 * cr.height;
      minX = Math.min(minX, sx); maxX = Math.max(maxX, sx);
      minY = Math.min(minY, sy); maxY = Math.max(maxY, sy);
    }
    if (anyFront && minX < r.x + r.w && maxX > r.x && minY < r.y + r.h && maxY > r.y) out.push(o);
  });
  return out;
}

function bboxCenter(o, target) {
  return new THREE.Box3().setFromObject(o).getCenter(target);
}

var _ca = new THREE.Vector3(), _cb = new THREE.Vector3();

// 对齐核心：objs 的包围盒中心在该轴对齐到 ref
function alignObjects(objs, axis, ref) {
  var target = bboxCenter(ref, _ca)[axis];
  objs.forEach(function (o) {
    if (o === ref) return;
    o.position[axis] += target - bboxCenter(o, _cb)[axis];
  });
  refreshMultiPivot();
  snapshot("对齐物体");
}

// 分布核心：objs 按该轴包围盒中心排序，首尾不动，中间等间距
function distributeObjects(objs, axis) {
  var items = objs.map(function (o) { return { o: o, c: bboxCenter(o, _ca)[axis] }; });
  items.sort(function (a, b) { return a.c - b.c; });
  var min = items[0].c, max = items[items.length - 1].c;
  var step = (max - min) / (items.length - 1);
  items.forEach(function (it, i) {
    it.o.position[axis] += min + step * i - it.c;
  });
  refreshMultiPivot();
  snapshot("均匀分布");
}

// ---------- 对齐/分布锁：锁住一组物体的某轴约束，移动成员时自动维持 ----------
// 交互：点锁头进入锁定模式（锁头亮）→ 点某个轴立即执行并锁定该轴+那组物体（轴按钮也亮）
//   → 再点同一个轴取消锁定（锁定模式保留，可另选轴）；换点别的轴则切换锁定轴。
//   再点锁头彻底退出锁定模式。未开锁定模式时，轴按钮就是普通的一次性对齐/分布。
// 语义：对齐锁——移动任一成员，其余成员在该轴跟随，保持对齐；
//   分布锁——移动端点成员 → 中间成员重算等距；移动中间成员 → 整个队形跟随平移；
//   全体一起移动（多选整体拖动）→ 不干预。锁随 serialize()/restore() 走，撤销/存档/项目
//   文件导入导出都会带着（早期版本"仅当前会话有效"，用户反馈导入项目后锁会丢，改成随存档持久化）。
var alignLock = null;   // { axis, ids:[], centers:{id:该轴包围盒中心（动前基准）} }
var distLock = null;
var alignArmed = false; // 锁定模式（点了锁头，等待选轴/已锁定）
var distArmed = false;

function lockMembers(lock) {
  var out = [];
  lock.ids.forEach(function (id) {
    var o = content.children.find(function (c) { return c.userData.id === id; });
    if (o) out.push(o);
  });
  return out;
}

// 锁头亮=锁定模式开（含已锁定）；轴按钮亮=当前锁定的轴
function refreshLockButtons() {
  [["align-lock", alignLock, alignArmed, "data-align"], ["dist-lock", distLock, distArmed, "data-dist"]].forEach(function (p) {
    var b = $(p[0]), lock = p[1], armed = p[2];
    b.classList.toggle("on", armed || !!lock);
    b.innerHTML = (armed || lock) ? ICON_LOCK_ON : ICON_LOCK_OFF;
    document.querySelectorAll("#prop-section-ops [" + p[3] + "]").forEach(function (ab) {
      ab.classList.toggle("on", !!lock && ab.getAttribute(p[3]) === lock.axis);
    });
  });
}

// 每次移动开始前捕获成员该轴基准位置（拖拽起点/输入框修改前），中间移动的位移以此为基
function captureLockCenters() {
  [alignLock, distLock].forEach(function (lock) {
    if (!lock) return;
    lock.centers = {};
    lockMembers(lock).forEach(function (o) {
      lock.centers[o.userData.id] = bboxCenter(o, _ca)[lock.axis];
    });
  });
}

// 锁头按钮：无锁未开 → 开锁定模式；已开未锁 → 关闭；已锁定 → 解除并关闭
function toggleLock(kind) {
  var isAlign = kind === "align";
  var lock = isAlign ? alignLock : distLock;
  var armed = isAlign ? alignArmed : distArmed;
  if (lock) {
    if (isAlign) { alignLock = null; alignArmed = false; } else { distLock = null; distArmed = false; }
    snapshot(isAlign ? "解除对齐锁" : "解除分布锁"); // 锁状态本身也要留痕，不然存档/撤销读到的还是解锁前那次快照
    toast(isAlign ? "已解除对齐锁" : "已解除分布锁");
  } else if (armed) {
    if (isAlign) alignArmed = false; else distArmed = false;
  } else {
    if (isAlign) alignArmed = true; else distArmed = true;
    toast(isAlign ? "锁定模式：点 X/Y/Z 立即对齐并锁定该轴（再点同轴取消）" : "锁定模式：点 X/Y/Z 立即分布并锁定该轴（再点同轴取消）");
  }
  refreshLockButtons();
}
$("align-lock").addEventListener("click", function () { toggleLock("align"); });
$("dist-lock").addEventListener("click", function () { toggleLock("dist"); });

// 轴按钮：锁定模式下执行并锁定 / 点已锁的轴取消 / 普通模式一次性执行
function axisAction(kind, axis) {
  var isAlign = kind === "align";
  var lock = isAlign ? alignLock : distLock;
  var armed = isAlign ? alignArmed : distArmed;
  var minCount = isAlign ? 2 : 3;
  if (lock && lock.axis === axis) { // 再点已锁定的轴：取消锁定（锁定模式保留）
    if (isAlign) alignLock = null; else distLock = null;
    refreshLockButtons();
    snapshot(isAlign ? "取消对齐锁定" : "取消分布锁定"); // 锁状态本身也要留痕
    toast(isAlign ? "已取消该轴对齐锁定" : "已取消该轴分布锁定");
    return;
  }
  // 物体组：优先当前选中；不足时沿用已锁定组（切换轴场景）
  var objs = selection.length >= minCount ? selection.slice() : (lock ? lockMembers(lock) : []);
  if (objs.length < minCount) {
    toast(isAlign ? "先选中至少 2 个物体" : "均匀分布需要至少 3 个物体");
    return;
  }
  var ref = objs.indexOf(selected) !== -1 ? selected : objs[objs.length - 1];
  if (isAlign) alignObjects(objs, axis, ref); else distributeObjects(objs, axis); // 内部已 snapshot 一次（对齐/分布这一步本身）
  if (armed || lock) { // 锁定模式：执行后即锁定此轴
    var newLock = { axis: axis, ids: objs.map(function (o) { return o.userData.id; }), centers: {} };
    if (isAlign) { alignLock = newLock; alignArmed = true; } else { distLock = newLock; distArmed = true; }
    captureLockCenters();
    refreshLockButtons();
    snapshot(isAlign ? "锁定对齐" : "锁定分布"); // 再存一次：上面那次快照是对齐/分布动作本身的，这次才带上刚建立的锁状态
    toast(isAlign ? "已对齐并锁定该轴" : "已分布并锁定该轴");
  } else {
    toast(isAlign ? "已对齐 " + objs.length + " 个物体" : "已沿该轴均匀分布");
  }
}
document.querySelectorAll("#prop-section-ops [data-align]").forEach(function (btn) {
  btn.addEventListener("click", function () { axisAction("align", btn.getAttribute("data-align")); });
});
document.querySelectorAll("#prop-section-ops [data-dist]").forEach(function (btn) {
  btn.addEventListener("click", function () { axisAction("dist", btn.getAttribute("data-dist")); });
});
refreshLockButtons(); // 初始化锁头图标

// 移动发生后维持约束；moverIds = 本次被用户直接移动的物体 id 集合
function enforceLocks(moverIds) {
  var changed = false;
  [["align", alignLock], ["dist", distLock]].forEach(function (p) {
    var kind = p[0], lock = p[1];
    if (!lock) return;
    var members = lockMembers(lock);
    if (members.length < (kind === "align" ? 2 : 3)) { // 成员被删/解组，锁失效
      if (kind === "align") alignLock = null; else distLock = null;
      refreshLockButtons();
      return;
    }
    var axis = lock.axis;
    var movers = members.filter(function (o) { return moverIds.indexOf(o.userData.id) !== -1; });
    if (!movers.length || movers.length === members.length) return; // 无关移动 / 整体移动不干预
    if (kind === "align") {
      var target = bboxCenter(movers[0], _ca)[axis];
      members.forEach(function (o) {
        if (movers.indexOf(o) !== -1) return;
        o.position[axis] += target - bboxCenter(o, _cb)[axis];
      });
      changed = true;
      return;
    }
    // 分布锁：按锁定时基准位置排序保持队形次序
    var order = members.slice().sort(function (a, b) {
      return (lock.centers[a.userData.id] || 0) - (lock.centers[b.userData.id] || 0);
    });
    var endMoved = movers.indexOf(order[0]) !== -1 || movers.indexOf(order[order.length - 1]) !== -1;
    if (endMoved) {
      // 端点移动：以当前两端为界，中间成员重算等距
      var min = bboxCenter(order[0], _ca)[axis];
      var max = bboxCenter(order[order.length - 1], _ca)[axis];
      var step = (max - min) / (order.length - 1);
      order.forEach(function (o, i) {
        if (i === 0 || i === order.length - 1) return;
        o.position[axis] += min + step * i - bboxCenter(o, _cb)[axis];
      });
    } else {
      // 中间移动：整个队形按同一位移跟随（相对移动开始时的基准）
      var m0 = movers[0];
      var delta = bboxCenter(m0, _ca)[axis] - (lock.centers[m0.userData.id] || 0);
      members.forEach(function (o) {
        if (movers.indexOf(o) !== -1) return;
        var want = (lock.centers[o.userData.id] || 0) + delta;
        o.position[axis] += want - bboxCenter(o, _cb)[axis];
      });
    }
    changed = true;
  });
  if (changed) refreshTransformFields();
}

// ---------- 选面工具：点击拾取共面区域，编辑面填充/透明度/边框 ----------

var faceMode = false;
var selectedFace = null; // { mesh, n:[x,y,z](局部), d, index: userData.faces 下标（-1=尚未建立样式） }
var faceSelHelper = null; // 边界线
var faceSelFill = null;   // 半透明填充

// 画板模式：在某个面上正视绘制线条
var sketching = null;     // { mesh, n, d, origin, U, V, plane, active, preview, savedCam, savedUp }
var sketchColor = "#E42214";
var sketchWidth = 3;
var sketchStraight = false; // false=自由手绘, true=直线
var sketchEraser = false;   // 橡皮：destination-out 擦除已画像素

function setFaceMode(on) {
  if (on) {
    exitSketch();
    exitDrawMode();
    if (lineMode) setLineMode(false);
    if (marqueeMode) setMarqueeMode(false);
  }
  faceMode = on;
  $("tool-face").classList.toggle("active", on);
  if (!on) { clearFaceSelection(); refreshProps(); }
  $("hintbar").textContent = on
    ? "选面模式：点击物体的某个面进行编辑 · 点空白取消 · F 或 Q 退出"
    : "左键选择 · 拖动旋转视角 · 滚轮缩放 · 右键平移 · W/E/R 切换移动/旋转/缩放";
}

function disposeFaceHelpers() {
  [faceSelHelper, faceSelFill].forEach(function (h) {
    if (!h) return;
    if (h.parent) h.parent.remove(h);
    h.geometry.dispose();
    h.material.dispose();
  });
  faceSelHelper = null;
  faceSelFill = null;
}

function clearFaceSelection() {
  selectedFace = null;
  disposeFaceHelpers();
  $("face-section").hidden = true;
}

// 选中面的高亮：边界线 + 半透明填充（helper，不序列化、模型导出前剔除）
function updateFaceHighlight() {
  disposeFaceHelpers();
  if (!selectedFace) return;
  var base = selectedFace.mesh.userData.baseGeo || selectedFace.mesh.geometry;
  var data = collectFaceTriangles(base, selectedFace.n, selectedFace.d);
  if (!data.boundary.length) return;
  var lg = new LineSegmentsGeometry();
  lg.setPositions(offsetPositions(data.boundary, selectedFace.n, 0.008));
  faceSelHelper = new LineSegments2(lg, buildLineMaterial({ color: "#736B85", width: 2.5, style: "solid" }));
  faceSelHelper.userData = { helper: "face-sel" };
  faceSelHelper.raycast = function () {};
  selectedFace.mesh.add(faceSelHelper);
  var fg = new THREE.BufferGeometry();
  fg.setAttribute("position", new THREE.Float32BufferAttribute(offsetPositions(data.positions, selectedFace.n, 0.007), 3));
  faceSelFill = new THREE.Mesh(fg, new THREE.MeshBasicMaterial({
    color: 0x736B85, transparent: true, opacity: 0.22, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -4, side: THREE.DoubleSide,
  }));
  faceSelFill.userData = { helper: "face-sel" };
  faceSelFill.raycast = function () {};
  selectedFace.mesh.add(faceSelFill);
}

var _faceN = new THREE.Vector3();
function handleFacePick(clientX, clientY) {
  var hit = raycastContent(clientX, clientY);
  if (!hit || !hit.face || !hit.object.isMesh) {
    clearFaceSelection();
    refreshProps();
    return;
  }
  var hitObj = hit.object;
  var n, d, mesh, idx = -1;
  if (hitObj.userData && hitObj.userData.helper === "face") {
    // 命中已样式化面的覆层：直接回选该面（原三角形已被剔除，覆层就是它的可点区）
    mesh = hitObj.parent;
    idx = hitObj.userData.faceIndex;
    var f = mesh.userData.faces[idx];
    n = new THREE.Vector3().fromArray(f.n);
    d = f.d;
  } else {
    mesh = hitObj;
    n = hit.face.normal.clone().normalize(); // 几何局部空间
    d = n.dot(mesh.worldToLocal(hit.point.clone()));
    var faces = mesh.userData.faces || [];
    for (var i = 0; i < faces.length; i++) {
      if (!faces[i].deleted && _faceN.fromArray(faces[i].n).dot(n) > 0.995 && Math.abs(faces[i].d - d) < 0.02) {
        idx = i;
        n.fromArray(faces[i].n);
        d = faces[i].d;
        break;
      }
    }
  }
  selectedFace = { mesh: mesh, n: n.toArray(), d: d, index: idx };
  setSelection([], true); // 只选面不选物体：不高亮整体、不挂变换手柄
  updateFaceHighlight();
  updateFaceUI();
}

function ensureFaceEntry() {
  if (!selectedFace) return null;
  var mesh = selectedFace.mesh;
  if (!mesh.userData.faces) mesh.userData.faces = [];
  if (selectedFace.index === -1) {
    mesh.userData.faces.push({
      n: selectedFace.n.slice(),
      d: selectedFace.d,
      color: "#" + mesh.material.color.getHexString(),
      opacity: 1,
      stroke: { enabled: false, color: "#43423D", width: 2, style: "solid" },
    });
    selectedFace.index = mesh.userData.faces.length - 1;
  }
  return mesh.userData.faces[selectedFace.index];
}

function updateFaceUI() {
  var has = !!selectedFace;
  $("face-section").hidden = !has;
  if (!has) return;
  selectTab("tab-props");
  var mesh = selectedFace.mesh;
  var f = selectedFace.index >= 0 ? mesh.userData.faces[selectedFace.index] : null;
  $("face-color").value = f ? f.color : "#" + mesh.material.color.getHexString();
  var op = f ? f.opacity : 1;
  $("face-opacity").value = op;
  $("face-opacity-val").textContent = op.toFixed(2);
  var ft = f && f.texture;
  $("face-texture").value = ft ? ft.type : "none";
  renderTextureParams($("face-texture-params"), ft || null, applyFaceTextureChange);
  var st = f && f.stroke;
  $("face-stroke-on").checked = !!(st && st.enabled);
  $("face-stroke-config").hidden = !(st && st.enabled);
  $("face-stroke-color").value = st ? st.color : "#43423D";
  $("face-stroke-width").value = st ? st.width : 2;
  $("face-stroke-style").value = st ? st.style : "solid";
}

function editFace(fn) {
  var entry = ensureFaceEntry();
  if (!entry) return;
  fn(entry);
  applyFaceStyles(selectedFace.mesh);
}

$("face-color").addEventListener("input", function () {
  var v = this.value;
  editFace(function (f) { f.color = v; });
});
$("face-color").addEventListener("change", function () { snapshot("改面颜色"); });
$("face-opacity").addEventListener("input", function () {
  var v = parseFloat(this.value);
  $("face-opacity-val").textContent = v.toFixed(2);
  editFace(function (f) { f.opacity = v; });
});
$("face-opacity").addEventListener("change", function () { snapshot("改面透明度"); });

// 面纹理：改动落到面条目并重建覆层
function applyFaceTextureChange() {
  if (!selectedFace) return;
  refreshDecorations(selectedFace.mesh);
  snapshot("改面纹理");
}
$("face-texture").addEventListener("change", function () {
  if (!selectedFace) return;
  var entry = ensureFaceEntry();
  entry.texture = this.value === "none" ? null : defaultTextureCfg(this.value);
  if (COLORED_MAP_TEXTURES[this.value]) {
    entry.color = "#ffffff"; // 贴图本色显示
    $("face-color").value = "#ffffff";
  }
  renderTextureParams($("face-texture-params"), entry.texture, applyFaceTextureChange);
  applyFaceTextureChange();
});
$("face-stroke-on").addEventListener("change", function () {
  var on = this.checked;
  editFace(function (f) { f.stroke.enabled = on; });
  $("face-stroke-config").hidden = !on;
  snapshot((on ? "开启" : "关闭") + "面边框");
});
function bindFaceStroke(id, key, parse) {
  $(id).addEventListener("change", function () {
    var v = parse ? parse(this.value) : this.value;
    if (key === "width") this.value = v;
    editFace(function (f) { f.stroke[key] = v; });
    snapshot("改面边框");
  });
}
bindFaceStroke("face-stroke-color", "color");
bindFaceStroke("face-stroke-width", "width", function (v) { return Math.min(12, Math.max(0.5, parseFloat(v) || 2)); });
bindFaceStroke("face-stroke-style", "style");
$("btn-face-clear").addEventListener("click", function () {
  if (!selectedFace || selectedFace.index < 0 || selectedFace.mesh.userData.faces[selectedFace.index].deleted) {
    toast("此面尚未设置样式");
    return;
  }
  selectedFace.mesh.userData.faces.splice(selectedFace.index, 1);
  refreshDecorations(selectedFace.mesh);
  selectedFace.index = -1;
  updateFaceHighlight();
  updateFaceUI();
  snapshot("清除面样式");
  toast("已清除此面样式");
});

// 删除此面：把该面标记为 deleted → 显示几何剔除其三角形，留空洞透出后方物体
$("btn-face-delete").addEventListener("click", function () {
  if (!selectedFace) return;
  var mesh = selectedFace.mesh;
  var entry = ensureFaceEntry();
  entry.deleted = true;
  refreshDecorations(mesh);
  clearFaceSelection(); // 面已删除，取消选中
  refreshProps();
  snapshot("删除面");
  toast("已删除此面（透出后方）");
});

// ---------- 画板：面上正视绘制（纹理绘画）----------
// 现实中"在面上涂画"= 改变表面材质颜色。对应做法：笔画渲染进该面的 canvas 贴图，
// 以面自身三角形做覆层几何（几乎零偏移，polygonOffset 防深度冲突），标准材质受光照。
// 零厚度、笔画出面自动裁掉（覆层只有面三角形）、导出 GLB/USDZ 时纹理随模型带走。
// 纯函数（faceBasis / paintGroups / renderPaintCanvas / textStrokeSize）在 main.js。
var PAINT_RES = 1024;    // 贴图长边分辨率
var PAINT_LIFT = 0.0015; // 覆层沿法线抬升：肉眼不可见，仅防其他查看器的深度冲突
var _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(); // 世界长度换算用的临时向量

// 单个面的涂料覆层：面三角形几何 + uv + canvas 贴图
function buildPaintOverlay(mesh, group, activeStroke) {
  var base = mesh.userData.baseGeo || mesh.geometry;
  var data = collectFaceTriangles(base, group.n, group.d);
  if (!data.count) return null;
  var basis = faceBasis(group.n);
  var origin = data.centroid;
  // 面三角形顶点投到 (U,V) 平面求 uv 包围盒
  var pts = data.positions, uvs = [], p = new THREE.Vector3();
  var uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
  for (var i = 0; i < pts.length; i += 3) {
    p.set(pts[i], pts[i + 1], pts[i + 2]).sub(origin);
    var u = p.dot(basis.U), v = p.dot(basis.V);
    uvs.push(u, v);
    uMin = Math.min(uMin, u); uMax = Math.max(uMax, u);
    vMin = Math.min(vMin, v); vMax = Math.max(vMax, v);
  }
  var uRange = Math.max(uMax - uMin, 1e-6), vRange = Math.max(vMax - vMin, 1e-6);
  // 物体若被非均匀拉伸（scale 不是三轴同值），局部 U/V 单位向量在世界空间里的实际长度
  // 会不一样——canvas 长宽比与笔画粗细/字号都要按这个世界长度换算，笔画在"画的那一刻"
  // 才不会跟着物体当前的拉伸变形；之后再拉伸物体，笔画随几何一起拉伸则是正常预期。
  var worldULen = _v1.set(basis.U.x * mesh.scale.x, basis.U.y * mesh.scale.y, basis.U.z * mesh.scale.z).length() || 1;
  var worldVLen = _v2.set(basis.V.x * mesh.scale.x, basis.V.y * mesh.scale.y, basis.V.z * mesh.scale.z).length() || 1;
  // canvas：长边 PAINT_RES，短边按面在世界空间里的真实长宽比（而非局部坐标比例）
  var aspect = (vRange * worldVLen) / (uRange * worldULen);
  var W = aspect <= 1 ? PAINT_RES : Math.max(2, Math.round(PAINT_RES / aspect));
  var H = aspect <= 1 ? Math.max(2, Math.round(PAINT_RES * aspect)) : PAINT_RES;
  var canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  var ctx = canvas.getContext("2d");
  var strokes = activeStroke ? group.strokes.concat([activeStroke]) : group.strokes;
  // U/V 两个方向"局部单位→像素"换算率分开算（W/H 已按世界长宽比定，二者一般不相等，
  // 定位必须各用各的，否则非均匀拉伸时笔画位置会错位）；线宽/字号用各向同性的世界换算率。
  var pxU = W / uRange, pxV = H / vRange;
  var sizePx = pxU / worldULen; // ≈ pxV / worldVLen，同一个世界单位→像素换算率
  renderPaintCanvas(ctx, strokes, uMin, vMax, pxU, pxV, sketching ? sketching.selText : null, sizePx);
  // 覆层几何：面三角形沿法线微抬，uv 归一化
  var g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(offsetPositions(pts, group.n, PAINT_LIFT), 3));
  var uvAttr = new Float32Array(uvs.length);
  for (var k = 0; k < uvs.length; k += 2) {
    uvAttr[k] = (uvs[k] - uMin) / uRange;
    uvAttr[k + 1] = (uvs[k + 1] - vMin) / vRange;
  }
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uvAttr, 2));
  g.computeVertexNormals();
  var tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  // 材质约束（勿改回 MeshBasicMaterial！）：USDZExporter 只导出 isMeshStandardMaterial
  // 的网格（vendor/exporters/USDZExporter.js:445），Basic 材质会让涂料整个从 USDZ 里消失。
  // 涂料=普通贴图受光材质（白色漫反射），与物体面同一光照模型——场景灯光已按
  // "渲染色≈材质色"校准，涂料颜色即所选颜色；导出到任何软件都是标准 baseColor 贴图。
  var overlay = new THREE.Mesh(g, new THREE.MeshStandardMaterial({
    map: tex,
    transparent: true, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -3, // 渲染层防深度冲突（不改几何位置）
    roughness: 1, metalness: 0,
  }));
  overlay.raycast = function () {}; // 点选穿透到底下的面
  return overlay;
}

// 重建某物体上的全部涂画（activeStroke=正在画的笔画，实时预览）
function applySketch(mesh, activeStroke) {
  if (!mesh.isMesh) return;
  removeHelperChildren(mesh, ["sketch"]);
  var groups = paintGroups(mesh.userData.sketch);
  // 正在画的笔画所属面可能还没有任何已完成笔画
  if (activeStroke && sketching) {
    var akey = sketching.n[0].toFixed(3) + "," + sketching.n[1].toFixed(3) + "," + sketching.n[2].toFixed(3) + "|" + sketching.d.toFixed(3);
    if (!groups[akey]) groups[akey] = { n: sketching.n, d: sketching.d, strokes: [] };
  }
  Object.keys(groups).forEach(function (key) {
    var group = groups[key];
    var isActiveFace = activeStroke && sketching && group.n[0] === sketching.n[0] && group.n[1] === sketching.n[1] && group.n[2] === sketching.n[2] && group.d === sketching.d;
    var overlay = buildPaintOverlay(mesh, group, isActiveFace ? activeStroke : null);
    if (overlay) { overlay.userData = { helper: "sketch" }; mesh.add(overlay); }
  });
}

function enterSketch() {
  hideFaceMenu();
  if (!selectedFace) return;
  var mesh = selectedFace.mesh;
  var faceN = selectedFace.n.slice(), faceD = selectedFace.d; // 先捕获，clearFaceSelection 会清空 selectedFace
  var base = mesh.userData.baseGeo || mesh.geometry;
  var data = collectFaceTriangles(base, faceN, faceD);
  if (!data.count) { toast("此面无法进入画板"); return; }
  var basis = faceBasis(faceN);
  var origin = data.centroid.clone();
  mesh.updateMatrixWorld(true);
  var worldOrigin = mesh.localToWorld(origin.clone());
  var nMat = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
  var worldN = new THREE.Vector3().fromArray(faceN).applyMatrix3(nMat).normalize();
  var worldV = basis.V.clone().transformDirection(mesh.matrixWorld).normalize();
  // 面的世界包围盒 → 相机距离，使面填满约 80% 视口
  var wb = new THREE.Box3();
  for (var i = 0; i < data.boundary.length; i += 3) {
    wb.expandByPoint(mesh.localToWorld(new THREE.Vector3(data.boundary[i], data.boundary[i + 1], data.boundary[i + 2])));
  }
  var wsize = wb.getSize(new THREE.Vector3());
  var faceSize = Math.max(wsize.x, wsize.y, wsize.z, 0.5);
  var dist = (faceSize / 2) / Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) / 0.8;
  // 文字默认字号 ≈ 面局部尺寸的 22%
  var uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
  for (var b = 0; b < data.boundary.length; b += 3) {
    var bp = new THREE.Vector3(data.boundary[b], data.boundary[b + 1], data.boundary[b + 2]).sub(origin);
    var bu = bp.dot(basis.U), bv = bp.dot(basis.V);
    uMin = Math.min(uMin, bu); uMax = Math.max(uMax, bu); vMin = Math.min(vMin, bv); vMax = Math.max(vMax, bv);
  }
  var textSize = Math.max(0.05, Math.min(uMax - uMin, vMax - vMin) * 0.22);

  clearFaceSelection();
  refreshProps();
  tc.detach();

  sketching = {
    mesh: mesh, n: faceN, d: faceD,
    origin: origin, U: basis.U, V: basis.V,
    plane: new THREE.Plane(worldN.clone(), -worldN.dot(worldOrigin)),
    worldN: worldN.clone(), worldV: worldV.clone(), worldOrigin: worldOrigin.clone(), // 旋转画布用
    active: null, pendingText: null, dragText: null, selText: null, textSize: textSize,
    savedCam: { pos: camera.position.clone(), target: controls.target.clone() },
    savedUp: camera.up.clone(),
    savedRotate: controls.enableRotate, savedPan: controls.enablePan,
  };
  camera.up.copy(worldV);
  camera.position.copy(worldOrigin).addScaledVector(worldN, dist);
  controls.target.copy(worldOrigin);
  camera.lookAt(worldOrigin);
  controls.enableRotate = false;
  controls.enablePan = false;
  controls.update();

  syncSketchToolbar();
  $("sketch-rot").value = 0;
  renderer.domElement.style.cursor = "crosshair";
  $("sketch-bar").classList.add("show");
  $("hintbar").textContent = "画板模式：在面上拖动绘制（自由/直线）· 「文字」输入后点面放置、可拖动 · 「完成」或 Esc 退出";
  setOthersDim(mesh, SKETCH_DIM_FACTOR); // 其余物体压暗，避免挡住正在画的这个面
}

// 画板模式下把"正在画的物体"之外的一切压暗到 5% 透明度（不改 userData.opacity，
// 只是渲染层面的临时效果），退出画板时用同一函数恢复到 100% 还原
var SKETCH_DIM_FACTOR = 0.05;
function setOthersDim(mesh, factor) {
  var keepTop = topLevelOf(mesh);
  content.children.forEach(function (o) {
    if (o !== keepTop) applyExistenceOpacity(o, factor);
  });
}

function exitSketch() {
  if (!sketching) return;
  clearSketchPreview();
  var mesh = sketching.mesh;
  setOthersDim(mesh, 1); // 恢复其余物体的正常透明度
  camera.up.copy(sketching.savedUp);
  camera.position.copy(sketching.savedCam.pos);
  controls.target.copy(sketching.savedCam.target);
  controls.enableRotate = sketching.savedRotate;
  controls.enablePan = sketching.savedPan;
  controls.update();
  sketching.selText = null;
  applySketch(mesh); // 去掉贴图里的文字选框虚线
  sketching = null;
  renderer.domElement.style.cursor = "";
  $("sketch-bar").classList.remove("show");
  $("sketch-text").classList.remove("on");
  $("sketch-text-input").hidden = true;
  $("hintbar").textContent = "左键选择 · 拖动旋转视角 · 滚轮缩放 · 右键平移 · W/E/R 切换移动/旋转/缩放";
  select(topLevelOf(mesh));
}

// 屏幕点 → 面平面 → mesh 局部 uv
function sketchUV(clientX, clientY) {
  var rect = renderer.domElement.getBoundingClientRect();
  pointer.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
  var hit = new THREE.Vector3();
  if (!raycaster.ray.intersectPlane(sketching.plane, hit)) return null;
  var lp = sketching.mesh.worldToLocal(hit).sub(sketching.origin);
  return [lp.dot(sketching.U), lp.dot(sketching.V)];
}

// 预览=把未完成笔画一并画进贴图；取消预览=只按已完成笔画重画
function clearSketchPreview() {
  if (sketching) applySketch(sketching.mesh);
}

function updateSketchPreview() {
  var s = sketching.active;
  if (!s || s.pts.length < 2) return;
  applySketch(sketching.mesh, { color: s.color, width: s.width, pts: s.pts });
}

// 当前面上命中 uv 处的文字笔画（后画的优先）
function textStrokeAt(uv) {
  var arr = sketching.mesh.userData.sketch || [];
  for (var i = arr.length - 1; i >= 0; i--) {
    var s = arr[i];
    if (s.text == null || s.d !== sketching.d || s.n[0] !== sketching.n[0] || s.n[1] !== sketching.n[1] || s.n[2] !== sketching.n[2]) continue;
    var sz = textStrokeSize(s);
    if (Math.abs(uv[0] - s.u) <= sz.w / 2 && Math.abs(uv[1] - s.v) <= sz.h / 2) return s;
  }
  return null;
}

// 选中/取消选中一个文字笔画（选中后字号输入框控制其大小）
function setSelText(stroke) {
  sketching.selText = stroke;
  if (stroke) $("sketch-font").value = Math.round(stroke.size * UI_UNIT);
  applySketch(sketching.mesh);
}

function sketchDown(e) {
  var uv = sketchUV(e.clientX, e.clientY);
  if (!uv) return;
  if (sketching.pendingText != null) {
    // 放置文字：点一下把文字贴到该处（随即选中，可拖动/改字号）
    if (!sketching.mesh.userData.sketch) sketching.mesh.userData.sketch = [];
    var placed = {
      n: sketching.n.slice(), d: sketching.d, color: sketchColor,
      u: uv[0], v: uv[1], size: sketching.textSize, text: sketching.pendingText,
    };
    sketching.mesh.userData.sketch.push(placed);
    snapshot("放置画板文字");
    cancelPendingText();
    setSelText(placed);
    return;
  }
  var hitText = !sketchEraser && textStrokeAt(uv); // 橡皮模式下不选/不拖文字，直接擦
  if (hitText) {
    setSelText(hitText);
    sketching.dragText = { stroke: hitText, du: uv[0] - hitText.u, dv: uv[1] - hitText.v };
    renderer.domElement.setPointerCapture(e.pointerId);
    return;
  }
  if (sketching.selText) setSelText(null); // 点空白取消文字选中
  sketching.active = { color: sketchColor, width: sketchWidth, straight: sketchStraight, erase: sketchEraser, pts: [uv] };
  renderer.domElement.setPointerCapture(e.pointerId);
}

function sketchMove(e) {
  var uv = sketchUV(e.clientX, e.clientY);
  if (!uv) return;
  if (sketching.dragText) {
    sketching.dragText.stroke.u = uv[0] - sketching.dragText.du;
    sketching.dragText.stroke.v = uv[1] - sketching.dragText.dv;
    applySketch(sketching.mesh);
    return;
  }
  var s = sketching.active;
  if (!s) {
    // 悬停光标：橡皮=格擦、文字=移动、其余=十字
    renderer.domElement.style.cursor = sketchEraser ? "cell" : (textStrokeAt(uv) ? "move" : "crosshair");
    return;
  }
  if (s.straight) {
    s.pts = [s.pts[0], uv];
  } else {
    var last = s.pts[s.pts.length - 1];
    if (Math.hypot(uv[0] - last[0], uv[1] - last[1]) > 0.004) s.pts.push(uv);
  }
  updateSketchPreview();
}

function sketchUp() {
  if (sketching.dragText) { sketching.dragText = null; snapshot("移动画板文字"); return; } // 文字拖动结束
  var s = sketching.active;
  sketching.active = null;
  if (!s || s.pts.length < 2) { clearSketchPreview(); return; } // 单点不成线
  if (!sketching.mesh.userData.sketch) sketching.mesh.userData.sketch = [];
  var stroke = { n: sketching.n.slice(), d: sketching.d, color: s.color, width: s.width, pts: s.pts };
  if (s.erase) stroke.erase = true;
  sketching.mesh.userData.sketch.push(stroke);
  applySketch(sketching.mesh);
  snapshot(s.erase ? "画板擦除" : "画板绘制");
}

function syncSketchToolbar() {
  $("sketch-color").value = sketchColor;
  $("sketch-width").value = sketchWidth;
  $("sketch-mode").textContent = sketchStraight ? "直线" : "自由";
  $("sketch-mode").classList.toggle("on", sketchStraight);
  $("sketch-eraser").classList.toggle("on", sketchEraser);
  if (sketching) $("sketch-font").value = Math.round(sketching.textSize * UI_UNIT);
}

$("sketch-eraser").addEventListener("click", function () {
  sketchEraser = !sketchEraser;
  if (sketchEraser) cancelPendingText(); // 橡皮与放置文字互斥
  syncSketchToolbar();
});
// 旋转画布视角（绕面法线滚转相机），决定绘画方向；笔画数据仍存面局部 uv，不受影响
$("sketch-rot").addEventListener("change", function () {
  if (!sketching) return;
  var deg = parseFloat(this.value) || 0;
  camera.up.copy(sketching.worldV).applyAxisAngle(sketching.worldN, THREE.MathUtils.degToRad(-deg));
  camera.lookAt(sketching.worldOrigin);
});
$("sketch-font").addEventListener("change", function () {
  var v = Math.min(200, Math.max(4, parseInt(this.value, 10) || 26));
  this.value = v;
  if (!sketching) return;
  sketching.textSize = v / UI_UNIT; // 之后放置的文字用此字号
  if (sketching.selText) {
    sketching.selText.size = v / UI_UNIT; // 选中的文字直接缩放
    applySketch(sketching.mesh);
    snapshot("改画板字号");
  }
});
$("sketch-color").addEventListener("input", function () { sketchColor = this.value; });
$("sketch-width").addEventListener("change", function () {
  sketchWidth = Math.min(20, Math.max(1, parseFloat(this.value) || 3));
  this.value = sketchWidth;
});
$("sketch-mode").addEventListener("click", function () { sketchStraight = !sketchStraight; syncSketchToolbar(); });
function cancelPendingText() {
  if (!sketching) return;
  sketching.pendingText = null;
  $("sketch-text").classList.remove("on");
  $("sketch-text-input").hidden = true;
  $("hintbar").textContent = "画板模式：在面上拖动绘制 · 「文字」放置文字（放置后可拖动）· 完成或 Esc 退出";
}

$("sketch-text").addEventListener("click", function () {
  if (!sketching) return;
  var input = $("sketch-text-input");
  if (sketching.pendingText != null || !input.hidden) { cancelPendingText(); return; } // 再点一次取消
  input.hidden = false;
  input.value = "";
  input.focus();
  $("sketch-text").classList.add("on");
});
$("sketch-text-input").addEventListener("keydown", function (e) {
  if (e.key === "Escape") { cancelPendingText(); return; }
  if (e.key !== "Enter") return;
  var t = this.value.trim();
  if (!t) { cancelPendingText(); return; }
  sketching.pendingText = t;
  this.hidden = true;
  $("hintbar").textContent = "点击面上位置放置文字「" + t + "」（放置后可拖动 · 再点「文字」取消）";
});
$("sketch-undo").addEventListener("click", function () {
  if (!sketching) return;
  var arr = sketching.mesh.userData.sketch;
  if (!arr || !arr.length) { toast("没有可撤销的笔画"); return; }
  var popped = arr.pop();
  if (popped === sketching.selText) sketching.selText = null;
  applySketch(sketching.mesh);
  snapshot("撤销画板笔画");
});
$("sketch-clear").addEventListener("click", function () {
  if (!sketching) return;
  var arr = sketching.mesh.userData.sketch || [];
  var kept = arr.filter(function (s) { return !(s.d === sketching.d && s.n[0] === sketching.n[0] && s.n[1] === sketching.n[1] && s.n[2] === sketching.n[2]); });
  if (kept.length === arr.length) { toast("此面没有笔画"); return; }
  sketching.mesh.userData.sketch = kept;
  sketching.selText = null;
  applySketch(sketching.mesh);
  snapshot("清空画板");
  toast("已清空此面的画");
});
$("sketch-done").addEventListener("click", exitSketch);

// ---------- 线条工具：两点放置 + 节点手柄编辑 ----------
var lineMode = false;
var lineStart = null;
var lineHandles = new THREE.Group();
scene.add(lineHandles);
var _lhNodeGeo = new THREE.SphereGeometry(0.085, 12, 8);
var _lhMidGeo = new THREE.BoxGeometry(0.11, 0.11, 0.11);

// 手柄按相机距离自适应缩放（屏幕上保持可点大小），渲染循环每帧调用
function scaleLineHandles() {
  if (!lineHandles.children.length) return;
  var dist = camera.position.distanceTo(controls.target);
  var s = Math.max(0.5, dist / 11);
  lineHandles.children.forEach(function (h) { h.scale.setScalar(s); });
}
var lineDragging = null; // { obj, index, plane }

function selectedLine() {
  return selection.length === 1 && selected && selected.userData.kind === "line" ? selected : null;
}

function setLineMode(on) {
  if (on) {
    exitSketch();
    exitDrawMode();
    if (marqueeMode) setMarqueeMode(false);
    if (faceMode) setFaceMode(false);
    select(null);
  }
  lineMode = on;
  lineStart = null;
  $("tool-line").classList.toggle("active", on);
  $("hintbar").textContent = on
    ? "线条：点击起点，再点击终点完成 · Esc 取消"
    : "左键选择 · 拖动旋转视角 · 滚轮缩放 · 右键平移 · W/E/R 切换移动/旋转/缩放";
}

function clearLineHandles() {
  while (lineHandles.children.length) {
    lineHandles.children[lineHandles.children.length - 1].material.dispose();
    lineHandles.remove(lineHandles.children[lineHandles.children.length - 1]);
  }
}

// 选中线条时显示手柄：节点小球（灰紫=折角、灰绿=平滑）、线段中点方块（点击加节点）
function refreshLineHandles() {
  clearLineHandles();
  var obj = selectedLine();
  if (!obj || playback || exporting) return;
  obj.updateMatrixWorld(true);
  var pts = obj.userData.params.pts;
  pts.forEach(function (n, i) {
    var h = new THREE.Mesh(_lhNodeGeo, new THREE.MeshBasicMaterial({ color: n.smooth ? 0x8A9A8B : 0x736B85, depthTest: false, transparent: true, opacity: 0.95 }));
    h.renderOrder = 1000;
    h.position.copy(obj.localToWorld(new THREE.Vector3().fromArray(n.p)));
    h.userData = { lh: "node", index: i };
    lineHandles.add(h);
  });
  for (var i = 0; i + 1 < pts.length; i++) {
    var m = new THREE.Mesh(_lhMidGeo, new THREE.MeshBasicMaterial({ color: 0xB98E84, depthTest: false, transparent: true, opacity: 0.9 }));
    m.renderOrder = 1000;
    m.position.copy(obj.localToWorld(new THREE.Vector3().fromArray(pts[i].p).lerp(new THREE.Vector3().fromArray(pts[i + 1].p), 0.5)));
    m.userData = { lh: "mid", index: i };
    lineHandles.add(m);
  }
}

// 屏幕空间拾取：手柄投影到屏幕，取 14px 内最近者（比射线检测更好点中小手柄）
var _lhProj = new THREE.Vector3();
function pickLineHandle(clientX, clientY) {
  if (!lineHandles.children.length) return null;
  var rect = renderer.domElement.getBoundingClientRect();
  var px = clientX - rect.left, py = clientY - rect.top;
  var best = null, bestD = 14;
  lineHandles.children.forEach(function (h) {
    _lhProj.copy(h.position).project(camera);
    if (_lhProj.z > 1) return; // 在相机身后
    var sx = (_lhProj.x + 1) / 2 * rect.width;
    var sy = (1 - _lhProj.y) / 2 * rect.height;
    var dd = Math.hypot(sx - px, sy - py);
    if (dd < bestD) { bestD = dd; best = h; }
  });
  return best;
}

function insertLineNode(segIndex) {
  var obj = selectedLine();
  if (!obj) return;
  var pts = obj.userData.params.pts;
  var a = pts[segIndex].p, b = pts[segIndex + 1].p;
  pts.splice(segIndex + 1, 0, { p: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2], smooth: false });
  rebuildLine(obj);
  snapshot("加线条节点");
  toast("已加节点（双击节点切换折角/平滑）");
}

function deleteLineNode(index) {
  var obj = selectedLine();
  if (!obj) return;
  var pts = obj.userData.params.pts;
  if (pts.length <= 2) { toast("线条至少保留两个端点"); return; }
  pts.splice(index, 1);
  rebuildLine(obj);
  refreshLineProps();
  snapshot("删线条节点");
}

// 线条属性：粗细 + 起点/终点（世界坐标，界面单位；Z 竖直）
function refreshLineProps() {
  var obj = selectedLine();
  $("line-props").hidden = !obj;
  $("prop-size-field").hidden = !!obj; // 线条不用尺寸缩放，用端点/节点定义形状
  $("prop-texture-field").hidden = !!obj;
  if (obj) $("texture-params").innerHTML = "";
  if (!obj) return;
  obj.updateMatrixWorld(true);
  var pts = obj.userData.params.pts;
  var s = obj.localToWorld(new THREE.Vector3().fromArray(pts[0].p));
  var e = obj.localToWorld(new THREE.Vector3().fromArray(pts[pts.length - 1].p));
  $("line-width").value = obj.userData.params.width || 4;
  $("line-sx").value = Math.round(s.x * UI_UNIT);
  $("line-sz").value = Math.round(s.z * UI_UNIT);
  $("line-sy").value = Math.round(s.y * UI_UNIT);
  $("line-ex").value = Math.round(e.x * UI_UNIT);
  $("line-ez").value = Math.round(e.z * UI_UNIT);
  $("line-ey").value = Math.round(e.y * UI_UNIT);
}

$("line-width").addEventListener("change", function () {
  var obj = selectedLine();
  if (!obj) return;
  var w = Math.min(40, Math.max(0.5, parseFloat(this.value) || 4));
  this.value = w;
  obj.userData.params.width = w;
  obj.material.linewidth = w * 0.01;
  snapshot("改线条粗细");
});

// 端点输入：世界坐标 → 线条局部坐标写回
function bindLineEndInput(id, axis, isEnd) {
  $(id).addEventListener("change", function () {
    var obj = selectedLine();
    if (!obj) return;
    var v = parseFloat(this.value) / UI_UNIT;
    if (isNaN(v)) { refreshLineProps(); return; }
    var pts = obj.userData.params.pts;
    var node = pts[isEnd ? pts.length - 1 : 0];
    obj.updateMatrixWorld(true);
    var world = obj.localToWorld(new THREE.Vector3().fromArray(node.p));
    world[axis] = v;
    node.p = obj.worldToLocal(world).toArray();
    rebuildLine(obj);
    snapshot("改线条端点");
  });
}
bindLineEndInput("line-sx", "x", false);
bindLineEndInput("line-sz", "z", false);
bindLineEndInput("line-sy", "y", false);
bindLineEndInput("line-ex", "x", true);
bindLineEndInput("line-ez", "z", true);
bindLineEndInput("line-ey", "y", true);

// 水槽属性：壁厚 / 底厚（局部单位 × UI_UNIT 显示，跟尺寸字段同一套换算，改完重建几何）
function selectedTrough() {
  return selection.length === 1 && selected && selected.userData.kind === "trough" ? selected : null;
}
function refreshTroughProps() {
  var obj = selectedTrough();
  $("trough-props").hidden = !obj;
  if (!obj) return;
  var p = obj.userData.params;
  $("trough-wall").value = Math.round((p.wall != null ? p.wall : TROUGH_WALL_DEFAULT) * UI_UNIT);
  $("trough-bottom").value = Math.round((p.bottom != null ? p.bottom : TROUGH_BOTTOM_DEFAULT) * UI_UNIT);
}
$("trough-wall").addEventListener("change", function () {
  var obj = selectedTrough();
  if (!obj) return;
  var maxWall = Math.round((TROUGH_SIZE / 2 - 0.02) * UI_UNIT);
  var w = Math.min(maxWall, Math.max(2, Math.round(parseFloat(this.value)) || Math.round(TROUGH_WALL_DEFAULT * UI_UNIT)));
  this.value = w;
  obj.userData.params.wall = w / UI_UNIT;
  rebuildTrough(obj);
  snapshot("改水槽壁厚");
});
$("trough-bottom").addEventListener("change", function () {
  var obj = selectedTrough();
  if (!obj) return;
  var maxBottom = Math.round((TROUGH_SIZE - 0.1) * UI_UNIT);
  var b = Math.min(maxBottom, Math.max(0, Math.round(parseFloat(this.value)) || 0));
  this.value = b;
  obj.userData.params.bottom = b / UI_UNIT;
  rebuildTrough(obj);
  snapshot("改水槽底厚");
});

$("tool-line").addEventListener("click", function () { setLineMode(!lineMode); });

// ---------- 面右键菜单 ----------

function showFaceMenu(clientX, clientY) {
  var menu = $("face-menu");
  var rect = viewport.getBoundingClientRect();
  menu.style.left = (clientX - rect.left) + "px";
  menu.style.top = (clientY - rect.top) + "px";
  menu.hidden = false;
}
function hideFaceMenu() { $("face-menu").hidden = true; }
$("menu-sketch").addEventListener("click", enterSketch);

renderer.domElement.addEventListener("contextmenu", function (e) {
  if (selectedFace && !sketching) {
    e.preventDefault();
    showFaceMenu(e.clientX, e.clientY);
  }
});
document.addEventListener("pointerdown", function (e) {
  if (!$("face-menu").hidden && !$("face-menu").contains(e.target)) hideFaceMenu();
});

$("btn-clear").addEventListener("click", function () {
  if (!content.children.length && !keyframes.length) return;
  if (!confirm("确认清空场景和全部关键帧？（可撤销）")) return;
  exitDrawMode();
  select(null);
  while (content.children.length) removeObject(content.children[0]);
  keyframes = [];
  renderKeyframes();
  snapshot("清空场景");
});

// ---------- 工具栏与快捷键 ----------

document.querySelectorAll(".tool[data-add]").forEach(function (btn) {
  btn.addEventListener("click", function () {
    exitDrawMode();
    addPrimitive(btn.getAttribute("data-add"));
  });
});
$("tool-select").addEventListener("click", function () { exitSketch(); exitDrawMode(); setLineMode(false); setMarqueeMode(false); setFaceMode(false); select(null); });
$("tool-marquee").addEventListener("click", function () { setMarqueeMode(!marqueeMode); });
$("tool-face").addEventListener("click", function () { setFaceMode(!faceMode); });
$("tool-draw").addEventListener("click", function () { drawing ? exitDrawMode() : enterDrawMode(); });
$("btn-draw-finish").addEventListener("click", drawPrimaryAction);
$("btn-draw-cancel").addEventListener("click", exitDrawMode);
$("mode-translate").addEventListener("click", function () { setTransformMode("translate"); });
$("mode-rotate").addEventListener("click", function () { setTransformMode("rotate"); });
$("mode-scale").addEventListener("click", function () { setTransformMode("scale"); });
$("toggle-snap").addEventListener("click", toggleSnap);

document.addEventListener("keydown", function (e) {
  var tag = (e.target.tagName || "").toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return;
  var ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && e.key.toLowerCase() === "z" && !e.shiftKey) { e.preventDefault(); applyHistory(undoIndex - 1); return; }
  if ((ctrl && e.key.toLowerCase() === "y") || (ctrl && e.shiftKey && e.key.toLowerCase() === "z")) { e.preventDefault(); applyHistory(undoIndex + 1); return; }
  if (ctrl && e.key.toLowerCase() === "d") { e.preventDefault(); duplicateSelected(); return; }
  if (ctrl && e.key.toLowerCase() === "g") { e.preventDefault(); if (e.shiftKey) ungroupSelection(); else groupSelection(); return; }
  switch (e.key) {
    case "Escape":
      if (sketching) exitSketch();
      else if (lineMode) setLineMode(false);
      else if (drawing) exitDrawMode();
      else if (selectedFace) { clearFaceSelection(); refreshProps(); }
      else if (faceMode) setFaceMode(false);
      else if (marqueeMode) setMarqueeMode(false);
      else select(null);
      break;
    case "Enter": if (drawing) drawPrimaryAction(); break;
    case "Delete":
    case "Backspace": if (selection.length) deleteSelected(); break;
    case "q": case "Q": exitDrawMode(); setLineMode(false); setMarqueeMode(false); setFaceMode(false); select(null); break;
    case "b": case "B": setMarqueeMode(!marqueeMode); break;
    case "f": case "F": setFaceMode(!faceMode); break;
    case "d": case "D": drawing ? exitDrawMode() : enterDrawMode(); break;
    case "l": case "L": setLineMode(!lineMode); break;
    case "w": case "W": setTransformMode("translate"); break;
    case "e": case "E": setTransformMode("rotate"); break;
    case "r": case "R": setTransformMode("scale"); break;
  }
});

// ---------- 启动：恢复存档或放一个默认物体 ----------

setTransformMode("translate");
renderKeyframes();
try {
  var savedView = JSON.parse(localStorage.getItem(VIEW_KEY));
  if (savedView) {
    view.shadow = savedView.shadow !== false;
    if (savedView.shadowCfg) view.shadowCfg = savedView.shadowCfg;
    view.ground = savedView.ground !== false;
    // 旧版 "" 表示无背景，迁移为默认图
    view.bg = savedView.bg === "" || savedView.bg == null ? "default" : savedView.bg;
    view.anchor = savedView.anchor || "center";
    view.fps = Math.min(120, Math.max(10, parseInt(savedView.fps, 10) || 60));
    view.res = savedView.res === "4k" ? "4k" : "1080";
    if (savedView.lightCfg) view.lightCfg = savedView.lightCfg;
  }
} catch (e) { /* 损坏设置忽略 */ }
applyViewSettings();
setBackground(view.bg);
var saved = null;
try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY)); } catch (e) { /* 损坏存档忽略 */ }
if (saved && saved.v === 2 && Array.isArray(saved.scenes) && saved.scenes.length && saved.store) {
  // 新版多场景存档
  scenes = saved.scenes;
  sceneSeq = saved.sceneSeq || scenes.reduce(function (m, s) { return Math.max(m, s.id); }, 0);
  sceneStore = saved.store;
  activeSceneId = findScene(saved.activeSceneId) ? saved.activeSceneId : scenes[0].id;
  restore(sceneStore[activeSceneId] || {}); // restore() 内部会渲染图层
  undoStack = [{ json: JSON.stringify(serialize()), label: "打开项目" }];
  undoIndex = 0;
  refreshUndoRedoTips();
  renderScenes();
} else if (saved && saved.v === 1 && (saved.objects || []).length) {
  // 旧版单场景存档：无缝迁移成唯一的"场景 1"，用户不用做任何操作就能继续用
  restore(saved);
  scenes = [{ id: 1, name: "场景 1" }];
  sceneSeq = 1;
  activeSceneId = 1;
  sceneStore = { 1: serialize() };
  undoStack = [{ json: JSON.stringify(saved), label: "打开项目" }];
  undoIndex = 0;
  refreshUndoRedoTips();
  renderScenes();
} else {
  renderLayers();
  var first = createObject("box", {});
  restOnGround(first);
  renderLayers(); // 反映首个物体的计数
  snapshot("新建物体"); // 内部会把 sceneStore[1] 一起同步好
  renderScenes();
}

// ---------- 脚本模式（独立模块 script.js，经 bridge 交互） ----------
initScriptMode({
  UI_UNIT: UI_UNIT,
  tmpVec: function () { return new THREE.Vector3(); },
  createObject: createObject,
  removeObject: function (o) {
    if (selection.indexOf(o) !== -1) select(null);
    removeObject(o);
  },
  copyClone: function (src) { return cloneObject(src); },
  mirrorClone: function (src) {
    if (!src.userData.mirror) src.userData.mirror = "m" + src.userData.id;
    var copy = cloneObject(src);
    copy.userData.mirror = src.userData.mirror;
    return copy;
  },
  topObjects: function () { return content.children.slice(); },
  localBounds: localBounds,
  setTexture: function (o, type, params) {
    if (!TEXTURES[type]) throw new Error("未知纹理类型：" + type + "（可用：" + Object.keys(TEXTURES).join("/") + "）");
    if (!o.isMesh || o.userData.kind === "text2d" || o.userData.kind === "line" || o.userData.kind === "group") return;
    var cfg = defaultTextureCfg(type);
    Object.keys(params || {}).forEach(function (k) { cfg.params[k] = params[k]; });
    o.userData.texture = cfg;
    applyTexture(o);
  },
  clearTexture: function (o) {
    if (!o.isMesh) return;
    o.userData.texture = null;
    applyTexture(o);
  },
  select: select,
  snapshot: snapshot,
  toast: toast,
  isBusy: function () { return !!(playback || exporting); },
});
