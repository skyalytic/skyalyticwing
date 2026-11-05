---
name: feishu-doc
description: "📄 飞书文档 - 读写飞书云文档和知识库"
emoji: 📄
---

# Feishu Doc Skill

通过飞书开放平台API操作云文档，包括创建、编辑、搜索文档和管理知识库。

## 使用场景

- 创建和编辑飞书文档
- 搜索文档和知识库
- 读取文档内容
- 管理知识库节点
- 批量导入导出文档

## 前置要求

- 需要配置飞书应用凭证（App ID 和 App Secret）
- 在飞书开放平台创建应用并获取权限
- 应用需要文档读写权限

## 操作步骤

1. **获取访问令牌**
   ```bash
   curl -X POST 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal' \
     -H 'Content-Type: application/json' \
     -d '{"app_id": "$FEISHU_APP_ID", "app_secret": "$FEISHU_APP_SECRET"}'
   ```

2. **创建文档**
   ```bash
   curl -X POST 'https://open.feishu.cn/open-apis/docx/v1/documents' \
     -H 'Authorization: Bearer ACCESS_TOKEN' \
     -H 'Content-Type: application/json' \
     -d '{"title": "新文档", "folder_token": "..."}'
   ```

3. **搜索文档**
   ```bash
   curl -G 'https://open.feishu.cn/open-apis/suite/docs/search' \
     -H 'Authorization: Bearer ACCESS_TOKEN' \
     --data-urlencode 'query=搜索关键词'
   ```

4. **获取文档内容**
   ```bash
   curl 'https://open.feishu.cn/open-apis/docx/v1/documents/DOC_ID/blocks' \
     -H 'Authorization: Bearer ACCESS_TOKEN'
   ```

5. **知识库操作**
   ```bash
   curl 'https://open.feishu.cn/open-apis/wiki/v2/spaces' \
     -H 'Authorization: Bearer ACCESS_TOKEN'
   ```

## 示例

```
用户: 在飞书创建一个新文档
执行: bash({ command: "curl -s -X POST https://open.feishu.cn/open-apis/docx/v1/documents ..." })

用户: 搜索飞书文档中包含"季度报告"的文档
执行: bash({ command: "curl -s -G https://open.feishu.cn/open-apis/suite/docs/search ..." })
```
