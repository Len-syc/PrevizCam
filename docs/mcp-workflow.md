# MCP 工作流


## 连接

三个进程按顺序就位：

```bash
python serve.py                 # 1. 网站，默认 127.0.0.1:8899
node mcp/config.mjs             # 2. 生成与本机路径匹配的 mcpServers JSON
```

把 `config.mjs` 的输出写入外部助手的 MCP 配置（Pi Web 与 pi 共用 `~/.pi/agent/mcp.json`），**由宿主启动这个 stdio 服务**，不要手动再起第二份。

3. 网站里点击 **Agent模式 → 连接本机 Agent**，桥接端口填 `8900`，等状态变为「已连接 · 草案模式」。

成功后 `list_workspaces` 会列出已连接的页面：

```json
[{ "workspaceId": "0d339ea9-…", "name": "武夷茶故事 · 山门预演", "revision": "7b72e3cc-…:1" }]
```

**多个页面时必须让用户确认目标**，不能默认取第一个。后续每个调用都要带 `workspaceId`。

## 标准流程

实测的一次完整循环，13 步全部成功、零页面错误：

| 步骤 | 调用 | 实测返回 |
|---|---|---|
| 1 | `list_workspaces` | 1 个页面、1 个 revision |
| 2 | `get_context` | revision、3 镜头/2 相机/3 人物、1074 网格、9 语义分组 |
| 3 | `create_draft` | version 1、baseRevision、3 镜头模板 |
| 4 | `update_draft` | version 2 |
| 5 | `check_draft` | checkedVersion 2、0 条提示、4 条限制 |
| 6 | `submit_draft`（未看图） | **拒绝**：`MISSING_FRAMES` |
| 7 | `render_frames` | 9 帧、1 张接触表、10 个证据文件、缺口 0 |
| 8 | `submit_draft` | status `submitted`、version 2 |
| 9 | `export_artifacts` | 4 格式任务 ID |
| 10 | `get_job` | `completed`、5 个产物带 SHA-256 |
| 11 | 页面点「应用整套草案」 | revision 递增到 `:2`，镜头与人物已换 |
| 12 | 页面点撤销 | 回到 3 镜头/3 人物 |
| 13 | 页面错误 | 0 |

第 6 步是这个流程的关键门禁。`submit_draft` 要求该版本每个镜头的必看时刻都已经真实渲染过，否则拒绝并逐个列出缺哪一帧：

```
提交前需要先看过每个镜头的必看时刻截图。还缺：SHOT_GUEST_1 缺 t=0、0.5、1；
SHOT_GUEST_2 缺 t=0、0.5、1；SHOT_GUEST_3 缺 t=0、0.5、1。
请用 render_frames 指定这些 progress 补拍后重试。
```

这条约束的作用是防止 Agent 不看画面就提交。**不要用「重复提交试错」绕过它**，缺什么就补拍什么。

## 13 个工具

只读工具（`readOnlyHint`）不改变任何状态：

| 工具 | 用途 |
|---|---|
| `list_workspaces` | 列出已连接页面，取得 `workspaceId` |
| `get_context` | 读正式项目、revision、空间上下文、草案列表、previsPlan 模板 |
| `get_draft` | 读草案全文、版本、检查结果、stale 状态 |
| `check_draft` | 对真实几何做采样检查，返回提示与限制 |
| `render_frames` | 渲染真实 PNG 帧证据 |
| `get_job` | 读导出进度、失败原因、产物路径与校验和 |

写入工具：

| 工具 | 用途 |
|---|---|
| `create_project` | 在页面创建空项目；非空工作区需用户同意后带 `replace: true` |
| `create_draft` | 从当前正式项目克隆一份独立草案 |
| `update_draft` | **整体替换** plan，需 `expectedVersion` |
| `submit_draft` | 提交供人审阅（**不应用**） |
| `discard_draft` | 丢弃草案，不影响正式项目 |
| `export_artifacts` | 启动异步导出 |
| `cancel_job` | 中止导出，不交付部分包 |

**没有**作为工具暴露的能力：应用方案、执行任意 JavaScript、Shell、任意文件读写。「应用」只能由人在页面上点击。

## 空间数据读取策略

`get_context` 的空间上下文默认是摘要，只给语义分组、包围盒、锚点、人物、镜头、相机和网格计数（实测 `meshes.total` 1074、`items` 为空）。需要看具体网格时分页取：

