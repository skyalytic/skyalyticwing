---
name: diffs
description: "🔄 差异对比 - 生成和查看文件、代码和内容的差异"
emoji: 🔄
---

# Diffs Skill

生成文件、代码和内容之间的差异对比，支持多种格式输出。

## 使用场景

- 对比两个文件的差异
- 查看代码变更
- 对比配置文件
- 生成可分享的差异报告
- 版本间对比

## 操作步骤

1. **文件对比**
   ```bash
   diff -u file1.txt file2.txt
   ```

2. **目录对比**
   ```bash
   diff -rq dir1/ dir2/
   ```

3. **Git差异**
   ```bash
   git diff HEAD~1 HEAD
   git diff --stat
   ```

4. **代码对比（更友好）**
   使用 Python difflib：
   ```python
   import difflib
   with open('file1.txt') as f1, open('file2.txt') as f2:
       diff = difflib.unified_diff(f1.readlines(), f2.readlines(), lineterm='')
       print(''.join(diff))
   ```

5. **生成HTML差异报告**
   ```python
   import difflib
   with open('file1.txt') as f1, open('file2.txt') as f2:
       diff = difflib.HtmlDiff().make_file(f1.readlines(), f2.readlines())
   with open('diff_report.html', 'w') as out:
       out.write(diff)
   ```

## 示例

```
用户: 对比这两个文件的差异
执行: bash({ command: "diff -u file1.txt file2.txt" })

用户: 查看最近的Git变更
执行: bash({ command: "git diff HEAD~1" })

用户: 生成HTML差异报告
执行: code_execution({ language: "python", code: "difflib HTML报告脚本" })
```
