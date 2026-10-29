// draw3d 纯函数模块（无场景状态，仅依赖 THREE）
// 供 index.js 调用：文字轮廓引擎、几何处理、随机扰动数学
import * as THREE from "three";

// ==================== 文字：画布渲染 + 位图轮廓提取（支持任意系统字体含中文，无需字体文件） ====================

var TEXT_FONT = "600 {px}px 'Inter', -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif";

export function textCanvas(text, fontPx, pad) {
  var canvas = document.createElement("canvas");
  var ctx = canvas.getContext("2d");
  var font = TEXT_FONT.replace("{px}", fontPx);
  ctx.font = font;
  canvas.width = Math.max(2, Math.ceil(ctx.measureText(text).width) + pad * 2);
  canvas.height = Math.ceil(fontPx * 1.4) + pad * 2; // 预留下伸部
  ctx = canvas.getContext("2d");
  ctx.font = font;
  ctx.fillStyle = "#fff";
  ctx.textBaseline = "top";
  ctx.fillText(text, pad, pad);
  return canvas;
}

// 位图 → 有向边界环：沿实心像素的裸露边生成有向单位边（实心区域在行进方向左侧），按端点串成闭环。
// 纯函数，便于测试：grid 为 w*h 布尔数组。
function traceGrid(grid, w, h) {
  var edges = {}; // "x,y" -> [[nx,ny], ...]
  function addEdge(x0, y0, x1, y1) {
    var k = x0 + "," + y0;
    (edges[k] || (edges[k] = [])).push([x1, y1]);
  }
  var filled = function (x, y) { return x >= 0 && y >= 0 && x < w && y < h && grid[y * w + x]; };
  for (var y = 0; y < h; y++) {
    for (var x = 0; x < w; x++) {
      if (!grid[y * w + x]) continue;
      if (!filled(x, y - 1)) addEdge(x + 1, y, x, y);         // 上边露空：向 -x
      if (!filled(x, y + 1)) addEdge(x, y + 1, x + 1, y + 1); // 下边露空：向 +x
      if (!filled(x - 1, y)) addEdge(x, y, x, y + 1);         // 左边露空：向 +y
      if (!filled(x + 1, y)) addEdge(x + 1, y + 1, x + 1, y); // 右边露空：向 -y
    }
  }
  var loops = [];
  for (var key in edges) {
    while (edges[key] && edges[key].length) {
      var start = key.split(",").map(Number);
      var loop = [start];
      var cur = edges[key].pop();
      while (cur[0] !== start[0] || cur[1] !== start[1]) {
        loop.push(cur);
        var nk = cur[0] + "," + cur[1];
        var outs = edges[nk];
        if (!outs || !outs.length) { loop = null; break; } // 理论不该发生，防御断链
        cur = outs.pop();
      }
      if (loop && loop.length >= 4) loops.push(loop);
    }
  }
  return loops;
}

// Ramer–Douglas–Peucker 抽稀（闭环按开链处理，首尾同点）
function rdpSimplify(points, eps) {
  if (points.length < 3) return points;
  var keep = new Array(points.length).fill(false);
  keep[0] = keep[points.length - 1] = true;
  var stack = [[0, points.length - 1]];
  while (stack.length) {
    var seg = stack.pop(), i0 = seg[0], i1 = seg[1];
    var a = points[i0], b = points[i1];
    var dx = b[0] - a[0], dy = b[1] - a[1];
    var len = Math.hypot(dx, dy) || 1e-9;
    var maxD = -1, maxI = -1;
    for (var i = i0 + 1; i < i1; i++) {
      var d = Math.abs((points[i][0] - a[0]) * dy - (points[i][1] - a[1]) * dx) / len;
      if (d > maxD) { maxD = d; maxI = i; }
    }
    if (maxD > eps) {
      keep[maxI] = true;
      stack.push([i0, maxI], [maxI, i1]);
    }
  }
  return points.filter(function (_, i) { return keep[i]; });
}

