import 'reflect-metadata';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ExtensionHostService } from '../../src/extensions/extension-host.service.js';
import { ExtensionSelectionService } from '../../src/extensions/extension-selection.service.js';
import { Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { ToolDefinition, ToolContext } from '@skyalyticwing/shared';
import { ToolExecutorService } from '../../src/modules/tools/executor/tool-executor.service.js';
import { ToolRegistryService } from '../../src/modules/tools/executor/tool-registry.service.js';
import type { SecurityManagerService } from '../../src/modules/core/security/security-manager.service.js';
import type { SafetyManagerService } from '../../src/modules/core/security/safety-manager.service.js';
import type { HttpClientService } from '../../src/modules/core/http/http-client.service.js';
import type { WebSocketService } from '../../src/modules/core/websocket/websocket.service.js';
import type { LoggerService } from '../../src/modules/core/logger/logger.service.js';
import type { ConfigService } from '../../src/modules/core/config/config.service.js';

// 静音 NestJS Logger 的控制台输出（onModuleInit/register 会打印日志）
beforeAll(() => {
  jest
    .spyOn(Logger.prototype as never as { log: (m: string) => void }, 'log')
    .mockImplementation(() => undefined);
});

const loggerMock = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
} as unknown as LoggerService;

const ctx: ToolContext = {
  sessionId: 's1',
  workspace: '/tmp/ws',
  config: {},
  log: jest.fn(),
  broadcast: jest.fn(),
};

const makeTool = (name: string, overrides: Partial<ToolDefinition> = {}): ToolDefinition => ({
  name,
  description: `${name} tool`,
  parameters: { type: 'object', properties: {} },
  category: 'test',
  dangerous: false,
  execute: jest.fn().mockResolvedValue({ success: true, output: `${name} ok` }),
  ...overrides,
});

/** security mock：命令守卫默认放行 */
const createSecurityMock = () =>
  ({
    isCommandAllowed: jest.fn().mockReturnValue(true),
    checkPath: jest.fn().mockReturnValue(true),
    checkPathSync: jest.fn().mockReturnValue(true),
    checkUrl: jest.fn().mockReturnValue(true),
    checkUrlSync: jest.fn().mockReturnValue(true),
  }) as unknown as SecurityManagerService;

