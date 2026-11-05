import { createLogger, type Logger } from '@skyalyticwing/shared';

export interface PluginManifest {
  name: string;
  version: string;
  description?: string;
  type: string;
  entry: string;
  dependencies?: Record<string, string>;
}

export interface PluginInstance {
  id: string;
  manifest: PluginManifest;
  activated: boolean;
}

export class PluginLoader {
  private logger: Logger;
  private plugins: Map<string, PluginInstance> = new Map();

  constructor(logger?: Logger) {
    this.logger = logger ?? createLogger({ name: 'plugin-loader' });
  }

  async discover(_directories: string[]): Promise<PluginManifest[]> {
    // TS-13 fix: 抛出未实现错误而非静默返回空数组
    throw new Error('PluginLoader.discover not implemented yet');
  }

  async load(_manifest: PluginManifest): Promise<PluginInstance> {
    // TS-13 fix: 抛出未实现错误而非静默成功
    throw new Error('PluginLoader.load not implemented yet');
  }

  async activate(pluginId: string): Promise<void> {
    const instance = this.plugins.get(pluginId);
    if (!instance) throw new Error(`Plugin not found: ${pluginId}`);
    instance.activated = true;
    this.logger.info({ plugin: pluginId }, 'Plugin activated');
  }

  async deactivate(pluginId: string): Promise<void> {
    const instance = this.plugins.get(pluginId);
    if (!instance) throw new Error(`Plugin not found: ${pluginId}`);
    instance.activated = false;
    this.logger.info({ plugin: pluginId }, 'Plugin deactivated');
  }

  list(): PluginInstance[] {
    return Array.from(this.plugins.values());
  }

  get(pluginId: string): PluginInstance | undefined {
    return this.plugins.get(pluginId);
  }
}
