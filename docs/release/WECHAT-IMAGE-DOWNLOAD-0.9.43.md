# 微信图片浏览器下载修复（0.9.43-debug.001）

微信图片浏览器的保存请求可能不提供 `current_name`。此前文件门户将目标命名为无扩展名的“微信文件”，浏览器端只能等待微信写入完成，因此界面停在“正在等待微信保存完成…”。现在无文件名的保存请求默认使用“微信图片.png”；有图片格式筛选条件时沿用其扩展名，例如 JPEG 使用 `.jpg`。普通带文件名的附件保存流程不变。

## 验证边界

- `npm run check` 通过；`node --test test/file-export.test.mjs` 5 项通过。
- 在 `192.168.3.7` 的独立 D-Bus 和 X 显示环境中运行 `scripts/test-file-portal-linux.py`，验证无文件名默认扩展名、JPEG 筛选条件、保存完成通知和现有文件门户操作均通过。此测试没有打开真实微信聊天或下载图片。
- fnOS 双架构包 `dist/releases/0.9.43/0.9.43-debug.001/qibox-0.9.43-debug.001-all.fpk` 已完成独立包校验；570635071 字节，SHA-256 `BBEF1DCFC8449C7C4B23459B832AC916FDD42BE3B8A24A1E350E32C5DB3F7C78`。UGOS 仍暂停。
- 当前设备应用中心仍是 0.9.42。已备份原 `file-portal.py` 至 `/vol1/@appdata/qibox/update-backups/20260929-image-download/file-portal.py.before`，只热更新该文件并重启受影响实例。原生登录按钮恢复后，实例的最新强制检查为 `running` / `logged-in`。后续完整安装包升级须与整体 UI 改造任务协调，避免互相覆盖。
- 真实微信图片浏览器再次点击下载、浏览器下载弹窗及图片字节一致性尚待操作验收，不能以隔离接口测试代替。
