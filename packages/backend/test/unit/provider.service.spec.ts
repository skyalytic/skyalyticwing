import 'reflect-metadata';
import { of } from 'rxjs';
import { ProviderService, isVisionModel } from '../../src/modules/ai/llm/provider.service.js';
import { RedactInterceptor } from '../../src/modules/core/logger/redact.interceptor.js';
import type { ConfigService } from '../../src/modules/core/config/config.service.js';
import type { LoggerService } from '../../src/modules/core/logger/logger.service.js';
import type { SecurityManagerService } from '../../src/modules/core/security/security-manager.service.js';
import type { LLMClientService } from '../../src/modules/ai/llm/llm-client.service.js';

const loggerMock = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
} as unknown as LoggerService;

/** 构造带内存存储的 ConfigService mock */
function createConfigMock(initial: Record<string, unknown> = {}) {
  const store: Record<string, unknown> = JSON.parse(JSON.stringify(initial));
  return {
    store,
    get: jest.fn((section: string) => store[section]),
    set: jest.fn((section: string, value: unknown) => {
      store[section] = value;
    }),
    save: jest.fn(),
  };
}

type ConfigMock = ReturnType<typeof createConfigMock>;

function createService(config: ConfigMock, opts?: {
  checkUrlSync?: jest.Mock;
  chatSync?: jest.Mock;
  getDefaultModel?: jest.Mock;
}) {
  const security = {
    checkUrlSync: opts?.checkUrlSync ?? jest.fn().mockReturnValue(true),
  } as unknown as SecurityManagerService;
  const llm = {
    chatSync: opts?.chatSync ?? jest.fn(),
    getDefaultModel: opts?.getDefaultModel ?? jest.fn().mockReturnValue('gpt-4o'),
  } as unknown as LLMClientService;
  const service = new ProviderService(
    config as unknown as ConfigService,
    loggerMock,
    security,
    llm,
  );
  return { service, security, llm };
}

