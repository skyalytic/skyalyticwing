import type { ChannelPluginApi, ProviderPluginApi, TTSPluginApi, STTPluginApi, PluginManifest } from './types.js';

export interface PluginApi {
  manifest: PluginManifest;
  channel?: ChannelPluginApi;
  provider?: ProviderPluginApi;
  tts?: TTSPluginApi;
  stt?: STTPluginApi;
}

export function createPluginApi(manifest: PluginManifest): PluginApi {
  return { manifest };
}