// 闭环抽稀：首尾同点会让 RDP 整段塌缩，先取距首点最远的点作第二锚点，分两段处理
function simplifyLoop(loop, eps) {
  var far = 0, farD = -1;
  for (var i = 1; i < loop.length; i++) {
    var dx = loop[i][0] - loop[0][0], dy = loop[i][1] - loop[0][1];
    var d = dx * dx + dy * dy;
    if (d > farD) { farD = d; far = i; }
  }
  var a = rdpSimplify(loop.slice(0, far + 1), eps);
  var b = rdpSimplify(loop.slice(far).concat([loop[0]]), eps);
  return a.slice(0, -1).concat(b.slice(0, -1));
}

function pointInLoop(px, py, loop) {
  var inside = false;
  for (var i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    var xi = loop[i][0], yi = loop[i][1], xj = loop[j][0], yj = loop[j][1];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// 环嵌套分类：偶数层=实心轮廓，奇数层=其直接父级的洞（天然支持「回」字型多层嵌套）
function loopsToShapeDefs(loops) {
  var info = loops.map(function (loop) {
    return { loop: loop, depth: 0, parent: -1, area: Math.abs(signedArea(loop)) };
  });
  function signedArea(l) {
    var s = 0;
    for (var i = 0, j = l.length - 1; i < l.length; j = i++) s += (l[j][0] * l[i][1] - l[i][0] * l[j][1]);
    return s / 2;
  }
  for (var i = 0; i < info.length; i++) {
    var p = info[i].loop[0];
    var bestArea = Infinity;
    for (var j = 0; j < info.length; j++) {
      if (i === j) continue;
      if (info[j].area > info[i].area && pointInLoop(p[0] + 0.5, p[1] + 0.5, info[j].loop) && info[j].area < bestArea) {
        bestArea = info[j].area;
        info[i].parent = j;
      }
    }
  }
  info.forEach(function (it) {
    var d = 0, p = it.parent;
    while (p !== -1) { d++; p = info[p].parent; }
    it.depth = d;
  });
  var defs = [];
  info.forEach(function (it, i) {
    if (it.depth % 2 === 0) defs.push({ outer: it.loop, holes: [], index: i });
  });
  info.forEach(function (it) {
    if (it.depth % 2 === 1) {
      var owner = defs.find(function (d) { return d.index === it.parent; });
      if (owner) owner.holes.push(it.loop);
    }
  });
  return defs;
}

export function textToShapes(text) {
  var canvas = textCanvas(text, 128, 6);
  var ctx = canvas.getContext("2d");
  var w = canvas.width, h = canvas.height;
  var alpha = ctx.getImageData(0, 0, w, h).data;
  var grid = new Uint8Array(w * h);
  for (var i = 0; i < w * h; i++) grid[i] = alpha[i * 4 + 3] > 127 ? 1 : 0;
  var loops = traceGrid(grid, w, h).map(function (loop) {
    return simplifyLoop(loop, 1.4);
  }).filter(function (l) { return l.length >= 3; });
  if (!loops.length) return [];
  var s = 1 / 128; // 字高 ≈ 1 场景单位
  var toVec = function (p) { return new THREE.Vector2(p[0] * s, (h - p[1]) * s); }; // 画布 y 向下 → 形状 y 向上
  return loopsToShapeDefs(loops).map(function (def) {
    var shape = new THREE.Shape(def.outer.map(toVec));
    def.holes.forEach(function (hole) { shape.holes.push(new THREE.Path(hole.map(toVec))); });
    return shape;
  });
}

// ==================== 几何处理：共面三角形聚合、面剔除、导入模型烘焙 ====================

// 收集与给定局部平面（法线 n、常数 d）共面的三角形：返回展开顶点、边界线段与质心
export function collectFaceTriangles(geometry, nArr, dConst) {
  var n = new THREE.Vector3().fromArray(nArr);
  var pos = geometry.attributes.position;
  var index = geometry.index;
  var triCount = index ? index.count / 3 : pos.count / 3;
  var a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  var ab = new THREE.Vector3(), ac = new THREE.Vector3(), tn = new THREE.Vector3();
  var out = { positions: [], boundary: [], centroid: new THREE.Vector3(), count: 0 };
  var edgeMap = {};
  function vKey(v) { return v.x.toFixed(4) + "," + v.y.toFixed(4) + "," + v.z.toFixed(4); }
  function addEdge(p, q) {
    var k1 = vKey(p), k2 = vKey(q);
    var key = k1 < k2 ? k1 + "|" + k2 : k2 + "|" + k1;
    if (edgeMap[key]) edgeMap[key].count++;
    else edgeMap[key] = { count: 1, seg: [p.x, p.y, p.z, q.x, q.y, q.z] };
  }
  for (var t = 0; t < triCount; t++) {
    var i0 = index ? index.getX(t * 3) : t * 3;
    var i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
    var i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;
    a.fromBufferAttribute(pos, i0);
    b.fromBufferAttribute(pos, i1);
    c.fromBufferAttribute(pos, i2);
    tn.crossVectors(ab.subVectors(b, a), ac.subVectors(c, a)).normalize();
    if (tn.dot(n) < 0.995) continue;
    if (Math.abs(a.dot(n) - dConst) > 0.01) continue;
    out.count++;
    out.positions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    out.centroid.add(a).add(b).add(c);
    addEdge(a, b);
    addEdge(b, c);
    addEdge(c, a);
  }
  if (out.count) out.centroid.divideScalar(out.count * 3);
  for (var key in edgeMap) {
    if (edgeMap[key].count === 1) out.boundary.push.apply(out.boundary, edgeMap[key].seg);
  }
  return out;
}

export function offsetPositions(arr, nArr, eps) {
  var res = new Array(arr.length);
  for (var i = 0; i < arr.length; i += 3) {
    res[i] = arr[i] + nArr[0] * eps;
    res[i + 1] = arr[i + 1] + nArr[1] * eps;
    res[i + 2] = arr[i + 2] + nArr[2] * eps;
  }
  return res;
}

// 判断三角形是否属于某个面（法线共向且共面）
function triOnFace(a, b, c, n, dConst, tn, ab, ac) {
  tn.crossVectors(ab.subVectors(b, a), ac.subVectors(c, a)).normalize();
  return tn.dot(n) >= 0.995 && Math.abs(a.dot(n) - dConst) <= 0.01;
}

// 显示几何 = 基础几何剔除「被样式化/删除的面」三角形。样式面由半透明覆层替代（透出后方），
// 删除面留空洞（透出后方物体）。无此类面时直接用基础几何，避免多余克隆。
export function trimGeometryForFaces(baseGeo, faces) {
  var active = faces || [];
  if (!active.length) return baseGeo;
  var planes = active.map(function (f) { return { n: new THREE.Vector3().fromArray(f.n), d: f.d }; });
  var pos = baseGeo.attributes.position;
  var index = baseGeo.index;
  var triCount = index ? index.count / 3 : pos.count / 3;
  var a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  var ab = new THREE.Vector3(), ac = new THREE.Vector3(), tn = new THREE.Vector3();
  var keep = [];
  for (var t = 0; t < triCount; t++) {
    var i0 = index ? index.getX(t * 3) : t * 3;
    var i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
    var i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;
    a.fromBufferAttribute(pos, i0);
    b.fromBufferAttribute(pos, i1);
    c.fromBufferAttribute(pos, i2);
    var drop = false;
    for (var p = 0; p < planes.length; p++) {
      if (triOnFace(a, b, c, planes[p].n, planes[p].d, tn, ab, ac)) { drop = true; break; }
    }
    if (!drop) keep.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
  }
  var g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(keep, 3));
  g.computeVertexNormals();
  return g;
}

// ==================== 随机扰动：多频正弦合成的平滑漂移，由物体 id 播种、结果确定可重放 ====================

function mulberry32(seed) {
  var a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    var t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 每个物体每轴一组固定的随机频率/相位（由物体 id 播种，重放结果确定）
var jitterSeeds = {};
function jitterSeed(id) {
  if (!jitterSeeds[id]) {
    var rand = mulberry32((id * 2654435761) >>> 0);
    var axes = [];
    for (var a = 0; a < 3; a++) {
      var f = [], p = [];
      for (var k = 0; k < 3; k++) {
        f.push(0.6 + rand() * 0.9);
        p.push(rand() * Math.PI * 2);
      }
      axes.push({ f: f, p: p });
    }
    jitterSeeds[id] = axes;
  }
  return jitterSeeds[id];
}

// 随机度 0=单频规律摆动，1=多频混沌；幅值不超出边框半径。target 为传入的 Vector3
export function jitterOffset(obj, t, target) {
  var j = obj.userData.jitter;
  var seeds = jitterSeed(obj.userData.id);
  var r = Math.min(1, Math.max(0, j.randomness));
  var w = t * (j.speed || 1) * 2;
  for (var a = 0; a < 3; a++) {
    var s = seeds[a];
    var smooth = Math.sin(w * s.f[0] + s.p[0]);
    var chaos = 0.55 * Math.sin(w * s.f[1] * 2.7 + s.p[1]) + 0.45 * Math.sin(w * s.f[2] * 6.3 + s.p[2]);
    var v = (1 - r) * smooth + r * (0.4 * smooth + 0.6 * chaos);
    target.setComponent(a, j.box[a] * Math.max(-1, Math.min(1, v)));
  }
  return target;
}

// ==================== 边框烘焙：屏幕像素粗线 → 真实细管几何（供模型导出） ====================
// fat-lines 是"永远 N 像素宽"的屏幕空间特效，3D 格式无法表达；导出时沿每条线段
// 生成细圆柱并合并为一个几何，虚线/点线按同样的 dash/gap 参数切段。

// 线段按虚线参数切成子段；dash 为 null 表示实线不切
function splitSegmentsByDash(segs, dash) {
  if (!dash || !dash.dashed) return segs;
  var out = [];
  var a = new THREE.Vector3(), b = new THREE.Vector3(), dir = new THREE.Vector3();
  for (var i = 0; i < segs.length; i += 6) {
    a.set(segs[i], segs[i + 1], segs[i + 2]);
    b.set(segs[i + 3], segs[i + 4], segs[i + 5]);
    var len = dir.subVectors(b, a).length();
    if (len < 1e-6) continue;
    dir.normalize();
    var t = 0;
    while (t < len) {
      var end = Math.min(len, t + dash.dashSize);
      out.push(
        a.x + dir.x * t, a.y + dir.y * t, a.z + dir.z * t,
        a.x + dir.x * end, a.y + dir.y * end, a.z + dir.z * end
      );
      t = end + dash.gapSize;
    }
  }
  return out;
}

// 线段数组（[x1,y1,z1,x2,y2,z2,...]）→ 合并的细管 BufferGeometry
export function strokeSegmentsToTubes(segs, radius, dash) {
  segs = splitSegmentsByDash(segs, dash);
  if (!segs.length) return null;
  var template = new THREE.CylinderGeometry(radius, radius, 1, 5, 1).toNonIndexed();
  var tPos = template.attributes.position, tNorm = template.attributes.normal;
  var vcount = tPos.count, segCount = segs.length / 6;
  var pos = new Float32Array(segCount * vcount * 3);
  var norm = new Float32Array(segCount * vcount * 3);
  var a = new THREE.Vector3(), b = new THREE.Vector3(), dir = new THREE.Vector3(), mid = new THREE.Vector3();
  var up = new THREE.Vector3(0, 1, 0), quat = new THREE.Quaternion();
  var v = new THREE.Vector3(), n = new THREE.Vector3(), mat = new THREE.Matrix4();
  var write = 0;
  for (var i = 0; i < segs.length; i += 6) {
    a.set(segs[i], segs[i + 1], segs[i + 2]);
    b.set(segs[i + 3], segs[i + 4], segs[i + 5]);
    var len = dir.subVectors(b, a).length();
    if (len < 1e-6) len = 1e-6;
    dir.normalize();
    quat.setFromUnitVectors(up, dir);
    mid.addVectors(a, b).multiplyScalar(0.5);
    mat.compose(mid, quat, v.set(1, len, 1));
    for (var k = 0; k < vcount; k++) {
      v.fromBufferAttribute(tPos, k).applyMatrix4(mat);
      // 法线只随旋转（模板侧面法线垂直于 Y、端盖法线沿 Y，Y 向缩放均不改变其方向）
      n.fromBufferAttribute(tNorm, k).applyQuaternion(quat);
      pos[write] = v.x; norm[write++] = n.x;
      pos[write] = v.y; norm[write++] = n.y;
      pos[write] = v.z; norm[write++] = n.z;
    }
  }
  template.dispose();
  var g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(norm, 3));
  return g;
}

// ==================== 涂画（纹理绘画）：面基向量 / 笔画分组 / 贴图渲染 ====================

// 面平面的局部正交基（由法线确定性推出，保证 uv 与渲染一致）
export function faceBasis(nArr) {
  var n = new THREE.Vector3().fromArray(nArr).normalize();
  var ref = Math.abs(n.y) < 0.99 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  var U = new THREE.Vector3().crossVectors(ref, n).normalize();
  var V = new THREE.Vector3().crossVectors(n, U).normalize();
  return { n: n, U: U, V: V };
}

// 笔画按所属面分组（同面共用一张贴图）
export function paintGroups(strokes) {
  var groups = {};
  (strokes || []).forEach(function (s) {
    var key = s.n[0].toFixed(3) + "," + s.n[1].toFixed(3) + "," + s.n[2].toFixed(3) + "|" + s.d.toFixed(3);
    (groups[key] = groups[key] || { n: s.n, d: s.d, strokes: [] }).strokes.push(s);
  });
  return groups;
}

// 涂画文字字体：圆体优先（mac 圆体-简 / win 幼圆），逐级回退
export var PAINT_FONT = '"Yuanti SC", "YouYuan", "幼圆", "Arial Rounded MT Bold", "PingFang SC", "Microsoft YaHei", sans-serif';
var SKETCH_WORLD_SCALE = 0.01; // 界面粗细值 → 世界单位线宽

// 文字笔画的世界尺寸（宽×高），用于命中测试与选框
var _measureCtx = null;
export function textStrokeSize(s) {
  if (!_measureCtx) _measureCtx = document.createElement("canvas").getContext("2d");
  _measureCtx.font = "100px " + PAINT_FONT;
  return { w: (_measureCtx.measureText(s.text).width / 100) * s.size, h: s.size };
}

// 把一组笔画画进 canvas（uv → 像素；线宽=世界单位×每单位像素，即真实涂料比例）
// 橡皮笔画（erase）用 destination-out 擦掉此前已画的像素——与现实橡皮语义一致
// selStroke（可选）：给该文字笔画画虚线选框（仅编辑视图贴图）
// pxU/pxV：局部 uv → 画布像素，U/V 两个方向分开传（定位用，保证画在面上的正确几何位置）。
// 物体被非均匀拉伸后，画布的 U/V 分辨率比例是按世界空间长宽比算的（见调用方），不再等于
// 局部 uv 的长宽比，所以两个方向的"局部单位→像素"换算率并不相等，必须分开，否则位置会错位。
// sizePx：线宽/字号用的"世界单位→像素"换算率（各向同性，调用方按 U 或 V 方向世界长度算出，
// 两者理论相等）。线宽/字号是世界单位量，用它换算能保证笔画粗细、字号在世界空间里始终保持
// 作者设定的大小——写字/画线那一刻看起来永远不拉伸，事后再拉伸物体才会连它们一起拉伸。
export function renderPaintCanvas(ctx, strokes, uMin, vMax, pxU, pxV, selStroke, sizePx) {
  if (sizePx == null) sizePx = pxU; // 未传世界尺寸换算时退回局部单位换算（兼容旧调用）
  strokes.forEach(function (s) {
    ctx.strokeStyle = ctx.fillStyle = s.color || "#000";
    ctx.globalCompositeOperation = s.erase ? "destination-out" : "source-over";
    if (s.text != null) {
      ctx.font = Math.max(4, s.size * sizePx) + "px " + PAINT_FONT;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(s.text, (s.u - uMin) * pxU, (vMax - s.v) * pxV);
      return;
    }
    if (!s.pts || s.pts.length < 2) return;
    ctx.lineWidth = Math.max(1, s.width * SKETCH_WORLD_SCALE * sizePx);
    ctx.lineCap = ctx.lineJoin = "round";
    ctx.beginPath();
    s.pts.forEach(function (p, i) {
      var x = (p[0] - uMin) * pxU, y = (vMax - p[1]) * pxV;
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.stroke();
  });
  ctx.globalCompositeOperation = "source-over";
  if (selStroke && strokes.indexOf(selStroke) !== -1) {
    var sz = textStrokeSize(selStroke);
    ctx.strokeStyle = "#736B85";
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(
      (selStroke.u - sz.w / 2 - uMin) * pxU - 4, (vMax - selStroke.v - sz.h / 2) * pxV - 4,
      sz.w * sizePx + 8, sz.h * sizePx + 8
    );
    ctx.setLineDash([]);
  }
}

// ==================== 程序化纹理画布：逐像素生成的真实材质纹理（彩色，高细节） ====================

// 确定性 hash 噪声 + 分形叠加（同参数同图案，存档重建一致）
function hash2(ix, iy) {
  var h = Math.sin(ix * 127.1 + iy * 311.7) * 43758.5453;
  return h - Math.floor(h);
}
function noise2(x, y) {
  var ix = Math.floor(x), iy = Math.floor(y);
  var fx = x - ix, fy = y - iy;
  fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
  var a = hash2(ix, iy), b = hash2(ix + 1, iy), c = hash2(ix, iy + 1), d = hash2(ix + 1, iy + 1);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}
function fbm(x, y, oct) {
  var v = 0, amp = 0.5, f = 1;
  for (var i = 0; i < oct; i++) { v += amp * noise2(x * f, y * f); amp *= 0.5; f *= 2.1; }
  return v;
}
function lerp3(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }

export function textureCanvas(type, p) {
  var S = 512;
  var canvas = document.createElement("canvas");
  canvas.width = canvas.height = S;
  var ctx = canvas.getContext("2d");
  var img = ctx.createImageData(S, S);
  var d = img.data;
  var x, y, i, col;

  if (type === "wood") {
    // 木纹：年轮条纹（密度可调）+ 噪声扭曲 + 结疤 + 细木缝
    var rings = p.rings == null ? 0.5 : p.rings;   // 年轮密度（层数）
    var grain = p.grain == null ? 0.6 : p.grain;   // 纹理深浅
    var freq = 5 + rings * 28;
    var light = [199, 154, 103], dark = [94, 60, 34];
    var knots = [[S * 0.28, S * 0.36], [S * 0.72, S * 0.74]];
    for (y = 0; y < S; y++) {
      for (x = 0; x < S; x++) {
        var wob = (fbm(x * 0.006, y * 0.013, 3) - 0.5) * 3.2;
        var ph = x / S * freq + wob;
        // 结疤：靠近结疤中心时年轮绕其弯曲
        for (i = 0; i < knots.length; i++) {
          var dx = (x - knots[i][0]) / S, dy = (y - knots[i][1]) / S;
          var dist = Math.sqrt(dx * dx * 4 + dy * dy);
          if (dist < 0.22) ph += (0.22 - dist) * 26 * (0.6 + 0.4 * Math.sin(i * 5));
        }
        var v = Math.sin(ph * Math.PI * 2);
        var t2 = Math.pow(0.5 + 0.5 * v, 1.5);
        col = lerp3(dark, light, 1 - grain * (1 - t2));
        // 细木缝：高频纵向噪声压暗
        var hair = noise2(x * 0.9, y * 0.02);
        if (hair > 0.82) col = lerp3(col, dark, (hair - 0.82) * 3 * grain);
        i = (y * S + x) * 4;
        d[i] = col[0]; d[i + 1] = col[1]; d[i + 2] = col[2]; d[i + 3] = 255;
      }
    }
  } else if (type === "marble") {
    // 大理石：湍流扭曲的脉纹，密度/对比可调
    var veins = p.veins == null ? 0.55 : p.veins;
    var contrast = p.contrast == null ? 0.6 : p.contrast;
    var base = [238, 237, 234], vein = [108, 112, 126], gold = [176, 154, 110];
    var vf = 1.2 + veins * 3.5;
    for (y = 0; y < S; y++) {
      for (x = 0; x < S; x++) {
        var turb = fbm(x * 0.007, y * 0.007, 4);
        var v2 = Math.sin((x * 0.010 + y * 0.006) * vf + turb * 9.5);
        var m1 = Math.pow(1 - Math.abs(v2), 7 - contrast * 4);
        var v3 = Math.sin((x * 0.004 - y * 0.009) * vf * 1.7 + turb * 7);
        var m2 = Math.pow(1 - Math.abs(v3), 10 - contrast * 5) * 0.5;
        col = lerp3(base, vein, Math.min(1, m1 * contrast * 1.4));
        col = lerp3(col, gold, Math.min(1, m2 * contrast));
        // 底面细颗粒
        var g2 = (noise2(x * 0.35, y * 0.35) - 0.5) * 10;
        i = (y * S + x) * 4;
        d[i] = col[0] + g2; d[i + 1] = col[1] + g2; d[i + 2] = col[2] + g2; d[i + 3] = 255;
      }
    }
  } else if (type === "water") {
    // 水：深浅水色 + 波纹亮线（强度可调） + 浑浊杂质斑点
    var wave = p.wave == null ? 0.6 : p.wave;
    var murk = p.murk == null ? 0.35 : p.murk;
    var deep = [40, 96, 124], shallow = [126, 184, 206], murkCol = [116, 130, 118];
    for (y = 0; y < S; y++) {
      for (x = 0; x < S; x++) {
        var nx = x / S * Math.PI * 2, ny = y / S * Math.PI * 2;
        // 底色随低频噪声在深浅水色间过渡
        var depthMix = 0.25 + fbm(x * 0.004, y * 0.004, 3) * 0.6;
        col = lerp3(deep, shallow, depthMix);
        // 波纹亮线（近似焦散）：两组正弦干涉的低谷处提亮（无缝平铺）
        var w1 = Math.sin(nx * 3 + Math.sin(ny * 2) * 2.2);
        var w2 = Math.sin((nx + ny) * 2.5 + Math.sin(nx * 4) * 1.6);
        var caustic = Math.pow(1 - Math.abs(w1 + w2) / 2, 3.2);
        col = [col[0] + caustic * 95 * wave, col[1] + caustic * 105 * wave, col[2] + caustic * 110 * wave];
        // 浑浊杂质：噪声斑块 + 细小悬浮颗粒
        var blotch = fbm(x * 0.012, y * 0.012, 3);
        col = lerp3(col, murkCol, Math.max(0, blotch - 0.45) * murk * 1.6);
        var speck = noise2(x * 0.6, y * 0.6);
        if (speck > 0.93 - murk * 0.08) col = lerp3(col, [70, 76, 70], 0.5);
        i = (y * S + x) * 4;
        d[i] = Math.min(255, col[0]); d[i + 1] = Math.min(255, col[1]); d[i + 2] = Math.min(255, col[2]); d[i + 3] = 255;
      }
    }
  } else if (type === "glass") {
    // 玻璃：浑浊雾斑 + 微小气泡 + 斜向擦痕（近白灰度，保留物体色调；浑浊度越高越明显）
    var turbid = p.turbid == null ? 0.15 : p.turbid;
    for (y = 0; y < S; y++) {
      for (x = 0; x < S; x++) {
        var haze = fbm(x * 0.008, y * 0.008, 3);                       // 雾斑
        var streak = noise2((x + y) * 0.05, (x - y) * 0.004);          // 斜向擦痕
        var v5 = 246 - haze * 52 * turbid - Math.max(0, streak - 0.72) * 90 * turbid;
        i = (y * S + x) * 4;
        d[i] = d[i + 1] = d[i + 2] = Math.max(185, Math.min(252, v5)); d[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    // 气泡：小空心圆，数量随浑浊度
    var rnd = (function (s) { return function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; })(11);
    var nb = Math.round(6 + turbid * 26);
    ctx.strokeStyle = "rgba(160,168,172,0.5)";
    for (i = 0; i < nb; i++) {
      ctx.lineWidth = 0.8 + rnd() * 1.2;
      ctx.beginPath();
      ctx.arc(rnd() * S, rnd() * S, 1.2 + rnd() * 3.4, 0, Math.PI * 2);
      ctx.stroke();
    }
    return canvas;
  } else if (type === "frosted") {
    // 磨砂：细密喷砂颗粒 + 低频起伏
    var rough = p.rough == null ? 0.9 : p.rough;
    for (y = 0; y < S; y++) {
      for (x = 0; x < S; x++) {
        var g3 = (hash2(x, y) - 0.5) * 56 * rough + (fbm(x * 0.02, y * 0.02, 2) - 0.5) * 26 * rough;
        i = (y * S + x) * 4;
        d[i] = d[i + 1] = d[i + 2] = Math.max(150, Math.min(250, 216 + g3)); d[i + 3] = 255;
      }
    }
  } else if (type === "glow") {
    // 发光：熔岩/能量式明暗斑块（作自发光贴图，暗谷透出底色形成纹理）
    var pat = p.pattern == null ? 0.5 : p.pattern;
    for (y = 0; y < S; y++) {
      for (x = 0; x < S; x++) {
        var e = fbm(x * 0.009, y * 0.009, 4);
        var hot = Math.pow(Math.max(0, (e - 0.28)) * 1.6, 1.3);
        var v6 = 255 - (1 - Math.min(1, hot)) * 190 * pat;
        // 亮脉细线
        var vein2 = Math.pow(1 - Math.abs(Math.sin((x * 0.01 + y * 0.013) * 3 + e * 8)), 8);
        v6 = Math.min(255, v6 + vein2 * 70 * pat);
        i = (y * S + x) * 4;
        d[i] = d[i + 1] = d[i + 2] = Math.max(40, v6); d[i + 3] = 255;
      }
    }
  } else if (type === "metal") {
    // 金属拉丝：横向细密条痕（灰度，乘物体颜色保留色调）
    var brushed = p.brushed == null ? 0.5 : p.brushed;
    for (y = 0; y < S; y++) {
      for (x = 0; x < S; x++) {
        var line = noise2(x * 0.02, y * 1.3);
        var v4 = 205 + (line - 0.5) * 90 * brushed + (noise2(x * 0.5, y * 0.5) - 0.5) * 14 * brushed;
        i = (y * S + x) * 4;
        d[i] = d[i + 1] = d[i + 2] = Math.max(120, Math.min(255, v4)); d[i + 3] = 255;
      }
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

// ==================== 线条工具：节点采样（折角保持尖角，平滑节点用二次贝塞尔圆角） ====================

// pts = [{ p:[x,y,z], smooth:bool }...] → 展平采样点 [x,y,z,...]
// 平滑节点：从前段中点经节点（控制点）到后段中点的二次贝塞尔；相邻平滑节点共享中点，曲线连续
export function lineCurvePoints(pts) {
  if (!pts || pts.length < 2) return [];
  var P = pts.map(function (n) { return new THREE.Vector3().fromArray(n.p); });
  var out = [P[0].clone()];
  for (var i = 1; i < P.length - 1; i++) {
    var prev = P[i - 1], cur = P[i], next = P[i + 1];
    if (!pts[i].smooth) { out.push(cur.clone()); continue; }
    var a = prev.clone().lerp(cur, 0.5), b = cur.clone().lerp(next, 0.5);
    for (var t = 0; t <= 14; t++) {
      var k = t / 14;
      out.push(new THREE.Vector3(
        a.x * (1 - k) * (1 - k) + cur.x * 2 * (1 - k) * k + b.x * k * k,
        a.y * (1 - k) * (1 - k) + cur.y * 2 * (1 - k) * k + b.y * k * k,
        a.z * (1 - k) * (1 - k) + cur.z * 2 * (1 - k) * k + b.z * k * k
      ));
    }
  }
  out.push(P[P.length - 1].clone());
  var flat = [];
  out.forEach(function (v) { flat.push(v.x, v.y, v.z); });
  return flat;
}

// 展平折线 → 相邻线段对（供细管烘焙）
export function polylineToSegments(flat) {
  var segs = [];
  for (var i = 0; i + 5 < flat.length; i += 3) {
    segs.push(flat[i], flat[i + 1], flat[i + 2], flat[i + 3], flat[i + 4], flat[i + 5]);
  }
  return segs;
}
