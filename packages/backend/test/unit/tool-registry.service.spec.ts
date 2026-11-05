import 'reflect-metadata';
import type { ToolDefinition } from '@skyalyticwing/shared';
import { ToolRegistryService } from '../../src/modules/tools/executor/tool-registry.service.js';

const makeTool = (name: string, overrides: Partial<ToolDefinition> = {}): ToolDefinition => ({
  name,
  description: `${name} tool`,
  parameters: { type: 'object', properties: {} },
  category: 'test',
  dangerous: false,
  execute: jest.fn().mockResolvedValue({ success: true }),
  ...overrides,
});

describe('ToolRegistryService', () => {
  let registry: ToolRegistryService;

  beforeEach(() => {
    registry = new ToolRegistryService();
  });

  describe('注册 / 查找 / 注销', () => {
    it('register 后可 get / has / getAll', () => {
      const tool = makeTool('demo');
      registry.register(tool);

      expect(registry.has('demo')).toBe(true);
      expect(registry.get('demo')).toBe(tool);
      expect(registry.getAll()).toEqual([tool]);
    });

    it('get / has 未注册名称返回 undefined / false', () => {
      expect(registry.get('missing')).toBeUndefined();
      expect(registry.has('missing')).toBe(false);
    });

    it('同名注册覆盖旧定义', () => {
      const v1 = makeTool('demo', { description: 'v1' });
      const v2 = makeTool('demo', { description: 'v2' });
      registry.register(v1);
      registry.register(v2);

      expect(registry.getAll()).toHaveLength(1);
      expect(registry.get('demo')?.description).toBe('v2');
    });

    it('unregister 移除指定工具', () => {
      registry.register(makeTool('a'));
      registry.register(makeTool('b'));

      registry.unregister('a');

      expect(registry.has('a')).toBe(false);
      expect(registry.has('b')).toBe(true);
    });

    it('unregister 未注册名称不抛错', () => {
      expect(() => registry.unregister('nope')).not.toThrow();
    });

    it('clear 清空全部工具', () => {
      registry.register(makeTool('a'));
      registry.register(makeTool('b'));

      registry.clear();

      expect(registry.getAll()).toHaveLength(0);
      expect(registry.has('a')).toBe(false);
    });
  });

  describe('ensureLoaded（并发安全加载）', () => {
    it('loader 成功后注册工具', async () => {
      const tool = makeTool('lazy');
      const loader = jest.fn().mockResolvedValue(tool);

      await registry.ensureLoaded('lazy', loader);

      expect(loader).toHaveBeenCalledTimes(1);
      expect(registry.get('lazy')).toBe(tool);
    });

    it('工具已注册时跳过 loader', async () => {
      const tool = makeTool('ready');
      registry.register(tool);
      const loader = jest.fn().mockResolvedValue(makeTool('ready', { description: 'other' }));

      await registry.ensureLoaded('ready', loader);

      expect(loader).not.toHaveBeenCalled();
      expect(registry.get('ready')?.description).toBe('ready tool');
    });

    it('并发加载同一工具仅执行一次 loader（去重）', async () => {
      const tool = makeTool('concurrent');
      let release!: (v: ToolDefinition) => void;
      const loader = jest.fn().mockImplementation(
        () => new Promise<ToolDefinition>((resolve) => (release = resolve)),
      );

      const p1 = registry.ensureLoaded('concurrent', loader);
      const p2 = registry.ensureLoaded('concurrent', loader);
      const p3 = registry.ensureLoaded('concurrent', loader);
      release(tool);
      await Promise.all([p1, p2, p3]);

      expect(loader).toHaveBeenCalledTimes(1);
      expect(registry.get('concurrent')).toBe(tool);
    });

    it('loader 抛错不注册且允许后续重试', async () => {
      const failLoader = jest.fn().mockRejectedValue(new Error('load fail'));
      await expect(registry.ensureLoaded('retry', failLoader)).rejects.toThrow('load fail');

      expect(registry.has('retry')).toBe(false);

      // 加载标记被清除，第二次加载可正常注册
      const tool = makeTool('retry');
      await registry.ensureLoaded('retry', jest.fn().mockResolvedValue(tool));
      expect(registry.get('retry')).toBe(tool);
    });

    it('loader 返回 undefined 不注册', async () => {
      await registry.ensureLoaded('empty', jest.fn().mockResolvedValue(undefined));
      expect(registry.has('empty')).toBe(false);
    });
  });
});
