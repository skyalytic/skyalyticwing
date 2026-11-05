---
name: oracle
description: "🧿 多模型查询 - 将提示发送给其他AI模型获取不同视角"
emoji: 🧿
---

# Oracle Skill

将提示和文件发送给其他 AI 模型，获取不同视角的回答，用于交叉验证和对比分析。

## 使用场景

- 对比不同模型的回答
- 交叉验证重要结论
- 获取特定模型的专长回答
- 多模型协作解决问题
- 模型能力测试

## 操作步骤

1. **确定目标模型**
   可用模型取决于配置的API密钥：
   - OpenAI: gpt-4o, gpt-4o-mini, o1, o3-mini
   - Anthropic: claude-3-5-sonnet, claude-3-opus
   - Google: gemini-2.0-flash, gemini-1.5-pro
   - DeepSeek: deepseek-chat, deepseek-reasoner
   - 本地: ollama 模型

2. **发送查询**
   使用 `bash` 执行 curl 调用目标模型 API：
   ```bash
   curl -X POST 'https://api.openai.com/v1/chat/completions' \
     -H "Authorization: Bearer $OPENAI_API_KEY" \
     -H 'Content-Type: application/json' \
     -d '{"model": "gpt-4o", "messages": [{"role": "user", "content": "问题内容"}]}'
   ```

3. **对比结果**
   收集多个模型的回答，进行对比分析

4. **综合结论**
   基于多模型结果，给出综合建议

## 示例

```
用户: 用GPT-4o回答这个问题
执行: bash({ command: "curl -s -X POST https://api.openai.com/v1/chat/completions ..." })

用户: 对比GPT-4o和Claude对这个问题的回答
步骤1: 分别调用两个模型
步骤2: 对比分析结果

用户: 用DeepSeek推理模型分析这个逻辑问题
执行: bash({ command: "curl -s -X POST https://api.deepseek.com/v1/chat/completions ..." })
```
