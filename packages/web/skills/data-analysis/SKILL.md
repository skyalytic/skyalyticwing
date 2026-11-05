---
name: data-analysis
description: "📊 数据分析 - 数据清洗、统计分析、可视化建议和报告生成"
emoji: 📊
---

# Data Analysis Skill

对结构化和非结构化数据进行分析，包括数据清洗、统计计算、趋势分析和可视化建议。

## 使用场景

- 分析CSV/JSON数据文件
- 执行统计计算（均值、中位数、标准差等）
- 数据清洗和预处理
- 生成数据报告
- 提供可视化建议

## 操作步骤

1. **数据加载**
   - CSV文件: 使用 `bash` 执行 Python 脚本读取
   - JSON文件: 使用 `file_read` 读取并解析
   - 数据库: 使用 `database` 技能查询

2. **数据探索**
   - 查看数据形状和类型
   - 检查缺失值和异常值
   - 计算基本统计量

3. **数据分析**
   - 使用 `code_execution` 工具执行 Python 分析脚本
   - 支持的库: pandas, numpy, scipy, statistics
   - 执行统计检验、回归分析等

4. **结果呈现**
   - 生成分析报告
   - 提供可视化建议（图表类型、配色方案）
   - 导出分析结果到文件

## 分析脚本模板

```python
import json, statistics
data = json.loads('''{{INPUT_DATA}}''')
# 分析逻辑
result = {
    "count": len(data),
    "mean": statistics.mean(data),
    "median": statistics.median(data),
    "stdev": statistics.stdev(data) if len(data) > 1 else 0
}
print(json.dumps(result, ensure_ascii=False))
```

## 示例

```
用户: 分析这个CSV文件的销售额趋势
步骤1: file_read({ path: "sales.csv" })
步骤2: code_execution({ language: "python", code: "分析脚本" })
步骤3: 生成分析报告

用户: 计算这组数据的统计特征
步骤1: code_execution({ language: "python", code: "统计计算脚本" })

用户: 清洗这个数据集中的异常值
步骤1: 读取数据
步骤2: 识别异常值
步骤3: 提供清洗方案
```
