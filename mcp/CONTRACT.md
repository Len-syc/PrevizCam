# PrevizCam MCP 合约

这是当前网站的本机草案接口。所有工具名称均不含宿主添加的 MCP 前缀；以客户端发现的名称为准。

## 连接和状态

先调用 `list_workspaces({})`，按用户正在使用的项目选择 `workspaceId`。多个页面时不能猜测第一个就是目标。后续调用都传 `workspaceId`。

`get_context({workspaceId, spatial?})` 返回正式 `project`、不透明 `revision`、实际 `spatialContext`、可编辑模板 `previsPlan`、草案摘要和 `activity`。`activity` 非空表示正在渲染、导出或人工预览；此时可读取状态，写入和渲染会自动等待空闲（见常见错误）。`spatialContext` 默认是摘要：语义分组、整体与分组包围盒、锚点、人物、镜头、相机和网格统计（`meshes.total`、`meshes.groups`），不列出上千条网格。需要具体网格时传 `spatial: {detail: "full", meshQuery?: 名称片段, meshGroup?: 语义分组 ID, meshLimit?: 1–200, meshOffset?: 起始, meshSort?: "size"|"name"}`，返回 `meshes.items`、`matched` 与 `nextOffset` 分页继续。

页面是项目权威来源。不要直接修改 IndexedDB、导出的 JSON 文件或仓库源码来绕过网站的草案审核。断线后先重新列出工作区。页面刷新会产生新的工作区 ID，旧草案不会自动恢复。

## 坐标和时间

- 所有位置是经过模型校准后的世界坐标，单位米，右手系，Y 向上。
- 相机 `target` 是世界坐标注视点。`fov` 是垂直视场角，单位度，范围 5–140。
- 等效焦距换算采用 36 × 20.25 mm、16:9 视窗：`fov = 2 * atan(20.25 / (2 * mm)) * 180 / PI`。
- 关键点 `t` 是镜头内归一化时间 0–1，必须严格递增，首点为 0。
- 静止相机 `mode: "static"` 只有一个 `t: 0` 关键点。`linear`、`smooth` 相机至少有首尾 0 和 1 两点。
- 人物走位只插值位置。`facing` 是人物统一朝向，单位度；不能用位置轨迹表示肢体表演或逐时刻转身。
- `shot.duration` 是秒，必须对应项目帧率下的整数帧。镜头间硬切；共享相机路径按各自镜头时长播放。
- 语义分组包围盒不是实心障碍物；门洞可能在包围盒里。当前检查不验证人物走位碰撞、可行走面、对白时长或人物之间的遮挡。

## 草案数据

`create_draft({workspaceId, label?})` 从当前正式项目建立草案，返回 `id`、`version`、`baseRevision` 和完整 `plan`。最多同时保留 20 份草案。

`update_draft({workspaceId, draftId, expectedVersion, plan})` **整体替换** plan。用 `get_draft` 取得最新内容再编辑，不能省略未修改的列表。格式：

```json
{
  "type": "previzcam.previs-plan",
  "version": 1,
  "sceneId": "与当前项目完全一致",
  "script": { "shots": [] },
  "actors": [],
  "cameras": [],
  "shots": []
}
```

以上是字段结构，空相机不是可提交的有效方案。通常直接修改 `create_draft` 返回的模板，不从空数组重建。模型、场景变换、锚点和视频格式由正式项目提供，不能放进 plan 改写。

`plan.shots` 的数组顺序就是时间轴顺序：重排、把主镜放前、把新镜头插到中间，都只需在新的 plan 里调整数组顺序，不需要任何追加式变通。

人物：`{id, name, color, height, facing, position:[x,y,z]}`。身高 0.1–10 m，颜色为六位十六进制。

相机：`{id, name, locked, mode, keyframes:[{t, position:[x,y,z], target:[x,y,z], fov}]}`。

镜头：`{id, title, sceneId, cameraId, duration, cast:[actorId], action, motionPolicy, blocking:{actorId:[{t,position:[x,y,z]}]}}`。允许保留已有的 `sourceId` 等来源字段。`cast` 控制占位人物是否出现在本镜，也决定检查范围；走位人物必须在本镜 cast 内。新增人物必须同时有 actors 记录。相机、人物和镜头 ID 各自唯一。

锁定相机必须完整保留且数值不变。使用新相机 ID 可以提出备选机位。固定摄影约束必须保留。当前解析器将存在 `script.cameraPolicy` 的剧本解释为固定摄影；如果输入明确允许运镜，结构化脚本应省略该全局字段，并按镜头使用 `motionPolicy: "unspecified"`。已有固定镜头不能通过改写同 ID 的 motionPolicy 绕过约束。

## 从文字剧本整理输入

最小结构化脚本示例（所有 ID 应绑定到本次真实场景/人物；这里仅展示形状）：

