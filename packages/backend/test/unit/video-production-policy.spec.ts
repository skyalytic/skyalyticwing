import {updateVideoCodeOnly} from '../../src/modules/ai/agent/video-production-policy.js';
import {createMediaTools} from '../../src/modules/tools/executor/built-in/media.js';
describe('code video preference',()=>{
  it('keeps explicit model prohibition until user explicitly changes it',()=>{
    expect(updateVideoCodeOnly(false,'不要用视频模型，做一个图表动画')).toBe(true);
    expect(updateVideoCodeOnly(false,'只用代码生成视频')).toBe(true);
    expect(updateVideoCodeOnly(false,"Don't use video generation models")).toBe(true);
    expect(updateVideoCodeOnly(true,'继续，改成蓝色')).toBe(true);
    expect(updateVideoCodeOnly(true,'现在允许视频模型')).toBe(false);
    expect(updateVideoCodeOnly(false,'不要用视频模型，改用视频模型')).toBe(false);
    expect(updateVideoCodeOnly(false,'视频模型与代码渲染有什么区别')).toBe(false);
  });
  it('refuses a prohibited video submission before resolving any media service',async()=>{
    const resolver=jest.fn();
    const tool=createMediaTools({} as never,{} as never,resolver).find(t=>t.name==='generate_video')!;
    const result=await tool.execute({prompt:'a cat'},{videoCodeOnly:true,workspace:'.',sessionId:'code',config:{},log:()=>{},broadcast:()=>{}});
    expect(result.blocked).toBe(true);expect(result.error).toContain('render_code_video');expect(resolver).not.toHaveBeenCalled();
  });
});
