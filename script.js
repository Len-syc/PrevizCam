// draw3d 脚本模式：轻编程批量创建 / 移动物体。
// 独立模块——不触碰编辑器内部状态，只通过 index.js 注入的 bridge 操作场景；
// 脚本坐标一律用界面单位（1 单位 = 0.01 场景单位，Z 轴竖直），与属性面板一致。

var B = null; // bridge

var CREATE_LIMIT = 800; // 单次运行的创建上限，防手滑把页面写死

// ---------- 坐标换算：界面 [X, Y(深度), Z(竖直)] ↔ 内部 (x, z, y) ----------
function toWorld(p) { return [p[0] / B.UI_UNIT, (p[2] || 0) / B.UI_UNIT, (p[1] || 0) / B.UI_UNIT]; }
function toUI(o) { return [Math.round(o.position.x * B.UI_UNIT), Math.round(o.position.z * B.UI_UNIT), Math.round(o.position.y * B.UI_UNIT)]; }

function setPosUI(o, p) {
  var w = toWorld(p);
  o.position.set(w[0], w[1], w[2]);
}

// 尺寸（界面单位）：按本地包围盒换算缩放，数字=三轴同值，数组=[长X,宽Y,高Z]
function setSizeUI(o, size) {
  if (size == null) return;
  var t = typeof size === "number" ? [size, size, size] : [size[0], size[2] || size[0], size[1] || size[0]];
  var base = B.localBounds(o).getSize(B.tmpVec());
  ["x", "y", "z"].forEach(function (ax, i) {
    if (base[ax] > 1e-6) o.scale[ax] = (t[i] / B.UI_UNIT) / base[ax];
  });
}

// ---------- 物体包装：脚本里拿到的操作句柄 ----------
function wrap(o) {
  var w = {
    raw: o,
    id: o.userData.id,
    kind: o.userData.kind,
    name: o.name,
    pos: function () { return toUI(o); },
    moveTo: function (x, y, z) { setPosUI(o, [x, y, z]); return w; },
    moveBy: function (dx, dy, dz) {
      o.position.x += (dx || 0) / B.UI_UNIT;
      o.position.z += (dy || 0) / B.UI_UNIT;
      o.position.y += (dz || 0) / B.UI_UNIT;
      return w;
    },
    size: function (s) { setSizeUI(o, s); return w; },
    color: function (c) { if (o.material && o.material.color) o.material.color.set(c); return w; },
    texture: function (type, params) {
      if (type == null || type === "none") B.clearTexture(o);
      else B.setTexture(o, type, params || {});
      return w;
    },
    rotate: function (rxDeg, ryDeg, rzDeg) {
      // 界面轴：X/Y(深度)/Z(竖直) → 内部 x/z/y
      o.rotation.x += (rxDeg || 0) * Math.PI / 180;
      o.rotation.z += (ryDeg || 0) * Math.PI / 180;
      o.rotation.y += (rzDeg || 0) * Math.PI / 180;
      return w;
    },
    copy: function () { return wrap(B.copyClone(o)); },   // 普通复制（独立副本）
    mirror: function () { return wrap(B.mirrorClone(o)); }, // 镜像复制（内容联动，仅位置独立）
    remove: function () { B.removeObject(o); return null; },
  };
  return w;
}

// ---------- 脚本可用 API ----------
var madeCount = 0;

function makeKind(kind, opts) {
  if (madeCount >= CREATE_LIMIT) throw new Error("单次运行最多创建 " + CREATE_LIMIT + " 个物体");
  madeCount++;
  var o = B.createObject(kind, {});
  var w = wrap(o);
  opts = opts || {};
  if (opts.size != null) w.size(opts.size);
  if (opts.pos) setPosUI(o, opts.pos);
  if (opts.color) w.color(opts.color);
  if (opts.texture) w.texture(typeof opts.texture === "string" ? opts.texture : opts.texture.type, typeof opts.texture === "object" ? opts.texture.params : null);
  return w;
}

