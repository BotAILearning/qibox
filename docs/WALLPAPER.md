# 栖盒默认背景

资源：`web/backgrounds/mist.jpg`，1920 × 1200，JPEG。构建复制到 `public/backgrounds/mist.jpg` 并打入 FPK；桌面启动时由 hsetroot 加载，网页仅在连接前或断开后显示同一背景，不叠加在远程画面上。

生成方式：2026-09-10 使用 Codex 内置 imagegen 工具生成一张原创图片，未使用 CLI。原图保持不变，使用 Sharp 裁切到 16:10 并压缩为 JPEG。

原图：`C:/Users/HW/.codex/generated_images/01a0890d-280a-7f41-9647-f9c23bdc6307/exec-6c3d3712-1f69-4e81-ac3f-453efc792412.png`。

最终生成提示词：

> Create one original elegant desktop wallpaper for a NAS app called Qibox. Use case: photorealistic-natural. Asset: default wallpaper behind a remote desktop window. Wide landscape 16:10 composition, ideally 1920 by 1200 or wider. Serene layered Chinese mountain ridges in muted sage green, silver mist and very pale warm cream morning light. Quiet cloudy sky and generous negative space, understated photographic textures, ridges mostly in the lower half, no sharp contrast. Calm, light and refined. No text, no logos, no icons, no people, no interface, no border, no watermark. The image is the wallpaper itself, filling the entire canvas.
