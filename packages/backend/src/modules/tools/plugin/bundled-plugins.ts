import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolDefinition, ToolContext } from '@skyalyticwing/shared';
import type { PluginApi, TypedPlugin } from './plugin.service.js';

export const bundledPluginIds = ['operation-logger', 'security-audit', 'smart-notifier'];
const hookNames: Record<string, string> = { before_agent_start: 'beforeAgentStart', agent_end: 'afterAgentEnd', message_received: 'messageReceived', message_sent: 'messageSent', before_tool_call: 'beforeToolCall', after_tool_call: 'afterToolCall', after_tool_failure: 'afterToolFailure', config_change: 'configChange', gateway_start: 'gatewayStart', gateway_stop: 'gatewayStop' };

/** Only these three application-owned modules may use this legacy adapter. */
export function bundledPlugins(ids = bundledPluginIds): Array<{ plugin: TypedPlugin; tools: ToolDefinition[] }> {
  const roots = [join(__dirname, '../../../../../web/plugins'), join(__dirname, '../../../../../../web/plugins'), join(process.cwd(), 'packages/web/plugins'), join(process.cwd(), '../web/plugins')];
  return ids.flatMap(id => {
    const file = roots.map(root => join(root, id + '.cjs')).find(existsSync);
    if (!file) return [];
    delete require.cache[require.resolve(file)];
    const raw = require(file);
    let api: PluginApi | undefined;
    let handles: Array<[string, string]> = [];
    const syncConfig = () => {
      raw.config = { ...raw.config, ...api?.getConfig() };
      if (id === 'operation-logger' && api) raw.config.logDir = api.getDataDir();
    };
    const tools: ToolDefinition[] = (raw.tools || []).map((tool: any) => ({
      name: tool.name, description: tool.description, category: 'plugin',
      dangerous: !['oplog_query', 'oplog_stats', 'sec_audit_log', 'sec_stats'].includes(tool.name),
      parameters: tool.parameters || { type: 'object', properties: {
        type: { type: 'string' }, tool: { type: 'string' }, limit: { type: 'number' }, n: { type: 'number' },
        format: { type: 'string', enum: ['json', 'tsv'] }, pattern: { type: 'string' }, action: { type: 'string', enum: ['add', 'remove'] },
      } },
      async execute(args: unknown, ctx: ToolContext) {
        syncConfig();
        const result = await tool.execute.call(raw, args, ctx);
        return { success: result?.success !== false, ...result };
      },
    }));
    const plugin: TypedPlugin = {
      id, name: raw.name, type: 'service', version: raw.version, description: raw.description,
      _path: file, config: raw.config, enabled: true,
      activate(nextApi: PluginApi) {
        api = nextApi; syncConfig();
        // Logs belong to private instance data, never an installer resource directory.
        if (id === 'operation-logger') raw.config.logDir = api.getDataDir();
        raw.hooks?.onLoad?.call(raw, api);
        handles = Object.entries(raw.hooks || {}).flatMap(([name, handler]) => {
          const mapped = hookNames[name]; if (!mapped || typeof handler !== 'function') return [];
          return [[mapped, api!.addHook(mapped, (context: unknown) => {
            const data = context && typeof context === 'object' ? context as Record<string, unknown> : {};
            syncConfig();
            return handler.call(raw, { ...data, tool: data['tool'] || data['toolName'], message: data['message'] || data['content'] || '' });
          }, raw.priority)]] as Array<[string, string]>;
        });
      },
      deactivate() {
        for (const [name, handle] of handles) api?.removeHook(name, handle);
        handles = []; raw.hooks?.onUnload?.call(raw, api);
      },
    };
    return [{ plugin, tools }];
  });
}
