import 'reflect-metadata';

describe('desktop platform command contracts (no live input)', () => {
  afterEach(() => { jest.resetModules(); jest.dontMock('node:os'); });
  function service(platform: string) {
    jest.resetModules();
    jest.doMock('node:os', () => ({ ...jest.requireActual('node:os'), platform: () => platform }));
    const { DesktopService } = require('../../src/modules/automation/desktop.service');
    const desktop = new DesktopService({});
    desktop.runFile = jest.fn(() => ({ success: true, stdout: '', stderr: '' }));
    desktop.skyInputRun = jest.fn(() => ({ success: true, stdout: '', stderr: '' }));
    desktop.detectPy = () => 'python3';
    return desktop;
  }
  it('Windows downward scroll emits a negative wheel delta', () => {
    const d = service('win32'); d.mouseScroll(2, 'down');
    expect(d.skyInputRun).toHaveBeenCalledWith('[SkyInput]::Scroll(-240)');
    expect(d.mouseClick('left', { x: NaN, y: 1 }).success).toBe(false);
    expect(d.mouseClick('invalid')).toMatchObject({ success: false });
  });
  it('Windows background scroll follows the same wheel direction as foreground input', () => {
    const d = service('win32');
    d.bgScroll('Fixture window', 2, 'down');
    expect(d.skyInputRun.mock.calls[0][0]).toContain('[SkyPost]::PostWheel($h, -240, $cx, $cy)');
    d.bgScroll('Fixture window', 3, 'up');
    expect(d.skyInputRun.mock.calls[1][0]).toContain('[SkyPost]::PostWheel($h, 360, $cx, $cy)');
  });
  it('Linux reports missing xdotool as failure and refuses to click after a failed move', () => {
    const d = service('linux'); d.runFile.mockReturnValue({ success: false, error: 'ENOENT' });
    expect(d.mouseMove(1, 2).success).toBe(false); d.runFile.mockClear();
    expect(d.mouseClick('left', { x: 10, y: 20 }).success).toBe(false);
    expect(d.runFile).toHaveBeenCalledTimes(1);
  });
  it('Linux uses supported wheel-button commands and positions clicks', () => {
    const d = service('linux'); d.mouseScroll(3, 'down');
    expect(d.runFile).toHaveBeenCalledWith('xdotool', ['click', '--repeat', '3', '--delay', '50', '5'], { timeout: 5000 });
    d.mouseClick('right', { x: 10, y: 20 });
    expect(d.runFile.mock.calls[1][1]).toEqual(['mousemove', '--sync', '10', '20']);
    expect(d.runFile.mock.calls[2][1]).toContain('3');
  });
  it('macOS posts distinct mouse and scroll events through direct Python arguments', () => {
    const d = service('darwin'); d.mouseMove(10, 20); d.mouseClick('middle', { x: 30, y: 40 }); d.mouseScroll(2, 'down');
    const scripts = d.runFile.mock.calls.map((call: unknown[]) => (call[1] as string[])[1]);
    expect(scripts[0]).toContain('kCGEventMouseMoved'); expect(scripts[0]).toContain('CGEventPost');
    expect(scripts[1]).toContain('pos = (30, 40)'); expect(scripts[1]).toContain('kCGMouseButtonCenter');
    expect(scripts[2]).toContain('CGEventCreateScrollWheelEvent(None, kCGScrollEventUnitLine, 1, -2)');
  });
});
