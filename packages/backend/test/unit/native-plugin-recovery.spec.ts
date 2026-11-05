import 'reflect-metadata';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NativeResourceInstaller } from '../../src/modules/ecosystem/native-resource-installer.service';
describe('private plugin rollback recovery', () => {
  it('reloads the retained working version when the requested rollback fails to load', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wing-native-'));
    const id = 'enterprise-12345678-1234-1234-1234-123456789abc';
    const target = join(root, 'plugins', 'enterprise-resources', id);
    mkdirSync(target, { recursive: true });
    mkdirSync(target + '.previous');
    writeFileSync(join(target, 'version'), 'working');
    writeFileSync(join(target + '.previous', 'version'), 'broken');
    let active = false;
    const load = jest.fn(async () => {
      active = readFileSync(join(target, 'version'), 'utf8') === 'working';
      return active;
    });
    const service = new NativeResourceInstaller(
      {
        listPlugins: () => (active ? [{ id }] : []),
        loadPluginFromPath: load,
        unloadPluginEntry: async () => {
          active = false;
        },
      } as any,
      { getDataDir: () => root } as any,
    );
    try {
      await expect(service.rollback(id)).rejects.toThrow('加载失败');
      expect(active).toBe(true);
      expect(load).toHaveBeenCalledTimes(2);
      expect(readFileSync(join(target, 'version'), 'utf8')).toBe('working');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
