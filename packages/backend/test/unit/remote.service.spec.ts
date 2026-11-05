import 'reflect-metadata';
import { RemoteService } from '../../src/modules/core/remote/remote.service.js';
import type { LoggerService } from '../../src/modules/core/logger/logger.service.js';

/** LoggerService mock */
const loggerMock = {
  info: jest.fn(),
  warn: jest.fn(),
} as unknown as LoggerService;

describe('RemoteService connectNode/disconnectNode（POST /api/remote/connect|disconnect 后端逻辑）', () => {
  let service: RemoteService;
  let nodeId: string;

  beforeEach(() => {
    // 不调用 onModuleInit，避免启动心跳定时器（open handle）
    service = new RemoteService(loggerMock);
    // host 使用保留 TLD，DNS 解析快速失败；registerNode 会异步 ping，不影响同步断言
    const registered = service.registerNode({ host: 'node-invalid.test', port: 8499, name: 'TestNode' });
    if ('error' in registered) throw new Error(registered.error);
    nodeId = registered.id;
  });
  afterEach(() => service.onModuleDestroy());

  it('connect 将节点标记为 active 并刷新心跳', () => {
    const result = service.connectNode(nodeId);
    expect(result.success).toBe(true);
    // pingNode 的回调为异步，同步断言时状态应为 active
    expect(service.getNodeStatus(nodeId)?.status).toBe('active');
  });

  it('disconnect 将节点标记为 disconnected', () => {
    const result = service.disconnectNode(nodeId);
    expect(result.success).toBe(true);
    expect(service.getNodeStatus(nodeId)?.status).toBe('disconnected');
  });

  it('connect/disconnect 不存在的节点返回 Node not found', () => {
    expect(service.connectNode('node-missing')).toEqual({
      success: false,
      error: 'Node not found',
    });
    expect(service.disconnectNode('node-missing')).toEqual({
      success: false,
      error: 'Node not found',
    });
  });

  it('disconnect 后节点不再计入 activeNodes 统计', () => {
    expect(service.getStats().activeNodes).toBe(1);
    service.disconnectNode(nodeId);
    expect(service.getStats().activeNodes).toBe(0);
  });
});
