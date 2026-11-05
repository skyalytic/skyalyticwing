import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createVideoComposeTool } from '../../src/modules/tools/executor/built-in/video-compose.js';
import { runShell } from '../../src/extensions/bundled/shared/tools/shell-runner.js';
jest.mock('../../src/extensions/bundled/shared/tools/shell-runner.js', () => ({runShell: jest.fn()}));
describe('existing video composition (process mocked; never generates video)', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'wing-concat-test-')); jest.resetAllMocks(); });
  afterEach(() => rmSync(root, {recursive:true,force:true}));
  const tool = (allowed = true) => createVideoComposeTool({isPathAllowed: () => allowed} as never, {getAll: () => ({automation:{media:{video:{ffmpeg:{ffmpegPath:'custom-ffmpeg'}}}}})} as never);
  const context = () => ({ workspace:root,sessionId:'compose-test',config:{},log:()=>{},broadcast:()=>{} });
  const files = () => { const paths = [join(root,"a's.mp4"),join(root,'b.mp4')]; paths.forEach(p => writeFileSync(p,'fixture bytes')); return paths; };
  it('passes ordered quoted files and publishes a new output, removes only owned temporary files', async () => {
    const inputs = files();
    jest.mocked(runShell).mockImplementation(async (exe,args) => {
      expect(exe).toBe('custom-ffmpeg');
      const list = readFileSync(args[args.indexOf('-i')+1]!, 'utf8');
      expect(list).toContain("a'\\''s.mp4"); expect(list.indexOf('a')).toBeLessThan(list.indexOf('b.mp4'));
      writeFileSync(args.at(-1)!, 'mock merged bytes');
      return {success:true};
    });
    expect((await tool().execute({files:inputs,output:'result.mp4'},context())).success).toBe(true);
    expect(readFileSync(join(root,'result.mp4'),'utf8')).toBe('mock merged bytes');
    expect(readdirSync(root).some(name => name.startsWith('.wing-concat'))).toBe(false);
    expect((await tool().execute({files:inputs,output:'result.mp4'},context())).success).toBe(false);
    expect(runShell).toHaveBeenCalledTimes(1);
  });
  it('rejects denied paths and cancellation; missing FFmpeg leaves no output', async () => {
    const inputs = files();
    expect((await tool(false).execute({files:inputs,output:'result.mp4'},context())).success).toBe(false);
    const controller = new AbortController();controller.abort();
    expect((await tool().execute({files:inputs,output:'result.mp4'},{...context(),signal:controller.signal})).success).toBe(false);
    expect(runShell).not.toHaveBeenCalled();
    jest.mocked(runShell).mockResolvedValue({success:false,error:'spawn ENOENT'});
    const result = await tool().execute({files:inputs,output:'result.mp4'},context());
    expect(result.error).toContain('FFmpeg');
    expect(readdirSync(root)).toHaveLength(2);
  });
});
