# PrevizCam · 镜头预演

基于 Three.js 的三维镜头预演：导入 GLB 模型与文字剧本，摆放占位人物、规划摄影机与走位，逐镜检查构图，并把场景数据交给Agent生成镜头方案

## 功能

- **三维场景调度**：导入 GLB 模型并校准尺寸与场景绑定，放置人物占位与空间锚点，语义分组自动初分。
- **摄影机与走位**：固定、直线/分段、平滑曲线三种运镜方式；等效焦距换算；人物走位按时间插值；相机可锁定。
- **时间轴与检查**：镜头硬切衔接，逐镜检查固定机位约束、相机穿模、人物头部出画与建筑遮挡，报告可定位到镜内时刻。
- **Agent 草案**：通过本机 MCP 服务器连接外部agent，AI 在独立草案中读取上下文、渲染实际画面、自检并提交方案，你在网站审阅后统一应用。
- **高级建模**：内置独立的三维绘图编辑器（`editor.html`），支持轮廓挤出建模、关键帧动画与 USDZ/GLB/OBJ/STL 导出。

## 快速开始

需要 Python 3、Node.js 22.19+

**1. 启动预演网站**

```bash
python serve.py
```

浏览器打开 [http://127.0.0.1:8899/](http://127.0.0.1:8899/)。

**2. 启动 Agent**

```bash
cd agent
npm install
npm run dev
```

浏览器打开 [http://127.0.0.1:30141](http://127.0.0.1:30141)。

**3. 配置 PrevizCam MCP**

```bash
npm ci --prefix mcp --ignore-scripts
node mcp/config.mjs   # 生成与本机路径匹配的配置
```

将输出写入 `~/.pi/agent/mcp.json`（内容会按本机实际路径生成）：

```json
{
  "mcpServers": {
    "previzcam": {
      "command": "node",
      "args": [
        "./mcp/server.mjs"
      ],
      "env": {
        "PREVIZCAM_ALLOWED_ORIGINS": "http://127.0.0.1:8899",
        "PREVIZCAM_BRIDGE_PORT": "8900"
      }
    }
  }
}
```

然后在预演网站点击 **Agent模式 → 连接本机 Agent**


## MCP

stdio MCP 服务器（`mcp/server.mjs`）

七个 Skills 覆盖剧本拆解、预检、场景勘景、人物调度、镜头设计、画面检查与交付整理，位于 `skills/`：

```bash
pwsh -NoProfile -File mcp/install-skills.ps1 -Destination '你的客户端技能目录'
```

完整工具列表、数据合约、坐标约定与错误处理见 [mcp/README.md](mcp/README.md) 与 [mcp/CONTRACT.md](mcp/CONTRACT.md)。



## 项目结构

```
├── serve.py               # 本机静态服务器
├── index.html             # 预演工作台入口
├── editor.html            # 高级建模编辑器
├── agent/                 # Pi Web
├── preview/               # 工作台逻辑（场景、存储、MCP 桥接客户端）
├── assets/                # 示例模型与剧本
├── examples/              # 网站实际导出的格式示例
├── skills/                # 七个 previzcam-* Agent Skills
├── mcp/                   # stdio MCP 服务器、桥接、合约与独立校验器
├── tests/                 # 单元测试与浏览器流程测试
├── vendor/                # 本地依赖（Three.js r180 及其扩展）
├── docs/                  # 架构、工作流、格式与限制文档
└── prepare_assets.py      # 示例 GLB 预处理脚本
```