describe('ProviderService', () => {
  let config: ConfigMock;

  it('preserves an existing provider key when the API echoes a redacted mask', () => {
    const saved = createConfigMock({providers:{openai:{apiKey:'fixture-key',maxTokens:8192}}});
    const {service} = createService(saved);
    service.updateProvider('openai',{apiKey:'***',maxTokens:16384});
    expect((saved.store['providers'] as any).openai).toMatchObject({apiKey:'fixture-key',maxTokens:16384});
    service.updateProvider('openai',{apiKey:''});
    expect((saved.store['providers'] as any).openai.apiKey).toBe('');
  });

  beforeEach(() => {
    jest.clearAllMocks();
    config = createConfigMock();
  });

  describe('listProviders', () => {
    it('无保存配置时保留第三方注册表且不提供 Wing 官方入口', () => {
      const { service } = createService(config);
      const { providers } = service.listProviders();

      expect(providers.find(p=>p.id==='skyalytic')).toBeUndefined();
      expect(new Set(providers.map(p=>p.id)).size).toBe(providers.length);
      const openai = providers.find((p) => p.id === 'openai');
      expect(openai).toMatchObject({
        name: 'OpenAI (GPT)',
        type: 'openai',
        region: 'US',
        baseUrl: 'https://api.openai.com/v1',
        requiresApiKey: true,
        configured: false,
        envKey: 'OPENAI_API_KEY',
        maxTokens: 8192,
        vision: true,
      });
      expect(openai?.models).toContain('gpt-4o');
      // 旧版 30 供应商全量迁移
      const ids = new Set(providers.map((p) => p.id));
      for (const id of [
        'custom', 'anthropic', 'openai', 'azure', 'google', 'bedrock', 'grok', 'mistral',
        'groq', 'perplexity', 'openrouter', 'nvidia', 'together', 'vertex', 'qwen', 'glm',
        'deepseek', 'moonshot', 'qianfan', 'doubao', 'minimax', 'hunyuan', 'xunfei',
        'xiaomi', 'baichuan', 'stepfun', 'siliconflow', 'ollama', 'lmstudio', 'vllm',
      ]) {
        expect(ids.has(id)).toBe(true);
      }
    });

    it('本地供应商（ollama）requiresApiKey=false', () => {
      const { service } = createService(config);
      const ollama = service.listProviders().providers.find((p) => p.id === 'ollama');
      expect(ollama).toMatchObject({ type: 'local', region: 'LOCAL', requiresApiKey: false });
    });

    it('已保存 apiKey 或 baseUrl 的供应商 configured=true 并沿用保存值', () => {
      config = createConfigMock({
        providers: {
          openai: { apiKey: 'sk-secret', baseUrl: 'https://proxy.example.com/v1', models: ['gpt-4o-mini'] },
        },
      });
      const { service } = createService(config);

      const openai = service.listProviders().providers.find((p) => p.id === 'openai');
      expect(openai?.configured).toBe(true);
      expect(openai?.baseUrl).toBe('https://proxy.example.com/v1');
      expect(openai?.models).toEqual(['gpt-4o-mini']);
    });

    it('保存的自定义供应商（custom_ 前缀）追加到列表', () => {
      config = createConfigMock({
        providers: {
          custom_xyz: { apiKey: 'k', baseUrl: 'https://my.llm/v1', displayName: '我的网关', models: ['m1'] },
        },
      });
      const { service } = createService(config);

      const custom = service.listProviders().providers.find((p) => p.id === 'custom_xyz');
      expect(custom).toMatchObject({
        type: 'custom',
        region: 'CUSTOM',
        requiresApiKey: true,
        configured: true,
        baseUrl: 'https://my.llm/v1',
        models: ['m1'],
        displayName: '我的网关',
      });
    });

    it('响应中不回传 apiKey 字段（密钥不出服务层）', () => {
      config = createConfigMock({
        providers: { openai: { apiKey: 'sk-secret', baseUrl: 'https://api.openai.com/v1' } },
      });
      const { service } = createService(config);

      const raw = JSON.stringify(service.listProviders());
      expect(raw).not.toContain('sk-secret');
      expect(raw).not.toContain('apiKey');
    });
  });

  describe('updateProvider', () => {
    it('空 id 抛错', () => {
      const { service } = createService(config);
      expect(() => service.updateProvider('', { apiKey: 'k' })).toThrow('Provider id required');
    });

    it('baseUrl 被 SSRF 守卫拦截时抛错且不落盘', () => {
      const { service } = createService(config, { checkUrlSync: jest.fn().mockReturnValue(false) });

      expect(() =>
        service.updateProvider('openai', { baseUrl: 'http://169.254.169.254/v1' }),
      ).toThrow(/SSRF guard/);
      expect(config.set).not.toHaveBeenCalled();
    });

    it('合法更新合并进 providers 段并持久化', () => {
      const { service } = createService(config);

      const res = service.updateProvider('openai', { apiKey: 'sk-1', baseUrl: 'https://api.openai.com/v1' });

      expect(res).toEqual({ updated: true });
      expect(config.set).toHaveBeenCalledWith('providers', expect.any(Object));
      expect(config.save).toHaveBeenCalled();
      expect(config.store['providers']).toMatchObject({
        openai: { apiKey: 'sk-1', baseUrl: 'https://api.openai.com/v1' },
      });
    });

    it('更新时跳过 id / providerId 字段避免污染配置，并自动补注册表默认 maxTokens', () => {
      const { service } = createService(config);

      service.updateProvider('openai', { id: 'evil', providerId: 'evil', apiKey: 'k' });

      const saved = config.store['providers'] as Record<string, Record<string, unknown>>;
      expect(saved['openai']).toEqual({ apiKey: 'k', maxTokens: 8192 }); // PROVIDER_MAX_TOKENS.openai
    });

    it('增量更新保留既有字段', () => {
      config = createConfigMock({ providers: { openai: { apiKey: 'old', models: ['gpt-4o'] } } });
      const { service } = createService(config);

      service.updateProvider('openai', { baseUrl: 'https://api.openai.com/v1' });

      expect(config.store['providers']).toMatchObject({
        openai: { apiKey: 'old', models: ['gpt-4o'], baseUrl: 'https://api.openai.com/v1' },
      });
    });
  });

  describe('deleteProvider', () => {
    it('删除不存在的供应商抛错', () => {
      const { service } = createService(config);
      expect(() => service.deleteProvider('nope')).toThrow('Provider not found: nope');
    });

    it('删除供应商并持久化', () => {
      config = createConfigMock({ providers: { openai: { apiKey: 'k' }, glm: { apiKey: 'k2' } } });
      const { service } = createService(config);

      expect(service.deleteProvider('openai')).toEqual({ deleted: 'openai' });
      expect(config.store['providers']).toEqual({ glm: { apiKey: 'k2' } });
      expect(config.save).toHaveBeenCalled();
    });

    it('被删供应商是默认模型来源时清空 general.defaultModel', () => {
      config = createConfigMock({
        providers: { openai: { apiKey: 'k' } },
        general: { defaultModel: 'openai' },
      });
      const { service } = createService(config);

      service.deleteProvider('openai');

      expect(config.store['general']).toEqual({ defaultModel: '' });
    });
  });

  describe('testProvider', () => {
    it('供应商不存在返回失败', async () => {
      const { service } = createService(config);
      const res = await service.testProvider('nope');
      expect(res.success).toBe(false);
      expect(res.error).toBe('Provider not found: nope');
    });

    it('未配置 apiKey 的远程供应商返回失败', async () => {
      config = createConfigMock({ providers: { openai: { baseUrl: 'https://api.openai.com/v1' } } });
      const { service } = createService(config);

      const res = await service.testProvider('openai');
      expect(res).toMatchObject({ success: false, error: '未配置API密钥' });
    });

    it('baseUrl 被 SSRF 拦截返回失败', async () => {
      config = createConfigMock({
        providers: { openai: { apiKey: 'sk-1', baseUrl: 'http://127.0.0.1:8080/v1' } },
      });
      const { service } = createService(config, { checkUrlSync: jest.fn().mockReturnValue(false) });

      const res = await service.testProvider('openai');
      expect(res.success).toBe(false);
      expect(res.error).toContain('SSRF guard');
    });

    it('chatSync 返回内容时连通成功并带时延与模型', async () => {
      config = createConfigMock({
        providers: { openai: { apiKey: 'sk-1', baseUrl: 'https://api.openai.com/v1', models: ['gpt-4o-mini'] } },
      });
      const chatSync = jest.fn().mockResolvedValue({ content: 'pong' });
      const { service } = createService(config, { chatSync });

      const res = await service.testProvider('openai');

      expect(res).toMatchObject({ success: true, model: 'gpt-4o-mini', message: '连接正常' });
      expect(res.latencyMs).toBeGreaterThanOrEqual(0);
      expect(chatSync).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'gpt-4o-mini', providerId: 'openai', stream: false }),
      );
    });

    it('chatSync 返回空内容判定失败（空响应）', async () => {
      config = createConfigMock({
        providers: { openai: { apiKey: 'sk-1', models: ['gpt-4o'] } },
      });
      const { service } = createService(config, { chatSync: jest.fn().mockResolvedValue({ content: '' }) });

      const res = await service.testProvider('openai');
      expect(res).toMatchObject({ success: false, message: '空响应' });
    });

    it('chatSync 抛错时返回失败与错误信息', async () => {
      config = createConfigMock({
        providers: { openai: { apiKey: 'sk-1', models: ['gpt-4o'] } },
      });
      const { service } = createService(config, {
        chatSync: jest.fn().mockRejectedValue(new Error('401 Unauthorized')),
      });

      const res = await service.testProvider('openai');
      expect(res).toMatchObject({ success: false, error: '401 Unauthorized' });
    });

    it('供应商未配置 models 时回退 LLM 默认模型', async () => {
      config = createConfigMock({
        providers: { openai: { apiKey: 'sk-1', baseUrl: 'https://api.openai.com/v1' } },
      });
      const chatSync = jest.fn().mockResolvedValue({ content: 'pong' });
      const { service } = createService(config, { chatSync });

      const res = await service.testProvider('openai');
      expect(res.model).toBe('gpt-4o');
    });

    describe('ollama / local 分支', () => {
      let fetchSpy: jest.SpyInstance;

      afterEach(() => {
        fetchSpy.mockRestore();
      });

      it('GET /api/tags 成功返回连接正常', async () => {
        config = createConfigMock({
          providers: { ollama: { baseUrl: 'http://localhost:11434' } },
        });
        fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, status: 200 } as Response);
        const { service } = createService(config);

        const res = await service.testProvider('ollama');

        expect(res.success).toBe(true);
        expect(res.message).toBe('本地服务连接正常');
        expect(fetchSpy).toHaveBeenCalledWith(
          'http://localhost:11434/api/tags',
          expect.objectContaining({ signal: expect.any(AbortSignal) }),
        );
      });

      it('GET /api/tags 非 2xx 返回 HTTP 错误', async () => {
        config = createConfigMock({
          providers: { ollama: { baseUrl: 'http://localhost:11434' } },
        });
        fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: false, status: 503 } as Response);
        const { service } = createService(config);

        const res = await service.testProvider('ollama');
        expect(res).toMatchObject({ success: false, error: 'HTTP 503' });
      });

      it('网络异常返回失败', async () => {
        config = createConfigMock({
          providers: { ollama: { baseUrl: 'http://localhost:11434' } },
        });
        fetchSpy = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
        const { service } = createService(config);

        const res = await service.testProvider('ollama');
        expect(res).toMatchObject({ success: false, error: 'ECONNREFUSED' });
      });

      it('本地供应商（ollama）豁免 SSRF 校验，直接发起请求（与旧版行为一致）', async () => {
        config = createConfigMock({
          providers: { ollama: { baseUrl: 'http://10.0.0.1:11434' } },
        });
        fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, status: 200 } as Response);
        const { service } = createService(config, { checkUrlSync: jest.fn().mockReturnValue(false) });

        const res = await service.testProvider('ollama');
        // local 类型豁免 SSRF：即使 checkUrlSync 返回 false 也照常请求本机/局域网服务
        expect(res.success).toBe(true);
        expect(fetchSpy).toHaveBeenCalledWith(
          'http://10.0.0.1:11434/api/tags',
          expect.objectContaining({ signal: expect.any(AbortSignal) }),
        );
      });

      it('lmstudio / vllm 走 OpenAI 兼容 /models 端点', async () => {
        config = createConfigMock({
          providers: { lmstudio: { baseUrl: 'http://localhost:1234/v1' } },
        });
        fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, status: 200 } as Response);
        const { service } = createService(config);

        const res = await service.testProvider('lmstudio');
        expect(res.success).toBe(true);
        expect(fetchSpy).toHaveBeenCalledWith(
          'http://localhost:1234/v1/models',
          expect.objectContaining({ signal: expect.any(AbortSignal) }),
        );
      });
    });
  });

  describe('listModels', () => {
    it('聚合各供应商模型并按 configured/local 标记 available，附 vision 能力', () => {
      config = createConfigMock({
        providers: {
          openai: { apiKey: 'sk-1', baseUrl: 'https://api.openai.com/v1', models: ['gpt-4o'] },
        },
      });
      const { service } = createService(config);

      const { models } = service.listModels();

      const gpt = models.find((m) => m.id === 'gpt-4o');
      expect(gpt).toMatchObject({ providerId: 'openai', providerName: 'OpenAI (GPT)', available: true, vision: true });

      // 未配置的远程供应商 available=false；vision 按 VISION_PROVIDERS/KEYWORDS 判定
      // （2026-09-27 官方校正：glm-5.2 为纯文本，视觉为 5v/4.6v/4.5v/5.3-flash 系）
      const glm = models.find((m) => m.id === 'glm-5.2');
      expect(glm?.available).toBe(false);
      expect(glm?.vision).toBe(false);
      const glmVision = models.find((m) => m.id === 'glm-5.3-flash');
      expect(glmVision?.vision).toBe(true);
      const kimi = models.find((m) => m.id === 'kimi-k3');
      expect(kimi?.vision).toBe(true);
      const ernie = models.find((m) => m.id === 'ernie-5.1');
      expect(ernie?.vision).toBe(true); // Explicit catalog capability, not provider-name heuristics.
      const ollamaModels = models.filter((m) => m.providerId === 'ollama');
      expect(ollamaModels).toHaveLength(0); // ollama 注册表 models 为空数组
    });
  });

  describe('apiKey 脱敏（RedactInterceptor 兜底）', () => {
    it('响应中的 apiKey/token/password 等字段被替换为 ***', (done) => {
      const interceptor = new RedactInterceptor();
      const data = {
        providers: {
          openai: { apiKey: 'sk-very-secret', name: 'OpenAI' },
          custom_a: { token: 'tk-1', nested: { password: 'pw', keep: 'ok' } },
        },
        normal: 'untouched',
      };

      interceptor
        .intercept({} as never, { handle: () => of(data) })
        .subscribe((result) => {
          const json = JSON.stringify(result);
          expect(json).toContain('***');
          expect(json).not.toContain('sk-very-secret');
          expect(json).not.toContain('tk-1');
          expect(json).not.toContain('"pw"');
          expect(json).toContain('untouched');
          expect(json).toContain('"ok"');
          done();
        });
    });

    it('数组与嵌套结构均被递归脱敏', (done) => {
      const interceptor = new RedactInterceptor();
      const data = [{ apiKey: 'a' }, { list: [{ secret: 'b' }] }];

      interceptor
        .intercept({} as never, { handle: () => of(data) })
        .subscribe((result) => {
          const json = JSON.stringify(result);
          expect(json).not.toContain('"a"');
          expect(json).not.toContain('"b"');
          expect(JSON.parse(json)).toEqual([
            { apiKey: '***' },
            { list: [{ secret: '***' }] },
          ]);
          done();
        });
    });
  });

  describe('autoConfigureFromEnv（旧版 ADDITIONAL_PROVIDERS.autoConfigure）', () => {
    afterEach(() => {
      delete process.env['DEEPSEEK_API_KEY'];
      delete process.env['ANTHROPIC_API_KEY'];
    });

    it('环境变量存在且用户未配置时自动写入（含 baseUrl/models/maxTokens）', () => {
      process.env['DEEPSEEK_API_KEY'] = 'sk-env-123';
      config = createConfigMock({ providers: {} });
      const { service } = createService(config);

      const n = service.autoConfigureFromEnv();

      expect(n).toBe(1);
      expect(config.store['providers']).toMatchObject({
        deepseek: {
          apiKey: 'sk-env-123',
          baseUrl: 'https://api.deepseek.com',
          maxTokens: 8192,
        },
      });
      expect(config.save).toHaveBeenCalled();
    });

    it('已有用户配置不被覆盖', () => {
      process.env['DEEPSEEK_API_KEY'] = 'sk-env-123';
      config = createConfigMock({
        providers: { deepseek: { apiKey: 'sk-user', baseUrl: 'https://my-proxy/v1' } },
      });
      const { service } = createService(config);

      const n = service.autoConfigureFromEnv();

      expect(n).toBe(0);
      expect(config.store['providers']).toMatchObject({
        deepseek: { apiKey: 'sk-user', baseUrl: 'https://my-proxy/v1' },
      });
      expect(config.save).not.toHaveBeenCalled();
    });

    it('anthropic 类型供应商自动标记 type=anthropic', () => {
      process.env['ANTHROPIC_API_KEY'] = 'sk-ant-env';
      config = createConfigMock({ providers: {} });
      const { service } = createService(config);

      service.autoConfigureFromEnv();

      expect(config.store['providers']).toMatchObject({
        anthropic: { apiKey: 'sk-ant-env', type: 'anthropic' },
      });
    });
  });
});

describe('browser vision capability metadata',()=>{it('enables current DeepSeek Flash without enabling text-only Pro',()=>{expect(isVisionModel('deepseek','deepseek-flash')).toBe(true);expect(isVisionModel('deepseek','deepseek-v4-pro')).toBe(false);});});
