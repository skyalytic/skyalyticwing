---
name: feishu-drive
description: "📁 飞书云盘 - 管理飞书云存储中的文件和文件夹"
emoji: 📁
---

# Feishu Drive Skill

通过飞书开放平台API管理云盘文件，包括上传下载、文件夹管理和权限设置。

## 使用场景

- 上传文件到飞书云盘
- 下载云盘文件
- 管理文件夹结构
- 设置文件权限和分享
- 搜索云盘文件

## 前置要求

- 需要配置飞书应用凭证
- 应用需要云盘读写权限（drive:drive, drive:file）

## 操作步骤

1. **获取访问令牌**（同 feishu-doc 技能）

2. **列出文件夹内容**
   ```bash
   curl -G 'https://open.feishu.cn/open-apis/drive/v1/files' \
     -H 'Authorization: Bearer ACCESS_TOKEN' \
     --data-urlencode 'folder_token=FOLDER_TOKEN'
   ```

3. **上传文件**
   ```bash
   curl -X POST 'https://open.feishu.cn/open-apis/drive/v1/files/upload_all' \
     -H 'Authorization: Bearer ACCESS_TOKEN' \
     -F 'file=@/path/to/file' \
     -F 'parent_node=FOLDER_TOKEN' \
     -F 'filename=report.pdf'
   ```

4. **下载文件**
   ```bash
   curl -G 'https://open.feishu.cn/open-apis/drive/v1/files/FILE_ID/download' \
     -H 'Authorization: Bearer ACCESS_TOKEN' \
     -o downloaded_file
   ```

5. **创建文件夹**
   ```bash
   curl -X POST 'https://open.feishu.cn/open-apis/drive/v1/files/create_folder' \
     -H 'Authorization: Bearer ACCESS_TOKEN' \
     -H 'Content-Type: application/json' \
     -d '{"name": "新文件夹", "folder_token": "PARENT_TOKEN"}'
   ```

## 示例

```
用户: 上传报告到飞书云盘
执行: bash({ command: "curl -s -X POST https://open.feishu.cn/open-apis/drive/v1/files/upload_all ..." })

用户: 列出飞书云盘根目录的文件
执行: bash({ command: "curl -s -G https://open.feishu.cn/open-apis/drive/v1/files ..." })
```