describe('ToolExecutorService', () => {
  let registry: ToolRegistryService;
  let security: SecurityManagerService;
  let config: { get: jest.Mock };
  let emitter: { emit: jest.Mock; emitAsync: jest.Mock };
  let service: ToolExecutorService;
  let extensions: ExtensionHostService, root: string, oldRoot: string | undefined;

  beforeEach(() => {
    oldRoot = process.env['SKYALYTICWING_DATA_DIR']; root = mkdtempSync(join(tmpdir(), 'wing-executor-test-'));
    process.env['SKYALYTICWING_DATA_DIR'] = root;
    registry = new ToolRegistryService();
    extensions = new ExtensionHostService(registry, new ExtensionSelectionService());
    // Jest runs source factories; production manifests point at their compiled .js entries.
    for (const manifest of (extensions as any).catalog.values()) manifest.entry = 'index.ts';
    security = createSecurityMock();
    config = { get: jest.fn().mockReturnValue({}) };
    emitter = { emit: jest.fn(), emitAsync: jest.fn().mockResolvedValue([]) };
    const http = {} as HttpClientService;
    const ws = { broadcast: jest.fn() } as unknown as WebSocketService;
    const safety = {} as SafetyManagerService;

    service = new ToolExecutorService(
      registry,
      security,
      http,
      ws,
      loggerMock,
      config as unknown as ConfigService,
      safety,
      undefined,
      emitter as unknown as EventEmitter2,
      undefined,
      extensions,
    );
  });
  afterEach(async () => {
    await extensions.onModuleDestroy();
    if (oldRoot === undefined) delete process.env['SKYALYTICWING_DATA_DIR']; else process.env['SKYALYTICWING_DATA_DIR'] = oldRoot;
    rmSync(root, { recursive: true, force: true });
  });

  describe('onModuleInit 内置工具加载', () => {
    it('serializes desktop actions across expert sessions and releases the queue after failure', async () => {
      let running = 0, peak = 0;
      registry.registerBuiltin(makeTool('computer_use', {execute: async () => {
        running++; peak = Math.max(peak,running);
        await new Promise(resolve => setTimeout(resolve,5)); running--;
        return {success:false,error:'fixture failure'};
      }}));
      const results=await Promise.all(Array.from({length:3},(_,i)=>service.execute('computer_use',{action:'act'},{...ctx,sessionId:'expert-'+i})));
      expect(peak).toBe(1); expect(results.every(r=>!r.success)).toBe(true);
    });
    it('fresh profiles expose bundled tools without a Wing account', async () => {
      await service.onModuleInit();
      expect(service.getToolDefinitions().map(tool => tool.name)).toEqual(expect.arrayContaining(['file-read','node_repl','builtin_browser']));
      expect(service.listTools().length).toBeGreaterThan(0);
    });
    it('显式安装工具包后注册完整工具集', async () => {
      await service.onModuleInit();
      for (const pack of await extensions.list()) await extensions.install(pack.id);

      const names = registry.getAll().map((t) => t.name);
      expect(names).toEqual(
        expect.arrayContaining([
          'file-read',
          'file-write',
          'file-edit',
          'file-delete',
          'directory-list',
          'glob',
          'grep',
          'bash',
          'powershell',
          'web-fetch',
          'notify',
          // 第二批：跨会话协作 / agent-reach / 渠道 / 杂项 / ACP / 守护进程域
          'agent_send',
          'agent_inbox',
          'agent_message_read',
          'sessions_list',
          'sessions_read',
          'sessions_send',
          'sessions_reply',
          'sessions_spawn',
          'subagent_execute',
          'subagents',
          'subagent_create',
          'subagent_status',
          'web_read',
          'rss_read',
          'v2ex_hot',
          'bilibili_search',
          'github_search',
          'exa_search',
          'weather',
          'gmail_search',
          'gmail_send',
          'webhook_send',
          'http_request',
          'show_message',
          'btw_ask',
          'cli_anything',
          'apply_patch',
          'diff',
          'tui_start',
          'acp_status',
          'acp_session_create',
          'daemon_install',
          'pairing_generate',
          'security_audit',
          'sandbox_run',
          'binding_add',
          'binding_list',
        ]),
      );
      expect(names).toHaveLength(process.platform === 'win32' ? 150 : 149);
    });

    it('listTools 返回已安装工具及 loaded 状态', async () => {
      await service.onModuleInit(); await extensions.install('wing-terminal');

      const list = service.listTools();
      expect(list.map(t => t.name)).toEqual(expect.arrayContaining(['bash', 'powershell']));
      for (const item of list) {
        expect(item.loaded).toBe(true);
        expect(typeof item.name).toBe('string');
        expect(typeof item.description).toBe('string');
        expect(typeof item.category).toBe('string');
        expect(typeof item.dangerous).toBe('boolean');
      }
      // bash 为危险工具
      expect(list.find((t) => t.name === 'bash')?.dangerous).toBe(true);
    });

    it('getToolDefinitions 返回注册表全部定义（LLM function calling）', async () => {
      await service.onModuleInit(); await extensions.install('wing-terminal');

      const defs = service.getToolDefinitions();
      expect(defs).toEqual(registry.getAll());
      expect(defs.find((t) => t.name === 'bash')?.parameters.required).toContain('command');
    });
  });

  describe('execute - 存在性校验', () => {
    it('未注册工具返回 Tool not found', async () => {
      const res = await service.execute('no-such-tool', {}, ctx);
      expect(res).toEqual({ success: false, error: 'Tool not found: no-such-tool' });
    });
  });

  describe('execute - 危险工具审批拦截（ask 模式）', () => {
    it('危险工具在默认 ask 模式下返回 approvalRequired 且不执行', async () => {
      const dangerous = makeTool('danger-tool', { dangerous: true });
      registry.register(dangerous);

      const res = await service.execute('danger-tool', {}, ctx);

      expect(res).toMatchObject({ success: false, approvalRequired: true });
      expect(res.error).toContain('需要确认');
      expect(dangerous.execute).not.toHaveBeenCalled();
    });

    it('config 读取异常时按默认 ask 拦截', async () => {
      config.get.mockImplementation(() => {
        throw new Error('config broken');
      });
      const dangerous = makeTool('danger-tool', { dangerous: true });
      registry.register(dangerous);

      const res = await service.execute('danger-tool', {}, ctx);
      expect(res.approvalRequired).toBe(true);
    });

    it('无效 yolo 配置按默认 ask 拦截', async () => {
      config.get.mockReturnValue({ yolo: 'whatever' });
      const dangerous = makeTool('danger-tool', { dangerous: true });
      registry.register(dangerous);

      const res = await service.execute('danger-tool', {}, ctx);
      expect(res.approvalRequired).toBe(true);
    });

    it('yolo 模式下危险工具直接执行', async () => {
      config.get.mockReturnValue({ yolo: 'yolo' });
      const dangerous = makeTool('danger-tool', { dangerous: true });
      registry.register(dangerous);

      const res = await service.execute('danger-tool', {}, ctx);
      expect(res.success).toBe(true);
      expect(dangerous.execute).toHaveBeenCalledTimes(1);
    });

    it('auto 模式下无法自动判断的危险工具仍请求确认', async () => {
      config.get.mockReturnValue({ yolo: 'auto' });
      const dangerous = makeTool('danger-tool', { dangerous: true });
      registry.register(dangerous);

      const res = await service.execute('danger-tool', {}, ctx);
      expect(res.approvalRequired).toBe(true);
      expect(dangerous.execute).not.toHaveBeenCalled();
    });

    it('非危险工具在 ask 模式下照常执行', async () => {
      const safe = makeTool('safe-tool');
      registry.register(safe);

      const res = await service.execute('safe-tool', {}, ctx);
      expect(res).toEqual({ success: true, output: 'safe-tool ok' });
      expect(safe.execute).toHaveBeenCalledWith({}, ctx);
    });
  });

  describe('execute - 内置 bash 工具的参数校验与命令守卫', () => {
    beforeEach(() => {
      // bash 为危险工具，绕过 executor 层审批以测其自身校验逻辑
      config.get.mockReturnValue({ yolo: 'yolo' });
    });

    it('缺少 command 参数返回参数错误', async () => {
      await service.onModuleInit(); await extensions.install('wing-terminal');

      const res = await service.execute('bash', {}, ctx);
      expect(res.success).toBe(false);
      expect(res.error).toContain('command');
    });

    it('命令被守卫拦截返回 blocked 结果', async () => {
      await service.onModuleInit(); await extensions.install('wing-terminal');
      (security.isCommandAllowed as jest.Mock).mockReturnValue(false);

      const res = await service.execute('bash', { command: 'rm -rf /' }, ctx);
      expect(res).toMatchObject({ success: false, blocked: true });
      expect(res.error).toContain('Command blocked by guard');
    });
  });

  describe('execute - 异常捕获', () => {
    it('工具抛错时返回错误而非向上抛出', async () => {
      const broken = makeTool('broken', {
        execute: jest.fn().mockRejectedValue(new Error('boom')),
      });
      registry.register(broken);

      const res = await service.execute('broken', {}, ctx);

      expect(res).toEqual({ success: false, error: 'boom' });
      expect(loggerMock.error).toHaveBeenCalledWith('Tool execution failed: broken', {
        error: 'boom',
      });
    });

    it('工具抛出非 Error 值时序列化为字符串', async () => {
      const weird = makeTool('weird', {
        execute: jest.fn().mockRejectedValue('plain failure'),
      });
      registry.register(weird);

      const res = await service.execute('weird', {}, ctx);
      expect(res).toEqual({ success: false, error: 'plain failure' });
    });
  });

  describe('execute - tool.executed 事件（设计 §4.9）', () => {
    it('工具成功执行后发射 tool.executed（payload 含 tool/sessionId/durationMs/success）', async () => {
      const safe = makeTool('event-tool');
      registry.register(safe);

      const res = await service.execute('event-tool', {}, ctx);

      expect(res.success).toBe(true);
      expect(emitter.emit).toHaveBeenCalledTimes(1);
      expect(emitter.emit).toHaveBeenCalledWith('tool.executed', {
        tool: 'event-tool',
        sessionId: 's1',
        durationMs: expect.any(Number),
        success: true,
      });
    });

    it('工具抛错时发射 success:false；未注册工具被拦截时不发射', async () => {
      const broken = makeTool('event-broken', {
        execute: jest.fn().mockRejectedValue(new Error('boom')),
      });
      registry.register(broken);

      const failRes = await service.execute('event-broken', {}, ctx);
      expect(failRes.success).toBe(false);
      expect(emitter.emit).toHaveBeenCalledWith('tool.executed', {
        tool: 'event-broken',
        sessionId: 's1',
        durationMs: expect.any(Number),
        success: false,
      });

      emitter.emit.mockClear();
      await service.execute('no-such-tool', {}, ctx);
      expect(emitter.emit).not.toHaveBeenCalled();
    });
  });

  describe('registerTool / unregisterTool', () => {
    it('unreviewed tools cannot skip approval by declaring a read-only-looking name', async () => {
      const tool = makeTool('file-read');
      registry.register(tool);
      (service as any).sandboxProfile = {
        check: () => ({ allowed: true, rule: 'pass' }),
        effectiveMode: () => 'workspace-write',
      };
      expect(await service.execute(tool.name, {}, ctx)).toMatchObject({
        success: false,
        approvalRequired: true,
      });
      expect(tool.execute).not.toHaveBeenCalled();
    });
    it('plugins cannot replace a reviewed built-in by reusing its name', async () => {
      await service.onModuleInit(); await extensions.install('wing-files');
      expect(() => service.registerTool(makeTool('file-read'))).toThrow('Cannot replace built-in');
      expect(() => service.registerTool(makeTool('file_read'))).toThrow('Cannot replace built-in');
    });

    it('does not execute when durable approval-decision logging fails', async () => {
      const tool = makeTool('audit-failure');
      registry.register(tool);
      emitter.emitAsync.mockRejectedValueOnce(new Error('audit disk full'));
      expect(await service.execute(tool.name, {}, ctx)).toMatchObject({
        success: false,
        error: 'audit disk full',
      });
      expect(tool.execute).not.toHaveBeenCalled();
    });
    it('registerTool 后工具可执行，unregisterTool 后不可执行', async () => {
      const tool = makeTool('managed');
      service.registerTool(tool);
      expect((await service.execute('managed', {}, ctx)).success).toBe(true);

      service.unregisterTool('managed');
      expect(await service.execute('managed', {}, ctx)).toEqual({
        success: false,
        error: 'Tool not found: managed',
      });
    });
  });
});