function buildApi() {
  madeCount = 0;
  var api = {
    // 创建：box/sphere/cylinder/cone/torus/plane({ pos:[x,y,z], size:数字或[长,宽,高], color:"#hex", texture:"wood"|{type,params} })
    box: function (opts) { return makeKind("box", opts); },
    sphere: function (opts) { return makeKind("sphere", opts); },
    cylinder: function (opts) { return makeKind("cylinder", opts); },
    cone: function (opts) { return makeKind("cone", opts); },
    torus: function (opts) { return makeKind("torus", opts); },
    plane: function (opts) { return makeKind("plane", opts); },
    // 线条：{ from:[X,Y,Z], to:[X,Y,Z], width, color }（科普连线/示意图用）
    line: function (opts) {
      if (madeCount >= CREATE_LIMIT) throw new Error("单次运行最多创建 " + CREATE_LIMIT + " 个物体");
      madeCount++;
      opts = opts || {};
      var o = B.createObject("line", {
        pts: [
          { p: toWorld(opts.from || [0, 0, 0]), smooth: false },
          { p: toWorld(opts.to || [100, 0, 0]), smooth: false },
        ],
        width: opts.width || 4,
      });
      var w = wrap(o);
      if (opts.color) w.color(opts.color);
      return w;
    },
    // 查询现有物体（含脚本刚建的）
    objects: function () { return B.topObjects().map(wrap); },
    find: function (nameOrId) {
      var hit = B.topObjects().filter(function (o) {
        return o.name === nameOrId || o.userData.id === nameOrId || ("obj_" + o.userData.id) === nameOrId;
      })[0];
      return hit ? wrap(hit) : null;
    },
    // 小工具
    range: function (n) { var a = []; for (var i = 0; i < n; i++) a.push(i); return a; },
    print: function () { pushMsg(Array.prototype.slice.call(arguments).map(String).join(" ")); },
  };
  return api;
}

// ---------- 运行 ----------
var msgLines = [];
function pushMsg(s) { msgLines.push(s); }

function runScript(code) {
  msgLines = [];
  var msgEl = document.getElementById("script-msg");
  var api = buildApi();
  var t0 = performance.now();
  try {
    /* eslint-disable no-new-func */
    var fn = new Function("api", "with (api) {\n" + code + "\n}"); // with 提供裸函数名，故不能用严格模式
    fn(api);
    B.select(null);
    B.snapshot(madeCount ? "脚本：新建 " + madeCount + " 个物体" : "运行脚本");
    var parts = [];
    if (madeCount) parts.push("新建 " + madeCount + " 个物体");
    parts.push(Math.round(performance.now() - t0) + "ms");
    msgEl.className = "script-msg ok";
    msgEl.textContent = "✓ 运行完成（" + parts.join(" · ") + "）" + (msgLines.length ? "\n" + msgLines.join("\n") : "");
    B.toast("脚本运行完成" + (madeCount ? "：新建 " + madeCount + " 个物体" : ""));
  } catch (e) {
    B.snapshot("运行脚本（出错中断）"); // 已发生的改动仍进撤销历史，可 Ctrl+Z 一步回退
    msgEl.className = "script-msg err";
    msgEl.textContent = "✗ " + (e && e.message ? e.message : e) + (msgLines.length ? "\n" + msgLines.join("\n") : "");
  }
}

