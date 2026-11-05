import {
  filterModelToolCatalog,
  MODEL_TOOL_REDUNDANCIES,
  resolveModelToolName,
  TOOL_NAME_ALIASES,
} from '../../src/modules/tools/executor/model-tool-catalog.js';
import { createBuiltInTools } from '../../src/modules/tools/executor/built-in-tools.js';

describe('model tool catalog', () => {
  const named = (...names: string[]) => names.map(name => ({ name }));

  it('hides only covered image and status shortcuts without mutating the registry', async () => {
    const legacy = { name: 'image_generate', execute: jest.fn().mockResolvedValue('legacy result') };
    const registry = [legacy, { name: 'generate_image' }, { name: 'subagent_status' }, { name: 'subagents' }];
    expect(filterModelToolCatalog(registry).map(tool => tool.name)).toEqual(['generate_image', 'subagents']);
    expect(registry).toHaveLength(4);
    expect(await legacy.execute()).toBe('legacy result');
    expect(MODEL_TOOL_REDUNDANCIES['subagent_status'].replacementArguments).toEqual({ action: 'status' });
  });

  it('keeps a shortcut when permission or an agent allowlist excludes its replacement', () => {
    const allowed = named('image_generate', 'subagent_status', 'powershell');
    expect(filterModelToolCatalog(allowed)).toEqual(allowed);
  });

  it('keeps distinct shells, browsers, notifications and media while hiding legacy desktop menus', () => {
    const tools = named('bash', 'powershell', 'node', 'python', 'code_execution', 'sandbox_run',
      'desktop', 'computer_use', 'desktop_screenshot', 'desktop_windows', 'browser', 'browser_open', 'builtin_browser',
      'notify', 'notification', 'show_message', 'api_call', 'http_request', 'web-fetch', 'web_read',
      'generate_image', 'generate_video', 'render_code_video', 'concat_videos', 'inspect_video', 'get_video_task',
      'todo', 'update_plan', 'session_create', 'acp_session_create', 'sessions_spawn', 'subagent_execute');
    expect(filterModelToolCatalog(tools)).toEqual(tools.filter(t => !['desktop', 'desktop_windows', 'desktop_screenshot'].includes(t.name)));
  });

  it('preserves desktop diagnostics when computer_use is not exposed', () => {
    const legacy = named('desktop', 'desktop_windows', 'desktop_screenshot', 'uia_diagnostics');
    expect(filterModelToolCatalog(legacy)).toEqual(legacy);
  });

  it('does not evaluate lazy descriptions or clone dynamic definitions', () => {
    const getter = jest.fn(() => 'current providers');
    const dynamic = { name: 'generate_image', get description() { return getter(); } };
    expect(filterModelToolCatalog([dynamic])[0]).toBe(dynamic);
    expect(getter).not.toHaveBeenCalled();
  });

  it('repairs legacy spellings to actual registered names instead of nonexistent underscore names', () => {
    const available = named('file-read', 'file-write', 'file-edit', 'file-delete', 'directory-list', 'web-fetch', 'todo');
    expect(resolveModelToolName('read', available)).toBe('file-read');
    expect(resolveModelToolName('FILE_READ', available)).toBe('file-read');
    expect(resolveModelToolName('write', available)).toBe('file-write');
    expect(resolveModelToolName('edit', available)).toBe('file-edit');
    expect(resolveModelToolName('file_delete', available)).toBe('file-delete');
    expect(resolveModelToolName('ls', available)).toBe('directory-list');
    expect(resolveModelToolName('fetch', available)).toBe('web-fetch');
    expect(resolveModelToolName('todos', available)).toBe('todo');
    expect(TOOL_NAME_ALIASES['todo_write']).toBe('todo');
  });

  it('never repairs to a disabled or absent capability, or overrides an exact external tool', () => {
    expect(resolveModelToolName('read', named('powershell'))).toBe('read');
    expect(resolveModelToolName('read', named('read', 'file-read'))).toBe('read');
    expect(resolveModelToolName('READ', named('read', 'file-read'))).toBe('read');
    expect(resolveModelToolName('image_generate', named('generate_image'))).toBe('image_generate');
  });

  it('keeps every repair destination registered and preserves unique built-in names', () => {
    // Factories only construct definitions; no tool is executed and no provider is called.
    const tools = createBuiltInTools({
      security: {}, http: {}, ws: {}, config: { get: () => undefined }, safety: {}, resolve: () => undefined,
    } as never);
    const registered = new Set(tools.map(tool => tool.name));
    expect(registered.size).toBe(tools.length);
    for (const destination of Object.values(TOOL_NAME_ALIASES)) expect(registered.has(destination)).toBe(true);
    const visible = filterModelToolCatalog(tools);
    expect(tools.length - visible.length).toBe(Object.entries(MODEL_TOOL_REDUNDANCIES).filter(([name, rule]) => registered.has(name) && registered.has(rule.replacement)).length);
    for (const name of ['computer_use', 'powershell', 'ask_user', 'render_code_video']) {
      expect(visible.some(tool => tool.name === name)).toBe(true);
    }
  });
});
