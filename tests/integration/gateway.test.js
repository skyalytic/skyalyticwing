import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GatewayServer } from '@skyalyticwing/core/gateway';
describe('Gateway Integration Tests', () => {
    let gateway;
    beforeAll(async () => {
        gateway = new GatewayServer({
            port: 18790,
            host: '127.0.0.1',
        });
        await gateway.start();
    });
    afterAll(async () => {
        await gateway.stop();
    });
    it('should start and stop gateway', () => {
        expect(gateway).toBeDefined();
    });
    it('should accept WebSocket connections', async () => {
        const WebSocket = (await import('ws')).default;
        const ws = new WebSocket('ws://127.0.0.1:18790');
        await new Promise((resolve, reject) => {
            ws.on('open', resolve);
            ws.on('error', reject);
        });
        ws.close();
    });
    it('should handle authentication', async () => {
        const WebSocket = (await import('ws')).default;
        const ws = new WebSocket('ws://127.0.0.1:18790');
        await new Promise((resolve) => {
            ws.on('open', () => {
                ws.send(JSON.stringify({
                    type: 'auth',
                    payload: { token: 'test-token' },
                }));
                resolve(undefined);
            });
        });
        ws.close();
    });
});
//# sourceMappingURL=gateway.test.js.map