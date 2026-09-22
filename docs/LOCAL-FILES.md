# 微信从本机选择发送文件

实现状态：代码、本地浏览器、NAS 上的独立 D-Bus / GTK 测试及官方微信空白实例启动已通过。0.1.16 飞牛双架构 FPK、绿联 x86 和 ARM UPK 均已生成并校验；192.168.3.7 已部署来自该包的服务和网页代码，原微信实例已恢复。官方微信原按钮的最终实机点击仍待用户反馈。交付记录见 `reports/LOCAL-FILES-0.1.16.md`。

## 使用流程

点击微信聊天窗口原来的“发送文件”按钮，浏览器打开当前电脑的文件选择框。用户选中的文件上传到当前微信实例，再交回微信原有的文件处理流程。栖盒没有新增桌面顶部发送按钮，也没有模拟点击微信的最终发送按钮。

浏览器只提供用户选择的文件，不把电脑磁盘或整个文件夹挂载给 NAS。网络延迟超过浏览器的用户手势有效期时，界面提供“选择本机文件”以继续当前请求。浏览器对此要求短暂用户激活，详见 [MDN showPicker](https://developer.mozilla.org/en-US/docs/Web/API/HTMLInputElement/showPicker)。

## 实现

- `server/file-portal.py` 在每个实例自己的 D-Bus 会话上提供 `org.freedesktop.portal.FileChooser`。当前已下载的官方微信二进制中包含相应接口和 `XFileDialogPortalPrivateImpl`，但仅凭这些标识不能证明真实点击一定选择该接口，必须实机验收。
- 微信启动环境设置 `QT_QPA_PLATFORMTHEME=xdgdesktopportal`，选择官方二进制内置的 Portal 主题；单独提供 D-Bus 服务不足以保证普通 X11 环境选择它。依据 [Qt 5.15 主题初始化源码](https://github.com/qt/qtbase/blob/5.15/src/gui/kernel/qguiapplication.cpp)。已有微信进程不会动态获得新环境设置。
- `server/file-chooser.mjs` 管理请求归属、文件清单、流式上传、完成及取消；`web/local-files.mjs` 将原始鼠标手势和原生请求关联。noVNC 的鼠标释放会经页面外层捕获元素转发，因此保留在桌面区域开始的真实 pointer 手势，避免依赖合成 mouseup。
- 文件选择接口遵循 [XDG FileChooser OpenFile / Response](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.FileChooser.html)。另存为及目录选择仍由 NAS 桌面上的文件框处理。
- 文件路径由服务端生成：当前实例数据目录下 `file-transfers/<request-id>/<file-id>/<filename>`。不接受浏览器传入 NAS 路径。多个同名文件使用不同子目录。
- 每个文件最多 1 GiB，一次最多 20 个、合计最多 2 GiB；这些是栖盒接入限制，最终仍受微信及 NAS 网关限制。
- 所有接口校验 NAS 用户身份、实例归属、CSRF 和请求客户端归属。未传完整或取消的文件不会返回给微信；取消会中断上传并清理该请求目录。
- 已成功交给微信的文件保留在所属实例目录中，避免微信尚未读取时被提前清除。删除该实例数据时一并删除。当前没有按时自动清理完成文件。

## 已完成的验证

- `npm test`：62 项通过，包括新增上传权限、路径、大小、并发、取消、Unicode 名称和精确字节检查。
- `npm run check`：语法、产品标识、版本一致性通过。
- `node scripts/test-local-files.mjs`：真实 Edge / noVNC / 应用 HTTP 上传；模拟的原生请求跟随远程鼠标操作，单次点击打开本机选择框，传回字节一致，取消生效，没有额外聊天发送按键。
- `npm run test:desktop`、`node scripts/test-ugos-desktop.mjs`、`npm run test:ui`：已有桌面输入、绿联传输、界面流程验证通过。
- Python 文件通过语法编译。
- 已通过 192.168.3.7 飞牛的 SSH 登录；在其实际 Linux 环境验证接口注册、原生 OpenFile 请求、精确文件 URI 返回、浏览器取消及 Request.Close。
- 使用飞牛已安装的运行库，在独立且需要认证的测试 X 显示上验证另存为、目录选择的 Request.Close，并确认取消后能再次打开文件。无显示环境的失败响应也通过；修正了异常时重复回复及窗口关闭后请求遗留的问题。记录在 `reports/portal-linux-headless-tests.json`、`reports/portal-linux-desktop-tests.json`。
- 在空白 HOME、独立显示和 D-Bus 中启动官方微信成功。微信启动时实际读取了 Portal 版本属性；测试进程全部停止，原实例未受该测试影响，记录在 `reports/native-runtime-tests.json`。
- 飞牛代码更新后的实际服务验证：原实例使用原 HOME 正常启动，新主题生效，文件接口可用，缺少 CSRF 的请求返回 403。记录在 `reports/fnos-file-code-update.json`、`reports/fnos-file-api-smoke.json`。

## 尚未完成

1. 在目标 NAS 的真实微信中验证原按钮、取消、多文件、中文名称、浏览器重新连接及另存为。旧实例的临时探测已结束，用户尚未反馈已点击；新启动配置的功能应在刷新网页、重新打开微信后验证。
2. 通过飞牛应用中心安装 0.1.16 FPK，使应用中心的版本信息与代码同步；当前 CLI 的 `install-fpk` 对已有应用只返回“已安装”，没有执行升级。
3. 绿联实际设备上的原按钮行为仍需验证；x86/ARM 共用该实现，不能将飞牛 x86 验证等同于 ARM 实机通过。

当前连接目标为用户更正的 192.168.3.7，设备为飞牛。正常包升级没有执行，因此备份原程序后直接更新了 30 个服务和网页文件，再停止、启动栖盒并恢复原微信实例；用户实例目录清单哈希保持一致，没有由更新脚本改写用户数据。应用中心和配置仍为 0.1.13，运行代码来自已校验的 0.1.16 包。旧代码备份保存在设备 `/vol1/@appdata/qibox/update-backups/20260911-0.1.13-local-files/qibox-before-upgrade.tar.gz`。没有发送聊天消息，登录口令没有写入代码或报告。浏览器能列出飞牛标签页，但读取 DOM 和截图仍超时，真实按钮点击需要用户完成。
