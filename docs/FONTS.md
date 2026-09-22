# 图案与特殊符号显示

0.1.9 在栖盒私有字体配置中加入 Noto Color Emoji、Noto Sans Symbols、Noto Sans Symbols2、Noto Sans Math。中文继续优先使用简体中文字体，普通英文数字继续使用文字字体，缺字时再由补充字体回退。

原配置过滤了非缩放位图字体，并统一禁用 embeddedbitmap，也未包含位图缩放规则。现在只排除旧 X11 PCF/BDF 位图字体，对彩色字体启用内嵌位图，并加载随运行库附带的 10-scale-bitmap-fonts.conf，让彩色字形按正文大小缩放。字体不安装到 NAS 系统，不替换微信二进制，不改昵称文字或发送内容。

字体在应用目录 fonts/ 下，只读使用。两种 CPU 架构共用相同字体文件。升级栖盒后，在微信图标的更多菜单中选择“停止”，再打开微信以加载新配置；仅关闭浏览器页面不会停止微信。不需要卸载微信或删除原数据。构建时核对 config/fonts.json 固定的源地址、SHA-256 和许可证。

验证样例包括 🍀、🍃、🌸、✨、🦋、🫠、🫩、🐈‍⬛、🧑🏽‍💻、👨‍👩‍👧‍👦、🇨🇳、1️⃣、❤️、❦、☯、♞、⚜、⟡、↠、♈、★、♥。测试检查字符映射、组合塑形结果和实际 Linux 字体回退。不是使用图片或改写内容代替缺失字符。

截图中已显示成方框的内容无法反推出原始字符，仍需用户提供原符号才能做一对一核对。微信自定义表情图片、私用区字符、未被字体收录的新字符与普通 Unicode 表情不同，不声明支持全部图案。ARM 和 UGOS 实机验收边界保持不变，见 MULTIPLATFORM.md。

官方来源：

- https://github.com/googlefonts/noto-emoji
- https://github.com/notofonts/symbols
- https://github.com/notofonts/math
- https://github.com/notofonts/notofonts.github.io
