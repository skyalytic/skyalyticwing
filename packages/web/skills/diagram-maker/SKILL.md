---
name: diagram-maker
description: "📊 图表制作 - 创建流程图、时序图、甘特图等各类图表"
emoji: 📊
requires: { bins: ["mmdc"] }
install: "npm install -g @mermaid-js/mermaid-cli"
---

# Diagram Maker Skill

使用 Mermaid 或 PlantUML 创建各类图表和流程图，包括流程图、时序图、甘特图、类图、状态图和饼图。

## 使用场景

- 创建业务流程图
- 绘制系统交互时序图
- 制作项目甘特图
- 生成 UML 类图
- 绘制状态机图
- 制作数据饼图

## 前置要求

- 需要安装 Mermaid CLI（`mmdc`）或 PlantUML
- Mermaid CLI 安装：`npm install -g @mermaid-js/mermaid-cli`
- PlantUML 需要 Java 运行环境和 Graphviz
- 首次运行 mmdc 可能需要下载 Puppeteer 浏览器

## 命令

### diagram_create

使用 Mermaid 语法创建图表。

- `type` (必填): 图表类型，"flowchart"（流程图）、"sequence"（时序图）、"gantt"（甘特图）、"class"（类图）、"state"（状态图）、"pie"（饼图）、"er"（ER图）、"mindmap"（思维导图）
- `content` (必填): Mermaid 语法的图表定义
- `title` (可选): 图表标题
- `direction` (可选): 流程图方向，"TD"（上到下）、"LR"（左到右），默认 "TD"
- `theme` (可选): 主题，"default"、"dark"、"forest"、"neutral"，默认 "default"

### diagram_export

将 Mermaid 文件导出为图片。

- `input` (必填): 输入的 .mmd 文件路径
- `output` (必填): 输出文件路径（支持 .png、.svg、.pdf）
- `theme` (可选): 主题，默认 "default"
- `width` (可选): 输出宽度，默认 800
- `height` (可选): 输出高度，默认 600
- `scale` (可选): 缩放比例，默认 1

### diagram_list_templates

列出可用的图表模板。

- `type` (可选): 按类型筛选模板

## 示例

```
用户: 画一个用户登录的流程图
执行: diagram_create({ type: "flowchart", direction: "TD", content: "A[用户访问] --> B{已登录?}\nB -->|是| C[进入首页]\nB -->|否| D[登录页面]\nD --> E[输入凭证]\nE --> F{验证通过?}\nF -->|是| C\nF -->|否| D" })

用户: 创建一个API调用的时序图
执行: diagram_create({ type: "sequence", content: "participant 客户端\nparticipant API网关\nparticipant 服务端\n客户端->>API网关: 发送请求\nAPI网关->>服务端: 转发请求\n服务端-->>API网关: 返回数据\nAPI网关-->>客户端: 响应结果" })

用户: 制作项目甘特图
执行: diagram_create({ type: "gantt", content: "title 项目开发计划\ndateFormat YYYY-MM-DD\nsection 设计\n需求分析 :a1, 2024-01-01, 10d\nUI设计 :a2, after a1, 15d\nsection 开发\n前端开发 :b1, after a2, 20d\n后端开发 :b2, after a2, 25d" })

用户: 导出图表为PNG
执行: diagram_export({ input: "flow.mmd", output: "flow.png", theme: "dark" })

用户: 列出可用的模板
执行: diagram_list_templates()
```

## 注意事项

- Mermaid 语法需严格遵循规范，否则渲染失败
- 复杂图表建议先验证语法再导出
- 中文字符在图表中可能需要指定字体
- SVG 格式适合网页嵌入，PNG 适合文档插入
- 大型图表导出可能需要较长时间
