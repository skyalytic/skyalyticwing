import { describe, it, expect } from 'vitest';
import { PermissionManager } from '@skyalyticwing/core/permission';
describe('Permission Integration Tests', () => {
    it('should check permission', async () => {
        const manager = new PermissionManager({
            rules: [
                {
                    id: 'test-rule',
                    type: 'tool',
                    pattern: 'TestTool',
                    permission: 'allow',
                    priority: 50,
                },
            ],
        });
        const decision = await manager.checkPermission({ name: 'TestTool', description: '', category: 'custom', inputSchema: {}, call: async () => ({}) }, {}, { toolUseId: 'test', sessionId: 'test', sessionKey: 'test', agentId: 'test', abortController: new AbortController(), metadata: {} });
        expect(decision.type).toBe('allow');
    });
    it('should deny by rule', async () => {
        const manager = new PermissionManager({
            rules: [
                {
                    id: 'deny-rule',
                    type: 'tool',
                    pattern: 'DangerousTool',
                    permission: 'deny',
                    priority: 100,
                },
            ],
        });
        const decision = await manager.checkPermission({ name: 'DangerousTool', description: '', category: 'custom', inputSchema: {}, call: async () => ({}) }, {}, { toolUseId: 'test', sessionId: 'test', sessionKey: 'test', agentId: 'test', abortController: new AbortController(), metadata: {} });
        expect(decision.type).toBe('deny');
    });
});
//# sourceMappingURL=permission.test.js.map