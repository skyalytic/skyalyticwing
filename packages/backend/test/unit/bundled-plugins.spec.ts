import 'reflect-metadata';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { PluginService } from '../../src/modules/tools/plugin/plugin.service';
import { ToolRegistryService } from '../../src/modules/tools/executor/tool-registry.service';

describe('shipped plugin runtime lifecycle', () => {
  let root: string, plugins: PluginService, registry: ToolRegistryService;
  const prior = process.env['SKYALYTICWING_DATA_DIR'];
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'wing-bundled-')); process.env['SKYALYTICWING_DATA_DIR'] = root;
    registry = new ToolRegistryService(); plugins = new PluginService({ unload() {} } as never, registry, {} as never); plugins.onModuleInit();
  });
  afterEach(async () => {
    for (const plugin of plugins.listPlugins()) await plugins.unloadPlugin(plugin.id);
    if (prior === undefined) delete process.env['SKYALYTICWING_DATA_DIR']; else process.env['SKYALYTICWING_DATA_DIR'] = prior;
    rmSync(root, { recursive: true, force: true });
  });
  async function call(name: string, args = {}) { return registry.get(name)!.execute(args, {} as never); }
  it('discovers three shipped plugins, binds state correctly, and unregisters on disable', async () => {
    expect(plugins.listPlugins()).toHaveLength(3);
    for (const plugin of plugins.listPlugins()) await plugins.loadPlugin(plugin.id);
    expect(registry.getAll()).toHaveLength(9);
    const blocked = await plugins.runHook('beforeToolCall', { toolName: 'bash', args: { command: 'rm -rf /fixture' } });
    expect(blocked).toMatchObject({ blocked: true });
    const stats = await call('sec_stats'); expect(JSON.parse(stats.output!).blocked).toBe(1);
    plugins.setEnabled('security-audit', false); expect(registry.get('sec_stats')).toBeUndefined();
    expect((await plugins.reloadAllPlugins()).success).toBe(true);
    expect(registry.get('sec_stats')).toBeUndefined();
    expect(registry.get('oplog_export')).toBeDefined();
    expect(plugins.getPluginTools().some(t=>t.name==='sec_stats')).toBe(false);
    expect(await plugins.runHook('beforeToolCall', { toolName: 'bash', args: { command: 'rm -rf /fixture' } })).not.toHaveProperty('blocked');
  });
  it('exports recorded entries after flushing instead of returning an empty export', async () => {
    await plugins.loadPlugin('operation-logger');
    await plugins.runHook('afterToolCall', { toolName: 'fixture-read', result: { success: true, output: 'private contents' } });
    expect((await call('oplog_export')).success).toBe(true);
    const dir = plugins.buildPluginApi('operation-logger').getDataDir();
    const file = readdirSync(dir).find(f => f.startsWith('export-'))!;
    const data = readFileSync(join(dir, file), 'utf8'); expect(JSON.parse(data)).toHaveLength(1); expect(data).not.toContain('private contents');
  });
  it('does not claim delivery with missing configuration and reports real webhook rejection', async () => {
    await plugins.loadPlugin('smart-notifier'); expect((await call('notify_test')).success).toBe(false);
    const server = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"errcode":1}'); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const port = (server.address() as { port: number }).port;
      plugins.setPluginConfig('smart-notifier', { webhookUrl: `http://127.0.0.1:${port}/private-key`, rateLimitMs: 0 });
      expect((await call('notify_config')).output).not.toContain('private-key');
      expect((await call('notify_test')).success).toBe(false);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
