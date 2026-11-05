import {toolAvailabilityPrompt} from '../../src/modules/ai/agent/tool-availability';
describe('current tool availability prompt', () => {
  it('explains installation and enabled permissions when no operation tools are available', () => {
    for(const tools of [undefined, [], [{name:'task_verify'}] as any]){
      const prompt=toolAvailabilityPrompt(tools);
      expect(prompt).toContain('本轮没有可调用的操作工具');
      expect(prompt).toContain('工具页安装或启用');
      expect(prompt).toContain('不要声称已经开始执行');
    }
  });
  it('lists only the supplied tools without inventing file or browser capabilities', () => {
    const prompt=toolAvailabilityPrompt([{name:'calendar_read'}] as any);
    expect(prompt).toContain('本轮可调用工具：calendar_read');
    expect(prompt).not.toContain('builtin_browser');
    expect(prompt).toContain('DSML');
  });
});
