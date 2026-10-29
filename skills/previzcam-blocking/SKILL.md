---
name: previzcam-blocking
description: 在 PrevizCam 草案中创建人物占位、安排站位与位置走位关键点，保持剧本人物引用和镜头接续。用于人物调度，不制作骨骼或精细动作动画。
---

# 人物调度

读取目标工作区与当前草案，结合实际锚点和场景尺度规划人物。工具参数见 MCP 资源 `previzcam://reference/previs-contract`。

人物对象为 `{id,name,color,height,facing,position}`；颜色为六位十六进制，身高单位米。新人物添加到 actors，并在对应镜头 cast 中引用。cast 控制该镜头中人物的显示及检查范围。

走位放在 `shot.blocking[actorId]`，内容为 `{t,position}` 数组。t 从 0 开始、在 0–1 内严格递增；持续走动通常给出终点 1，提前到位可用末段重复位置表示停留。只插值位置，facing 是角色全局设置，不能把它写成逐帧转身或精细表演。

先定位起点、停留点及节拍，再补必要的中间关键点。相邻镜头保持人物位置连续，叙事明确要求跳时空时在说明中记录。不要仅靠增加关键点掩盖路径穿墙。

修改完整 plan 后用 update_draft 携带 expectedVersion。调用 check_draft 并检查相关镜头实际画面。系统没有人物走位碰撞保证；涉及门洞、台阶或身体接触时保留待验证事项。

交付走位方案、叙事依据及限制，交由总控提交草案。STALE_DRAFT 时重新依据当前项目规划。
