import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GatewayServer } from '@skyalyticwing/core/gateway/index.js';
const TEST_PORT = 19876;
let server;
describe('Gateway E2E', () => {
    beforeAll(async () => {
        server = new GatewayServer({
            port: TEST_PORT,
            host: '127.0.0.1',
            auth: { mode: 'none' },
        });
        await server.start();
    });
    afterAll(async () => {
        await server.stop();
    });
    it('should respond to health check', async () => {
        const res = await fetch(`http://127.0.0.1:${TEST_PORT}/api/health`);
        expect(res.ok).toBe(true);
        const data = await res.json();
        expect(data).toHaveProperty('status');
    });
    it('should list agents', async () => {
        const res = await fetch(`http://127.0.0.1:${TEST_PORT}/api/agents`);
        expect(res.ok).toBe(true);
        const data = await res.json();
        expect(Array.isArray(data)).toBe(true);
    });
    it('should list tools', async () => {
        const res = await fetch(`http://127.0.0.1:${TEST_PORT}/api/tools`);
        expect(res.ok).toBe(true);
        const data = await res.json();
        expect(Array.isArray(data)).toBe(true);
    });
    it('should list channels', async () => {
        const res = await fetch(`http://127.0.0.1:${TEST_PORT}/api/channels`);
        expect(res.ok).toBe(true);
        const data = await res.json();
        expect(Array.isArray(data)).toBe(true);
    });
    it('should list providers', async () => {
        const res = await fetch(`http://127.0.0.1:${TEST_PORT}/api/providers`);
        expect(res.ok).toBe(true);
        const data = await res.json();
        expect(Array.isArray(data)).toBe(true);
    });
    it('should accept chat messages', async () => {
        const res = await fetch(`http://127.0.0.1:${TEST_PORT}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: 'Hello' }),
        });
        expect(res.ok).toBe(true);
    });
    it('should get configuration', async () => {
        const res = await fetch(`http://127.0.0.1:${TEST_PORT}/api/config`);
        expect(res.ok).toBe(true);
    });
    it('should update configuration', async () => {
        const res = await fetch(`http://127.0.0.1:${TEST_PORT}/api/config`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ permissionMode: 'ask' }),
        });
        expect(res.ok).toBe(true);
    });
});
//# sourceMappingURL=gateway.e2e.js.map