// ---------- 内置示例 ----------
var EXAMPLES = [
  {
    name: "面板堆叠（面贴面，间隔可调）",
    code: [
      "// 10 块方形薄板竖直堆叠：gap=0 时面贴面无缝，改 gap 即留缝",
      "var count = 10, size = 160, thick = 10, gap = 0;",
      "for (var i = 0; i < count; i++)",
      "  box({",
      "    pos: [0, 0, i * (thick + gap) + thick / 2],",
      "    size: [size, size, thick],",
      "    color: i % 2 ? \"#8DA0AE\" : \"#B98E84\",",
      "  });",
    ].join("\n"),
  },
  {
    name: "棋盘格 / 内存颗粒（间隔可调）",
    code: [
      "// 5×5 薄板平铺：gap=0 是无缝棋盘格；把 gap 改成 10 就像内存颗粒排布",
      "var n = 5, size = 80, thick = 8, gap = 0;",
      "var step = size + gap, half = (n - 1) / 2;",
      "for (var i = 0; i < n; i++)",
      "  for (var j = 0; j < n; j++)",
      "    box({",
      "      pos: [(i - half) * step, (j - half) * step, thick / 2],",
      "      size: [size, size, thick],",
      "      color: (i + j) % 2 ? \"#43423D\" : \"#EDEBE6\",",
      "    });",
    ].join("\n"),
  },
  {
    name: "内存条（PCB + 颗粒阵列）",
    code: [
      "// 计算机科普：绿色 PCB 基板 + 8×2 黑色存储颗粒",
      "box({ pos: [0, 0, 5], size: [560, 200, 10], color: \"#2F6B4F\" });",
      "var W = 52, H = 64, gapX = 14, gapY = 22;",
      "for (var i = 0; i < 8; i++)",
      "  for (var j = 0; j < 2; j++)",
      "    box({",
      "      pos: [(i - 3.5) * (W + gapX), (j - 0.5) * (H + gapY), 19],",
      "      size: [W, H, 18],",
      "      color: \"#1A1A1A\",",
      "    });",
    ].join("\n"),
  },
  {
    name: "二进制比特墙（8×8 像素图案）",
    code: [
      "// 每行一个字节，点亮的位组成图案（默认笑脸，改 rows 画你自己的）",
      "var rows = [0x3C, 0x42, 0xA5, 0x81, 0xA5, 0x99, 0x42, 0x3C];",
      "var s = 56, gap = 4, step = s + gap;",
      "rows.forEach(function (byte, r) {",
      "  range(8).forEach(function (c) {",
      "    var lit = (byte >> (7 - c)) & 1;",
      "    box({",
      "      pos: [(c - 3.5) * step, 0, (7 - r) * step + s / 2 + 20],",
      "      size: [s, 18, s],",
      "      color: lit ? \"#5CB8E8\" : \"#3B3A36\",",
      "    }).texture(lit ? \"glow\" : \"none\");",
      "  });",
      "});",
    ].join("\n"),
  },
  {
    name: "神经网络示意（节点 + 全连接）",
    code: [
      "// AI 科普：输入4 · 隐藏6 · 输出2，层间全连接",
      "var layers = [4, 6, 2];",
      "var X = [-220, 0, 220];",
      "var colors = [\"#5CB8E8\", \"#8A9A8B\", \"#E42214\"];",
      "var nodes = [];",
      "layers.forEach(function (cnt, li) {",
      "  nodes[li] = [];",
      "  range(cnt).forEach(function (i) {",
      "    var z = (i - (cnt - 1) / 2) * 78 + 240;",
      "    nodes[li].push([X[li], 0, z]);",
      "    sphere({ pos: [X[li], 0, z], size: 40, color: colors[li] });",
      "  });",
      "});",
      "for (var l = 0; l < layers.length - 1; l++)",
      "  nodes[l].forEach(function (a) {",
      "    nodes[l + 1].forEach(function (b) {",
      "      line({ from: a, to: b, width: 1.2, color: \"#B8B4AC\" });",
      "    });",
      "  });",
    ].join("\n"),
  },
  {
    name: "数据柱状图（算力增长）",
    code: [
      "// 数据可视化：一组数值 → 柱状图，最后一根发光强调",
      "var data = [1, 2, 4, 8, 15, 28, 52, 100];",
      "data.forEach(function (v, i) {",
      "  var h = v * 4 + 14;",
      "  var b = box({",
      "    pos: [(i - (data.length - 1) / 2) * 72, 0, h / 2],",
      "    size: [52, 52, h],",
      "    color: \"#736B85\",",
      "  });",
      "  if (i === data.length - 1) b.color(\"#E42214\").texture(\"glow\", { inten: 0.7 });",
      "});",
    ].join("\n"),
  },
  {
    name: "5×5×5 小球立方阵",
    code: [
      "// 125 个小球排成 5×5×5 立方体，间距 60",
      "var N = 5, gap = 60, half = (N - 1) / 2;",
      "for (var i = 0; i < N; i++)",
      "  for (var j = 0; j < N; j++)",
      "    for (var k = 0; k < N; k++)",
      "      sphere({",
      "        pos: [(i - half) * gap, (j - half) * gap, k * gap + 30],",
      "        size: 40,",
      "        color: \"#5CB8E8\",",
      "      });",
    ].join("\n"),
  },
  {
    name: "圆环阵列（12 个金属立方体）",
    code: [
      "// 12 个立方体围成一圈，朝向圆心，金属纹理",
      "var n = 12, R = 260;",
      "range(n).forEach(function (i) {",
      "  var a = i / n * Math.PI * 2;",
      "  box({ pos: [Math.cos(a) * R, Math.sin(a) * R, 40], size: 60, color: \"#8DA0AE\" })",
      "    .texture(\"metal\", { polish: 0.9 })",
      "    .rotate(0, 0, a * 180 / Math.PI);",
      "});",
    ].join("\n"),
  },
  {
    name: "镜像复制一排（改一个全变）",
    code: [
      "// 原物体 + 4 个镜像副本排成一排：之后编辑任何一个，其余全部跟随",
      "var src = box({ pos: [-240, 0, 60], size: 90, color: \"#B98E84\" });",
      "range(4).forEach(function (i) {",
      "  src.mirror().moveTo(-120 + i * 120, 0, 60);",
      "});",
    ].join("\n"),
  },
  {
    name: "移动现有物体（全体抬高）",
    code: [
      "// 把场景里所有物体整体抬高 80，并打印清单",
      "objects().forEach(function (o) {",
      "  o.moveBy(0, 0, 80);",
      "  print(o.name, o.kind, \"→\", o.pos().join(\",\"));",
      "});",
    ].join("\n"),
  },
];

