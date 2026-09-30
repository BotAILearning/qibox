# 栖盒 0.9.70 fnOS 正式版交付

日期：2026-09-30。以[已验收的 Debug 构建](EXECUTION-RECORDS-0.9.70.md)为功能基线，正式构建号为 `0.9.70`，发布通道为 `stable`。隐私协议的“绿联版通过本机上传导入”已删除；UGOS 安装包继续暂停。

## 包与核验

- 双架构 fnOS 安装包：`dist/releases/0.9.70/0.9.70/qibox-0.9.70-all.fpk`，570691580 字节，SHA-256 `b77ea646ddfadb77e6c21e68c6503b2c49e2c3629f817a73811eab6334d3ac12`。先前 Debug 包独立保留。
- `npm run check` 通过；`npm test` 共 821 项，820 通过、0 失败、1 项既有 UGOS 跳过。FPK 的应用身份、版本、权限和 850 个运行组件哈希通过独立校验。包内 `config/product.json` 确认为 `version=buildId=0.9.70`、`channel=stable`，包内隐私协议已不含指定句子。

## 真机安装

- 升级前的代码和用户登记文件备份保存在 NAS `/vol1/@appdata/qibox-upgrade-backups/0.9.70-stable-20260930`。上传到 NAS 的正式 FPK 哈希与本地一致。
- `192.168.3.7` 应用中心升级任务 `1790731567451818362-qibox`：状态 2、进度 100%。服务恢复为 `running`，微信实例仍在运行。
- 安装态 API 返回 `version=0.9.70`、`buildId=0.9.70`、`channel=stable`；浏览器页面显示“栖盒 0.9.70”。隐私协议页面显示修订后的文字且没有脚本错误。已安装的 `public/privacy.html` 与本地构建 SHA-256 一致。
- `users.json` 升级前后 SHA-256 均为 `eb0ebdaa59f356a184161a17a8f14b78eb7dd74a2c94b8a2124ea0cfc0ba0757`。本次没有发送微信消息或删除记录；既有功能的真机交互验收见上方 Debug 构建记录。
