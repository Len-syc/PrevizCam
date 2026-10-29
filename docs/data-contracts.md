# 数据格式

本文记录各类 JSON 的真实结构。示例文件都在 `examples/`，由网站实际导出，可以直接对照。

| 文件 | 类型 | 来源 |
|---|---|---|
| [scene-context.json](../examples/scene-context.json) | `previzcam.spatial-context` | 「AI 镜头方案 → 下载空间 JSON」 |
| [camera-planning-task.txt](../examples/camera-planning-task.txt) | 纯文本 | 「下载 AI 任务文本」 |
| [camera-plan-template.json](../examples/camera-plan-template.json) | `previzcam.camera-plan` | 「填入格式示例」 |
| [camera-plan.json](../examples/camera-plan.json) | `previzcam.camera-plan` | 「导出 → 仅下载可编辑镜头方案」 |
| [camera-timeline.json](../examples/camera-timeline.json) | `previzcam.sampled-timeline` | 「导出 → 相机与逐帧轨迹」 |

## 项目 `previzcam.project`

正式项目与「下载完整预演项目」的格式。实测 6500 B，结构：

```json
{
  "type": "previzcam.project",
  "version": 1,
  "name": "武夷茶故事 · 山门预演",
  "format": { "fps": 24, "width": 1280, "height": 720 },
  "scene": {
    "id": "LOC_GATE", "name": "寺门与院廊", "modelName": "temple-gate.glb", "source": "bundled",
    "transform": { "scale": 1, "rotationY": 0, "offset": [0, 0, 0] },
    "anchors": [{ "id": "gate_center", "name": "门洞中心", "position": [0, 1.5, 0] }],
    "annotations": {}, "calibration": "示例尺寸；请按实际拍摄需求确认"
  },
  "cameras": [{ "id": "CAM_GATE_A", "name": "A · 山门接待", "locked": false, "mode": "static",
    "keyframes": [{ "t": 0, "position": [-2.8, 2.15, -6.15], "target": [0.35, 1.25, -3.6], "fov": 37.3 }] }],
  "actors": [{ "id": "CHAR_DINGXIAN", "name": "丁弦", "color": "#…", "height": 1.75, "facing": 90, "position": [0, 0.43, -3.6] }],
  "shots": [{ "id": "Q3_S4_M1", "title": "跨门报喜", "sceneId": "LOC_GATE", "cameraId": "CAM_GATE_A",
    "duration": 4, "cast": ["CHAR_DINGXIAN"], "action": "…", "motionPolicy": "…",
    "blocking": { "CHAR_DINGXIAN": [{ "t": 0, "position": [-1.0, 0.43, -2.4] }] } }],
  "script": { "title": "…", "format": { "fps": 24 }, "cameraPolicy": { "mode": "static" },
    "characters": [{ "id": "CHAR_DINGXIAN", "name": "丁弦" }],
    "shots": [{ "id": "GROUP", "locationId": "LOC_GATE", "cast": ["CHAR_DINGXIAN"],
      "materials": [{ "id": "Q3_S4_M1", "locationId": "LOC_GATE", "action": "…",
        "useSeconds": 4, "startFrame": 0, "endFrame": 96 }] }] }
}
```

自定义 GLB 以 base64 内嵌保存在项目里，所以导出的项目能脱离原模型文件重新导入。

## 草案 plan `previzcam.previs-plan`

`create_draft` 返回的 `plan`、以及 `update_draft` 接受的载荷。只包含可变部分：

```json
{ "type": "previzcam.previs-plan", "version": 1, "sceneId": "与项目完全一致",
  "script": { "shots": [] }, "actors": [], "cameras": [], "shots": [] }
```

要点：

- **整体替换**。`update_draft` 不接受增量，先 `get_draft` 读最新再改，不能省略未修改的列表。
- 模型、场景变换、锚点、视频格式由正式项目提供，**不能**放进 plan 改写。
- `plan.shots` 的数组顺序就是时间轴顺序。重排镜头只需调整数组顺序。
- `sceneId` 必须与项目一致，否则 `SCENE_MISMATCH`。
- 锁定相机必须完整保留且数值不变，否则 `LOCKED_CAMERA`。

## 空间上下文 `previzcam.spatial-context`

交给外部 AI 的场景描述，「下载空间 JSON」的原样输出（实测 131826 B）。顶层字段：

| 字段 | 说明 |
|---|---|
| `coordinates` | 坐标约定（见下） |
| `transform`、`bounds` | 场景变换与整体包围盒 |
| `objects` | 语义分组：`id`、`name`、`nodeCount`、`bounds`、`note` |
| `meshes` | 网格分页：`total`、`returned`、`limit`、`offset`、`nextOffset`、`hint`、`items` |
| `obstacleHints` | 命名墙体/立柱的轴对齐包围盒，附 `approximation` 说明 |
| `anchors`、`actors`、`shots`、`cameras` | 与项目一致 |
| `assumptions` | 需要人工校正的假设 |
| `outputContract` | 期望 AI 返回的 `camera-plan` 模板 |