// ---------- 快速生成：选项 → 一段可再编辑的代码 ----------
var QB_SHAPES = {
  plate: { label: "薄板", fn: "box", h: "thick" },
  box: { label: "立方体", fn: "box", h: "size" },
  sphere: { label: "球体", fn: "sphere", h: "size" },
  cylinder: { label: "圆柱", fn: "cylinder", h: "size" },
  cone: { label: "圆锥", fn: "cone", h: "size" },
  torus: { label: "圆环体", fn: "torus", h: "size" },
};

function buildQuickCode(shape, layout, count, size, gap, color) {
  var s = QB_SHAPES[shape];
  var isPlate = shape === "plate";
  var head = [
    "// 快速生成：" + s.label + " · " + { grid: "平面网格 " + count + "×" + count, stack: "竖直堆叠 " + count, row: "横向排列 " + count, cube: "立体阵列 " + count + "³", circle: "圆环阵列 " + count }[layout] + " · 间隔 " + gap,
    "var n = " + count + ", size = " + size + ", gap = " + gap + ";",
  ];
  if (isPlate) head.push("var thick = 10; // 薄板厚度，可改");
  var sizeExpr = isPlate ? (layout === "stack" ? "[size, size, thick]" : "[size, size, thick]") : "size";
  var hVar = isPlate ? "thick" : "size";
  var mk = function (posExpr) {
    return s.fn + "({ pos: " + posExpr + ", size: " + sizeExpr + ", color: \"" + color + "\" });";
  };
  var body = [];
  if (layout === "row") {
    body = [
      "var step = size + gap, half = (n - 1) / 2;",
      "for (var i = 0; i < n; i++)",
      "  " + mk("[(i - half) * step, 0, " + hVar + " / 2]"),
    ];
  } else if (layout === "stack") {
    body = [
      "var step = " + hVar + " + gap; // 面贴面：gap=0 无缝",
      "for (var i = 0; i < n; i++)",
      "  " + mk("[0, 0, i * step + " + hVar + " / 2]"),
    ];
  } else if (layout === "grid") {
    body = [
      "var step = size + gap, half = (n - 1) / 2;",
      "for (var i = 0; i < n; i++)",
      "  for (var j = 0; j < n; j++)",
      "    " + mk("[(i - half) * step, (j - half) * step, " + hVar + " / 2]"),
    ];
  } else if (layout === "cube") {
    body = [
      "var step = size + gap, half = (n - 1) / 2;",
      "for (var i = 0; i < n; i++)",
      "  for (var j = 0; j < n; j++)",
      "    for (var k = 0; k < n; k++)",
      "      " + mk("[(i - half) * step, (j - half) * step, k * step + " + hVar + " / 2]"),
    ];
  } else { // circle
    body = [
      "var R = Math.max(60, n * (size + gap) / (2 * Math.PI)); // 周长≈n×(尺寸+间隔)",
      "for (var i = 0; i < n; i++) {",
      "  var a = i / n * Math.PI * 2;",
      "  " + mk("[Math.cos(a) * R, Math.sin(a) * R, " + hVar + " / 2]"),
      "}",
    ];
  }
  return head.concat(body).join("\n");
}

