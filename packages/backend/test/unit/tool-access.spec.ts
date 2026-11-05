import { toolAccess } from '../../src/modules/tools/executor/tool-access.js';
import { YoloClassifierService } from '../../src/modules/tools/executor/yolo-classifier.service.js';
describe('unified approval modes', () => {
  it('keeps browser reads separate from input while respecting explicit settings', () => {
    const check = (action: string, mode = 'ask', settings = {}) => toolAccess({
      config: { get: <T>(section: string) => (section === 'security' ? { yolo: mode } : { toolSettings: { builtin_browser: settings } }) as T },
      name: 'builtin_browser', args: { action }, dangerous: true,
    }).action;
    expect(check('snapshot')).toBe('pass');
    expect(check('wait_for')).toBe('pass');
    expect(check('click')).toBe('ask');
    expect(check('click', 'yolo')).toBe('pass');
    expect(check('snapshot', 'yolo', { disabled: true })).toBe('reject');
    expect(check('snapshot', 'ask', { permission: 'ask' })).toBe('ask');
  });
  const classifier = new YoloClassifierService();
  function gate(mode: string, extra: Record<string, unknown> = {}, command = 'npm install package') {
    return toolAccess({ config: { get: <T>(section: string) => (section === 'security' ? { yolo: mode, ...extra } : {}) as T }, name: 'powershell', args: { command }, sessionId: 'scheduled-job', dangerous: true, classify: c => classifier.classify(c) });
  }
  it('full access includes unattended tools and commands with ask rules', () => {
    expect(gate('yolo', { permissionRules: [{ tool: 'powershell', type: 'ask' }] }).action).toBe('pass');
    expect(gate('yolo', {}, 'rm -rf some-folder').action).toBe('pass');
  });
  it('explicit bans are not erased by full access', () => {
    expect(gate('yolo', { permissionRules: [{ tool: 'powershell', type: 'deny' }], alwaysApproved: ['*'] }).action).toBe('reject');
  });
  it('manual asks; auto allows classified low-risk and asks on uncertain operations', () => {
    expect(gate('ask', {}, 'git status').action).toBe('ask');
    expect(gate('auto', {}, 'git status').action).toBe('pass');
    expect(gate('auto').action).toBe('ask');
    expect(gate('auto', {}, 'echo ok; rm -rf x').action).toBe('ask');
    expect(gate('auto', {}, 'echoevil').action).toBe('ask');
  });
  it('desktop observation works without an input approval, while explicit permissions and input approvals remain effective', () => {
    const check = (action: string, settings: Record<string, unknown> = {}, mode = 'ask') => toolAccess({
      config: { get: <T>(section: string) => (section === 'security' ? { yolo: mode } : { toolSettings: { computer_use: settings } }) as T },
      name: 'computer_use', args: { action }, dangerous: true,
    }).action;
    expect(check('look')).toBe('pass');
    expect(check('wait_for')).toBe('pass');
    expect(check('act')).toBe('ask');
    expect(check('look', { permission: 'ask' })).toBe('ask');
    expect(check('look', { disabled: true }, 'yolo')).toBe('reject');
    expect(check('act', {}, 'yolo')).toBe('pass');
  });
});
