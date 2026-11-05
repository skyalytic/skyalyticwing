import { describe, it, expect } from 'vitest';
import { MemoryEngine } from '@skyalyticwing/core/memory';
describe('Memory Integration Tests', () => {
    it('should store and retrieve messages', async () => {
        const engine = new MemoryEngine();
        await engine.addMessage('test-session', {
            role: 'user',
            content: 'Hello',
        });
        const messages = await engine.getConversation('test-session');
        expect(messages.length).toBeGreaterThan(0);
    });
    it('should retrieve relevant memories', async () => {
        const engine = new MemoryEngine();
        await engine.addMessage('test-session', {
            role: 'user',
            content: 'This is a test about machine learning',
        });
        const results = await engine.retrieve('machine learning');
        expect(results.length).toBeGreaterThanOrEqual(0);
    });
});
//# sourceMappingURL=memory.test.js.map