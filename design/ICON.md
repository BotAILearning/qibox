# 栖盒 0.1.13 图标主体放大

按原透明图中的主体边界裁去多余留白，再等比导出各尺寸。主体宽度从画布的 66.1% 提升到 91.9%，视觉尺寸约增大 39%，左右各保留约 4% 透明边距。盒子原始造型、颜色、比例与透明通道保持不变。

- 完整源图：design/qibox-icon.png（902 × 902）
- 网页资源：web/icon.png（512 × 512），构建同步到 public 与 public-ugos
- FPK 导出：64 × 64、256 × 256，保持 Alpha 通道
- 原透明图备份：design/qibox-icon-0.1.12.png（1254 × 1254）；此前不透明原图：design/qibox-icon-0.1.11.png
- 调整工具：sharp，裁剪原图矩形 x=177、y=175、width=902、height=902 后等比缩放。主体边界统计阈值只用于定位，不改变像素 Alpha。完整参数见 reports/icon-framing-0.1.13.json。
- 内置 image_gen 放大候选没有真实 Alpha 通道，未采用。最终直接调整原透明素材尺寸。
- 本次更新飞牛安装包为 0.1.13。绿联网页资源同步；已有 0.1.9 UPK 未重新打包。

本次未采用的 image_gen 放大提示词：

> Edit this exact transparent PNG application icon by changing framing and scale ONLY. Enlarge the existing green open box uniformly so its visible silhouette spans 92 percent of the square canvas width, with 4 percent fully transparent margin at left and right. Vertically center the box and keep the entire silhouette inside the canvas. Preserve the original aspect ratio, perspective, shape, cream lid and green colors, shading and details. The background must remain actual transparent alpha, NOT black, white, mint, or a printed checkerboard. Do not redesign or add a shadow. Clean smooth edges. Return the enlarged original box as a transparent PNG.

原透明素材的编辑提示词（0.1.12）：

> Use case: background-extraction. Edit target: the provided Qibox application icon, a green 3D open box. Remove only the pale mint background and all ground shadow outside the box silhouette, replacing it with genuine alpha transparency, not a checkerboard or solid fill. Preserve the exact original box silhouette, geometry, perspective, position, scale, rounded edges, green and cream colors, surface lighting and all interior details. The dark green interior of the box is part of the object and must remain opaque. Keep the original square canvas composition and margins. Crisp smooth antialiased cutout edges with no pale background halo. Do not redesign, add objects, add text, or add a backdrop. Return a transparent PNG suitable as an app icon.

未采用的边缘清理候选提示词：

> Use case: background-extraction. Final cleanup of this exact transparent green open-box app icon. Keep the box completely unchanged. Repair ONLY the alpha-mask boundary: remove all stray light pixels, ragged white fringe, bright green/cyan fringe, and tiny isolated specks outside the true smooth box silhouette, including the specks above the top opening and around the cream lid edges. Make a professionally clean, continuous, smoothly antialiased silhouette with no white rim. Preserve actual alpha transparency throughout all exterior background; no shadow, no checkerboard, no opaque background. Preserve the opaque dark-green box interior, original colors, exact geometry, original subject size, center position and square canvas. Do not add anything or redesign the icon. Deliver a clean transparent PNG.
