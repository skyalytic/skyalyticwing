import { Hono } from 'hono';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import type { AppConfig } from '../types/index.js';
import { createLogger, type Logger } from '@skyalyticwing/shared';

export interface GatewayOptions {
  config: AppConfig;
  logger?: Logger;
}

export class Gateway {
  private app: Hono;
  private server: Server | null = null;
  private wsServer: WebSocketServer | null = null;
  private logger: Logger;
  private config: AppConfig;
  private clients: Set<WebSocket> = new Set();

  constructor(options: GatewayOptions) {
    this.config = options.config;
    this.logger = options.logger ?? createLogger({ name: 'gateway' });
    this.app = new Hono();
    this.setupRoutes();
  }

  private setupRoutes(): void {
    // Security response headers
    this.app.use('*', async (c, next) => {
      await next();
      c.header('X-Content-Type-Options', 'nosniff');
      c.header('X-Frame-Options', 'DENY');
      c.header('X-XSS-Protection', '1; mode=block');
      c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    });

    // Auth middleware
    this.app.use('/api/*', async (c, next) => {
      const authConfig = this.config.auth;
      if (!authConfig || authConfig.mode === 'none') {
        return next();
      }
      if (authConfig.mode === 'token') {
        if (!authConfig.token) {
          this.logger.error('Token authentication is enabled but no token is configured');
          return c.json({ error: 'Authentication is not configured' }, 503);
        }
        const authHeader = c.req.header('Authorization');
        if (!authHeader?.startsWith('Bearer ')) {
          return c.json({ error: 'Unauthorized' }, 401);
        }
        const token = authHeader.slice(7);
        const tokenBuf = Buffer.from(token);
        const authBuf = Buffer.from(authConfig.token);
        if (tokenBuf.length !== authBuf.length || !timingSafeEqual(tokenBuf, authBuf)) {
          return c.json({ error: 'Unauthorized' }, 401);
        }
      }
      if (authConfig.mode === 'password') {
        const authHeader = c.req.header('Authorization');
        if (!authHeader || !authHeader.startsWith('Basic ')) {
          return c.json({ error: 'Unauthorized' }, 401);
        }
        const credentials = Buffer.from(authHeader.substring(6), 'base64').toString();
        const colonIndex = credentials.indexOf(':');
        if (colonIndex === -1) {
          return c.json({ error: 'Unauthorized' }, 401);
        }
        const username = credentials.substring(0, colonIndex);
        const password = credentials.substring(colonIndex + 1);
        const userMatch = authConfig.username && username.length === authConfig.username.length &&
          timingSafeEqual(Buffer.from(username), Buffer.from(authConfig.username));
        const passMatch = authConfig.password && password.length === authConfig.password.length &&
          timingSafeEqual(Buffer.from(password), Buffer.from(authConfig.password));
        if (!userMatch || !passMatch) {
          return c.json({ error: 'Unauthorized' }, 401);
        }
      }
      return next();
    });

    // TS-3 fix: POST /shutdown route for CLI gateway stop
    this.app.post('/shutdown', (c) => {
      this.logger.info('Shutdown requested via HTTP');
      setTimeout(() => { void this.stop(); }, 100);
      return c.json({ status: 'shutting down' });
    });

    this.app.get('/health', (c) => c.json({ status: 'ok' }));
    this.app.get('/healthz', (c) => c.json({ status: 'ok' }));
    this.app.get('/readyz', (c) => c.json({ ready: true }));
    this.app.get('/api/status', (c) => c.json({
      version: '1.1.0',
      uptime: process.uptime(),
      gateway: { port: this.config.gateway.port, host: this.config.gateway.host },
    }));
    this.app.get('/api/config', (c) => {
      const safeConfig = JSON.parse(JSON.stringify(this.config));
      if (safeConfig.auth?.token) safeConfig.auth.token = '***';
      if (safeConfig.auth?.password) safeConfig.auth.password = '***';
      if (safeConfig.auth?.username) safeConfig.auth.username = '***';
      if (safeConfig.database?.url) {
        try {
          const url = new URL(safeConfig.database.url);
          if (url.password) {
            url.password = '***';
            safeConfig.database.url = url.toString();
          }
        } catch {}
      }
      if (safeConfig.channels) {
        for (const ch of safeConfig.channels) {
          if (ch.config) this._sanitizeChannelConfigRecursive(ch.config);
        }
      }
      if (safeConfig.models) {
        for (const m of safeConfig.models) {
          if (m.apiKey) m.apiKey = '***';
        }
      }
      // TS-10 fix: mask gateway.tls.key
      if (safeConfig.gateway?.tls?.key) safeConfig.gateway.tls.key = '***';
      return c.json(safeConfig);
    });
    this.app.post('/api/chat', async (c) => {
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: 'invalid JSON body' }, 400);
      }
      if (!body || typeof body !== 'object') {
        return c.json({ error: 'message is required' }, 400);
      }
      const b = body as { message?: unknown };
      if (!b.message || typeof b.message !== 'string') {
        return c.json({ error: 'message is required' }, 400);
      }
      if (b.message.length > 100000) {
        return c.json({ error: 'message too long' }, 413);
      }
      return c.json({ message: 'Chat endpoint accepted', received: true });
    });
    this.app.get('/api/agents', (c) => c.json(this.config.agents));
    this.app.get('/api/channels', (c) => {
      const safeChannels = JSON.parse(JSON.stringify(this.config.channels || []));
      for (const ch of safeChannels) {
        if (ch.config) this._sanitizeChannelConfigRecursive(ch.config);
      }
      return c.json(safeChannels);
    });
  }

  private _sanitizeChannelConfigRecursive(config: unknown): void {
    if (config === null || typeof config !== 'object') return;
    if (Array.isArray(config)) {
      for (const item of config) {
        this._sanitizeChannelConfigRecursive(item);
      }
      return;
    }
    const obj = config as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      if (/token|secret|key|password|appSecret/i.test(key)) {
        obj[key] = '***';
      } else if (obj[key] !== null && typeof obj[key] === 'object') {
        this._sanitizeChannelConfigRecursive(obj[key]);
      }
    }
  }

  async start(): Promise<void> {
    const { port, host } = this.config.gateway;
    this.server = createServer();

    this.server.on('request', (req, res) => {
      const chunks: Buffer[] = [];
      const MAX_BODY_SIZE = 10 * 1024 * 1024;
      let bodySize = 0;
      let bodyExceeded = false;
      req.on('data', (chunk: Buffer) => {
        bodySize += chunk.length;
        if (bodySize > MAX_BODY_SIZE) {
          bodyExceeded = true;
          if (!res.headersSent) { res.statusCode = 413; res.end('Payload Too Large'); }
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('error', (err) => {
        this.logger.error({ error: err }, 'Request stream error');
        if (!res.headersSent) {
          res.statusCode = 400;
          res.end('Bad Request');
        } else {
          res.destroy();
        }
      });
      req.on('end', async () => {
        if (bodyExceeded) return;
        const body = Buffer.concat(chunks);
        const url = `http://${host}:${port}${req.url}`;
        const headers = Object.entries(req.headers).reduce<Record<string, string>>((acc, [k, v]) => {
          if (v) acc[k] = Array.isArray(v) ? v.join(', ') : v;
          return acc;
        }, {});
        const init: RequestInit = {
          // TS-11 fix: cast req.method to string for exactOptionalPropertyTypes
          method: req.method as string,
          headers,
        };
        if (req.method !== 'GET' && req.method !== 'HEAD' && body.length > 0) {
          init.body = body;
        }
        try {
          const response = await this.app.fetch(new Request(url, init));
          res.statusCode = response.status;
          response.headers.forEach((value, key) => res.setHeader(key, value));
          const buf = await response.arrayBuffer();
          res.end(Buffer.from(buf));
        } catch (error) {
          this.logger.error({ error }, 'Request handler error');
          if (!res.headersSent) {
            res.statusCode = 500;
            res.end('Internal Server Error');
          } else {
            res.destroy();
          }
        }
      });
    });

    this.wsServer = new WebSocketServer({
      server: this.server,
      path: '/ws',
      maxPayload: 10 * 1024 * 1024,
      verifyClient: (info, callback) => {
        // TS-16 fix: require Origin header, reject missing Origin (CSWSH protection)
        const origin = info.req.headers.origin;
        if (!origin) {
          this.logger.warn('WebSocket connection rejected: missing Origin header');
          callback(false, 403, 'Forbidden');
          return;
        }
        const allowedOrigins = [
          `http://127.0.0.1:${this.port}`,
          `http://localhost:${this.port}`,
          `http://${this.config.gateway.host}:${this.port}`,
        ];
        if (!allowedOrigins.includes(origin)) {
          this.logger.warn({ origin }, 'WebSocket connection rejected: invalid origin');
          callback(false, 403, 'Forbidden');
          return;
        }
        callback(true);
      }
    });

    this.wsServer.on('connection', (ws, req) => {
      if (this.config.auth && this.config.auth.mode === 'token') {
        if (!this.config.auth.token) {
          this.logger.error('Token authentication is enabled but no token is configured');
          ws.close(4001, 'Authentication is not configured');
          return;
        } else {
          const url = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
          const token = url.searchParams.get('token') ||
                        (req.headers['sec-websocket-protocol'] as string) ||
                        req.headers.authorization?.replace('Bearer ', '');
          const wsTokenBuf = Buffer.from(token || '');
          const wsAuthBuf = Buffer.from(this.config.auth.token);
          if (!token || wsTokenBuf.length !== wsAuthBuf.length ||
              !timingSafeEqual(wsTokenBuf, wsAuthBuf)) {
            this.logger.warn('WebSocket connection rejected: unauthorized');
            ws.close(4001, 'Unauthorized');
            return;
          }
        }
      }
      if (this.config.auth && this.config.auth.mode === 'password') {
        const authHeader = req.headers.authorization || '';
        if (!authHeader.startsWith('Basic ')) {
          ws.close(4001, 'Unauthorized');
          this.logger.warn('WebSocket connection rejected: no Basic auth');
          return;
        }
        try {
          const credentials = Buffer.from(authHeader.substring(6), 'base64').toString();
          const colonIndex = credentials.indexOf(':');
          if (colonIndex === -1) {
            ws.close(4001, 'Unauthorized');
            this.logger.warn('WebSocket connection rejected: invalid credentials format');
            return;
          }
          const username = credentials.substring(0, colonIndex);
          const password = credentials.substring(colonIndex + 1);
          const userMatch = this.config.auth.username && username.length === this.config.auth.username.length &&
            timingSafeEqual(Buffer.from(username), Buffer.from(this.config.auth.username));
          const passMatch = this.config.auth.password && password.length === this.config.auth.password.length &&
            timingSafeEqual(Buffer.from(password), Buffer.from(this.config.auth.password));
          if (!userMatch || !passMatch) {
            ws.close(4001, 'Unauthorized');
            this.logger.warn('WebSocket connection rejected: invalid credentials');
            return;
          }
        } catch {
          ws.close(4001, 'Unauthorized');
          return;
        }
      }
      this.clients.add(ws);
      this.logger.info('WebSocket client connected');
      ws.on('error', (err) => {
        this.logger.error({ error: err }, 'WebSocket error');
        this.clients.delete(ws);
      });
      ws.on('close', () => {
        this.clients.delete(ws);
        this.logger.info('WebSocket client disconnected');
      });
      ws.on('message', (data) => {
        const str = typeof data === 'string'
          ? data
          : Buffer.isBuffer(data)
            ? data.toString()
            : Array.isArray(data)
              ? Buffer.concat(data).toString()
              : Buffer.from(data).toString();
        this.handleWsMessage(ws, str);
      });
    });

    return new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(port, host, () => {
        this.server!.off('error', reject);
        this.server!.on('error', (err) => {
          this.logger.error({ error: err }, 'Gateway server runtime error');
        });
        this.logger.info(`Gateway started on ${host}:${this.port}`);
        resolve();
      });
    });
  }

  private handleWsMessage(ws: WebSocket, data: string): void {
    try {
      const message = JSON.parse(data);
      this.logger.debug({ type: message.type }, 'WebSocket message received');
      const allowedClientTypes = ['ping', 'chat_input', 'channel_command'];
      if (!message.type || !allowedClientTypes.includes(message.type)) {
        return;
      }
      for (const client of this.clients) {
        if (client !== ws && client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify(message));
        }
      }
    } catch {
      this.logger.warn('Invalid WebSocket message');
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
      }
    }
  }

  broadcast(message: unknown): void {
    const data = JSON.stringify(message);
    const MAX_BROADCAST_SIZE = 10 * 1024 * 1024;
    if (data.length > MAX_BROADCAST_SIZE) {
      this.logger.warn({ size: data.length, max: MAX_BROADCAST_SIZE }, 'Broadcast message exceeds max size, dropping');
      return;
    }
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        // TS-15 fix: wrap client.send in try/catch to prevent crash on send failure
        try {
          client.send(data);
        } catch (err) {
          this.logger.error({ error: err }, 'Failed to broadcast to client, removing');
          this.clients.delete(client);
        }
      }
    }
  }

  async stop(): Promise<void> {
    // TS-1 fix: do NOT clear this.clients before the timeout Promise.
    // Original code cleared clients before the Promise, so the 5s timeout callback
    // iterated an empty set and terminate() was never called.
    // Now we only close clients (ws close event handler removes them individually),
    // and the timeout callback can still access unclosed clients to force terminate.
    for (const client of this.clients) {
      try { client.close(); } catch { /* ignore close errors */ }
    }

    await new Promise<void>((resolve) => {
      if (!this.wsServer) {
        resolve();
        return;
      }
      let settled = false;
      const forceTimeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.logger.warn('Forcing WebSocket server close after 5s timeout');
        // TS-1 fix: this.clients not cleared early, can access unclosed clients here
        for (const client of this.clients) {
          try { client.terminate(); } catch { /* ignore */ }
        }
        this.clients.clear();
        resolve();
      }, 5000);
      this.wsServer.close(() => {
        if (settled) return;
        settled = true;
        clearTimeout(forceTimeout);
        resolve();
      });
    });

    await new Promise<void>((resolve) => {
      const forceTimeout = setTimeout(() => {
        this.logger.warn('Forcing server close after timeout');
        resolve();
      }, 5000);
      if (this.server) {
        this.server.close(() => {
          clearTimeout(forceTimeout);
          this.logger.info('Gateway stopped');
          resolve();
        });
      } else {
        clearTimeout(forceTimeout);
        resolve();
      }
    });
  }

  get port(): number {
    const address = this.server?.address();
    return address && typeof address === 'object' ? address.port : this.config.gateway.port;
  }
}
