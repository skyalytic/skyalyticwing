import 'reflect-metadata';
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  mkdirSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readJsonRecover,
  writeJsonAtomicSync,
  writeJsonAtomic,
} from '../../src/modules/core/utils/atomic-json.util.js';
import {
  compactContext,
  COMPACTION_MARKER,
} from '../../src/modules/ai/agent/context-compaction.js';
import type { LlmMessage } from '../../src/modules/ai/types.js';
import { SessionService } from '../../src/modules/session/session.service.js';
import { ChannelRouterService } from '../../src/modules/channels/channel-router.service.js';
import { SandboxProfileService } from '../../src/modules/tools/sandbox/sandbox-profile.service.js';
import { parseWorktreePorcelain } from '../../src/modules/tools/worktree.service.js';
import { terminalShell } from '../../src/modules/terminal/terminal.service.js';
import { AuditJournal } from '../../src/modules/monitor/audit-journal.js';
import {
  FileRollbackError,
  recordFileCheckpoint,
  rollbackFileCheckpoints,
} from '../../src/modules/tools/files/checkpoint-store.js';

const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() } as any;
describe('durable execution foundations', () => {
  let dir: string;
  let previous: string | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sky-reliability-'));
    previous = process.env['SKYALYTICWING_DATA_DIR'];
    process.env['SKYALYTICWING_DATA_DIR'] = dir;
  });
  afterEach(() => {
    if (previous === undefined) delete process.env['SKYALYTICWING_DATA_DIR'];
    else process.env['SKYALYTICWING_DATA_DIR'] = previous;
  });

  it('recovers last valid snapshot after primary corruption', async () => {
    const path = join(dir, 'store.json');
    writeJsonAtomicSync(path, { version: 1 });
    await writeJsonAtomic(path, { version: 2 });
    expect(readJsonRecover(path, {})).toEqual({ version: 2 });
    writeFileSync(path, '{broken');
    expect(readJsonRecover(path, {})).toEqual({ version: 1 });
    writeJsonAtomicSync(path, { version: 3 });
    expect(JSON.parse(readFileSync(path + '.bak', 'utf8'))).toEqual({ version: 1 });
    expect(readdirSync(dir).some((p) => p.endsWith('.tmp'))).toBe(false);
  });

  it('does not silently empty a corrupt store without backup', () => {
    const path = join(dir, 'bad.json');
    writeFileSync(path, '{');
    expect(() => readJsonRecover(path, {})).toThrow();
  });

  it('reads Windows BOM-encoded JSON without discarding its contents', () => {
    const path = join(dir, 'windows.json');
    writeFileSync(path, '\uFEFF' + JSON.stringify({keep:'UTF-8'}), 'utf8');
    expect(readJsonRecover(path, {})).toEqual({keep:'UTF-8'});
    writeFileSync(path, '\uFEFF' + JSON.stringify({keep:'UTF-16'}), 'utf16le');
    expect(readJsonRecover(path, {})).toEqual({keep:'UTF-16'});
  });

  it('session shutdown awaits latest ordered snapshot', async () => {
    const store = new SessionService(logger);
    store.onModuleInit();
    const session = store.createSession('durable');
    store.addMessage(session.id, { id: 'a', role: 'user', content: 'first', timestamp: 1 });
    const first = store.flush();
    store.addMessage(session.id, { id: 'b', role: 'assistant', content: 'last', timestamp: 2 });
    await store.onModuleDestroy();
    await first;
    const restored = new SessionService(logger);
    restored.onModuleInit();
    expect(restored.getMessages(session.id).map((m) => m.content)).toEqual(['first', 'last']);
  });

  it('channel identity survives restart and keeps tuple boundaries', () => {
    const one = new ChannelRouterService();
    one.onModuleInit();
    const route = one.route('a:b', 'c');
    const two = new ChannelRouterService();
    two.onModuleInit();
    expect(two.route('a:b', 'c').sessionId).toBe(route.sessionId);
    expect(two.route('a', 'b:c').sessionId).not.toBe(route.sessionId);
  });

  it('rejects rollback over user or another session changes', async () => {
    const path = join(dir, 'edit.txt');
    recordFileCheckpoint(dir, path, 'old', 'agent');
    writeFileSync(path, 'human');
    await expect(rollbackFileCheckpoints(dir, 0)).rejects.toBeInstanceOf(FileRollbackError);
    expect(readFileSync(path, 'utf8')).toBe('human');
    writeFileSync(path, 'agent');
    await rollbackFileCheckpoints(dir, 0);
    expect(readFileSync(path, 'utf8')).toBe('old');
  });

  it('default profile requires approval for unclassified plugin tools', () => {
    const policy = new SandboxProfileService(logger, dir);
    const ctx = { sessionId: 's', workspace: dir } as any;
    expect(policy.effectiveMode()).toBe('workspace-write');
    expect(policy.check({ toolName: 'custom_exec', args: {}, ctx }).allowed).toBe(false);
    policy.setMode({ mode: 'read-only' });
    expect(policy.check({ toolName: 'file_write', args: { path: 'x' }, ctx }).allowed).toBe(false);
  });

  it('workspace writes cannot escape through directory links', () => {
    const root = join(dir, 'root'),
      outside = join(dir, 'outside');
    mkdirSync(root);
    mkdirSync(outside);
    symlinkSync(outside, join(root, 'link'), 'junction');
    const policy = new SandboxProfileService(logger, dir);
    expect(
      policy.check({
        toolName: 'file-write',
        args: { path: 'link/x.txt' },
        ctx: { workspace: root } as any,
      }).allowed,
    ).toBe(false);
  });

  it('journal persists decisions independently of debug logger', () => {
    new AuditJournal(dir).append({
      tool: 'file-write',
      decision: 'approved',
      policyVersion: 'v2',
      sessionId: 's',
    });
    const records = new AuditJournal(dir).recent();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ decision: 'approved', sessionId: 's' });
  });

  it('parses git worktree paths containing spaces without splitting them', () => {
    expect(
      parseWorktreePorcelain('worktree /tmp/my project\0HEAD abc\0branch refs/heads/main\0\0'),
    ).toEqual([{ path: '/tmp/my project', commit: 'abc', branch: 'main' }]);
  });
  it.each([
    ['win32', 'powershell.exe'],
    ['linux', '/bin/sh'],
    ['darwin', '/bin/zsh'],
  ])('selects platform shell %s', (platform, executable) => {
    expect(terminalShell(platform as NodeJS.Platform).executable).toBe(executable);
  });
});

