---
name: previzcam-delivery
description: 导出 PrevizCam 预演项目、分镜图、相机轨迹、检查报告和 WebM，核实任务完成状态与版本，并整理可追溯的审阅包。
---

# 预演交付

先明确交付对象是候选草案还是用户已应用的正式项目。读取工作区和版本；不得把候选输出描述为用户已批准的最终版。合约见 MCP 资源 `previzcam://reference/previs-contract`。

草案用 `export_artifacts({workspaceId,draftId,formats})`。正式项目先 get_context，再传 expectedRevision。可选格式 project、storyboard、timeline、report、video；按任务需要选择，默认前四种。

调用返回 job.id。通过 get_job 查询进度，只有 completed 且返回实际 artifacts 才报告导出成功。产物含绝对路径、MIME、字节数、SHA-256；manifestPath 记录冻结的项目 revision 或草案版本。及时取得完成结果，让 MCP 保存文件。可用 cancel_job 取消正在运行的导出。

WebM 是 1280×720 实时录制、不含声音、每次最多 5 分钟。提前说明需要页面保持前台；隐藏、断连或编码失败会中止，失败后不能把部分结果作为完成包。不要自动重试长时间视频录制。

交付说明列出版本/审批状态、可编辑项目、可用图像和轨迹、检查报告及未解决事项，给出实际可访问路径。分镜包为每镜首中尾三帧，并非逐帧视频。导出项目中的内嵌 GLB 可用于恢复自定义场景。

本技能不负责调用付费视频生成服务，也不把预演画面称为写实成片。
