---
name: wiki-maintainer
description: "📚 知识库维护 - 管理和维护AI记忆知识库"
emoji: 📚
---

# Wiki Maintainer Skill

管理和维护 SkyalyticWing 的记忆知识库，包括知识整理、索引构建和内容更新。

## 使用场景

- 整理和分类知识条目
- 构建知识索引
- 合并重复知识
- 更新过时信息
- 生成知识地图

## 操作步骤

1. **搜索知识库**
   使用 `memory_search` 工具：
   ```
   memory_search({ query: "搜索关键词" })
   ```

2. **保存知识**
   使用 `memory_save` 工具：
   ```
   memory_save({ key: "主题", content: "知识内容", tags: ["标签1", "标签2"] })
   ```

3. **知识整理**
   - 搜索相关条目
   - 合并重复内容
   - 更新过时信息
   - 添加缺失标签

4. **构建索引**
   使用 `knowledge_search` 搜索向量知识库：
   ```
   knowledge_search({ query: "关键词", topK: 10 })
   ```

5. **生成知识地图**
   分析知识条目间的关联，生成结构化的知识地图

## 示例

```
用户: 搜索关于"部署"的知识
执行: memory_search({ query: "部署" })

用户: 保存一条新知识
执行: memory_save({ key: "Docker部署流程", content: "...", tags: ["docker", "部署"] })

用户: 整理知识库中的重复条目
步骤1: memory_search 搜索相关条目
步骤2: 分析重复内容
步骤3: 合并并更新
```
