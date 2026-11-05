import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Gateway } from '@skyalyticwing/core/gateway';
import { loadConfig } from '@skyalyticwing/core/config';

const TEST_PORT = 19876;
let server: Gateway;

describe('Gateway E2E', () => {
  beforeAll(async () => {
    const config = loadConfig('./config/default.yaml');
    config.gateway.port = TEST_PORT;
    config.gateway.host = '127.0.0.1';
    config.auth.mode = 'none';
    server = new Gateway({ config });
    await server.start();
  });

  afterAll(async () => {
    await server.stop();
  });

  it('should respond to health check', async () => {
    const res = await fetch(`http://127.0.0.1:${TEST_PORT}/health`);
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(data).toHaveProperty('status');
  });

  it('should respond to healthz check', async () => {
    const res = await fetch(`http://127.0.0.1:${TEST_PORT}/healthz`);
    expect(res.ok).toBe(true);
  });

  it('should respond to readyz check', async () => {
    const res = await fetch(`http://127.0.0.1:${TEST_PORT}/readyz`);
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

  it('should get config', async () => {
    const res = await fetch(`http://127.0.0.1:${TEST_PORT}/api/config`);
    expect(res.ok).toBe(true);
  });

  it('should accept chat messages', async () => {
    const res = await fetch(`http://127.0.0.1:${TEST_PORT}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Hello' }),
    });
    expect(res.ok).toBe(true);
  });
});
