# 真实接口验收

这些脚本调用已经启动的真实后端，会消耗模型额度，并在测试实例中创建、修改、删除测试数据。必须使用独立数据目录，不能指向日常或生产实例。`extended.cjs` 会在测试数据目录初始化 Git、创建工作树并测试备份恢复。

前提：

1. 完成根目录构建，启动独立后端，设置独立 `SKYALYTICWING_DATA_DIR`、`SKYALYTICWING_WEB_DATA_DIR`、端口和鉴权令牌。
2. 在该实例设置模型供应商。本轮用到 DeepSeek `deepseek-flash` 和阿里 `qwen3.8-flash`；未来模型名以实际可用列表为准。
3. 在独立数据目录创建空文件 `.acceptance-only`，明确允许测试脚本操作该目录。
4. 在不提交到 Git 的目录准备连接 JSON：`{"url":"http://127.0.0.1:独立端口","token":"测试令牌","data":"独立数据目录绝对路径"}`。
5. 设置 `SKY_LIVE_CONNECTION` 为该 JSON 的绝对路径，从仓库根目录运行。

```powershell
node e2e/live/functional.cjs --live
node e2e/live/extended.cjs --live
node e2e/live/additional.cjs --live
```

- `functional.cjs`：79 项核心接口及流程，包含真实聊天、跨供应商工作流、定时任务、AI 文件写入与回滚。根目录 `API.txt` 只用于检查响应没有泄露原始密钥。
- `extended.cjs`：后台任务、Git 工作树、插件、MCP 子进程、备份恢复、审批和隔离缺失时拒绝执行。该脚本的“缺少 Docker”用例专用于没有 Docker 的测试机；有 Docker 的机器应另运行 `scripts/test-container-isolation.cjs`。
- `additional.cjs`：渠道停用状态配置、路由绑定、自定义工具、隔离代理、旁路提问、视觉和浏览器截图。视觉用例需要连接文件同目录的 `media-image.json`（真实图片生成响应）；浏览器用例需要独立的 Chrome/Edge CDP 测试浏览器。

每个脚本写入连接文件同目录的 JSON 结果；任何失败都会设置非零退出码。脚本中的 fixture 数据和模型断言为本轮验收固定场景，不代表覆盖所有工具、第三方账户或所有参数组合。真实渠道收发、桌面输入控制、系统服务安装及跨系统安装包需单独测试环境。

浏览器模拟后端测试仍使用 `pnpm e2e`；它验证聊天与审批界面，不替代这些真实接口验收。
