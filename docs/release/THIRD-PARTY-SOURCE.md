# 第三方对应源码与构建

本版 GitHub Release 在 FPK 同一下载页提供 `qibox-third-party-source-part-*.tar`。请下载所有分卷；每卷是可独立解压的 tar，包含不同源码文件，并非需要拼接的二进制分片。完整清单见同页的 `runtime-source-lock.json` 与 `SHA256SUMS.txt`。npm 原始源码包附在 `qibox-npm-source.tar`，精确下载地址和完整性见 `package-lock.json`。产品源码及构建脚本另附源码 zip，并可在 Release 标签对应的 Git 仓库查看。

## Debian 运行组件

`config/runtime-lock.json`、`config/runtime-lock-arm64.json` 和 `config/runtime-supplement-lock.json` 保留原二进制版本、官方来源和 SHA-256。`config/runtime-source-lock.json` 将每个二进制版本（去除 Debian binNMU 的 `+bN` 后缀）映射到同源目录、同源版本的 `.dsc`、上游归档及 Debian 修改归档。已从当前镜像移除的 expat 对应版本取自 Debian 官方 snapshot。所有源码归档按 `.dsc` 的 SHA-256 验证，原始 `.dsc` 也随包保留。

同一源包会产生多个二进制包，源码不按二进制重复下载。分卷解压到同一个目录，然后在目标源包目录执行：

```sh
dpkg-source -x package_version.dsc
cd package-version
# 按 debian/control 的 Build-Depends 在匹配 Debian 12/架构的构建环境安装依赖
dpkg-buildpackage -us -uc
```

各包的 Debian 构建规则、补丁、依赖和版权在源码的 `debian/` 内；库与应用仍采用其各自许可证，未重新许可为栖盒许可证。安装包保留 `usr/share/doc` 中的版权及 `licenses/debian`。

## 栖盒组合与修改

栖盒不修改微信二进制，也不随包分发微信。Debian 组件按锁定包提取；裁剪文件策略见 `config/runtime-policy.json`，保留清单、模式、链接和源哈希由 `scripts/prepare-runtime-solid.py` 记录。补充运行库由 `scripts/prepare-runtime-supplements.py` 按官方索引与原包哈希提取。

2026-10-28 构建中，Xvfb 私有副本有两处等长路径重定位，修改字节、偏移和前后完整哈希见 `config/xvfb-relocations.json`，应用逻辑见 `server/x11.mjs`。上游源码与 Debian 补丁完整保留。运行组件其余代码按上游原样提取。

产品构建要求 Node.js、Python 3、npm 锁定依赖、官方 fnpack；运行 `npm ci`、`npm run prepare:runtime` 和 `npm run build -- --arch=all`，细节以同标签脚本为准。fnOS 的 Node.js 是系统依赖，不打入本 FPK。源码构建环境与不同编译器可能影响二进制复现；这里提供原始包版本及实际组合脚本，不声称位级可复现编译。

## Web、Node 依赖及字体

noVNC 使用 MPL-2.0，其原始 npm 源码包随 Release 提供；飞牛 Web SDK、ws、PDFKit、fflate 及其依赖的许可证或包声明见 FPK 的 `licenses/npm`。仅参与构建的开发依赖不属于安装时运行组件。补充 Noto 字体使用 OFL-1.1，原文件未修改，来源、哈希及许可证见 `config/fonts.json` 与 `licenses/fonts`。
