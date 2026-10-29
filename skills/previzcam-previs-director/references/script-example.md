# 文字剧本到可播放数据

假设用户说：“访客从门口到接待区，停下来向住持致意，三镜头共 12 秒，保持定镜。”

先读取真实 sceneId、锚点、人物及项目 fps。不要把下面示例 ID 或坐标当作当前场景事实。可以提出“进入—停步—反应”三个叙事节拍；若输入已有切镜和时长，优先遵守输入。

脚本最小形状：

```json
{
  "title": "访客接待",
  "format": { "fps": 24 },
  "cameraPolicy": { "mode": "static" },
  "characters": [{ "id": "CHAR_VISITOR", "name": "访客" }],
  "shots": [{
    "id": "RECEPTION",
    "locationId": "实际场景ID",
    "cast": ["CHAR_VISITOR"],
    "materials": [{
      "id": "RECEPTION_ENTER",
      "locationId": "实际场景ID",
      "action": "访客从门口来到接待区。",
      "useSeconds": 5,
      "startFrame": 0,
      "endFrame": 120
    }]
  }]
}
```

补齐另外两个素材段落，并生成对应的 plan.shots。脚本只是叙事来源；实际镜头还需要 cameraId、duration、cast、motionPolicy、blocking。每个引用的人物必须有完整 actor 记录，每个相机必须有合法关键点。

始终以 create_draft 返回的 plan 为底稿。保留锁定相机和未要求修改的内容；替换片段应在 summary 中明确说明。若只处理已有段落，使用原 ID，避免失去来源对应关系。

完成后输出实际检查记录与画面证据；在检查结果仍有提示时保留说明，不为了消除提示随意删除人物或镜头。
