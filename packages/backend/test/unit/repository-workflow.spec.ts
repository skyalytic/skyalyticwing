import 'reflect-metadata';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepositoryTools } from '../../src/modules/tools/executor/built-in/repository-tools';
import { ChatControlRegistry } from '../../src/modules/ai/chat/chat-control.registry';

describe('real repository task workflow', () => {
  let root: string, tools: ReturnType<typeof createRepositoryTools>;
  const sessionId = 'repo-test';
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'wing-repository-'));
    execFileSync('git', ['init', '--quiet', root], { windowsHide: true });
    writeFileSync(join(root, 'sum.cjs'), 'exports.sum=(a,b)=>a-b;\n');
    writeFileSync(
      join(root, 'sum.test.cjs'),
      "const assert=require('node:assert/strict'); const {sum}=require('./sum.cjs'); assert.equal(sum(2,3),5);\n",
    );
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ scripts: { test: 'node sum.test.cjs' } }),
    );
    execFileSync('git', ['add', '.'], { cwd: root, windowsHide: true });
    execFileSync(
      'git',
      [
        '-c',
        'user.email=test@example.invalid',
        '-c',
        'user.name=Fixture',
        'commit',
        '--quiet',
        '-m',
        'fixture',
      ],
      { cwd: root, windowsHide: true },
    );
    tools = createRepositoryTools(
      { isPathAllowed: () => true, isCommandAllowed: () => true } as any,
      () => undefined,
    );
  });
  afterEach(() => {
    ChatControlRegistry.clearAbort(sessionId);
    rmSync(root, { recursive: true, force: true });
  });
  const ctx = () =>
    ({ sessionId, workspace: root, config: {}, log: () => {}, broadcast: () => {} }) as any;
  it('discovers a repository, runs failing tests, records fixed tests and actual changed files', async () => {
    const inspect = await tools.find((t) => t.name === 'repo_inspect')!.execute({}, ctx());
    expect((inspect.data as any).files).toContain('sum.cjs');
    expect((inspect.data as any).commands[0]).toEqual({
      label: 'test',
      command: 'npm',
      args: ['run', 'test'],
    });
    const verify = tools.find((t) => t.name === 'repo_verify')!;
    const failed = await verify.execute(
      { command: process.execPath, args: ['sum.test.cjs'] },
      ctx(),
    );
    expect(failed.success).toBe(false);
    expect((failed.data as any).exitCode).not.toBe(0);
    writeFileSync(join(root, 'sum.cjs'), 'exports.sum=(a,b)=>a+b;\n');
    const passed = await verify.execute(
      { command: process.execPath, args: ['sum.test.cjs'] },
      ctx(),
    );
    expect(passed.success).toBe(true);
    expect((passed.data as any).exitCode).toBe(0);
    expect((passed.data as any).after.diff).toContain('+exports.sum=(a,b)=>a+b');
    expect(typeof readFileSync((passed.data as any).outputPath, 'utf8')).toBe('string');
  }, 30000);
  it('passes literal arguments without interpreting shell metacharacters', async () => {
    writeFileSync(
      join(root, 'args.cjs'),
      "require('node:assert/strict').equal(process.argv[2], 'space & ; $(echo injection)');",
    );
    const result = await tools
      .find((t) => t.name === 'repo_verify')!
      .execute(
        { command: process.execPath, args: ['args.cjs', 'space & ; $(echo injection)'] },
        ctx(),
      );
    expect(result.success).toBe(true);
  }, 15000);
  it('stops a running repository process', async () => {
    writeFileSync(join(root, 'long.cjs'), 'setInterval(()=>{},1000)');
    const controller = new AbortController();
    const promise = tools
      .find((t) => t.name === 'repo_verify')!
      .execute(
        { command: process.execPath, args: ['long.cjs'] },
        { ...ctx(), signal: controller.signal },
      );
    const timer = setTimeout(() => controller.abort(), 1000);
    try {
      const result = await promise;
      expect(result.success).toBe(false);
      expect((result.data as any)?.cancelled ?? result.error?.includes('aborted')).toBeTruthy();
    } finally {
      clearTimeout(timer);
    }
  }, 20000);
});
