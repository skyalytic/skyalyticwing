---
name: debug
description: "🐛 调试 - 诊断和调试AI会话、工具调用和系统问题"
emoji: 🐛
---

# Debug Skill

诊断和调试 SkyalyticWing 系统问题，包括会话异常、工具调用失败和性能问题。

## 使用场景

- 调试工具调用失败
- 诊断会话异常
- 分析性能瓶颈
- 检查系统日志
- 排查连接问题

## 操作步骤

1. **查看系统日志**
   ```bash
   # 查看最近日志
   tail -100 logs/app.log
   # 搜索错误
   grep -i "error" logs/app.log | tail -20
   ```

2. **检查服务状态**
   ```bash
   # 检查端口
   netstat -an | findstr LISTEN  # Windows
   ss -tlnp                       # Linux
   # 检查进程
   tasklist | findstr node        # Windows
   ps aux | grep node             # Linux
   ```

3. **调试工具调用**
   - 检查工具定义是否正确
   - 验证参数格式
   - 检查权限配置
   - 查看工具执行日志

4. **性能分析**
   ```bash
   # 内存使用
   node -e "console.log(process.memoryUsage())"
   # CPU使用
   # Windows
   typeperf "\Processor(_Total)\% Processor Time" -sc 5
   ```

5. **连接诊断**
   - 测试API连接
   - 检查网络代理
   - 验证SSL证书

## 诊断模板

```
## 🐛 诊断报告

**问题**: [问题描述]
**时间**: [发生时间]

### 环境信息
- 操作系统: [OS]
- Node版本: [版本]
- 内存使用: [使用量]

### 错误信息
```
[错误堆栈]
```

### 可能原因
1. [原因1]
2. [原因2]

### 建议修复
1. [修复方案1]
2. [修复方案2]
```

## 示例

```
用户: 工具调用失败了，帮我调试
步骤1: 查看错误日志
步骤2: 检查工具定义和参数
步骤3: 生成诊断报告

用户: 系统响应很慢
步骤1: 检查系统资源使用
步骤2: 分析日志中的慢查询
步骤3: 提供优化建议
```
