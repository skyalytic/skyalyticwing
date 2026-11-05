---
name: nano-edit
description: "📝 文本编辑 - 精确搜索替换和多块文件编辑"
emoji: 📝
---

# Nano Edit Skill

使用 apply_patch 工具进行精确的搜索替换和多块文件编辑。

## 使用场景

- 精确修改文件中的特定内容
- 多处同时修改
- 代码重构
- 配置文件修改
- 批量文本替换

## 操作步骤

1. **读取文件**
   ```
   file_read({ path: "目标文件路径" })
   ```

2. **单处修改**
   ```
   apply_patch({
     path: "目标文件路径",
     patches: [{
       search: "要搜索的原始文本",
       replace: "替换后的新文本"
     }]
   })
   ```

3. **多处修改**
   ```
   apply_patch({
     path: "目标文件路径",
     patches: [
       { search: "文本1", replace: "新文本1" },
       { search: "文本2", replace: "新文本2" },
       { search: "文本3", replace: "新文本3" }
     ]
   })
   ```

4. **验证修改**
   ```
   file_read({ path: "目标文件路径", offset: 修改行号, limit: 10 })
   ```

## 注意事项

- search 必须精确匹配文件中的内容（包括缩进和空格）
- 每个patch的search应该是唯一的，避免误改
- 修改后验证结果

## 示例

```
用户: 把config.json中的端口从3000改为8080
执行: apply_patch({ path: "config.json", patches: [{ search: "3000", replace: "8080" }] })

用户: 同时修改这个文件中的3处代码
执行: apply_patch({ path: "app.js", patches: [...] })
```