describe('context compaction protocol', () => {
  const call: LlmMessage = {
    role: 'assistant',
    content: '',
    toolCalls: [{ id: 'c', type: 'function', function: { name: 'read', arguments: '{}' } }],
  };
  it('preserves tool call and result when the tail boundary crosses them', () => {
    const messages: LlmMessage[] = [
      { role: 'system', content: 'policy' },
      { role: 'user', content: 'goal' },
      { role: 'assistant', content: 'start' },
      call,
      { role: 'tool', toolCallId: 'c', content: 'result' },
      { role: 'user', content: 'continue' },
    ];
    const result = compactContext(messages, 2);
    expect(result.slice(-3)).toEqual(messages.slice(-3));
    expect(result.filter((m) => m.role === 'system')).toEqual([messages[0]]);
  });
  it('replaces old summaries and does not promote quoted instructions to system', () => {
    const messages: LlmMessage[] = [
      { role: 'system', content: 'policy' },
      { role: 'system', content: COMPACTION_MARKER + 'old' },
      ...Array.from({ length: 25 }, (_, i): LlmMessage => ({ role: 'user', content: `task ${i}` })),
    ];
    const result = compactContext(compactContext(messages, 4), 2);
    expect(
      result.filter(
        (m) => typeof m.content === 'string' && m.content.startsWith(COMPACTION_MARKER),
      ),
    ).toHaveLength(1);
    expect(result.filter((m) => m.role === 'system')).toEqual([
      { role: 'system', content: 'policy' },
    ]);
    expect(JSON.stringify(result)).toContain('task 24');
  });
});
