import { describe, it, expect } from 'vitest';
import { BaseTool } from '@skyalyticwing/tools';

class TestTool extends BaseTool {
  readonly id = 'test-tool';
  readonly name = 'Test Tool';
  readonly description = 'A test tool';
  readonly category = 'test';

  async execute(input: Record<string, unknown>): Promise<unknown> {
    return { success: true, input };
  }
}

describe('Tool Integration Tests', () => {
  it('should create and execute a tool', async () => {
    const tool = new TestTool();
    expect(tool.id).toBe('test-tool');

    const result = await tool.execute({ test: 'value' });
    expect(result).toEqual({ success: true, input: { test: 'value' } });
  });

  it('should return tool definition', () => {
    const tool = new TestTool();
    const def = tool.getDefinition();
    expect(def.id).toBe('test-tool');
    expect(def.name).toBe('Test Tool');
    expect(def.enabled).toBe(true);
  });
});
