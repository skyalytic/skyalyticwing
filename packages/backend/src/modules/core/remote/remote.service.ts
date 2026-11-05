import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import * as http from 'node:http';
import { randomBytes } from 'node:crypto';
import { LoggerService } from '../logger/logger.service.js';
import type { RegisterNodeDto } from './dto/remote.dto.js';

/**
 * RemoteService - 分布式远程节点系统（AG-006）
 *
 * 移植自 start.cjs RemoteAgentSystem：
 *   - 节点注册（SSRF 防护：拒绝内网地址）
 *   - 30s 心跳探测（/api/health），超时 120s 判定离线
 *   - 任务分派（POST /api/remote/task，Bearer authKey 认证）
 *   - 响应 sanitize：authKey 在列表/详情中脱敏
 */

/** 远程节点（内部完整形态） */
interface RemoteNode {
  id: string;
  name: string;
  host: string;
  port: number;
  status: 'active' | 'offline' | 'disconnected';
  capabilities: string[];
  authKey: string;
  lastHeartbeat: number;
  tasksCompleted: number;
  load: number;
}

/** 远程节点（对外脱敏形态） */
export type SanitizedRemoteNode = Omit<RemoteNode, 'authKey'>;

/** 心跳间隔（ms） */
const HEARTBEAT_INTERVAL = 30_000;
/** 心跳超时（ms） */
const HEARTBEAT_TIMEOUT = 120_000;
/** 分派超时（ms） */
const DISPATCH_TIMEOUT = 30_000;

@Injectable()
export class RemoteService implements OnModuleInit, OnModuleDestroy {
  private nodes: RemoteNode[] = [];
  private registry: Record<string, RemoteNode> = {};
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private readonly requests = new Map<http.ClientRequest, string>();
  private stopping = false;

  constructor(private readonly logger: LoggerService) {}

  onModuleInit(): void {
    this.stopping = false;
    this.heartbeatTimer = setInterval(() => this.checkHeartbeats(), HEARTBEAT_INTERVAL);
    this.logger.info('remote: 心跳监控已启动（30s 间隔）');
  }

  onModuleDestroy(): void {
    this.stopping = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    for (const request of this.requests.keys()) request.destroy(new Error('Remote service stopped'));
    this.requests.clear();
  }
  private track(request: http.ClientRequest, nodeId: string, timeout: number): void {
    this.requests.set(request, nodeId);
    const timer = setTimeout(() => request.destroy(new Error('Remote request timed out')), timeout);
    timer.unref();
    request.once('close', () => {clearTimeout(timer);this.requests.delete(request);});
  }
  private cancelNodeRequests(nodeId: string): void {
    for(const [request,id] of this.requests) if(id===nodeId)request.destroy(new Error('Remote node disconnected'));
  }

  /**
   * 注册节点（含 SSRF 防护：拒绝内网 / 环回地址）
   * 返回完整节点（含 authKey，仅注册时下发一次）；重复地址返回已有节点。
   */
  registerNode(dto: RegisterNodeDto): RemoteNode | { error: string } {
    const host = dto.host ?? '';
    if (
      /^(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|0\.|169\.254\.|::1|localhost)/i.test(host)
    ) {
      this.logger.warn(`remote: SSRF 防护，拒绝注册内网节点 ${host}`);
      return { error: `SSRF check failed: 拒绝内网节点 ${host}` };
    }
    const existing = this.nodes.find((n) => n.host === host && n.port === dto.port);
    if (existing) return existing;
    const node: RemoteNode = {
      id: dto.id && dto.id.length > 0 ? dto.id : `node-${Date.now()}`,
      name: dto.name && dto.name.length > 0 ? dto.name : 'RemoteNode',
      host,
      port: dto.port,
      status: 'active',
      capabilities: dto.capabilities && dto.capabilities.length > 0 ? dto.capabilities : ['chat', 'tool_use'],
      authKey: randomBytes(32).toString('hex'),
      lastHeartbeat: Date.now(),
      tasksCompleted: 0,
      load: 0,
    };
    this.nodes.push(node);
    this.registry[node.id] = node;
    this.pingNode(node);
    this.logger.info(`remote: 节点已注册 ${node.name}（${node.host}:${node.port}）`);
    return node;
  }

  /** 节点列表（脱敏） */
  listNodes(): Array<Record<string, unknown>> {
    return this.nodes.map((n) => ({
      id: n.id,
      name: n.name,
      host: `${n.host}:${n.port}`,
      status: n.status,
      load: n.load,
      tasksCompleted: n.tasksCompleted,
      capabilities: n.capabilities,
    }));
  }

  /** 节点详情（脱敏） */
  getNodeStatus(nodeId: string): SanitizedRemoteNode | null {
    const node = this.registry[nodeId];
    if (!node) return null;
    const { authKey: _authKey, ...sanitized } = node;
    return sanitized;
  }

  /** 移除节点（节点不存在时返回失败，不再假成功） */
  removeNode(nodeId: string): { success: true } | { success: false; error: string } {
    this.cancelNodeRequests(nodeId);
    const existed = !!this.registry[nodeId];
    this.nodes = this.nodes.filter((n) => n.id !== nodeId);
    delete this.registry[nodeId];
    if (!existed) {
      this.logger.warn(`remote: 移除节点失败，节点不存在 ${nodeId}`);
      return { success: false, error: 'Node not found' };
    }
    this.logger.info(`remote: 节点已移除 ${nodeId}`);
    return { success: true };
  }

