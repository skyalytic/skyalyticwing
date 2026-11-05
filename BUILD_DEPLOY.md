# 构建与部署

## 本地构建

安装 Node.js、pnpm、Rust 及目标平台的 Tauri 系统依赖后，在仓库根目录执行：

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm desktop:check
pnpm desktop:build --local-test
```

`--local-test` 不生成自动更新签名，也不上传产物。Windows 安装包位于 `src-tauri/target/community/<target>/release/bundle/`。构建回执位于 `.source-check/packaging-audit/package-receipt.json`；回执和构建缓存不提交到 Git。

不要复制其他版本的 `deploy`、运行时或用户目录来凑齐构建输入。运行时脚本依据 `deploy` 下的锁定版本下载并验证组件；需保留组件自己的许可证和对应源码说明。

## Windows 桥接组件

仓库随附预编译的 Windows UIA 桥接程序 `packages/web/binaries/windows-bridge.exe`，用于相关窗口发现、聚焦和控件操作路径。它已列入 `config/packaging-inputs.json`，打包时自动纳入安装资源，无需从个人版、备份或已安装程序中另行复制。

此文件是预编译打包输入，不由本仓库的 Rust 构建生成。提交或分发仓库时应保留该文件；更新它后需重新验证打包输入和相关 Windows 功能。当前文件大小为 1,028,608 字节，SHA-256 为 `6d2730b3a2cfaab1dce6004269aec0bf435b815cfa34d4b4ba480476403c467e`。

截图与真实键鼠实现、内置浏览器源码以及 WGC 截图辅助程序的 Rust 源码均在本目录；WGC 辅助程序通过 `scripts/build-computer-use-native.cjs` 构建，与上述旧桥接组件不同。

## 服务配置

后端默认使用本机回环地址。模型接口和密钥由使用者配置，不需要 Wing 账号。需要反向代理时，显式配置监听地址、认证令牌和允许的浏览器来源；不要把 `.env.example` 中的示例值用于生产。

## 自有发布站点

默认不执行远程发布，也不更改官方更新源。下列变量仅由维护者在自己的发布环境设置：

| 变量 | 用途 |
| --- | --- |
| `WING_DEPLOY_HOST` | SSH 目标，格式为 `user@host` |
| `WING_RELEASE_DIRECTORY` | 服务器上的下载根目录，必须是绝对路径 |
| `WING_RELEASE_BASE_URL` | 与下载目录对应的 HTTPS URL，末尾含 `/` |
| `WING_UPDATE_FEED_URL` | 已存在的 HTTPS 更新清单地址 |
| `TAURI_SIGNING_PRIVATE_KEY` | 通过 CI Secret 或进程环境提供的签名私钥 |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 通过 Secret 提供的私钥口令 |

发布脚本仍要求 `config/release-policy.json` 明确开放发布及更新源开关，并验证平台产物、哈希和签名。不要在公开工作流中放置生产凭据。默认 CI 只做源码检查，不部署安装包。

## 第三方内容

技能目录包含执行所需的 scripts、references 和 assets；桌面操作指南由扩展 manifest 引用。修改说明文字时保留这些文件和引用关系。组件说明见 `THIRD_PARTY_NOTICES.md`。
