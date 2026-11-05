# SkyalyticWing Windows 独立服务包

要求：Windows x64、已安装 Node.js 22 或以上版本。此包包含网页、后端和生产依赖；不需要源码仓库、pnpm 或 npm。它不是桌面安装器，Python 工具与 Docker 执行环境需要另外配置。

解压后在包目录打开 PowerShell：

```powershell
$env:NODE_ENV = 'production'
$env:PORT = '910'
$env:SKYALYTICWING_HOST = '127.0.0.1'
$env:SKYALYTICWING_DATA_DIR = Join-Path $env:LOCALAPPDATA 'SkyalyticWingServer'
$env:SKYALYTICWING_WEB_DATA_DIR = $env:SKYALYTICWING_DATA_DIR
$env:SKYALYTICWING_AUTH_TOKEN = '替换为至少32字符的随机令牌'
node dist/main.js
```

打开 `http://127.0.0.1:910`，在界面配置本应用连接令牌和模型供应商。连接令牌用于保护本机服务，不是供应商 API key。服务包不包含任何真实供应商密钥。

工具页的视频任务面板支持万相文生视频，默认 2.6，2.7 可选。提交会消耗供应商额度；生成过程中可刷新网页。暂停查询不会取消供应商任务或计费。没有供应商任务 ID 且结果未知时，请先核对供应商控制台，不能盲目重新提交。

停止服务用 Ctrl+C。更新前停止服务并备份整个数据目录，再替换此程序目录。保留 `SKYALYTICWING_DATA_DIR` 即保留会话、配置、视频任务和文件。一次只允许一个进程使用同一数据目录。端口被占用时更换 PORT，程序不会自动杀死其他进程。

外网部署必须自行配置可信 TLS 反向代理、随机强令牌与 `SKYALYTICWING_ALLOWED_ORIGINS`。本次只验证了 Windows 本机服务部署；没有将它作为多租户 SaaS、Linux 容器或签名桌面安装包验收。
