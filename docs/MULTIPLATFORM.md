# 栖盒平台适配（飞牛 0.1.13 / 绿联 ARM64 0.1.15）

## 安装

飞牛：现有交付为 `qibox-0.1.13-all.fpk`。同一个文件适用于 x86_64 和 ARM64，manifest 为 platform=all，包内 payload/x64 和 payload/arm64 分开存放；服务按 Node 的原生 process.arch 选择并校验运行库。需安装飞牛 Node.js 22 依赖。仅支持 64 位设备，运行环境要求 glibc 2.36 或更新。

绿联：在应用中心手动安装与设备架构匹配的 UPK。ARM64 本次版本为 0.1.15；Intel/AMD 现有交付仍为 0.1.9。需 UGOS Pro 1.13.0.0000 或更新版本及相应开发者测试授权。

ARM64 升级时直接覆盖安装，随后关闭栖盒窗口并重新打开。0.1.14 对首次登录失败自动重试，登录令牌失效后重新获取；下载安装、导入安装包与已安装应用入口由恢复后的实际状态显示。应用中心和网页同步最新透明图标，脚本、样式及网页图标使用内容哈希更新缓存。

0.1.15 修复 DH4300 Plus / UGOS 1.19.1 网关传入有效用户 ID、却缺少 Ugreen-User-Type 时的登录拒绝。缺少角色时以普通用户权限加载应用，仅明确的 admin 角色可卸载共用程序；非法角色值仍拒绝。同时支持经过校验的非数字用户 ID，映射为稳定、区分大小写的目录键；原数字账号沿用旧目录。身份来源仍限定本机网关，不使用用户名、浏览器自报身份或未验证 token 代替认证。

已使用真实设备登录接口取得有效三方令牌，确认旧版本 session/state 返回 401，网关仅注入 Ugreen-User-ID 与 Ugreen-User-Name。网关会移除客户端伪造的用户 ID/管理员头。实机验证记录见 reports/ugos-device.json。

从 NAS 应用入口打开栖盒，在精选应用中下载安装微信，或上传官方 Linux 微信的 .deb 文件。下载自动匹配架构。绿联支持本机上传，飞牛另外支持 NAS 文件选择。手机仅下载安装及提示使用电脑。

## 运行方式

绿联使用原生后台进程与应用桌面入口，应用标识 com.bot.qibox。前端通过官方 SDK 取得 Ugreen-Ttk，系统网关验证后向后台传递用户 ID 和管理员标志。服务仅监听 127.0.0.1:28790，API 前缀 /api/qibox。桌面使用带认证头的 fetch 数据流和串行输入请求，不依赖浏览器无法设置自定义认证头的 WebSocket。应用根目录只读，用户数据位于 UGAPP_DATA_DIR；微信、图形运行库和用户 HOME 不写系统目录。

飞牛保留原 Unix socket 网关身份与 WebSocket 桌面连接。两平台均检查请求者、一次性桌面票据和写操作 CSRF；名称、恢复、删除和闲时资格隔离规则一致。迁移到另一架构时保留 HOME，旧微信二进制失效，需重新下载对应版本。恢复原目录不等于替微信保证再次登录及历史数据兼容性。

## 可重现构建

1. npm ci；分别执行 scripts/prepare-runtime.mjs 和 `scripts/prepare-runtime.mjs --arch=arm64`。
2. `npm run build` 生成飞牛统一 FPK，并自动验证两套运行组件和文件权限。
3. `node scripts/build-ugos.mjs` 生成 build/qibox-ugos，含公共目录、两套原生 Node 和运行组件，并通过官方 ugcli check。
4. 在项目目录调用官方 `ugcli pack --arch arm64 --build 1` 生成 ARM64 UPK；需要两个架构时使用 `--arch all`。Windows 工具位于 `.cache/tools/ugcli.exe`，Linux 工具为构建目录内的 `ugcli-linux`。最终必须运行 `scripts/verify-upk.py` 检查实际包内 Unix 权限、架构、版本、图标与源码后交付。

也可使用 `python scripts/pack-upk-ssh.py --host HOST --user USER` 在 Linux 临时目录打包两种架构并取回 UPK；0.1.8/0.1.9 使用了此方式。SSH 主机密钥需提前核实；密码仅从交互输入读取。

Node.js 版本及归档 SHA-256 固定在构建脚本；所有 Debian 归档哈希固定在相应 runtime-lock。官方微信不随 FPK 或 UPK 分发。

0.1.9 增加两架构共用的表情与符号字体，固定来源、SHA-256 和许可证位于 config/fonts.json。从更早版本升级后，从微信图标更多菜单“停止”，再打开微信使字体配置生效，无需删除数据。绿联 ARM64 0.1.14 沿用这些字体并同步 0.1.13 的透明底绿色盒子图标。

## 验证范围

本地测试覆盖两种架构选择、ARM deb 控制信息和真实 ELF、组件哈希、用户及桌面请求鉴权、真实 Edge/noVNC 数据流画面与输入、桌面和手机页面。浏览器测试使用 RFB 和 NAS 网关替身；它不能代替 UGOS 固件或 ARM 原生执行。

仍需在飞牛 ARM64、绿联 ARM64 实机检查系统沙箱权限、首次解压、微信启动/扫码/中文候选窗、退出及重启、系统升级保留数据。绿联还需验证真实 SDK 入口、网关长连接与签名安装；准备运行库时被系统强制停止后的恢复也需验收。自动登录与闲时收消息完整周期仍遵循 IDLE-POLICY.md 中的待验范围。

## 官方依据

- 微信 Linux 下载：https://linux.weixin.qq.com/
- 飞牛 manifest：https://developer.fnnas.com/docs/core-concepts/manifest/
- 绿联打包工具：https://developer.ugnas.com/doc/tools/ugcli.html
- 绿联配置：https://developer.ugnas.com/doc/tools/project-yaml.html
- 绿联运行环境：https://developer.ugnas.com/doc/backend/application/runtime-environment.html
- 绿联登录鉴权：https://developer.ugnas.com/doc/backend/system-capabilities/login-auth.html
- 绿联 SDK：https://developer.ugnas.com/doc/frontend/ugos-core/install.html