```
get_context({ spatial: { detail: "full", meshLimit: 3 } })
  → meshes.returned 3、nextOffset 3
get_context({ spatial: { detail: "full", meshLimit: 3, meshOffset: 3 } })
  → 下一页，不重复
get_context({ spatial: { detail: "full", meshQuery: "<名称片段>" } })
  → matched 计数 + 过滤结果
```

不要为了「看全」把上千条网格一次性拉回来。只有要按名称定位具体网格时才用 `detail: "full"`。

## 画面

`render_frames` 省略 `frames` 时自动覆盖每个镜头的必看时刻（首、中、尾加相机与走位关键点），按整镜装批，放不下的列在 `deferred`。

- 默认 `view: "auto"`：多个时刻只回传**一张接触表**（4 列 320×180 拼图，带 t 标签），同时每张单帧仍保存为证据文件。
- `view: "frames"`：逐张看图，用于复核细节。
- `view: "sheet"`：只要拼图。

返回的 `coverage` 给出每镜 `requiredTimes`、`capturedTimes`、`missingRequiredTimes`。实测 3 镜头 9 帧时，每镜缺口均为 0。

## 导出

`export_artifacts` 立即返回任务 ID，必须轮询 `get_job` 到 `completed` 才算交付完成。实测 4 格式产出 5 个文件：

| 文件 | 大小 | 内容 |
|---|---|---|
| `previzcam-project.json` | 6500 B | 可重新导入的完整项目 |
| `previzcam-storyboards.zip` | 1461787 B | 每镜首中尾 PNG + 镜头/相机数据 + 报告 |
| `camera-plan.json` | 1150 B | 可编辑相机计划 |
| `camera-timeline.json` | 84033 B | 逐帧采样轨迹 |
| `review-report.json` | 1596 B | 检查提示、限制、待审事项 |

另有 `manifest.json` 记录来源 revision 或草案 ID/version/baseRevision，以及每个文件的 SHA-256 与大小。

产物关联冻结的 source：草案导出绑定草案版本与 `baseRevision`，正式项目导出绑定 `expectedRevision`。版本过期返回 `STALE_REVISION`。

WebM 是 1280×720 实时无音频录制，最长 5 分钟；页面隐藏、断连、取消或编码失败都会中止且**不交付部分文件**。

## 错误处理

| 错误码 | 含义与做法 |
|---|---|
| `WORKSPACE_NOT_FOUND` | 页面不存在或未连接，重新 `list_workspaces` |
| `WORKSPACE_DISCONNECTED` | 页面断连，等用户重新连接 |
| `STALE_DRAFT` | 正式项目已变，重新读上下文并新建草案 |
| `STALE_REVISION` | 导出用的 revision 过期，重新 `get_context` |
| `DRAFT_CONFLICT` | `expectedVersion` 不符，先 `get_draft` 读最新 |
| `CHECK_REQUIRED` | 当前版本未检查，先 `check_draft` |
| `MISSING_FRAMES` | 必看时刻没看完，按列出的 `镜头 X 缺 t=…` 补拍 |
| `WORKSPACE_BUSY` | 页面正忙，工具会自动等空闲（约 15 秒）后重试 |
| `PAGE_HIDDEN` | 回到前台后重新发起视频导出 |
| `REQUEST_TIMEOUT` | 先查当前状态，写入可能已发生，不要无条件重试 |
| `DRAFT_LIMIT` | 草案上限 20 份，先丢弃不用的 |
| `LOCKED_CAMERA` | 改了锁定相机，改用新 ID 提出备选机位 |
| `SCENE_MISMATCH` | plan 的 `sceneId` 与项目不符 |
| `INVALID_PLAN` / `INVALID_BLOCKING` / `MISSING_ACTOR` / `MOTION_POLICY` | plan 结构或引用不合法，按消息修正 |

默认至多三轮自动修正，之后应交付未解决事项而不是继续试错。

## 配套 Skills

`skills/` 下七个 `previzcam-*` Skill 覆盖完整流程：

```bash
pwsh -NoProfile -File mcp/install-skills.ps1 -Destination '你的客户端技能目录'
```

- `previzcam-previs-director`：剧本转完整预演，总控流程
- `previzcam-preflight`：开工前预检与防返工
- `previzcam-scene-survey`：空间依据与场景约束
- `previzcam-blocking`：人物占位与走位
- `previzcam-cinematography`：景别、机位与运镜
- `previzcam-shot-review`：实际画面和几何检查
- `previzcam-delivery`：输出整理与版本核对

完整参数与格式见 [../mcp/CONTRACT.md](../mcp/CONTRACT.md)，也可通过 MCP 资源 `previzcam://reference/previs-contract` 读取。
