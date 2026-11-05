import { describe, it, expect } from 'vitest';
import { AgentRuntime } from '@skyalyticwing/core/agent';
describe('Agent Integration Tests', () => {
    it('should create agent runtime', () => {
        const runtime = new AgentRuntime();
        expect(runtime).toBeDefined();
    });
    it('should register agent', async () => {
        const runtime = new AgentRuntime();
        await runtime.createAgent({
            id: 'test-agent',
            name: 'Test Agent',
            type: 'custom',
            model: 'claude-sonnet-4',
            provider: 'anthropic',
        });
        const agent = runtime.getAgent('test-agent');
        expect(agent).toBeDefined();
    });
    it('should register tool', () => {
        const runtime = new AgentRuntime();
        runtime.registerTool({
            name: 'TestTool',
            description: 'A test tool',
            category: 'custom',
            inputSchema: {},
            call: async () => ({ success: true }),
        });
        expect(runtime.getToolsForAgent).toBeDefined();
    });
});
//# sourceMappingURL=agent.test.js.map