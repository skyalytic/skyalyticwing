import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveMediaBinary } from '../../src/modules/core/utils/ffmpeg-runtime.util.js';
import * as runtime from '../../src/modules/core/utils/ffmpeg-runtime.util.js';
import { createVideoInspectionTool } from '../../src/modules/tools/executor/built-in/video-compose.js';
import { selectLocalVideoEncoder } from '../../src/modules/automation/video-provider.service.js';
describe('bundled media inspection', () => {
  afterEach(() => jest.restoreAllMocks());
  it('honors explicit configured binaries', () => {
    expect(resolveMediaBinary('ffmpeg','/custom/ffmpeg')).toEqual({path:'/custom/ffmpeg',source:'configured'});
  });
  it('does not require the GPL x264 encoder for the bundled LGPL runtime', () => {
    expect(selectLocalVideoEncoder(' V..... libopenh264 OpenH264\n V..... mpeg4 MPEG4')).toBe('libopenh264');
    expect(selectLocalVideoEncoder(' V..... h264_videotoolbox VideoToolbox')).toBe('h264_videotoolbox');
    expect(() => selectLocalVideoEncoder('')).toThrow('编码器');
  });
  it('checks both programs without requesting media generation', async () => {
    jest.spyOn(runtime,'resolveMediaBinary').mockImplementation(name => ({path:'/bundled/'+name,source:'bundled'}));
    const read = jest.spyOn(runtime,'readMediaTool').mockImplementation(async binary => binary+' version test');
    const tool = createVideoInspectionTool({isPathAllowed:()=>true} as never,{getAll:()=>({})} as never);
    const result = await tool.execute({}, {workspace:'.',sessionId:'test'} as never);
    expect(result.success).toBe(true);
    expect(read.mock.calls.map(call=>call[1])).toEqual([['-version'],['-version']]);
  });
  it('reads metadata of an existing allowed file and rejects denied files', async () => {
    const directory = mkdtempSync(join(tmpdir(),'wing-probe-test-'));
    try {
      const file = join(directory,'existing.mp4');writeFileSync(file,'fixture');
      jest.spyOn(runtime,'resolveMediaBinary').mockImplementation(name => ({path:'/bundled/'+name,source:'bundled'}));
      const read = jest.spyOn(runtime,'readMediaTool').mockImplementation(async (_binary,args) => args.includes('-version')?'version':JSON.stringify({format:{duration:'5'},streams:[{codec_type:'video'}]}));
      const context = {workspace:directory,sessionId:'test'} as never;
      const denied = createVideoInspectionTool({isPathAllowed:()=>false} as never,{getAll:()=>({})} as never);
      expect((await denied.execute({path:file},context)).success).toBe(false);
      expect(read.mock.calls.every(call=>call[1].includes('-version'))).toBe(true);
      const allowed = createVideoInspectionTool({isPathAllowed:()=>true} as never,{getAll:()=>({})} as never);
      expect((await allowed.execute({path:file},context)).success).toBe(true);
      expect(read.mock.calls.at(-1)![1]).toContain('-show_streams');
    } finally { rmSync(directory,{recursive:true,force:true}); }
  });
});