实测 `meshes.total` 为 1074，手动导出只带 200 条并给出续取提示：

```
还有 874 个网格未返回；用 meshOffset=200 继续，或用 meshQuery / meshGroup 缩小范围。
```

`objects[0]` 这样描述一个分组：

```json
{ "id": "approach", "name": "门外铺地与石阶", "nodeCount": 92,
  "bounds": { "min": [-6.5, -0.2, -6.93], "max": [6.5, 0.68, 4.15] },
  "note": "分组包围盒仅描述范围，不能当作实心障碍物；门洞可能位于范围内。" }
```

`obstacleHints` 每条都自带免责说明，读数据时不要把 `objects` 当障碍物用。

## 镜头方案 `previzcam.camera-plan`

手动流程与相机导出的格式：

```json
{ "type": "previzcam.camera-plan", "version": 1, "sceneId": "LOC_GATE",
  "cameras": [{ "id": "CAM_GATE_A", "name": "A · 山门接待", "locked": false, "mode": "static",
    "keyframes": [{ "t": 0, "position": [-2.8, 2.15, -6.15], "target": [0.35, 1.25, -3.6], "fov": 37.3 }] }],
  "assignments": [{ "shotId": "Q3_S4_M1", "cameraId": "CAM_GATE_A" }] }
```

它只描述机位与镜头归属，不包含人物与走位。这与 MCP 的完整 `previzcam.previs-plan` **不是同一种输入**，两者不能混用。

## 逐帧轨迹 `previzcam.sampled-timeline`

「相机与逐帧轨迹」的输出（实测 84033 B）。按项目帧率把每镜展开：

```json
{ "type": "previzcam.sampled-timeline", "version": 1, "units": "metres", "up": "+Y",
  "handedness": "right", "aspect": 1.777…, "fps": 24,
  "shots": [{ "id": "Q3_S4_M1", "sourceId": "Q3_S4_M1", "duration": 5, "startSeconds": 0,
    "cameraId": "CAM_GATE_A", "cutIn": true,
    "samples": [{ "time": 0, "t": 0, "position": [-2.8, 2.15, -6.15], "target": [0.35, 1.25, -3.6], "fov": 37.3 }] }] }
```

实测首个镜头 5 秒 → 121 个采样点（帧数 + 1，首尾都含）。`time` 是镜内秒数，`t` 是镜内归一化时间。

示例里三个镜头的 `t` 都是 0，因为示例相机是 `static`——固定相机的采样恒定取 `t=0`，位置不随时间变化。换成 `linear` 或 `smooth` 相机时 `t` 会随帧递增。

## 导出产物

`export_artifacts` 完成后 `get_job` 返回的 `artifacts` 每项含 `name`、`mimeType`、`path`、`bytes`、`sha256`：

| 名称 | 格式 | 内容 |
|---|---|---|
| `previzcam-project.json` | project | 可重新导入的完整项目 |
| `previzcam-storyboards.zip` | storyboard | 每镜首中尾 PNG + 镜头/相机数据 + 报告 |
| `camera-plan.json` | timeline | 可编辑相机计划 |
| `camera-timeline.json` | timeline | 逐帧采样轨迹 |
| `review-report.json` | report | 检查提示、限制、Agent 待审事项 |
| `previzcam-preview.webm` | video | 1280×720 实时无音频，最长 5 分钟 |

同目录还有 `manifest.json`：

```json
{ "type": "previzcam.artifacts", "version": 1, "id": "<jobId>", "workspaceId": "…",
  "source": { "kind": "draft", "draftId": "…", "draftVersion": 2, "baseRevision": "…:1" },
  "review": { "summary": "…", "unresolved": ["…"],
    "checks": { "messages": [], "limitations": ["…"], "checkedAt": "…", "draftVersion": 2 } },
  "status": "completed", "artifacts": [{ "name": "…", "sha256": "…", "bytes": 6500 }] }
```

`source.kind` 为 `draft` 或 `active`；后者记录 `revision`。这是产物的溯源依据。

## 报告 `previzcam.review-report`

检查报告固定包含四条限制，交付说明应原样保留而不是隐去：

- 每镜最多 301 个离散采样时刻，并检查相邻相机位置间的相交；不是连续无碰撞保证。
- 空间分组包围盒描述范围，不等于实心障碍；内部判定只覆盖命名规则匹配的墙、柱等结构。
- 未检查人物相互遮挡、肢体或走位碰撞、对白时长、真实景深和精细表演。
- 轴线、动作接续和叙事构图需要结合实际画面审阅。