function wireQuickBuilder() {
  document.getElementById("qb-gen").addEventListener("click", function () {
    var count = Math.min(20, Math.max(1, parseInt(document.getElementById("qb-count").value, 10) || 5));
    var code = buildQuickCode(
      document.getElementById("qb-shape").value,
      document.getElementById("qb-layout").value,
      count,
      parseFloat(document.getElementById("qb-size").value) || 80,
      Math.max(0, parseFloat(document.getElementById("qb-gap").value) || 0),
      document.getElementById("qb-color").value
    );
    document.getElementById("script-code").value = code;
    var msgEl = document.getElementById("script-msg");
    msgEl.className = "script-msg";
    msgEl.textContent = "已按选项生成代码（可手改），点「运行」执行。";
  });
}

// ---------- UI ----------
function openPanel() {
  if (B.isBusy()) { B.toast("正在播放或导出中，稍后再用脚本"); return; }
  document.getElementById("script-overlay").hidden = false;
  document.getElementById("script-code").focus();
}
function closePanel() {
  document.getElementById("script-overlay").hidden = true;
}

export function initScriptMode(bridge) {
  B = bridge;
  var sel = document.getElementById("script-example");
  EXAMPLES.forEach(function (ex, i) {
    var o = document.createElement("option");
    o.value = i;
    o.textContent = ex.name;
    sel.appendChild(o);
  });
  var code = document.getElementById("script-code");
  code.value = EXAMPLES[0].code;
  sel.addEventListener("change", function () { code.value = EXAMPLES[this.value].code; });
  wireQuickBuilder();
  document.getElementById("btn-script").addEventListener("click", openPanel);
  document.getElementById("script-close").addEventListener("click", closePanel);
  document.getElementById("script-run").addEventListener("click", function () { runScript(code.value); });
  // 覆层内 Esc 关面板（捕获阶段拦下，不落到编辑器的全局 Esc）
  document.getElementById("script-overlay").addEventListener("keydown", function (e) {
    if (e.key === "Escape") { closePanel(); e.stopPropagation(); }
  }, true);
  // Ctrl+Enter 运行
  code.addEventListener("keydown", function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") runScript(code.value);
  });
}
