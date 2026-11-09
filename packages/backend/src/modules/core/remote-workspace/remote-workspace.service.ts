import { Injectable, Optional, OnModuleDestroy } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
} from 'node:fs';
import { join, dirname, posix } from 'node:path';
import { getDefaultDataDir } from '../utils/web-data.util.js';
import { removeSessionProjectDir } from '../config/session-project.store.js';
import { LocalResourcePolicy } from '../../core/security/local-resource-policy.service.js';
import {
  RemoteConnection,
  remoteLaunch,
  shellQuote,
  validateTarget,
  type RemoteWorkspace,
} from './remote-connections.js';
import { globToRegExp } from '../../../extensions/bundled/shared/tools/glob-utils.js';
import { remoteRuntimeShell } from './remote-runtime.js';
import { remoteOfficeTool, readRemoteDocument } from './remote-office.js';
import { remoteOfficeSource } from './remote-office-source.js';
import { remoteTextTool } from './remote-text-tools.js';
type State = { workspaces: RemoteWorkspace[]; bindings: Record<string, string> };
const supported: Record<string, string> = {
  'file-read': 'read',
  'file-write': 'write',
  'file-edit': 'edit',
  'file-delete': 'delete',
  'directory-list': 'list',
  'file-list': 'list',
  grep: 'search',
  glob: 'search',
  bash: 'exec',
  office_read: 'office',
  office_edit: 'office',
  doc_generate: 'office',
  office_live: 'live',
  repo_inspect: 'repo-inspect',
  repo_verify: 'repo-verify',
  apply_patch: 'text',
  diff: 'text',
};
const localAllowed = new Set([
  'builtin_browser',
  'computer_use',
  'node_repl',
  'node_repl_reset',
  'computer_use_confirm',
  'desktop',
  'desktop_screenshot',
  'web-search',
  'web_search',
  'web-fetch',
  'web_fetch',
  'request_user_input',
  'ask_user',
  'todo',
  'update_plan',
  'task_journal',
  'notify',
  'btw_ask',
  'memory_search',
  'memory_get',
  'memory_save',
  'knowledge_search',
  'knowledge_add',
  'skill_list',
  'skill_create',
  'skill_execute',
  'cron_create',
  'cron_update',
  'cron_delete',
  'cron_list',
  'cron_toggle',
  'cron_run_now',
  'cron_delivery',
  'mcp_list',
  'mcp_start',
  'mcp_stop',
  'mcp_call',
  'mcp_resources',
  'mcp_resource_read',
  'mcp_loopback_start',
  'mcp_loopback_status',
  'mcp_loopback_stop',
  'mcp_conversations_list',
  'session_list',
  'session_history',
  'session_status',
  'plugin_list',
  'sandbox_status',
]);
export const usesLocalHost = (name: string) => localAllowed.has(name);
const orchestration = new Set([
  'subagent_execute',
  'subagent_spawn_swarm',
  'subagent_create',
  'subagent_status',
  'subagents',
  'sessions_spawn',
]);
export function remoteSandboxGate(mode: string, name: string, root: string, args: any) {
  const read =
    [
      'file-read',
      'directory-list',
      'file-list',
      'grep',
      'glob',
      'office_read',
      'diff',
      'repo_inspect',
    ].includes(name) ||
    (name === 'office_live' && args?.action === 'read_selection');
  if (mode === 'danger-full-access' || read) return { allowed: true, rule: 'remote' };
  if (mode === 'read-only')
    return { allowed: false, rule: 'remote-read-only', reason: '只读工作区需要批准修改操作' };
  if (name === 'bash' || name === 'repo_verify' || !supported[name])
    return {
      allowed: false,
      rule: 'remote-command',
      reason: '远程命令需要逐次批准；远程主机未提供本地容器沙箱',
    };
  const paths =
    name === 'file-delete'
      ? args?.paths
      : [
          name === 'doc_generate'
            ? args?.outputPath || '.'
            : name === 'apply_patch'
              ? args?.file_path
              : args?.path,
        ];
  const allowed =
    Array.isArray(paths) &&
    paths.length > 0 &&
    paths.every((value) => {
      if (typeof value !== 'string' || !value || value.includes('\0')) return false;
      const relative = posix.relative(root, posix.resolve(root, value));
      return relative !== '..' && !relative.startsWith('../');
    });
  return { allowed, rule: 'remote-path', reason: '路径必须位于远程工作区内' };
}
@Injectable()
export class RemoteWorkspaceService implements OnModuleDestroy {
  private readonly connections = new Map<string, RemoteConnection>();
  private readonly observed = new Map<string, string | null>();
  private readonly inherited = new Map<
    string,
    {
      parent: string;
      sourceId: string;
      identity: string;
      mode: 'shared' | 'isolated';
      workspaceId?: string;
    }
  >();
  private readonly preparing = new Map<string, Promise<RemoteWorkspace | undefined>>();
  private activeIdentity = '';
  constructor(@Optional() private readonly policy?: LocalResourcePolicy) {}
  private identity() {
    const identity = this.policy?.credentialIdentity() ?? 'local';
    if (this.activeIdentity && identity !== this.activeIdentity) {
      for (const c of this.connections.values()) c.close('Account changed');
      this.connections.clear();
    }
    this.activeIdentity = identity;
    return identity;
  }
  private file() {
    return join(
      getDefaultDataDir(),
      'remote-workspaces',
      createHash('sha256').update(this.identity()).digest('hex') + '.json',
    );
  }
  private state(): State {
    const file = this.file();
    if (!existsSync(file)) return { workspaces: [], bindings: {} };
    const value = JSON.parse(readFileSync(file, 'utf8')) as State;
    if (!Array.isArray(value.workspaces) || !value.bindings || typeof value.bindings !== 'object')
      throw Error('Invalid remote workspace store');
    return value;
  }
  private save(value: State) {
    const file = this.file();
    mkdirSync(dirname(file), { recursive: true });
    const temp = file + '.' + randomUUID() + '.tmp';
    try {
      writeFileSync(temp, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
      renameSync(temp, file);
    } finally {
      if (existsSync(temp)) unlinkSync(temp);
    }
  }
  private key(workspace: RemoteWorkspace) {
    return JSON.stringify([
      this.identity(),
      workspace.id,
      workspace.transport,
      workspace.target,
      workspace.port ?? 22,
    ]);
  }
  private open(workspace: RemoteWorkspace) {
    return new RemoteConnection(workspace);
  }
  list(sessionId?: string) {
    const state = this.state();
    return {
      workspaces: state.workspaces,
      bound: sessionId ? (state.bindings[sessionId] ?? null) : null,
      connected: state.workspaces
        .filter((w) => {
          const c = this.connections.get(this.key(w));
          return c && !c.closed;
        })
        .map((w) => w.id),
    };
  }
  binding(sessionId?: string): RemoteWorkspace | undefined {
    if (!sessionId) return undefined;
    const inherited = this.inherited.get(sessionId);
    if (inherited) {
      if (inherited.identity !== this.identity())
        throw Error('Remote task belongs to another account');
      const parent = this.binding(inherited.parent);
      if (!parent || parent.id !== inherited.sourceId)
        throw Error('Parent remote workspace changed; task stopped');
      if (inherited.mode === 'shared') return parent;
      if (!inherited.workspaceId) throw Error('Remote isolated workspace is not prepared');
      return this.get(inherited.workspaceId);
    }
    const s = this.state(),
      id = s.bindings[sessionId];
    if (!id) return undefined;
    const workspace = s.workspaces.find((w) => w.id === id);
    if (!workspace) throw Error('Remote workspace binding is missing');
    return workspace;
  }
  inherit(parent: string, child: string, mode: 'shared' | 'isolated' = 'isolated') {
    const workspace = this.binding(parent);
    if (!workspace) return;
    if (parent === child || this.inherited.has(child)) throw Error('Invalid remote child binding');
    this.inherited.set(child, { parent, sourceId: workspace.id, identity: this.identity(), mode });
  }
  hasChild(child: string) {
    return this.inherited.has(child);
  }
  async prepareChild(child: string): Promise<RemoteWorkspace | undefined> {
    const record = this.inherited.get(child);
    if (!record) return this.binding(child);
    if (record.mode === 'shared' || record.workspaceId) return this.binding(child);
    const pending = this.preparing.get(child);
    if (pending) return pending;
    const preparing = (async () => {
      if (record.identity !== this.identity())
        throw Error('Remote task belongs to another account');
      const source = this.binding(record.parent);
      if (!source || source.id !== record.sourceId)
        throw Error('Parent remote workspace changed; task stopped');
      const token = createHash('sha256')
        .update(JSON.stringify([getDefaultDataDir(), record.identity, source.id, child]))
        .digest('hex');
      const workspace: RemoteWorkspace = {
        id: token,
        name: source.name + ' / ' + child,
        transport: source.transport,
        target: source.target,
        ...(source.port ? { port: source.port } : {}),
        root: source.root,
      };
      const connection = this.open(workspace);
      this.connections.set(this.key(workspace), connection);
      const created = await connection.request(source.root, 'worktree-create', { token });
      if (record.identity !== this.identity()) throw Error('Account changed');
      workspace.root = created.root;
      workspace.worktree = {
        sourceId: source.id,
        token,
        baseHead: created.baseHead,
        checkout: created.checkout,
        childSessionId: child,
      };
      const state = this.state();
      if (!state.workspaces.some((w) => w.id === workspace.id)) state.workspaces.push(workspace);
      // Retain task output for review, even if cancellation arrived during creation.
      if (this.inherited.get(child) === record) {
        record.workspaceId = workspace.id;
        state.bindings[child] = workspace.id;
      }
      this.save(state);
      if (this.inherited.get(child) !== record) {
        connection.close();
        throw Error('Remote child was cancelled');
      }
      return this.binding(child);
    })();
    this.preparing.set(child, preparing);
    try {
      return await preparing;
    } finally {
      this.preparing.delete(child);
    }
  }
  release(child: string) {
    const record = this.inherited.get(child);
    if (record?.workspaceId && record.identity === this.identity()) {
      const state = this.state(),
        workspace = state.workspaces.find((w) => w.id === record.workspaceId);
      if (workspace) this.connections.get(this.key(workspace))?.close('Remote child released');
      delete state.bindings[child];
      this.save(state);
    }
    this.inherited.delete(child);
  }
  private get(id: string) {
    const w = this.state().workspaces.find((w) => w.id === id);
    if (!w) throw Error('Remote workspace not found');
    return w;
  }
  async create(input: Omit<RemoteWorkspace, 'id'>) {
    validateTarget(input);
    if (
      typeof input.root !== 'string' ||
      !input.root.startsWith('/') ||
      input.root.includes('\0') ||
      input.root.length > 4096
    )
      throw Error('Absolute POSIX workspace path required');
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 100)
      throw Error('Workspace name required');
    const workspace: RemoteWorkspace = {
      id: randomUUID(),
      name: input.name.trim(),
      transport: input.transport,
      target: input.target,
      root: posix.normalize(input.root),
      ...(input.port ? { port: input.port } : {}),
    };
    const identity = this.identity(),
      key = this.key(workspace);
    let connection = this.connections.get(key);
    if (!connection || connection.closed) {
      connection = this.open(workspace);
      this.connections.set(key, connection);
    }
    const hello = await connection.request(workspace.root, 'hello');
    if (identity !== this.identity()) throw Error('Account changed');
    if (hello.platform === 'win32') throw Error('Remote workspace requires a POSIX host or WSL');
    workspace.root = hello.root;
    const state = this.state();
    state.workspaces.push(workspace);
    this.save(state);
    return workspace;
  }
  async connect(id: string) {
    const w = this.get(id),
      key = this.key(w);
    let connection = this.connections.get(key);
    if (!connection || connection.closed) {
      connection = this.open(w);
      this.connections.set(key, connection);
    }
    return connection.request(w.root, 'hello');
  }
  disconnect(id: string) {
    const w = this.get(id);
    this.connections.get(this.key(w))?.close();
    return { closed: true };
  }
  async bind(sessionId: string, id: string | null) {
    if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 200)
      throw Error('Session required');
    const identity = this.identity();
    const old = this.binding(sessionId);
    if (old && old.id !== id) this.disconnect(old.id);
    if (id) await this.connect(id);
    if (identity !== this.identity()) throw Error('Account changed');
    const state = this.state();
    if (id) state.bindings[sessionId] = id;
    else delete state.bindings[sessionId];
    this.save(state);
    if (id) removeSessionProjectDir(sessionId);
    return { bound: id };
  }
  unbind(sessionId?: string) {
    if (!sessionId) return;
    const state = this.state();
    if (!state.bindings[sessionId]) return;
    this.disconnect(state.bindings[sessionId]!);
    delete state.bindings[sessionId];
    this.save(state);
  }
  async remove(id: string) {
    const state = this.state();
    if (Object.values(state.bindings).includes(id))
      throw Error('Unbind workspace before removing it');
    if (state.workspaces.some((w) => w.worktree?.sourceId === id))
      throw Error('Remove child worktrees before removing their source workspace');
    const workspace = this.get(id);
    if (workspace.worktree) {
      await this.connect(workspace.worktree.sourceId);
      await this.request(workspace.worktree.sourceId, 'worktree-remove', {
        token: workspace.worktree.token,
      });
    }
    this.disconnect(id);
    const latest = this.state();
    latest.workspaces = latest.workspaces.filter((w) => w.id !== id);
    this.save(latest);
    return { removed: true };
  }
  async request(id: string, op: string, args: Record<string, unknown> = {}, signal?: AbortSignal) {
    const identity = this.identity(),
      w = this.get(id),
      connection = this.connections.get(this.key(w));
    if (!connection || connection.closed) throw Error('远程工作区未连接，请重新连接');
    const result = await connection.request(w.root, op, args, signal);
    if (identity !== this.identity()) throw Error('Account changed');
    return result;
  }
  async tool(sessionId: string, name: string, args: any, signal?: AbortSignal) {
    const w = this.binding(sessionId);
    if (!w) return undefined;
    const op = supported[name];
    if (op === 'office')
      return remoteOfficeTool(w.root, name, args, async (operation, parameters) => {
        if (signal?.aborted) throw Error('Remote request cancelled');
        if (this.binding(sessionId)?.id !== w.id) throw Error('Remote workspace changed');
        return this.request(w.id, operation, parameters, signal);
      });
    if (op === 'text') {
      const path =
        typeof args?.file_path === 'string' ? posix.resolve(w.root, args.file_path) : null;
      const key = JSON.stringify([this.identity(), w.id, sessionId, path]);
      const result = await remoteTextTool(
        name,
        args,
        async (operation, parameters) => {
          if (signal?.aborted) throw Error('Remote request cancelled');
          if (this.binding(sessionId)?.id !== w.id) throw Error('Remote workspace changed');
          return this.request(w.id, operation, parameters, signal);
        },
        this.observed.get(key),
      );
      if (name === 'apply_patch') {
        this.observed.set(key, (result.data as { revision: string }).revision);
        while (this.observed.size > 10000) this.observed.delete(this.observed.keys().next().value!);
      }
      return result;
    }
    if (op === 'live') return undefined;
    if (!op) {
      if (localAllowed.has(name) || orchestration.has(name)) return undefined;
      throw Error(
        '工具 ' +
          name +
          ' 尚未声明远程执行能力，未在本机执行。远程文件使用文件工具，远程命令使用 bash。',
      );
    }
    if (name === 'file-delete') {
      if (
        !Array.isArray(args?.paths) ||
        !args.paths.length ||
        !remoteSandboxGate('workspace-write', name, w.root, args).allowed
      )
        throw Error('Valid workspace paths required');
      const deleted: string[] = [],
        errors: string[] = [];
      for (const path of args.paths) {
        try {
          await this.request(w.id, 'delete', { path }, signal);
          deleted.push(path);
        } catch (error) {
          errors.push(path + ': ' + String(error instanceof Error ? error.message : error));
          if (signal?.aborted) break;
        }
      }
      return {
        success: errors.length === 0,
        data: { deleted, errors },
        output: JSON.stringify({ deleted, errors }),
        ...(errors.length ? { error: errors.join('\n') } : {}),
      };
    }
    const key = JSON.stringify([
      this.identity(),
      w.id,
      sessionId,
      typeof args?.path === 'string' ? posix.resolve(w.root, args.path) : null,
    ]);
    const requestArgs = { ...args, ...(name === 'glob' ? { kind: 'glob' } : {}) };
    if (name === 'file-write' || name === 'file-edit') {
      const expected = args?.expectedVersion ?? this.observed.get(key);
      if (expected !== undefined) requestArgs.revision = expected === 'missing' ? null : expected;
      else if (sessionId.startsWith('sub-')) requestArgs.revision = null;
    }
    const data = await this.request(w.id, op, requestArgs, signal);
    if (
      ['file-read', 'file-write', 'file-edit'].includes(name) &&
      typeof data.revision === 'string'
    ) {
      data.version = data.revision;
      this.observed.set(key, data.revision);
      while (this.observed.size > 10000) this.observed.delete(this.observed.keys().next().value!);
    }
    if (name === 'directory-list' && Array.isArray(args?.ignore)) {
      const ignore = args.ignore
        .filter((p: unknown) => typeof p === 'string' && p.length > 0)
        .map((p: string) => globToRegExp(p));
      data.entries = data.entries.filter(
        (entry: { name: string }) => !ignore.some((pattern: RegExp) => pattern.test(entry.name)),
      );
    }
    return {
      success:
        op === 'exec' || op === 'repo-verify' || op === 'search'
          ? data.exitCode === 0 || (op === 'search' && data.exitCode === 1)
          : true,
      data,
      output: typeof data.content === 'string' ? data.content : JSON.stringify(data),
      ...(data.timedOut ? { success: false, error: 'Remote command timed out' } : {}),
    };
  }
  async office(id: string, name: 'office_read' | 'office_edit', args: Record<string, unknown>) {
    const workspace = this.get(id);
    const result = await remoteOfficeTool(workspace.root, name, args, (op, parameters) =>
      this.request(id, op, parameters),
    );
    if (!result.success) throw Error(result.error || 'Remote document operation failed');
    return result.data;
  }
  officeSource(id: string, path: string) {
    const w = this.get(id),
      owner = this.identity(),
      descriptor = JSON.stringify(w);
    const check = () => {
      if (owner !== this.identity() || JSON.stringify(this.get(id)) !== descriptor)
        throw Error('Office document belongs to another account or workspace');
    };
    return remoteOfficeSource(
      JSON.stringify([owner, id]),
      w.root,
      path,
      check,
      async (op, args) => {
        check();
        return this.request(id, op, args);
      },
    );
  }
  async documentBytes(id: string, path: string) {
    if (
      typeof path !== 'string' ||
      !['.docx', '.xlsx', '.pptx', '.pdf'].includes(posix.extname(path).toLowerCase())
    )
      throw Error('Unsupported document format');
    this.get(id);
    return readRemoteDocument((op, args) => this.request(id, op, args), path);
  }
  terminal(sessionId: string) {
    const w = this.binding(sessionId);
    if (!w) throw Error('Remote workspace not bound');
    const owner = this.identity();
    const guard = () => {
      if (owner !== this.identity() || this.binding(sessionId)?.id !== w.id)
        throw Error('Remote terminal belongs to another account or workspace');
    };
    return {
      ...remoteLaunch(
        w,
        [
          'sh',
          '-c',
          remoteRuntimeShell([
            'sh',
            '-c',
            'cd ' + shellQuote(w.root) + ' && exec "${SHELL:-/bin/sh}"',
          ]),
        ],
        true,
      ),
      cwd: w.root,
      guard,
    };
  }
  onModuleDestroy() {
    for (const c of this.connections.values()) c.close();
    this.connections.clear();
  }
}
