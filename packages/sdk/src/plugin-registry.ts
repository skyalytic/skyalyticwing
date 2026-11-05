import type { PluginApi } from './plugin-api.js';
import type { ChannelPluginApi, ProviderPluginApi, TTSPluginApi, STTPluginApi } from './types.js';

export class PluginRegistry {
  private plugins: Map<string, PluginApi> = new Map();
  private channels: Map<string, ChannelPluginApi> = new Map();
  private providers: Map<string, ProviderPluginApi> = new Map();
  private ttsEngines: Map<string, TTSPluginApi> = new Map();
  private sttEngines: Map<string, STTPluginApi> = new Map();

  register(api: PluginApi): void {
    // M18: 验证插件名非空
    if (!api.manifest.name || typeof api.manifest.name !== 'string' || api.manifest.name.trim() === '') {
      throw new Error('Plugin registration failed: manifest.name must be a non-empty string');
    }
    // Warn if overwriting an existing plugin with the same name
    const existing = this.plugins.get(api.manifest.name);
    if (existing) {
      console.warn(`Plugin "${api.manifest.name}" is already registered. Overwriting.`);
      // 断开旧插件的 channel 连接，避免资源泄漏（fire-and-forget，因 register 为同步方法）
      if (existing.channel) {
        void existing.channel.disconnect().catch(() => { /* ignore */ });
      }
      // Clean up previous capabilities（仅当 map 中仍指向 existing 自身时才删除，避免误删被其它插件覆盖的条目）
      if (existing.channel && this.channels.get(existing.channel.id) === existing.channel) {
        this.channels.delete(existing.channel.id);
      }
      if (existing.provider && this.providers.get(existing.provider.id) === existing.provider) {
        this.providers.delete(existing.provider.id);
      }
      if (existing.tts && this.ttsEngines.get(existing.tts.id) === existing.tts) {
        this.ttsEngines.delete(existing.tts.id);
      }
      if (existing.stt && this.sttEngines.get(existing.stt.id) === existing.stt) {
        this.sttEngines.delete(existing.stt.id);
      }
    }
    this.plugins.set(api.manifest.name, api);
    if (api.channel) {
      const existingChannel = this.channels.get(api.channel.id);
      if (existingChannel && existingChannel !== api.channel) {
        console.warn(`Channel "${api.channel.id}" is already registered by another plugin. Overwriting.`);
        // 断开被覆盖的旧 channel 连接
        void existingChannel.disconnect().catch(() => { /* ignore */ });
      }
      this.channels.set(api.channel.id, api.channel);
    }
    if (api.provider) {
      const existingProvider = this.providers.get(api.provider.id);
      if (existingProvider && existingProvider !== api.provider) {
        console.warn(`Provider "${api.provider.id}" is already registered by another plugin. Overwriting.`);
        // 注册新 provider 前先 disconnect 旧实例（若存在 disconnect 方法），
        // 避免旧 provider 持有的连接/资源泄漏。fire-and-forget 因 register 为同步方法。
        this._safeDisconnect(existingProvider, 'provider');
      }
      this.providers.set(api.provider.id, api.provider);
    }
    if (api.tts) {
      const existingTTS = this.ttsEngines.get(api.tts.id);
      if (existingTTS && existingTTS !== api.tts) {
        console.warn(`TTS engine "${api.tts.id}" is already registered by another plugin. Overwriting.`);
        // 同 provider，注册新 TTS 前先 disconnect 旧实例
        this._safeDisconnect(existingTTS, 'tts');
      }
      this.ttsEngines.set(api.tts.id, api.tts);
    }
    if (api.stt) {
      const existingSTT = this.sttEngines.get(api.stt.id);
      if (existingSTT && existingSTT !== api.stt) {
        console.warn(`STT engine "${api.stt.id}" is already registered by another plugin. Overwriting.`);
        // 同 provider，注册新 STT 前先 disconnect 旧实例
        this._safeDisconnect(existingSTT, 'stt');
      }
      this.sttEngines.set(api.stt.id, api.stt);
    }
  }

  /**
   * 安全调用组件的 disconnect 方法（若存在）。
   * Provider/TTS/STT 接口未强制定义 disconnect，但实现类可能提供（如关闭 HTTP keep-alive、
   * 释放音频设备等）。统一通过鸭子类型检查并调用，错误不抛出仅记录。
   */
  private _safeDisconnect(component: unknown, label: string): void {
    if (component && typeof component === 'object' && 'disconnect' in component) {
      const disconnect = (component as { disconnect: unknown }).disconnect;
      if (typeof disconnect === 'function') {
        try {
          const result = (disconnect as () => unknown | Promise<unknown>).call(component);
          if (result && typeof (result as Promise<unknown>).then === 'function') {
            void (result as Promise<unknown>).catch((err) => {
              console.warn(`[PluginRegistry] Error disconnecting old ${label}:`, err);
            });
          }
        } catch (err) {
          console.warn(`[PluginRegistry] Error disconnecting old ${label}:`, err);
        }
      }
    }
  }

  async unregister(name: string): Promise<void> {
    const api = this.plugins.get(name);
    if (!api) return;
    if (api.channel) {
      try { await api.channel.disconnect(); } catch { /* ignore */ }
      // 仅当 map 中仍指向 api.channel 本身时才删除，避免误删被其它插件覆盖的条目
      if (this.channels.get(api.channel.id) === api.channel) {
        this.channels.delete(api.channel.id);
      }
    }
    if (api.provider && this.providers.get(api.provider.id) === api.provider) {
      this.providers.delete(api.provider.id);
    }
    if (api.tts && this.ttsEngines.get(api.tts.id) === api.tts) {
      this.ttsEngines.delete(api.tts.id);
    }
    if (api.stt && this.sttEngines.get(api.stt.id) === api.stt) {
      this.sttEngines.delete(api.stt.id);
    }
    // 仅当 map 中仍指向 api 本身时才删除，避免 await 期间被其它插件覆盖后误删
    if (this.plugins.get(name) === api) {
      this.plugins.delete(name);
    }
  }

  getChannel(id: string): ChannelPluginApi | undefined { return this.channels.get(id); }
  getProvider(id: string): ProviderPluginApi | undefined { return this.providers.get(id); }
  getTTS(id: string): TTSPluginApi | undefined { return this.ttsEngines.get(id); }
  getSTT(id: string): STTPluginApi | undefined { return this.sttEngines.get(id); }
  listChannels(): ChannelPluginApi[] { return Array.from(this.channels.values()); }
  listProviders(): ProviderPluginApi[] { return Array.from(this.providers.values()); }
  listTTS(): TTSPluginApi[] { return Array.from(this.ttsEngines.values()); }
  listSTT(): STTPluginApi[] { return Array.from(this.sttEngines.values()); }
}