```json
{
  "title": "接待段落",
  "format": { "fps": 24 },
  "cameraPolicy": { "mode": "static" },
  "characters": [{ "id": "CHAR_VISITOR", "name": "访客" }],
  "shots": [{
    "id": "GROUP_RECEPTION",
    "locationId": "LOC_GATE",
    "cast": ["CHAR_VISITOR"],
    "materials": [{
      "id": "SHOT_RECEPTION_1",
      "locationId": "LOC_GATE",
      "action": "访客进入接待区，停下致意。",
      "useSeconds": 5,
      "startFrame": 0,
      "endFrame": 120
    }]
  }]
}
```

结构化脚本保存叙事来源，plan.shots 保存实际可播放编排，两者需要一致。沿用输入中可靠的 ID、动作、对白和时长约束；新增 ID 是本次创作结果，不代表已存在资产。仅处理当前场景的段落。缺少关键场景映射或导演意图时向用户澄清，普通机位选择可在草案中提出。

## 检查、图像与审核

1. `check_draft({workspaceId,draftId})` 检查当前版本，返回 `checks.messages`、`checks.limitations` 和 `checkedVersion`。
2. `render_frames({workspaceId,draftId,frames?,view?})` 返回实际 PNG 证据和 `coverage`；每次 1–12 帧。省略 `frames` 时自动覆盖每个必看时刻（首、中、尾加相机与走位关键点），按整镜装批，放不下的列在 `deferred`。`view` 默认 `"auto"`：多个时刻只回传一张接触表（4 列 320×180 拼图，带 t 标签），单帧仍保存为 artifacts；需要逐张看细节用 `view:"frames"`，只要拼图用 `"sheet"`。`coverage` 给出每镜的 `requiredTimes`、`capturedTimes` 和 `missingRequiredTimes`。整段审核仍应分批覆盖全部镜头，并对问题时刻加采样。
3. 修改后重新检查和取必要画面。每次更新会清空旧检查、提交状态和已记录的必看时刻。
4. `submit_draft({workspaceId,draftId,expectedVersion,summary,unresolved:[]})` 要求该版本已检查，并且每个镜头的必看时刻都已渲染过；缺帧时返回 `MISSING_FRAMES` 并逐个列出（如 `镜头 S2 缺 t=0.5、1`）。只提交审阅，不应用。
5. 用户在网站“Agent 草案 → 预览与审阅 → 应用整套草案”确认后，正式项目才变化。一次撤销恢复整套应用前的内容。用 `get_draft` 的 `status: "applied"` 和 `appliedRevision` 确认应用。

几何检查采用每镜最多 301 个时刻的有限采样；不要把没有提示解释为完整无碰撞保证。只将已观察到的画面写成视觉审核结论。未看图、没覆盖的时刻、对白与精细表演列为未验证。默认至多三轮自动修正，再交付未解决事项。

## 导出

草案导出：`export_artifacts({workspaceId,draftId,formats:["project","storyboard","timeline","report","video"]})`。

正式项目导出：先 `get_context`，再 `export_artifacts({workspaceId,expectedRevision:revision,formats:[...]})`。应用后的草案应改用正式项目导出。默认格式不含 video。

调用立即返回 job `id`。轮询 `get_job({workspaceId,jobId})`，完成后获得 `artifacts`（绝对路径、MIME、大小、SHA-256）及 `manifestPath`。只有 `completed` 才能报告交付完成。`cancel_job` 中止任务；取消或失败不会交付部分包。

所有文件关联冻结的 source（正式 revision，或草案 ID/version/baseRevision）。项目 JSON 可重新导入；自定义 GLB 内嵌保存。storyboard ZIP 包含每镜首中尾 PNG、镜头/相机数据和报告；timeline 包含可编辑相机计划及逐帧采样；report 包含几何提示、限制及 Agent 提交的待审事项。

WebM 为 1280×720 实时无音频录制，最多 5 分钟。保持页面可见；后台、断连、取消或编码失败会终止录制。最多保留最近 5 项浏览器导出记录；完成后及时调用 get_job，将文件落盘到 MCP 输出目录。

## 常见错误

- `WORKSPACE_NOT_FOUND` / `WORKSPACE_DISCONNECTED`：确认 MCP 和网站连接，重新列出页面；不要盲目重复写入。
- `STALE_DRAFT`：正式项目已改变（包括撤销/重做、模型替换），重新读取上下文并创建新草案；旧草案不能直接重新标记为通过。
- `DRAFT_CONFLICT`：先读取草案最新 version，再决定修改。
- `CHECK_REQUIRED`：检查当前版本并重新提交。
- `MISSING_FRAMES`：该版本还有镜头没看过必看时刻。按错误里列出的 `镜头 缺 t=…` 用 `render_frames` 补拍再提交。
- `WORKSPACE_BUSY`：页面正在渲染、导出或用户正在预览草案。工具会先自动等待空闲（约 15 秒）再执行，仍忙时返回该错误并带 `retryAfterMs`，MCP 会按它自动重试；不要用 sleep 猜测，也不要手动调大间隔。
- `PAGE_HIDDEN`：回到网站前台后重新发起视频导出。
- `REQUEST_TIMEOUT`：先检查当前状态，写入可能已经发生；不要无条件重试。

旧 `previzcam.camera-plan` 仍用于网站的手动复制粘贴入口及相机导出，与完整 previs-plan 不是同一种输入。