  /**
   * 连接节点：标记为 active（已连接）并初始化连接资源
   * （刷新心跳时间 + 立即探测 /api/health，探测结果会回写节点状态）。
   */
  connectNode(nodeId: string): { success: true; node: SanitizedRemoteNode } | { success: false; error: string } {
    const node = this.registry[nodeId];
    if (!node) return { success: false, error: 'Node not found' };
    node.status = 'active';
    node.lastHeartbeat = Date.now();
    this.pingNode(node);
    this.logger.info(`remote: 节点已连接 ${node.name}`);
    const { authKey: _authKey, ...sanitized } = node;
    return { success: true, node: sanitized };
  }

  /**
   * 断开节点：标记为 disconnected 并释放连接资源
   * （disconnected 节点不再参与心跳巡检，也无法接收任务分派；
   * 重新 connect 可恢复）。
   */
  disconnectNode(nodeId: string): { success: true } | { success: false; error: string } {
    const node = this.registry[nodeId];
    if (!node) return { success: false, error: 'Node not found' };
    node.status = 'disconnected';
    this.cancelNodeRequests(nodeId);
    this.logger.info(`remote: 节点已断开 ${node.name}`);
    return { success: true };
  }

  /** 统计 */
  getStats(): { totalNodes: number; activeNodes: number; nodes: Array<Record<string, unknown>> } {
    return {
      totalNodes: this.nodes.length,
      activeNodes: this.nodes.filter((n) => n.status === 'active').length,
      nodes: this.listNodes(),
    };
  }

  /** 分派任务到节点 */
  dispatchToRemote(
    nodeId: string,
    task: unknown,
  ): Promise<{ success: true; taskId: string; nodeId: string; result: unknown } | { success: false; error: string; taskId?: string }> {
    const node = this.registry[nodeId];
    if (this.stopping) return Promise.resolve({ success:false, error:'Remote service stopped' });
    if (!node) return Promise.resolve({ success: false, error: 'Node not found' });
    if (node.status !== 'active') return Promise.resolve({ success: false, error: 'Node not active' });

    const taskId = `rtask-${Date.now()}`;
    this.logger.info(`remote: 分派任务 ${taskId} 到节点 ${node.name}`);
    const postData = JSON.stringify({ type: 'task', id: taskId, task, timestamp: Date.now() });

    return new Promise((resolve) => {
      try {
        const req = http.request(
          {
            hostname: node.host,
            port: node.port,
            path: '/api/remote/task',
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${node.authKey}`,
              'Content-Length': Buffer.byteLength(postData),
            },
          },
          (res) => {
            if(!res.statusCode || res.statusCode<200 || res.statusCode>=300){res.resume();resolve({success:false,error:'Remote HTTP '+res.statusCode,taskId});return;}
            let data = '';
            let bytes = 0;
            res.on('data', (c: string) => {
              bytes += Buffer.byteLength(c);
              if(bytes>2*1024*1024){req.destroy(new Error('Remote response exceeds 2 MB'));return;}
              data += c;
            });
            res.on('error', e => resolve({success:false,error:e.message,taskId}));
            res.on('end', () => {
              try {
                const result = JSON.parse(data) as unknown;
                node.tasksCompleted += 1;
                resolve({ success: true, taskId, nodeId: node.id, result });
              } catch {
                resolve({ success: false, error: 'Parse error', taskId });
              }
            });
          },
        );
        req.on('error', (e: Error) => resolve({ success: false, error: e.message, taskId }));
        this.track(req,nodeId,DISPATCH_TIMEOUT);
        req.setTimeout(DISPATCH_TIMEOUT, () => {
          req.destroy();
          resolve({ success: false, error: 'Timeout', taskId });
        });
        req.write(postData);
        req.end();
      } catch (err) {
        resolve({ success: false, error: err instanceof Error ? err.message : String(err) });
      }
    });
  }

  /** 心跳巡检 */
  private checkHeartbeats(): void {
    for (const node of this.nodes) {
      if (node.status === 'offline' || node.status === 'active') this.pingNode(node);
      const elapsed = Date.now() - node.lastHeartbeat;
      if (elapsed > HEARTBEAT_TIMEOUT && node.status === 'active') {
        node.status = 'offline';
        this.logger.warn(`remote: 节点离线（心跳超时）${node.name}`);
      }
    }
  }

  /** 探测节点 /api/health（disconnected 节点的在途探测响应不再回写状态，防止"复活"已断开节点） */
  private pingNode(node: RemoteNode): void {
    if(this.stopping)return;
    try {
      const req = http.get({ hostname: node.host, port: node.port, path: '/api/health', timeout: 5000 }, (res) => {
        if (res.statusCode === 200) {
          if (this.stopping || node.status === 'disconnected' || this.registry[node.id]!==node) {
            res.resume();
            return;
          }
          node.status = 'active';
          node.lastHeartbeat = Date.now();
        } else if (node.status !== 'disconnected') {
          node.status = 'offline';
        }
        res.resume();
      });
      req.on('error', () => {
        if (!this.stopping && node.status !== 'disconnected') node.status = 'offline';
      });
      this.track(req,node.id,5000);
    } catch {
      if (node.status !== 'disconnected') node.status = 'offline';
    }
  }
}
