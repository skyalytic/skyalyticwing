import { describe, it, expect } from 'vitest';
import { ToolRegistry, ToolExecutor } from '@skyalyticwing/core/tool';
describe('Tool Integration Tests', () => {
    it('should register and execute tool', async () => {
        const registry = new ToolRegistry();
        const executor = new ToolExecutor(registry);
        registry.register({
            name: 'TestTool',
            description: 'A test tool',
            category: 'custom',
            inputSchema: {},
            call: async () => ({ success: true, data: 'test' }),
        });
        const result = await executor.execute('TestTool', {}, {
            toolUseId: 'test',
            sessionId: 'test',
            sessionKey: 'test',
            agentId: 'test',
            abortController: new AbortController(),
            metadata: {},
        });
        expect(result.success).toBe(true);
    });
    it('should handle tool not found', async () => {
        const registry = new ToolRegistry();
        const executor = new ToolExecutor(registry);
        const result = await executor.execute('NonExistentTool', {}, {
            toolUseId: 'test',
            sessionId: 'test',
            sessionKey: 'test',
            agentId: 'test',
            abortController: new AbortController(),
            metadata: {},
        });
        expect(result.success).toBe(false);
        expect(result.error).toContain('not found');
    });
});
//# sourceMappingURL=tool.test.js.map