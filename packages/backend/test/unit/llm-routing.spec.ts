import { LLMClientService } from '../../src/modules/ai/llm/llm-client.service.js';

describe('LLM provider routing', () => {
  const providers = {
    deepseek: {
      apiKey: 'deepseek-test-key',
      baseUrl: 'https://api.deepseek.com',
      models: ['deepseek-flash'],
    },
    qwen: {
      apiKey: 'qwen-test-key',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      models: ['qwen3.8-flash'],
    },
    ollama: { baseUrl: 'http://localhost:11434/v1', models: ['local-test-model'] },
  };
  function setup() {
    const adapter = {
      chat: jest.fn(async function* (_params: unknown, _config: unknown) {
        yield { type: 'content', content: 'OK' };
      }),
    };
    const args = [
      {
        get: (name: string) =>
          name === 'providers' ? providers : { defaultModel: 'qwen3.8-flash' },
      },
      { debug: jest.fn() },
      { checkUrl: jest.fn().mockResolvedValue({ safe: true }) },
      adapter,
      adapter,
    ] as unknown as ConstructorParameters<typeof LLMClientService>;
    return { client: new LLMClientService(...args), adapter };
  }
  it('routes a selected model to its configured provider, not the first provider', async () => {
    const { client, adapter } = setup();
    await client.chatSync({ model: 'qwen3.8-flash', messages: [] });
    expect(adapter.chat.mock.calls[0]?.[1]).toMatchObject({ id: 'qwen', apiKey: 'qwen-test-key' });
    expect(client.getDefaultModel()).toBe('qwen3.8-flash');
  });
  it('retains reasoning from done events even without usage for the next tool round', async () => {
    const {client,adapter}=setup();
    adapter.chat.mockImplementation(async function* () {
      yield {type:'done',reasoningContent:'provider continuation'} as any;
    });
    expect(await client.chatSync({model:'deepseek-flash',messages:[]})).toEqual({content:'',reasoningContent:'provider continuation'});
  });
  it('supports keyless local models and rejects an explicit unknown provider', async () => {
    const { client } = setup();
    expect(client.resolveProviderForModel('local-test-model')?.id).toBe('ollama');
    await expect(
      client.chatSync({ model: 'qwen3.8-flash', providerId: 'missing', messages: [] }),
    ).rejects.toThrow("Provider 'missing' not found");
  });
  it('keeps an explicitly qualified provider and strips its UI namespace before calling its API', async () => {
    const {client,adapter}=setup();
    await client.chatSync({model:'qwen::qwen3.8-flash',messages:[]});
    expect(adapter.chat.mock.calls[0]?.[0]).toMatchObject({providerId:'qwen',model:'qwen3.8-flash'});
    expect(adapter.chat.mock.calls[0]?.[1]).toMatchObject({id:'qwen',apiKey:'qwen-test-key'});
  });
  it.each(['qwen3.8-flash', 'local-test-model'])('account-free callers use their selected provider for %s without the official gateway', async model => {
    const {client,adapter}=setup();
    expect(await client.chatSync({ model, messages: [] })).toEqual({ content: 'OK' });
    expect(adapter.chat.mock.calls[0]?.[1]).toMatchObject({ id: model === 'local-test-model' ? 'ollama' : 'qwen' });
  });
});
