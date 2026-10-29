# PrevizCam MCP 与 Skills

本机外部 Agent → stdio MCP → `127.0.0.1` WebSocket → 已连接的 PrevizCam 页面。浏览器持有正式项目并负责 Three.js 渲染；Agent 只编辑独立草案，用户在网站统一应用。

## 安装与连接

需要 Node.js 22.19+、Python 和支持 WebGL 2 的浏览器。在项目根目录安装锁定依赖：

```powershell
npm.cmd ci --prefix mcp --ignore-scripts
```

启动本目录网站：

```powershell
python serve.py
```

浏览器打开 `http://127.0.0.1:8899/`。已有其他服务占用端口时，保留它并使用例如 `python serve.py --port 18899`。

生成与本机实际路径匹配的 MCP 配置：

```powershell
node mcp/config.mjs
# 网站使用其他端口时：
node mcp/config.mjs --site-url http://127.0.0.1:18899/
```

将输出合并到外部助手的 MCP 配置。输出为常见的 `mcpServers` JSON；若客户端使用配置界面，分别填写输出中的 `command`、`args` 和 `env`。命令是本机 Node 可执行文件，参数是本仓库 `mcp/server.mjs` 的绝对路径，无需配置工作目录。**通过宿主启动这个 stdio 服务**；不要同时手动启动第二份。标准输出只用于 MCP，启动信息写入标准错误。

然后在网站点击 **Agent 草案 → 连接本机 Agent**。桥接端口默认 8900。确认“已连接 · 草案模式”后，让 Agent 调用 `list_workspaces` 并选择页面。仅连接本机；网站来源精确匹配，包括主机名和端口。

## 安装七个 Skills

源码位于根目录 `skills/`。将七个 `previzcam-*` 文件夹安装到外部客户端识别的 Skill 目录，或将仓库中的这些目录登记给支持自定义技能路径的客户端。可使用复制脚本：

```powershell
pwsh -NoProfile -File mcp/install-skills.ps1 -Destination '你的客户端技能目录'
```

目录有同名技能时脚本拒绝复制，先自行比较并合并。它不会修改客户端 MCP 或模型设置。安装后按客户端要求重新加载技能。

- `previzcam-previs-director`：剧本转完整预演，总控流程。
- `previzcam-preflight`：开工前预检与防返工（朝向、边界、白模、pilot 单帧、覆盖成本）。
- `previzcam-scene-survey`：空间依据与场景约束。
- `previzcam-blocking`：人物占位与走位。
- `previzcam-cinematography`：景别、机位与运镜。
- `previzcam-shot-review`：实际画面和几何检查。
- `previzcam-delivery`：输出整理与版本核对。

第一条任务可以是：

> 使用 previzcam-previs-director，在当前山门场景中把“访客进门、停步致意、住持回应”做成 12 秒三镜头占位预演。保持固定机位，查看实际画面并检查，提交草案供我预览，不直接应用。

## 审阅与交付

Agent 创建、修改、检查后提交草案。网站的按钮显示待审数量。进入“预览与审阅”可播放、拖动时间轴并查看检查报告。预览只读；点击“应用整套草案”后修改正式项目，一次撤销恢复原状态。

人工编辑、模型替换、项目导入、撤销和重做都会使旧草案失效。需要 Agent 读取新上下文重新生成。草案属于当前页面会话，刷新/关闭页面后不恢复；正式项目沿用已有 IndexedDB 自动保存。需要长期保留候选时，在刷新前导出草案项目。

导出是异步任务。Agent 必须轮询 `get_job` 至 completed，才能取得保存后的文件。默认输出在 `outputs/previzcam/<包ID>/`，每包有 `manifest.json`，记录来源 revision、草案版本、文件大小和 SHA-256。画面证据同样按版本保存。

画面证据以草案版本为前提：`render_frames` 省略 `frames` 时会自动覆盖每个镜头的必看时刻（首、中、尾加相机与走位关键点），按整镜装批，放不下的列在 `deferred`；返回的 `coverage` 给出每镜 `missingRequiredTimes`。首轮默认只回传一张接触表（4 列 320×180 拼图，带 t 标签），单帧仍保存为证据文件，需要细节时用 `view: "frames"` 或指定 `frames` 取单帧。`submit_draft` 会拒绝仍有必看时刻未渲染的版本，并逐个列出 `镜头 X 缺 t=…`。

WebM 输出 1280×720、不含音频，实时录制最多 5 分钟；页面隐藏、断连、取消或编码失败时中止，不交付部分文件。生成分镜包支持最多 100 个镜头，每镜首中尾三帧。所有检查均有明确的有限采样范围，不保证连续无碰撞，也不验证对白和精细表演。

## 配置与接口

| 环境变量 | 默认 | 用途 |
|---|---|---|
| `PREVIZCAM_BRIDGE_PORT` | `8900` | 本机桥接监听端口；修改后网站填写相同值 |
| `PREVIZCAM_ALLOWED_ORIGINS` | `http://127.0.0.1:8899` | 允许的网站来源，逗号分隔，必须是明确的本机 HTTP 来源 |
| `PREVIZCAM_OUTPUT_DIR` | 仓库的 `outputs/previzcam` | 导出和画面证据目录 |

完整参数、格式、操作次序和错误处理见 [CONTRACT.md](CONTRACT.md)，也通过 MCP 资源 `previzcam://reference/previs-contract` 提供。共 12 个工具，正式应用、任意 JavaScript 执行、Shell 和任意文件读写均未作为工具暴露。

服务器实例独占桥接端口。页面关闭时未完成请求失败，未保存完成的导出中止。已由 get_job 保存到磁盘的产物继续存在。多个页面可以连接，但每次请求必须明确指定工作区；当前版本按一个主 Agent 顺序工作设计。

### 脱离浏览器校验项目 JSON

`mcp/validate.mjs` 复用 `preview/core.mjs` 的 `validateProject`，不需要浏览器：

```powershell
node mcp/validate.mjs path/to/project.json
Get-Content project.json -Raw | node mcp/validate.mjs
```

成功输出 `{valid, name, sceneId, cameras, actors, shots, totalSeconds}` 并以 0 退出；失败把原因写到 stderr 并以 1 退出。它只检查结构（相机/人物/镜头/时长/引用完整性），不检查几何或画面。

## 验证

```powershell
node --test tests/core.test.mjs tests/commands.test.mjs tests/bridge.test.mjs
```

网站启动后运行真实 MCP 与浏览器流程，使用独立浏览器上下文，不接触用户存档：

```powershell
node tests/mcp-browser.test.mjs
node tests/workflow.test.mjs
node tests/browser-smoke.mjs
```

可用 `PREVIZCAM_TEST_URL` 指定测试网站地址，`PREVIZCAM_TEST_PORT` 指定测试桥接端口（默认 18900）。Playwright 与 Chrome 路径沿用项目的 `PLAYWRIGHT_PACKAGE`、`CHROME_PATH` 配置。产物与截图位于 `tests/artifacts/mcp/`。无头浏览器的后台事件测试采用模拟 visibilitychange，实际视频编码与播放使用真实浏览器功能。
