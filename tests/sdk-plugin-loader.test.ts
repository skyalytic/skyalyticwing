import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { PluginLoader } from '../packages/sdk/src/plugin-loader.js';

describe('SDK plugin discovery and loading', () => {
  let directory: string;
  let root: string;
  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wing-sdk-test-'));
    root = path.join(directory, 'plugins');
    await fs.mkdir(root);
  });
  afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }); });

  async function plugin(base: string, name = 'example', extra: Record<string, unknown> = {}) {
    await fs.mkdir(base, { recursive: true });
    const manifest = { name, version: '1.0.0', type: 'provider' as const, entry: 'index.mjs', ...extra };
    await fs.writeFile(path.join(base, 'plugin.json'), JSON.stringify(manifest));
    await fs.writeFile(path.join(base, 'index.mjs'), 'export const provider = { id: "fixture" };');
    return { ...manifest, baseDir: base };
  }

  it('discovers root and child plugins without executing their entries', async () => {
    const first = await plugin(root, 'root-plugin', { baseDir: 'untrusted-json-value' });
    const child = path.join(root, 'child');
    await plugin(child, 'child-plugin');
    await fs.writeFile(path.join(child, 'index.mjs'), 'throw new Error("must not execute during discovery");');
    const loader = new PluginLoader();
    const manifests = await loader.discover([root, root, path.join(directory, 'not-installed')]);
    expect(manifests.map(item => item.name)).toEqual(['root-plugin', 'child-plugin']);
    expect(manifests[0]?.baseDir).toBe(await fs.realpath(root));
    expect(loader.list()).toEqual([]);
    const loaded = await loader.load(manifests[0]!);
    expect(loaded.provider?.id).toBe('fixture');
    expect(loader.get(first.name)).toBe(loaded);
    await loader.unload(first.name);
    expect(loader.get(first.name)).toBeUndefined();
  });

  it('returns no plugins for missing optional directories but rejects an empty request', async () => {
    const loader = new PluginLoader();
    expect(await loader.discover([path.join(directory, 'missing')])).toEqual([]);
    await expect(loader.discover([])).rejects.toThrow('no directories');
  });

  it('reports malformed and unsupported manifests', async () => {
    await plugin(root);
    await fs.writeFile(path.join(root, 'plugin.json'), '{bad json');
    await expect(new PluginLoader().discover([root])).rejects.toThrow('Invalid plugin manifest');
    await plugin(root, 'example', { type: 'unknown' });
    await expect(new PluginLoader().discover([root])).rejects.toThrow('Invalid plugin manifest');
  });

  it('rejects duplicate names instead of silently replacing plugins', async () => {
    await plugin(path.join(root, 'one'));
    await plugin(path.join(root, 'two'));
    await expect(new PluginLoader().discover([root])).rejects.toThrow('Duplicate plugin name');
  });

  it('rejects traversal, absolute and URL entries', async () => {
    const loader = new PluginLoader();
    loader.setTrustedRoots([root]);
    for (const entry of ['../outside.mjs', '..\\outside.mjs', path.join(directory, 'outside.mjs'), 'file:///outside.mjs']) {
      const manifest = await plugin(root, 'example', { entry });
      await expect(loader.load(manifest)).rejects.toThrow('Invalid plugin entry path');
    }
  });

  it('requires a trusted root even when baseDir is omitted', async () => {
    const manifest = await plugin(root);
    const { baseDir: _baseDir, ...withoutBase } = manifest;
    await expect(new PluginLoader().load(withoutBase)).rejects.toThrow('no trusted plugin root');
    await expect(new PluginLoader().load(manifest)).rejects.toThrow('no trusted plugin root');
  });

  it('rejects sibling-prefix directories and junctions outside the root', async () => {
    const outside = path.join(directory, 'plugins-outside');
    const manifest = await plugin(outside);
    const loader = new PluginLoader();
    loader.setTrustedRoots([root]);
    await expect(loader.load(manifest)).rejects.toThrow('escapes trusted plugin root');
    await fs.symlink(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(loader.discover([root])).rejects.toThrow('escapes trusted plugin root');
  });

  it('rejects an entry reached through an escaping directory junction', async () => {
    const outside = path.join(directory, 'outside');
    await plugin(outside);
    const manifest = await plugin(root, 'example', { entry: 'linked/index.mjs' });
    await fs.symlink(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    const loader = new PluginLoader();
    loader.setTrustedRoots([root]);
    await expect(loader.load(manifest)).rejects.toThrow('entry escapes plugin directory');
  });

  it('validates that entries are files and exist', async () => {
    await plugin(root, 'example', { entry: 'missing.mjs' });
    await expect(new PluginLoader().discover([root])).rejects.toThrow();
    await plugin(root, 'example', { entry: '.' });
    await expect(new PluginLoader().discover([root])).rejects.toThrow('entry is not a file');
  });
});
