---
name: canvas-skill
description: "🎨 画布绘图 - 创建SVG图形、图表和可视化内容"
emoji: 🎨
---

# Canvas Skill

使用 canvas 工具创建 SVG 图形、流程图、图表和可视化内容。

## 使用场景

- 创建SVG图标和插图
- 绘制流程图和架构图
- 生成数据可视化图表
- 创建信息图
- 设计简单的UI原型

## 操作步骤

1. **创建SVG图形**
   使用 `canvas` 工具：
   ```
   canvas({ action: "create", content: "<svg>...</svg>", output: "diagram.svg" })
   ```

2. **流程图**
   创建包含矩形、箭头和文字的SVG：
   ```svg
   <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 400">
     <rect x="50" y="50" width="150" height="60" rx="8" fill="#4A90D9" />
     <text x="125" y="85" text-anchor="middle" fill="white">开始</text>
     <line x1="200" y1="80" x2="280" y2="80" stroke="#333" marker-end="url(#arrow)" />
     <!-- 更多元素 -->
   </svg>
   ```

3. **柱状图**
   使用SVG rect元素创建简单图表

4. **导出**
   - SVG: 直接保存
   - PNG: 使用 `bash` 执行转换工具（如 cairosvg、inkscape）
   ```bash
   pip install cairosvg && cairosvg diagram.svg -o diagram.png
   ```

## SVG模板

### 流程图箭头定义
```svg
<defs>
  <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
    <path d="M 0 0 L 10 5 L 0 10 z" fill="#333"/>
  </marker>
</defs>
```

## 示例

```
用户: 画一个系统架构图
执行: canvas({ action: "create", content: "架构图SVG", output: "architecture.svg" })

用户: 创建一个柱状图显示销售数据
执行: canvas({ action: "create", content: "柱状图SVG", output: "chart.svg" })

用户: 把SVG转成PNG
执行: bash({ command: "cairosvg diagram.svg -o diagram.png" })
```
