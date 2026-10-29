---
name: previzcam-cinematography
description: 根据 PrevizCam 实际场景、剧本及人物调度设计景别、机位、焦距和相机路径。用于草案镜头设计与调整，尊重固定摄影和锁定相机。
---

# 镜头设计

读取工作区、空间数据和最新草案。按叙事功能提出机位，检查每镜实际人物站位与走位后再选构图。优先利用锚点和实际空间，不能从包围盒推出无碰撞结论。

相机字段为 `{id,name,locked,mode,keyframes}`。每个关键点含 t、世界坐标 position、target 和垂直视场角 fov。坐标米、Y 向上，fov 为度。完整合约见 `previzcam://reference/previs-contract`。

- static 只允许 t=0 一个关键点，位置、焦距与注视点不变。
- linear / smooth 至少包含 t=0 与 t=1，时间严格递增。smooth 可能超出控制点的包围范围，应检查中间时刻。
- 锁定相机完整保留。需要替代方案时新增相机 ID，并调整镜头绑定。
- 固定摄影镜头保留 motionPolicy=static。只有用户/剧本允许时才选择运镜。
- 镜头绑定 cameraId；多个镜头共享相机会共享同一路径，按各镜头时长播放。

当前 16:9 视窗的焦距换算为 `fov = 2 * atan(20.25 / (2 * mm)) * 180 / PI`。该换算不模拟景深。

通过 update_draft 更新完整 plan，然后 check_draft 和 render_frames。省略 `frames` 时会自动包含首、中、尾与相机/走位关键时刻，并按整镜装批；先看接触表，需要细节再用 `view: "frames"` 取单帧。路径拐弯或遮挡时刻要追加画面。检查头部安全区、视线与轴线、景别和镜间差异。报告实际观察和候选意图，不把数值合法等同于画面成立。
