---
name: previzcam-previs-director
description: 将文字或结构化剧本制作成 PrevizCam 单场景可编辑占位预演，组织人物调度、镜头设计、画面审查和候选提交。用于用户要求“剧本转预演”或完整规划一段戏。
---

# 剧本转预演

使用已连接的 PrevizCam MCP 完成单场景草案。第一版由一个主 Agent 完成流程；模型与场景校准已由网站提供。结果包括可播放的镜头序列、人物走位、相机、审阅说明与可导出项目。

先发现工具并读取 MCP 资源 `previzcam://reference/previs-contract`，了解真实参数及坐标约定。工具名称可能带宿主前缀。`get_context` 也返回现有项目、空间数据和完整 `previsPlan` 模板；空间数据默认是摘要，只有要按名称找具体网格时才用 `spatial: {detail: "full", meshQuery / meshGroup / meshLimit / meshOffset}` 分页读取，不要为了“看全”把上千条网格拉回来。

1. `list_workspaces` 选择用户正在使用的项目，读取上下文与 revision。多个页面时依据项目名确认目标。
2. 从输入提取当前场景的叙事节拍、人物、对白、摄影约束和时长。现有结构化剧本保留来源 ID；文字剧本整理为脚本 shots/materials 及实际 plan.shots，参阅 [文字剧本示例](references/script-example.md)。多场景内容只处理当前场景，缺少关键映射时澄清。
3. 创建草案。按需采用场景勘察、人物调度和镜头设计技能中的方法，完成 actors、shots、cameras 和 script；用 update_draft 整体提交，携带最新 expectedVersion。`plan.shots` 的顺序就是时间轴顺序，重排或插入镜头直接调整数组顺序，没有追加式限制。
4. check_draft 后 render_frames。省略 `frames` 会按必看时刻（首、中、尾加关键点）自动取图并按整镜装批，首轮默认只回一张接触表；看 `coverage` 确认每镜还缺哪些 `t`，需要细节时用 `view: "frames"` 或指定 `frames` 补拍。结合画面检查连续性与叙事效果。默认最多三轮自动修正，每次修改后重新检查。
5. submit_draft 写明做了什么、约束如何满足、实际审查了哪些画面及剩余问题。仍有镜头缺必看时刻时会被 MISSING_FRAMES 拒绝并逐个列出 `镜头 X 缺 t=…`，先补齐再提交。提示用户在网站预览与统一应用；不要自行修改正式项目或代点应用按钮。
6. 需要交付时使用导出工具；用户应用后读取新的正式 revision 再导出。get_job 完成后提供实际文件位置。

固定机位与锁定相机是约束。模型包围盒不等于实心障碍，人物只是占位，没有肢体动画。纸面时长不能冒充已验证的对白/动作时长。MCP 的采样检查不能证明连续无碰撞。

遇到 STALE_DRAFT 重新读取项目并创建新草案；不能把旧方案直接标记为有效。遇到 WORKSPACE_BUSY 时工具已经先自动等待空闲并带 retryAfterMs 自动重试；不要自己用 sleep 猜间隔，也不要因为一次 busy 就放弃操作。
