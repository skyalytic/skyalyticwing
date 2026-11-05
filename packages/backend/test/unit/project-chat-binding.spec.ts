import 'reflect-metadata';
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FilesService } from '../../src/modules/tools/files/files.service.js';
import { SessionService } from '../../src/modules/session/session.service.js';
import { resolveEffectiveWorkspace } from '../../src/modules/core/config/effective-workspace.util.js';
describe('project and conversation persistence', () => {
  let directory: string,
    previous: string | undefined,
    files: FilesService,
    sessions: SessionService;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'wing-projects-'));
    previous = process.env['SKYALYTICWING_DATA_DIR'];
    process.env['SKYALYTICWING_DATA_DIR'] = directory;
    files = new FilesService(
      { addAllowedPath: jest.fn() } as never,
      { get: () => ({ projectDir: directory }) } as never,
    );
    sessions = new SessionService({ info: jest.fn(), warn: jest.fn(), error: jest.fn() } as never);
    sessions.onModuleInit();
  });
  afterEach(async () => {
    await sessions.onModuleDestroy();
    if (previous === undefined) delete process.env['SKYALYTICWING_DATA_DIR'];
    else process.env['SKYALYTICWING_DATA_DIR'] = previous;
  });
  it('keeps project labels separate from folder paths, preserves empty projects, and never renames folders', () => {
    const folder = join(directory, 'sample-project');
    mkdirSync(folder);
    expect(files.saveProject(folder).name).toBe('sample-project');
    files.saveProject(folder, 'My project');
    expect(files.listProjects()).toEqual([{ path: folder, name: 'My project' }]);
    expect(existsSync(folder)).toBe(true);
    expect(JSON.parse(readFileSync(join(directory, 'projects.json'), 'utf8'))[0].name).toBe(
      'My project',
    );
  });
  it('binds multiple chats to one project, preserves binding on fork, and keeps ordinary chats independent', () => {
    const folder = join(directory, 'project');
    mkdirSync(folder);
    const a = sessions.createSession(),
      b = sessions.createSession(),
      plain = sessions.createSession();
    files.setProjectDir(folder, a.id);
    files.setProjectDir(folder, b.id);
    expect(sessions.listSessions().find((s) => s.id === a.id)?.projectDir).toBe(folder);
    expect(sessions.forkSession(a.id, Date.now())?.projectDir).toBe(folder);
    expect(files.resolveProjectDir(plain.id)).toEqual({ path: '', source: '' });
    expect(resolveEffectiveWorkspace('agent', plain.id)).not.toBe(folder);
    expect(resolveEffectiveWorkspace('agent', plain.id)).not.toBe(directory);
    sessions.deleteSession(a.id);
    expect(files.resolveProjectDir(b.id).path).toBe(folder);
    expect(existsSync(folder)).toBe(true);
  });
  it('removes only the project entry, keeps chats and files, and stays removed after a refresh', () => {
    const folder = join(directory, 'keep-files'); mkdirSync(folder);
    writeFileSync(join(folder, 'document.txt'), 'keep this content');
    const chat = sessions.createSession(); files.setProjectDir(folder, chat.id);
    files.saveProject(folder, 'Display name');
    expect(files.removeProject(folder)).toEqual({removed:true});
    expect(files.listProjects()).toEqual([]);
    expect(files.listProjects()).toEqual([]);
    expect(sessions.listSessions().find(s=>s.id===chat.id)?.projectDir).toBe(folder);
    expect(files.resolveProjectDir(chat.id).path).toBe(folder);
    expect(readFileSync(join(folder, 'document.txt'), 'utf8')).toBe('keep this content');
    expect(files.removeProject(folder)).toEqual({removed:false});
    files.saveProject(folder);
    expect(files.listProjects()).toEqual([{path:folder,name:'Display name'}]);
  });
  it('can remove a stale project whose folder no longer exists, and rejects an invalid path', () => {
    const folder=join(directory,'stale');mkdirSync(folder);files.saveProject(folder);rmdirSync(folder);
    expect(files.removeProject(folder)).toEqual({removed:true});
    expect(files.listProjects()).toEqual([]);
    expect(()=>files.removeProject('')).toThrow('项目路径无效');
    expect(()=>files.removeProject('bad\0path')).toThrow('项目路径无效');
  });
});
