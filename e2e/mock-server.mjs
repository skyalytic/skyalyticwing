// E2E mock 后端：浏览器级端到端测试的基础设施（纯 Node，无构建步骤）
//
// 职责：
//   1. 静态托管 packages/frontend/dist（真实前端产物）
//   2. Mock 全部 /api/* REST 端点（sessions / chat/send / approvals / 兜底 200）
//   3. 在同端口提供真实 WebSocket（/ws），可主动推送 chat_message / approval_request 等事件
//   4. 测试控制端点（仅测试使用）：
//        POST /api/__e2e/push     body { type, data } → 向所有 WS 客户端广播事件
//        GET  /api/__e2e/requests → 返回已捕获的 REST 请求列表（method/path/body）
//        DEL  /api/__e2e/requests → 清空捕获列表
//
// 启动：node mock-server.mjs （端口 env E2E_PORT，默认 9199；健康检查 GET /healthz）

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { WebSocketServer } from 'ws';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIST = join(__dirname, '..', 'packages', 'frontend', 'dist');
const PORT = parseInt(process.env.E2E_PORT || '9199', 10);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/** 已捕获的 REST 请求（供测试断言，如审批决策） */
const capturedRequests = [];
const pendingApprovals = new Map();
const sessions = new Map();
const transcripts = new Map();

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);
  const path = url.pathname;

  const sendJson = (status, payload) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(payload));
  };
  const readBody = () =>
    new Promise((resolve) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        try {
          resolve(raw ? JSON.parse(raw) : null);
        } catch {
          resolve(raw);
        }
      });
    });

  // ---- 健康检查（Playwright webServer 就绪探测） ----
  if (path === '/healthz') {
    return sendJson(200, { ok: true });
  }

  // ---- 测试控制端点 ----
  if (path === '/api/__e2e/push' && req.method === 'POST') {
    const body = await readBody();
    if (body?.type === 'approval_request') pendingApprovals.set(body.data.id, body.data);
    broadcast({ timestamp: Date.now(), ...body });
    return sendJson(200, { success: true, data: { pushed: true } });
  }
  if (path === '/api/__e2e/requests' && req.method === 'GET') {
    return sendJson(200, { success: true, data: capturedRequests });
  }
  if (path === '/api/__e2e/requests' && req.method === 'DELETE') {
    capturedRequests.length = 0;
    pendingApprovals.clear();
    sessions.clear();
    transcripts.clear();
    return sendJson(200, { success: true, data: { cleared: true } });
  }

  // ---- REST API mock ----
  if (path === '/api/auth/capabilities') {
    return sendJson(200, { mode: 'legacy', smsConfigured: false, website: 'https://skyalytic.com' });
  }
  if (path.startsWith('/api/')) {
    const body = await readBody();
    capturedRequests.push({ method: req.method, path, body, at: Date.now() });

    // 创建会话
    if (path === '/api/sessions' && req.method === 'POST') {
      const session = { id: `sess-e2e-${sessions.size + 1}`, title: 'E2E 会话', createdAt: Date.now(), updatedAt: Date.now(), messageCount: 0 };
      sessions.set(session.id, session);
      transcripts.set(session.id, []);
      return sendJson(200, {
        success: true,
        data: session,
      });
    }

    // 发送聊天消息：经 WS 推回助手回复后返回成功
    if (path === '/api/chat/send' && req.method === 'POST') {
      const sessionId = body?.session || 'api';
      const history = transcripts.get(sessionId) || [];
      const turnId = body.turnId || `turn-e2e-${history.length}`;
      const message = { id: `${turnId}:assistant`, sessionId, turnId, turnSequence: 1, role: 'assistant',
        content: '收到！这是 E2E-MOCK 后端的自动回复内容。', timestamp: Date.now() };
      history.push({ id: `${turnId}:user`, sessionId, turnId, turnSequence: 0, role: 'user', content: body.message, timestamp: Date.now() }, message);
      transcripts.set(sessionId, history);
      if (sessions.has(sessionId)) sessions.get(sessionId).messageCount = history.length;
      broadcast({
        type: 'chat_message',
        timestamp: Date.now(),
        data: message,
      });
      return sendJson(200, { success: true, data: { message } });
    }

    // 审批决策：记录后经 WS 推回工具执行结果
    const approvalMatch = path.match(/^\/api\/approvals\/([^/]+)$/);
    if (approvalMatch && req.method === 'POST') {
      const approved = body?.decision === 'allow-once' || body?.decision === 'allow-always';
      broadcast({
        type: 'chat_message',
        timestamp: Date.now(),
        data: {
          id: 'msg-tool-result-e2e',
          sessionId: pendingApprovals.get(approvalMatch[1])?.sessionId,
          role: 'assistant',
          content: approved
            ? '审批已通过：工具 bash 已执行完成（E2E-MOCK 结果）。'
            : '审批已拒绝：工具 bash 未执行（E2E-MOCK 结果）。',
          timestamp: Date.now(),
        },
      });
      return sendJson(200, { success: true, data: { id: approvalMatch[1], decision: body?.decision } });
    }

    if (path === '/api/approvals/history' && req.method === 'GET') {
      return sendJson(200, { success: true, data: { approvals: [] } });
    }

    if (path === '/api/sessions' && req.method === 'GET') return sendJson(200, { success: true, data: [...sessions.values()] });
    const messagesMatch = path.match(/^\/api\/sessions\/([^/]+)\/messages$/);
    if (messagesMatch && req.method === 'GET') return sendJson(200, { success: true, data: transcripts.get(decodeURIComponent(messagesMatch[1])) || [] });

    if (req.method === 'GET' && [
      '/api/sessions', '/api/agents', '/api/tools', '/api/channels', '/api/cron',
      '/api/plugins', '/api/bindings', '/api/tool-policies', '/api/background-tasks', '/api/files/projects',
      '/api/tools/ask-user/pending',
    ].includes(path)) {
      return sendJson(200, { success: true, data: [] });
    }
    if (req.method === 'GET' && (path.startsWith('/api/chat/history/') || /\/messages$/.test(path))) {
      return sendJson(200, { success: true, data: [] });
    }
    if (path === '/api/remote-workspaces' && req.method === 'GET') return sendJson(200, { success: true, data: { workspaces: [], bound: null } });
    if (path === '/api/models') return sendJson(200, { success: true, data: { models: [] } });
    if (path === '/api/sessions/recovery') return sendJson(200, {success:true,data:null});
    if (path === '/api/providers') return sendJson(200, { success: true, data: { providers: [] } });
    if (path === '/api/approvals') return sendJson(200, { success: true, data: { approvals: [] } });

    // 兜底：其余 /api/* 一律返回空成功，避免前端加载报错
    return sendJson(200, { success: true, data: {} });
  }

  // ---- 静态资源（SPA 回退到 index.html） ----
  let filePath = normalize(join(FRONTEND_DIST, path === '/' ? 'index.html' : path));
  if (!filePath.startsWith(FRONTEND_DIST)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  try {
    const st = await stat(filePath).catch(() => null);
    if (!st || !st.isFile()) filePath = join(FRONTEND_DIST, 'index.html'); // SPA 路由回退
    const content = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] || 'application/octet-stream' });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end('frontend dist not found — run: pnpm --filter @skyalyticwing/frontend build');
  }
});

// ---- WebSocket（与生产网关同路径 /ws） ----
const wss = new WebSocketServer({ server, path: '/ws' });

function broadcast(event) {
  const msg = JSON.stringify(event);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(msg);
  }
}

wss.on('connection', (socket) => {
  socket.send(JSON.stringify({ type: 'connected', timestamp: Date.now(), clientId: 'e2e-mock' }));
  // 忽略客户端文本层 ping（前端不依赖 pong 维持连接）
  socket.on('message', () => {});
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[e2e-mock] listening on http://127.0.0.1:${PORT} (frontend: ${FRONTEND_DIST})`);
});
