---
name: testing
description: "自动生成单元测试、集成测试和E2E测试。适用场景：(1) 需要为新代码生成测试, (2) 需要增加测试覆盖率, (3) 需要修复失败的测试。不适用于：生产代码编写（使用coding-agent）"
metadata:
  skyalyticwing:
    emoji: "🧪"
    requires: { bins: ["vitest", "jest"] }
    tools: ["file_read", "file_write", "code_test", "bash"]
    install:
      - kind: npm
        package: vitest
        bins: ["vitest"]
---

# 测试生成技能 (Testing Skill)

自动生成单元测试、集成测试和E2E测试。

## 适用场景

[OK] **使用此技能：**

- 为新功能生成测试
- 增加测试覆盖率
- 修复失败的测试
- 重构测试代码

[X] **不适用场景：**

- 编写生产代码 → 使用 coding-agent
- 文档生成 → 使用 documentation

## Setup

```bash
# 安装 Vitest
npm install -D vitest

# 运行测试
npx vitest
```

## Common Commands

### 生成单元测试

```bash
# 读取源文件
file_read path="./src/utils.ts"

# 生成测试文件
file_write path="./src/utils.test.ts" content="..."
```

### 运行测试

```bash
# 运行所有测试
code_test path="./src"

# 运行特定测试
code_test path="./src/utils.test.ts"
```

## Templates

### 单元测试模板

```typescript
import { describe, it, expect } from 'vitest';
import { functionName } from './module';

describe('functionName', () => {
  it('should handle normal input', () => {
    expect(functionName('input')).toBe('expected');
  });

  it('should handle edge cases', () => {
    expect(functionName('')).toBe('');
    expect(functionName(null)).toBeNull();
  });

  it('should throw on invalid input', () => {
    expect(() => functionName(undefined)).toThrow();
  });
});
```

## Notes

- 测试应该清晰、独立、可重复
- 覆盖正常、边界和异常情况
- 使用有意义的测试描述
- 保持测试简单，一个测试一个断言
