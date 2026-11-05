import 'reflect-metadata';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PythonEnvService, detectBundledPython } from '../../src/modules/core/python/python-env.service.js';

/** 伪造捆绑结构：<base>/../python/python.exe（模拟 deploy/dist → deploy/python） */
function makeFakeDeploy(): string {
  const base = mkdtempSync(join(tmpdir(), 'sky-py-'));
  const distDir = join(base, 'dist');
  const pyDir = join(base, 'python');
  mkdirSync(distDir, { recursive: true });
  mkdirSync(pyDir, { recursive: true });
  writeFileSync(join(pyDir, 'python.exe'), 'fake');
  return distDir;
}

describe('detectBundledPython', () => {
  it('deploy/dist 基准目录上 1 级命中 python/', () => {
    const distDir = makeFakeDeploy();
    const hit = detectBundledPython(distDir);
    expect(hit).toBeTruthy();
    expect(hit).toContain(join('python', 'python.exe'));
  });

  it('无捆绑结构时返回 null', () => {
    const base = mkdtempSync(join(tmpdir(), 'sky-py-none-'));
    expect(detectBundledPython(join(base, 'dist'))).toBeNull();
  });

  it('does not use a parent repository build cache', () => {
    const root = mkdtempSync(join(tmpdir(), 'sky-py-isolated-'));
    const checkout = join(root, 'community');
    mkdirSync(checkout);
    writeFileSync(join(checkout, 'pnpm-workspace.yaml'), 'packages: []');
    mkdirSync(join(root, 'build', 'python-embed', 'bin'), { recursive: true });
    writeFileSync(join(root, 'build', 'python-embed', 'python.exe'), 'fake');
    writeFileSync(join(root, 'build', 'python-embed', 'bin', 'python3'), 'fake');
    expect(detectBundledPython(join(checkout, 'packages', 'backend'))).toBeNull();
  });
});

describe('PythonEnvService', () => {
  it('SKYWING_PYTHON 环境变量优先（bundled 语义，须为真实存在路径）', () => {
    // Resolution only checks existence; use a fixture independent of cwd or installed Python.
    const bin = join(makeFakeDeploy(), '..', 'python', 'python.exe');
    const prev = process.env['SKYWING_PYTHON'];
    process.env['SKYWING_PYTHON'] = bin;
    try {
      const svc = new PythonEnvService().withBaseDir(join(tmpdir(), 'nonexistent-base'));
      const r = svc.resolve();
      expect(r).toEqual({ bin, source: 'bundled' });
    } finally {
      if (prev === undefined) delete process.env['SKYWING_PYTHON'];
      else process.env['SKYWING_PYTHON'] = prev;
    }
  });

  it('伪造 deploy 结构：解析为捆绑解释器（结果缓存）', () => {
    const distDir = makeFakeDeploy();
    const svc = new PythonEnvService().withBaseDir(distDir);
    const r1 = svc.resolve();
    const r2 = svc.resolve();
    expect(r1?.source).toBe('bundled');
    expect(r1?.bin).toContain('python.exe');
    expect(r2).toBe(r1); // 缓存同一实例
  });

  it('missingHint 提供用户引导文案', () => {
    expect(new PythonEnvService().missingHint()).toContain('Python');
  });
});
