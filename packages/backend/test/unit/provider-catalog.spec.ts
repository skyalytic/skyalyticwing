import 'reflect-metadata';
import { PROVIDERS_REGISTRY, providerCapabilityDefaults } from '../../src/modules/ai/llm/provider-catalog.js';
import { ProviderController } from '../../src/modules/ai/llm/provider.controller.js';
import { ProviderService, isVisionModel } from '../../src/modules/ai/llm/provider.service.js';

describe('provider templates', () => {
  it('keeps October model IDs attached to the right provider and vision capability', () => {
    for (const [provider, model] of [
      ['moonshot', 'kimi-k3.1-pro'], ['moonshot', 'kimi-k3.1-pro-highspeed'],
      ['deepseek', 'deepseek-flash'],
      ['minimax', 'MiniMax-M3.1-Flash'],
      ['qwen', 'MiniMax/MiniMax-M3.1-Flash'], ['qwen', 'xiaomi/mimo-v2.6-pro-ultraspeed'],
      ['qwen', 'deepseek-v4.1-flash-1017'],
    ]) {
      expect(PROVIDERS_REGISTRY.find(p => p.id === provider)?.models).toContain(model);
      expect(isVisionModel(provider!, model!)).toBe(true);
    }
    expect(PROVIDERS_REGISTRY.find(p => p.id === 'deepseek')?.models).not.toContain('deepseek-v4.1-flash-1017');
    expect(PROVIDERS_REGISTRY.some(p => p.id === 'huawei')).toBe(false);
  });
  it('keeps pending protocol validation and enterprise-only models out of default chat presets', () => {
    for (const [provider, model] of [['google', 'gemini-4-argon'], ['openai', 'gpt-6.1-terra'], ['glm', 'glm-5.3-flashx-legal']]) {
      const entry = PROVIDERS_REGISTRY.find(p => p.id === provider)!;
      expect(entry.models).not.toContain(model);
      expect(entry.catalog?.references?.some(m => m.id === model)).toBe(true);
    }
    expect(PROVIDERS_REGISTRY.find(p => p.id === 'minimax')?.catalog?.references).toBeUndefined();
  });
  it('separates reviewed vision, image and video capabilities from text IDs', () => {
    expect(isVisionModel('anthropic', 'claude-fable-5-1')).toBe(true);
    expect(isVisionModel('deepseek', 'deepseek-v4-pro')).toBe(false);
    expect(isVisionModel('deepseek', 'deepseek-flash')).toBe(true);
    for (const p of PROVIDERS_REGISTRY) {
      for (const id of p.visionModels || []) expect(p.models).toContain(id);
      if (p.imageModels?.length) expect(p.imageProtocol).toBeTruthy();
      if (p.videoModels?.length) expect(p.videoProtocol).toBeTruthy();
      if (p.catalog?.setup === 'reference') expect([...p.models, ...(p.imageModels || []), ...(p.videoModels || [])]).toEqual([]);
    }
  });
  it('does not let editing a template mutate the catalog', () => {
    const p = PROVIDERS_REGISTRY.find(p => p.id === 'google')!;
    const draft = providerCapabilityDefaults(p); draft.visionModels.length = 0;
    expect(providerCapabilityDefaults(p).visionModels.length).toBeGreaterThan(0);
    expect(draft.imageProtocol).toBe('gemini');
    expect(draft.imageBaseUrl).toBe('https://generativelanguage.googleapis.com/v1');
  });
  it('preserves configured proxies, explicit disabled capabilities and output limits while exposing a separate pristine preset', () => {
    const state = { openai: { apiKey: 'test-fixture-only', baseUrl: 'https://proxy.example/v1', models: ['private-text'], visionModels: [], imageProtocol: 'none', maxTokens: 1234 } };
    const cfg = { get: () => state } as never;
    const service = new ProviderService(cfg, {} as never, {} as never, {} as never);
    const controller = new ProviderController(service, cfg, {} as never);
    const item = (controller.list().data as any).providers.find((p: any) => p.id === 'openai');
    expect(item).toMatchObject({ baseUrl: 'https://proxy.example/v1', imageBaseUrl: 'https://proxy.example/v1', visionModels: [], imageProtocol: 'none', maxTokens: 1234, models: ['private-text'] });
    expect(item.preset.baseUrl).toBe('https://api.openai.com/v1');
    expect(item.preset.imageProtocol).toBe('openai-images');
    expect(JSON.stringify(item)).not.toContain('test-fixture-only');
  });
});
