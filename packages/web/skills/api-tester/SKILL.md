---
name: api-tester
description: "🔌 API测试 - HTTP接口测试、性能基准和文档验证"
emoji: 🔌
---

# API Tester Skill

测试HTTP API接口，包括功能测试、性能测试、安全测试和文档验证。

## 使用场景

- 测试REST API端点
- 验证API响应格式和状态码
- 性能基准测试
- API文档与实际行为对比验证
- 批量接口测试

## 操作步骤

1. **单个接口测试**
   - 使用 `web_fetch` 或 `bash`(curl) 发送请求
   - 验证状态码、响应头、响应体
   - 检查响应时间

2. **批量接口测试**
   - 使用 `code_execution` 执行测试脚本
   - 支持并发请求测试
   - 生成测试报告

3. **性能测试**
   - 使用 `bash` 执行 ab/wrk 等性能测试工具
   - 或使用 Python requests + time 模块
   - 统计响应时间分布

4. **安全测试**
   - 测试认证和授权
   - 检查输入验证
   - 测试常见漏洞（XSS、SQL注入等）

## 测试脚本模板

```python
import urllib.request, json, time

url = "{{API_URL}}"
method = "{{METHOD}}"
headers = {"Content-Type": "application/json", "Authorization": "Bearer {{TOKEN}}"}
data = json.dumps({{BODY}}).encode() if method != "GET" else None

start = time.time()
req = urllib.request.Request(url, data=data, headers=headers, method=method)
try:
    with urllib.request.urlopen(req, timeout=30) as resp:
        elapsed = time.time() - start
        body = json.loads(resp.read().decode())
        print(json.dumps({"status": resp.status, "time_ms": round(elapsed*1000), "body": body}, ensure_ascii=False))
except Exception as e:
    print(json.dumps({"error": str(e), "time_ms": round((time.time()-start)*1000)}, ensure_ascii=False))
```

## 示例

```
用户: 测试 https://api.example.com/users 接口
步骤1: bash({ command: "curl -s -o /dev/null -w '%{http_code} %{time_total}s' https://api.example.com/users" })
步骤2: 分析响应并报告

用户: 批量测试这些API端点
步骤1: code_execution({ language: "python", code: "批量测试脚本" })
步骤2: 生成测试报告
```
