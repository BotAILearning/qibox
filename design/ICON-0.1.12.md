# 栖盒 0.1.12 透明图标

去掉原来的浅薄荷色背景及盒子外部投影，保留绿色开口盒子、象牙色高光与盒子内部颜色。PNG 使用真实 Alpha 透明背景。

- 完整源图：design/qibox-icon.png
- 网页资源：web/icon.png（512 × 512），构建同步到 public 与 public-ugos
- FPK 导出：64 × 64、256 × 256，保持 Alpha 通道
- 原图备份：design/qibox-icon-0.1.11.png
- 工具：内置 image_gen；采用首个含真实 Alpha 通道的去背景结果，网页与安装包尺寸由项目已有 sharp 构建流程导出。后续边缘清理候选生成了不透明棋盘格背景，经检查后未采用。
- 本次更新飞牛安装包为 0.1.12。绿联已有 0.1.9 UPK 未重新打包。

最终采用版本的编辑提示词：

> Use case: background-extraction. Edit target: the provided Qibox application icon, a green 3D open box. Remove only the pale mint background and all ground shadow outside the box silhouette, replacing it with genuine alpha transparency, not a checkerboard or solid fill. Preserve the exact original box silhouette, geometry, perspective, position, scale, rounded edges, green and cream colors, surface lighting and all interior details. The dark green interior of the box is part of the object and must remain opaque. Keep the original square canvas composition and margins. Crisp smooth antialiased cutout edges with no pale background halo. Do not redesign, add objects, add text, or add a backdrop. Return a transparent PNG suitable as an app icon.

未采用的边缘清理候选提示词：

> Use case: background-extraction. Final cleanup of this exact transparent green open-box app icon. Keep the box completely unchanged. Repair ONLY the alpha-mask boundary: remove all stray light pixels, ragged white fringe, bright green/cyan fringe, and tiny isolated specks outside the true smooth box silhouette, including the specks above the top opening and around the cream lid edges. Make a professionally clean, continuous, smoothly antialiased silhouette with no white rim. Preserve actual alpha transparency throughout all exterior background; no shadow, no checkerboard, no opaque background. Preserve the opaque dark-green box interior, original colors, exact geometry, original subject size, center position and square canvas. Do not add anything or redesign the icon. Deliver a clean transparent PNG.
