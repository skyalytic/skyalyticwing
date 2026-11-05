import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Gateway } from '@skyalyticwing/core/gateway';
import { loadConfig } from '@skyalyticwing/core/config';

let TEST_PORT: number;
let gateway: Gateway;

describe('Gateway Integration Tests', () => {
  beforeAll(async () => {
    const config = loadConfig('./config/default.yaml');
    config.gateway.port = 0;
    config.gateway.host = '127.0.0.1';
    config.auth.mode = 'none';
    gateway = new Gateway({ config });
    await gateway.start();
    TEST_PORT = gateway.port;
  });

  afterAll(async () => {
    await gateway.stop();
  });

  it('should start and stop gateway', () => {
    expect(gateway).toBeDefined();
    expect(gateway.port).toBe(TEST_PORT);
    expect(TEST_PORT).toBeGreaterThan(0);
  });

  it('should respond to health check', async () => {
    const res = await fetch(`http://127.0.0.1:${TEST_PORT}/health`);
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(data.status).toBe('ok');
  });

  it('should respond to readyz check', async () => {
    const res = await fetch(`http://127.0.0.1:${TEST_PORT}/readyz`);
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(data.ready).toBe(true);
  });

  it('should accept WebSocket connections', async () => {
    const WebSocket = (await import('ws')).default;
    const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/ws`, {
      origin: `http://127.0.0.1:${TEST_PORT}`,
    });

    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
    });

    ws.close();
  });

  it('should handle chat messages', async () => {
    const res = await fetch(`http://127.0.0.1:${TEST_PORT}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Hello' }),
    });
    expect(res.ok).toBe(true);
  });

  it('should list agents', async () => {
    const res = await fetch(`http://127.0.0.1:${TEST_PORT}/api/agents`);
    expect(res.ok).toBe(true);
  });

  it('should list channels', async () => {
    const res = await fetch(`http://127.0.0.1:${TEST_PORT}/api/channels`);
    expect(res.ok).toBe(true);
  });
});
