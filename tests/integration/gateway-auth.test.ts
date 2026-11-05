import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { Gateway } from '../../packages/core/src/gateway/index.js';
import { loadConfig } from '../../packages/core/src/config/index.js';

describe('gateway token authentication', () => {
  const gateways: Gateway[] = [];
  afterEach(async () => { await Promise.all(gateways.splice(0).map(gateway => gateway.stop())); });
  async function start(token?: string) {
    const config = loadConfig('./config/default.yaml');
    config.gateway.host = '127.0.0.1';
    config.gateway.port = 0;
    config.auth.mode = 'token';
    if (token === undefined) delete config.auth.token;
    else config.auth.token = token;
    const gateway = new Gateway({ config });
    gateways.push(gateway);
    await gateway.start();
    return gateway;
  }

  it('rejects protected HTTP requests when token mode has no configured token', async () => {
    const gateway = await start();
    const response = await fetch(`http://127.0.0.1:${gateway.port}/api/agents`);
    expect(response.status).toBe(503);
  });

  it('closes WebSocket connections when token mode has no configured token', async () => {
    const gateway = await start();
    const ws = new WebSocket(`ws://127.0.0.1:${gateway.port}/ws`, { origin: `http://127.0.0.1:${gateway.port}` });
    const result = await new Promise<number>((resolve, reject) => {
      ws.once('error', reject);
      ws.once('close', resolve);
    });
    expect(result).toBe(4001);
  });

  it('accepts the configured token and rejects missing or wrong credentials', async () => {
    const gateway = await start('isolated-test-token');
    const url = `http://127.0.0.1:${gateway.port}/api/agents`;
    expect((await fetch(url)).status).toBe(401);
    expect((await fetch(url, { headers: { Authorization: 'Bearer wrong' } })).status).toBe(401);
    expect((await fetch(url, { headers: { Authorization: 'Bearer isolated-test-token' } })).status).toBe(200);
  });

  it('runs independent gateways without a shared fixed port', async () => {
    const [first, second] = await Promise.all([start('first'), start('second')]);
    expect(first.port).not.toBe(second.port);
    expect(first.port).toBeGreaterThan(0);
    expect(second.port).toBeGreaterThan(0);
  });
});
