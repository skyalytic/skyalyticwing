import 'reflect-metadata';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SandboxProfileService } from '../../src/modules/tools/sandbox/sandbox-profile.service.js';
import { compareVersions } from '../../src/modules/core/version/mandatory-update.service.js';
import type { ToolContext } from '@skyalyticwing/shared';

/** LoggerService 静音 stub（仅构造期打点） */
const loggerStub = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as never;

/** 每个用例独立临时数据目录：避免读写真实用户 dataDir（测试隔离） */
function makeService(): SandboxProfileService {
  const dataDir = mkdtempSync(join(tmpdir(), 'skywing-sandbox-profile-'));
  return new SandboxProfileService(loggerStub, dataDir);
}

function ctx(sessionId?: string, workspace?: string): ToolContext {
  return { sessionId, workspace } as unknown as ToolContext;
}

describe('compareVersions（强制更新最低版本比较）', () => {
  it('三段数字逐段比较', () => {
    expect(compareVersions('2.0.0', '2.1.0')).toBe(-1);
    expect(compareVersions('2.1.0', '2.0.9')).toBe(1);
    expect(compareVersions('2.0.0', '2.0.0')).toBe(0);
  });

  it('缺失段按 0 处理', () => {
    expect(compareVersions('2.0', '2.0.0')).toBe(0);
    expect(compareVersions('2', '2.0.1')).toBe(-1);
    expect(compareVersions('3', '2.9.9')).toBe(1);
  });
});

describe('SandboxProfileService 三级沙箱档位', () => {
  it('reports persistence failure without changing the active sandbox mode', () => {
    const blocked = join(mkdtempSync(join(tmpdir(), 'wing-blocked-profile-')), 'file');
    writeFileSync(blocked, 'fixture');
    const s = new SandboxProfileService(loggerStub, blocked), previous = s.getConfig();
    expect(() => s.setMode({ mode: previous.mode === 'read-only' ? 'danger-full-access' : 'read-only' })).toThrow();
    expect(s.getConfig()).toEqual(previous);
  });
  it('显式 danger-full-access：写类与命令面工具全部放行', () => {
    const s = makeService();
    s.setMode({ mode: 'danger-full-access' });
    expect(s.effectiveMode()).toBe('danger-full-access');
    expect(
      s.check({ toolName: 'file-write', args: { path: 'C:/any/where/x.txt' }, ctx: ctx('s1') })
        .allowed,
    ).toBe(true);
    expect(s.check({ toolName: 'bash', args: { command: 'ls' }, ctx: ctx('s1') }).allowed).toBe(
      true,
    );
  });

  it('read-only：写类与命令面拦截（提权审批），只读工具放行', () => {
    const s = makeService();
    s.setMode({ mode: 'read-only' });
    const c = ctx('s1');
    const blockedWrite = s.check({ toolName: 'file-write', args: { path: 'x.txt' }, ctx: c });
    expect(blockedWrite.allowed).toBe(false);
    expect(blockedWrite.rule).toBe('write-tool');
    expect(s.check({ toolName: 'file-edit', args: { path: 'x.txt' }, ctx: c }).rule).toBe(
      'write-tool',
    );
    expect(s.check({ toolName: 'file-delete', args: { path: 'x.txt' }, ctx: c }).rule).toBe(
      'write-tool',
    );
    expect(s.check({ toolName: 'bash', args: {}, ctx: c }).rule).toBe('command-tool');
    expect(s.check({ toolName: 'powershell', args: {}, ctx: c }).rule).toBe('command-tool');
    expect(s.check({ toolName: 'desktop', args: {}, ctx: c }).rule).toBe('command-tool');
    // 只读/检索类不受限
    expect(s.check({ toolName: 'file-read', args: { path: 'x.txt' }, ctx: c }).allowed).toBe(true);
    expect(s.check({ toolName: 'web-search', args: { query: 'q' }, ctx: c }).allowed).toBe(true);
  });

  it('workspace-write：工作区内写放行，工作区外拦截', () => {
    const s = makeService();
    s.setMode({ mode: 'workspace-write' });
    const root = 'D:/ws/project';
    const c = ctx('s1', root);
    // 工作区内（绝对路径）
    expect(
      s.check({ toolName: 'file-write', args: { path: 'D:/ws/project/src/a.ts' }, ctx: c }).allowed,
    ).toBe(true);
    // 相对路径按工作区根解析
    expect(s.check({ toolName: 'file-write', args: { path: 'src/a.ts' }, ctx: c }).allowed).toBe(
      true,
    );
    // 越界（.. 逃逸与外部绝对路径）
    const outside = s.check({
      toolName: 'file-write',
      args: { path: 'D:/elsewhere/a.ts' },
      ctx: c,
    });
    expect(outside.allowed).toBe(false);
    expect(outside.rule).toBe('outside-workspace');
    expect(
      s.check({ toolName: 'file-write', args: { path: '../escape.txt' }, ctx: c }).allowed,
    ).toBe(false);
    // 无路径参数无法判定 → 保守拦截
    expect(s.check({ toolName: 'file-write', args: {}, ctx: c }).allowed).toBe(false);
    // 命令面在 workspace-write 下放行（既有 CommandGuard/审批兜底）
    expect(s.check({ toolName: 'bash', args: {}, ctx: c }).allowed).toBe(true);
  });

  it('会话级覆盖优先于全局，清除后回落', () => {
    const s = makeService();
    s.setMode({ mode: 'read-only' });
    s.setSessionMode('s2', 'workspace-write');
    expect(s.effectiveMode('s2')).toBe('workspace-write');
    expect(s.effectiveMode('s1')).toBe('read-only');
    s.setSessionMode('s2', null);
    expect(s.effectiveMode('s2')).toBe('read-only');
  });

  it('预设应用与非法输入校验', () => {
    const s = makeService();
    s.setMode({ presetId: 'safe' });
    expect(s.getConfig()).toMatchObject({ mode: 'read-only', presetId: 'safe' });
    s.setMode({ presetId: 'standard' });
    expect(s.getConfig()).toMatchObject({ mode: 'workspace-write', presetId: 'standard' });
    expect(() => s.setMode({ presetId: 'nope' as never })).toThrow();
    expect(() => s.setMode({ mode: 'bogus' as never })).toThrow();
  });
});
