---
name: mcporter
description: "📦 MCP服务器管理 - 发现、安装和配置MCP服务器"
emoji: 📦
---

# MCPorter Skill

管理 MCP (Model Context Protocol) 服务器，包括发现、安装、配置和调试。

## 使用场景

- 列出已安装的MCP服务器
- 安装新的MCP服务器
- 启动和停止MCP服务
- 调试MCP连接问题
- 管理MCP工具和资源

## 操作步骤

1. **列出MCP服务器**
   使用 `mcp_list` 工具：
   ```
   mcp_list()
   ```

2. **启动MCP服务器**
   使用 `mcp_start` 工具：
   ```
   mcp_start({ serverId: "filesystem", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/path"] })
   ```

3. **停止MCP服务器**
   ```
   mcp_stop({ serverId: "filesystem" })
   ```

4. **调用MCP工具**
   ```
   mcp_call({ serverId: "filesystem", toolName: "read_file", args: { path: "/path/to/file" } })
   ```

5. **列出MCP资源**
   ```
   mcp_resources({ serverId: "filesystem" })
   ```

6. **读取MCP资源**
   ```
   mcp_resource_read({ serverId: "filesystem", uri: "file:///path/to/file" })
   ```

## 常用MCP服务器

| 服务器 | 安装命令 | 功能 |
|--------|---------|------|
| filesystem | `npx -y @modelcontextprotocol/server-filesystem` | 文件系统操作 |
| github | `npx -y @modelcontextprotocol/server-github` | GitHub API |
| postgres | `npx -y @modelcontextprotocol/server-postgres` | PostgreSQL |
| brave-search | `npx -y @modelcontextprotocol/server-brave-search` | Brave搜索 |
| google-maps | `npx -y @modelcontextprotocol/server-google-maps` | Google地图 |
| puppeteer | `npx -y @modelcontextprotocol/server-puppeteer` | 浏览器自动化 |
| slack | `npx -y @modelcontextprotocol/server-slack` | Slack集成 |

## 示例

```
用户: 列出所有MCP服务器
执行: mcp_list()

用户: 启动文件系统MCP服务器
执行: mcp_start({ serverId: "fs", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"] })

用户: 调用MCP工具读取文件
执行: mcp_call({ serverId: "fs", toolName: "read_file", args: { path: "/workspace/README.md" } })
```
