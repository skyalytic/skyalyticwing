---
name: healthcheck
description: "🔒 系统安全检查 - 主机安全加固、风险扫描与配置审计"
emoji: 🔒
---

# Healthcheck Skill

对系统进行安全检查和风险评估，包括权限配置、端口扫描、服务状态、密钥泄露检测等。

## 使用场景

- 检查系统安全配置是否合理
- 扫描开放端口和潜在风险
- 审计文件权限和敏感配置
- 检测环境变量中的密钥泄露
- 验证防火墙和安全策略
- 检查依赖包的已知漏洞

## 操作步骤

1. **系统信息收集**
   - 使用 `bash` 执行系统信息命令
   - Windows: `systeminfo`, `netstat -an`, `net user`
   - Linux/macOS: `uname -a`, `ss -tlnp`, `who`

2. **端口和服务检查**
   - 扫描监听端口: `netstat -an | findstr LISTEN` (Windows) 或 `ss -tlnp` (Linux)
   - 检查运行中的服务
   - 识别异常端口

3. **文件权限审计**
   - 检查关键目录权限
   - 检查SSH密钥权限（Linux/macOS）
   - 检查配置文件访问权限

4. **环境变量检查**
   - 扫描环境变量中的敏感信息（API_KEY, SECRET, PASSWORD, TOKEN等）
   - 检查PATH安全性

5. **依赖安全检查**
   - 运行 `npm audit`（Node.js项目）
   - 运行 `pip audit`（Python项目）
   - 检查过时的依赖版本

6. **生成安全报告**
   - 汇总发现的问题
   - 按严重程度分级（高/中/低）
   - 提供修复建议

## 报告模板

```
## 🔒 安全检查报告

**检查时间**: [时间]
**系统**: [操作系统信息]

### 🔴 高风险
- [问题描述] → [修复建议]

### 🟡 中风险
- [问题描述] → [修复建议]

### 🟢 低风险
- [问题描述] → [修复建议]

### ✅ 已通过检查
- [检查项]

### 📊 总体评分: [X/100]
```

## 示例

```
用户: 检查我的系统安全
执行: 按步骤收集系统信息并生成安全报告

用户: 扫描开放端口
执行: bash({ command: "netstat -an | findstr LISTEN" })

用户: 检查项目中是否有密钥泄露
执行: grep({ pattern: "(API_KEY|SECRET|PASSWORD|TOKEN)\\s*=\\s*['\"][^'\"]+['\"]", path: "/project" })
```
