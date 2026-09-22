# 栖盒第三方组件说明

栖盒不预装或分发微信。用户从腾讯官方源下载或自行导入后，微信程序仅保存在用户 NAS 的栖盒数据目录。

补充字体 Noto Color Emoji、Noto Sans Symbols、Noto Sans Symbols2、Noto Sans Math 使用 SIL Open Font License 1.1。原始字体未修改，来源固定到官方仓库提交，文件 SHA-256 见 config/fonts.json；完整版权与许可见 licenses/fonts。字体作为独立资源随栖盒分发。

前端使用 noVNC（MPL-2.0）、飞牛 @trimjs/web-app SDK 和绿联 @ugreen-nas/core SDK（MIT，见组件包元数据），服务使用 ws（MIT）。相应许可或组件声明随安装包保存在 licenses/npm。绿联包附带官方 Node.js 22，完整第三方许可在 bin/NODE-LICENSE。

绿联原生启动辅助程序源码随包位于 native/ugos-namespace.c，使用 Zig 0.14.1 编译并静态链接 musl。构建信息与哈希见 config/ugos-bootstrap-lock.json，编译器及 musl 许可见 licenses/ugos-native。辅助程序以应用自身用户运行，不设置 setuid 或文件能力；仅在自己的子命名空间中准备运行环境。

图形运行环境使用 Debian 12 组件，版本、下载来源和 SHA-256 见 config/runtime-lock.json 与 config/runtime-lock-arm64.json。组件自身的版权与许可随运行归档保存在 usr/share/doc，另附 licenses/debian。Xvfb 的私有副本使用两处等长路径重定位，将 xkbcomp 搜索路径和键盘编译输出路径改为实例的私有工作目录。两种架构的修改位置、原始字节、替换字节及完整输入/输出 SHA-256 见 config/xvfb-relocations.json；不修改微信二进制。运行环境其余代码按上游原样提取。

这是自有设备验证构建。公开分发前需完成各 GPL/LGPL 组件对应源码提供、修改说明和许可证履约核验；仅附版权文件不作为已完成该义务的声明。
