# 架构总览

PrevizCam 是本地运行的三维镜头预演工作台。它由三个进程/层组成，边界清晰：浏览器持有项目、负责渲染；MCP 服务器负责把外部 Agent 的请求转成对页面的命令；Agent 只能编辑草案。

## 组成

```
外部 Agent (stdio)
      │  MCP 工具调用
      ▼
mcp/server.mjs ── WebSocket ──► 浏览器页面 (index.html + preview/)
      │                              │
      │                              ├─ IndexedDB：正式项目（唯一真相）
      │                              └─ Three.js：真实渲染与几何检查
      ▼
outputs/previzcam/<包ID>/   导出产物与画面证据（带 SHA-256）
```

| 层 | 位置 | 职责 |
|---|---|---|
| 页面 | `index.html`、`preview/` | 持有正式项目、渲染、几何检查、人工应用 |
| MCP 服务器 | `mcp/server.mjs` | 12 个工具的 stdio 入口、导出落盘 |
| 桥接 | `mcp/bridge.mjs` | 本机 WebSocket（默认 8900）、来源精确校验 |
| 静态服务 | `serve.py` | 回环地址静态文件服务（默认 8899） |
| Agent 界面 | `agent/` | Pi Web，浏览器里的编码 Agent |


## 草案生命周期

```
create_draft ──► update_draft ──► check_draft ──► render_frames ──► submit_draft ──► 用户在页面「应用」
   version 1        version 2        checked        必看时刻已看        status:submitted
```

每一步都写版本号。`update_draft` 必须带上一次读到的 `expectedVersion`，版本不符返回 `DRAFT_CONFLICT`，不会落半份数据。

## 检查的边界

几何检查基于离散采样与命名规则，不是连续碰撞保证：

- 每镜最多 301 个采样时刻，并检查相邻采样位置间的相交。
- 建筑内部判定只覆盖名称匹配墙、柱、门板等规则的网格包围盒；包围盒可能高估占据范围。
- 不检查人物互相遮挡、肢体碰撞、走位碰撞、对白时长、真实景深。
- 语义分组的包围盒描述范围，**不等于实心障碍物**，门洞可能在其中。

所以 `check_draft` 返回的 `messages` 是提示而非证明，文档与交付说明中不应把「无提示」表述为「已验证无碰撞」。

## 相关文档

- [mcp-workflow.md](mcp-workflow.md)：Agent 完整工作流与 12 个工具
- [data-contracts.md](data-contracts.md)：项目、草案、空间上下文与导出产物格式
- [coordinates-and-limits.md](coordinates-and-limits.md)：坐标约定、时间约定与已知限制
