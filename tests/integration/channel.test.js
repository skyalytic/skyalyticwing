import { describe, it, expect } from 'vitest';
import { ChannelManager } from '@skyalyticwing/core/channel';
describe('Channel Integration Tests', () => {
    it('should register channel', async () => {
        const manager = new ChannelManager();
        await manager.register({
            id: 'test-channel',
            name: 'Test Channel',
            version: '1.0.0',
            description: 'Test',
            configSchema: {},
            capabilities: {},
            initialize: async () => { },
            connect: async () => { },
            disconnect: async () => { },
            destroy: async () => { },
            sendMessage: async () => ({ success: true }),
            onMessage: () => () => { },
            onEvent: () => () => { },
            getStatus: () => ({ connected: false }),
            getCapabilities: () => ({}),
        }, {});
        const channel = manager.get('test-channel');
        expect(channel).toBeDefined();
    });
    it('should list all channels', () => {
        const manager = new ChannelManager();
        const channels = manager.getAll();
        expect(Array.isArray(channels)).toBe(true);
    });
});
//# sourceMappingURL=channel.test.js.map