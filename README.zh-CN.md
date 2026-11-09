# SkyalyticWing

<p><img src="packages/frontend/public/logo-transparent.png" alt="Skyalytic Logo" width="160" /></p>

[English](README.md) | 简体中文

[官网](https://skyalytic.com/) · [个人版下载](https://skyalytic.com/download) · [使用文档](https://docx.skyalytic.com/) · [企业版与商业授权咨询](https://skyalytic.com/contact)

SkyalyticWing 是穹析科技（Skyalytic）的 AI 工作台，支持多模型对话、工具调用、项目文件操作和桌面工作流。前端使用 React，后端使用 NestJS，桌面宿主使用 Tauri。本仓库提供免 Wing 登录的个人版（社区版）源码，按非商用许可开放使用、修改和分享。

## 2.1.1 更新

- 新增任务中心，集中查看进度、结果、问题、审批和通知，支持提示词版本管理。
- 完善任务调度、主动规则、发送队列和中断恢复。
- 支持 SSH、WSL、Docker 远程工作区，以及远程文件、终端、Git、Office 编辑和子任务 worktree 隔离。
- 支持 Responses API，完善上下文检查点和浏览器恢复。

继续保留免 Wing 登录设计。配置与测试方法见[任务中心与远程工作区说明](docs/tasks-and-remote-workspaces.md)。

## 配套企业版

SkyalyticWing 企业版是独立产品，面向团队提供企业账号、组织、席位、部门、企业预算和资源审批。员工自己的 API Key 由员工控制，不扣企业额度；企业派发的 Key 受企业权限与额度控制。

| 版本         | 使用方式                                                        | 获取方式                                                                                            |
| ------------ | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 本仓库社区版 | 无需 Wing 账号，自有 API Key 或本地模型；按本仓库非商用许可使用 | 下载源码并自行构建                                                                                  |
| 官网个人版   | 官方发布的个人版安装包，功能和服务条款以官网为准                | [官方下载](https://skyalytic.com/download)                                                          |
| 企业版       | 独立企业账号与团队管理，具体授权和交付范围以约定为准            | [联系穹析科技](https://skyalytic.com/contact)，付费授权后交付，不在此仓库提供企业版代码或公开安装包 |

需要商业用途、团队部署或企业版，请通过官网咨询并取得相应授权。本仓库许可不授予商业使用权。

## 环境要求

- Node.js 24；支持的版本范围见 `package.json`。
- pnpm 版本使用 `package.json` 中 `packageManager` 指定的版本。
- 编译桌面应用需要 Rust 和对应平台的 Tauri 编译依赖。Windows 需要 MSVC 构建工具和 WebView2；macOS 需要 Xcode Command Line Tools；Linux 需要 GTK、WebKitGTK 等开发包。

## 安装与运行

```sh
pnpm install --frozen-lockfile
```

后端默认监听 `127.0.0.1:19111`，前端开发端口为 `1421`。启动任一开发命令前，请显式允许开发前端来源。当前后端内置的开发例外仍使用 `1420`，因此需要以下配置。

PowerShell：

```powershell
$env:SKYALYTICWING_ALLOWED_ORIGINS = 'http://localhost:1421,http://127.0.0.1:1421'
pnpm dev
```

Bash / zsh：

```sh
export SKYALYTICWING_ALLOWED_ORIGINS='http://localhost:1421,http://127.0.0.1:1421'
pnpm dev
```

需要启动 Tauri 开发窗口时，在上述已配置的终端中，将 `pnpm dev` 换成 `pnpm desktop:dev`。

`.env.example` 说明可用配置。Node.js 不会自动读取该文件，请在启动终端中设置环境变量，或显式加载环境文件。不要提交真实凭据或用户数据。

## 账号与服务边界

- 无需注册或登录 Wing。配置自己的模型供应商 API Key，或连接 Ollama、LM Studio、vLLM 等本地模型即可使用。第三方 API 和联网工具仍需要网络；离线使用需事先准备本地模型和所需运行时。
- 此源码不包含 Wing 官方账号、官方模型网关、会员、积分、签到、充值、购买、发布收益和企业资源分配。自有 API、媒体生成和本地工具不检查 Wing 账号权益。公开的免账号资源目录、技能 ZIP 导入导出及第三方连接器授权仍保留。
- 独立企业版工程、官网后台、生产数据和运维凭据不包含在此仓库中。
- 本地服务面向可信的单用户环境。监听回环地址和检查浏览器来源不能认证本机其他原生进程。当前令牌认证为可选配置，调整网络暴露范围前请阅读[安全说明](SECURITY.md)。
- 应用数据目录应视为敏感资料：服务商配置可能包含 API Key。请保护本地数据目录，不要提交到公开仓库。
- 技能、插件和桌面自动化可以操作本地资源。JavaScript 执行会话不等同于操作系统级安全沙箱。

## 首次使用

1. 启动后打开设置中的模型供应商页面，添加自己的供应商、模型 ID、接口地址及 API Key；本地模型填写其服务地址和实际模型 ID，按服务要求配置密钥。
2. 保存配置后，在对话输入区选择已配置的模型即可开始对话，无需登录 Wing。
3. 需要读写项目文件时先选择项目文件夹。使用桌面操作、内置浏览器或其他工具时，根据任务授予相应权限；涉及第三方服务的连接器仍需单独配置或授权。

## 检查与构建

根据修改范围运行相应检查：

```sh
pnpm version:check
pnpm lint
pnpm type-check
pnpm test:delivery
pnpm test:public-source
pnpm build
pnpm desktop:check
```

在目标操作系统上构建本地测试安装包：

```sh
pnpm desktop:build --local-test
```

打包会下载并核验平台运行时，再检查部署目录与安装包内容。首次构建可能较慢。签名、远程发布和更新源部署需要单独配置，见[构建说明](BUILD_DEPLOY.md)。

Windows UIA 桥接程序已随仓库提供于 `packages/web/binaries/windows-bridge.exe`，作为预编译输入自动打包；请保留该文件。截图辅助程序 WGC 则由仓库中的 Rust 源码构建。

## 目录结构

| 路径                                           | 用途                             |
| ---------------------------------------------- | -------------------------------- |
| `packages/frontend`                            | 对话界面、设置和项目工作台       |
| `packages/backend`                             | 会话、模型、工具、扩展及本地服务 |
| `packages/cli`                                 | 命令行入口                       |
| `packages/shared`、`sdk`、`tools`、`providers` | 工作区公共包                     |
| `src-tauri`                                    | 原生窗口、平台集成和安装配置     |
| `scripts`、`tests`                             | 构建脚本及验证                   |
| `config`                                       | 版本身份、发布策略及打包文件清单 |
| `deploy`                                       | 可选运行时与服务部署配置         |

## 参与贡献

贡献流程见 [CONTRIBUTING.md](CONTRIBUTING.md)。请保持修改范围明确，说明行为和设计理由，并提供相关验证结果。测试使用隔离数据，不使用真实账号或消息接收人。安全问题请按 [SECURITY.md](SECURITY.md) 中的流程报告，不要在公开 Issue 中提交凭据或可直接利用的漏洞细节。

## 许可

项目自有内容按 [PolyForm Noncommercial License 1.0.0](LICENSE) 提供，可按协议用于非商业用途、修改及再分发；商用需另行授权，具体允许范围以协议全文为准。这是“源码可用、非商用”许可，不属于 [OSI 定义的开源许可](https://opensource.org/osd)。

保留 [NOTICE](NOTICE) 中的署名和许可证。第三方依赖、字体、运行时和其他带有单独许可的材料仍适用各自许可，见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。本次许可调整不撤销此前已合法授予的许可。
