import 'reflect-metadata';
import {
  BuiltInBrowserService,
  type BrowserSnapshot,
} from '../../src/modules/browser/browser.service.js';
import { createBuiltinBrowserTools } from '../../src/modules/tools/executor/built-in/builtin-browser.js';
import type { ToolContext, ToolResult } from '@skyalyticwing/shared';

/** 构造服务（BrowserService 构造期无副作用，不启动浏览器） */
function makeService(): BuiltInBrowserService {
  return new BuiltInBrowserService();
}

/** 访问私有 normalizeUrl（纯函数逻辑，单测价值高） */
function normalizeUrl(s: BuiltInBrowserService): (u: string) => string {
  return (s as unknown as { normalizeUrl: (u: string) => string }).normalizeUrl.bind(s);
}

function ctx(): ToolContext {
  return { sessionId: 's1' } as unknown as ToolContext;
}

/** 构造假快照（工具层 stub 返回值） */
function fakeSnapshot(over: Partial<BrowserSnapshot> = {}): BrowserSnapshot {
  return {
    pageId: 'p1',
    url: 'https://example.com/',
    title: 'Example',
    viewport: { width: 1280, height: 800 },
    screenshot: 'aGVsbG8=',
    elements: [{ index: 1, tag: 'button', text: '登录', rect: { x: 10, y: 20, w: 60, h: 24 } }],
    consoleTail: ['[console.log] hi'],
    markedAt: Date.now(),
    ...over,
  };
}

describe('native browser popup action observations', () => {
  it.each([['popup-1', 'popup-1'], [undefined, 'source-1']])(
    'observes the confirmed action target %s', async (openedPageId, expectedPageId) => {
      const service = makeService();
      const request = jest.fn().mockResolvedValue(openedPageId ? { pageId: openedPageId } : {});
      Object.defineProperty(service, 'native', { value: { enabled: true, request } });
      const snapshot = jest.spyOn(service, 'snapshot').mockResolvedValue(fakeSnapshot({ pageId: expectedPageId }));
      const result = await service.action('source-1', 'click', { index: 1 });
      expect(snapshot).toHaveBeenCalledWith(expectedPageId);
      expect(result.pageId).toBe(expectedPageId);
    },
  );
  it('preserves native failures instead of inventing a successful popup', async () => {
    const service = makeService();
    Object.defineProperty(service, 'native', { value: { enabled: true, request: jest.fn().mockRejectedValue(new Error('input failed')) } });
    const snapshot = jest.spyOn(service, 'snapshot');
    await expect(service.action('source-1', 'click', { index: 1 })).rejects.toThrow('input failed');
    expect(snapshot).not.toHaveBeenCalled();
  });
});

describe('BuiltInBrowserService.normalizeUrl', () => {
  it('无协议自动补 https://', () => {
    const f = normalizeUrl(makeService());
    expect(f('example.com')).toBe('https://example.com/');
    expect(f('  www.foo.cn/path ')).toBe('https://www.foo.cn/path');
  });

  it('localhost 与 IP 补 http://', () => {
    const f = normalizeUrl(makeService());
    expect(f('localhost:3000/api')).toBe('http://localhost:3000/api');
    expect(f('127.0.0.1:9100')).toBe('http://127.0.0.1:9100/');
    expect(f('192.168.1.5')).toBe('http://192.168.1.5/');
  });

  it('http(s) 与 file 协议原样保留', () => {
    const f = normalizeUrl(makeService());
    expect(f('http://a.b/c')).toBe('http://a.b/c');
    expect(f('HTTPS://A.B')).toBe('https://a.b/');
    expect(f('file:///d:/tmp/x.html')).toBe('file:///d:/tmp/x.html');
  });

  it('空地址新建空白页，关键词通过百度搜索', () => {
    const f = normalizeUrl(makeService());
    expect(f('')).toBe('about:blank');
    expect(f('   ')).toBe('about:blank');
    expect(f('杭州天气')).toBe('https://www.baidu.com/s?wd=%E6%9D%AD%E5%B7%9E%E5%A4%A9%E6%B0%94');
    expect(f('你好')).toBe('https://www.baidu.com/s?wd=%E4%BD%A0%E5%A5%BD');
    expect(f('wing AI')).toBe('https://www.baidu.com/s?wd=wing%20AI');
    expect(f('site:skyalytic.com Wing')).toBe(
      'https://www.baidu.com/s?wd=site%3Askyalytic.com%20Wing',
    );
    expect(() => f('javascript:alert(1)')).toThrow('仅支持');
    expect(() => f('data:text/html,hello')).toThrow('仅支持');
  });
});

describe('BuiltInBrowserService 页面生命周期守卫', () => {
  it('shows AI control only during an action, never user browsing, reading or after takeover', async () => {
    const s = makeService();
    await s.runOperation('user', async () => expect(s.status().agentBusy).toBe(false));
    await s.runOperation('agent', async () => expect(s.status().agentBusy).toBe(false), false);
    await s.runOperation('agent', async () => {
      expect(s.status().agentBusy).toBe(true);
      s.setControl(true);
      expect(s.status().agentBusy).toBe(false);
    });
    expect(s.status().agentBusy).toBe(false);
    await expect(s.runOperation('agent', async () => undefined)).rejects.toThrow('用户已接管');
    s.setControl(false);
    await expect(
      s.runOperation('agent', async () => {
        throw new Error('test error');
      }),
    ).rejects.toThrow('test error');
    expect(s.status().agentBusy).toBe(false);
  });
  it('初始 status：未运行', () => {
    expect(makeService().status()).toMatchObject({
      running: false,
      pages: 0,
      activePageId: null,
      engine: null,
    });
  });

  it('未打开页面时 snapshot/elementAt/action 抛出可读错误', async () => {
    const s = makeService();
    await expect(s.snapshot()).rejects.toThrow('浏览器页面未打开或已关闭');
    await expect(s.elementAt('p1', 1, 1)).rejects.toThrow('浏览器页面未打开或已关闭');
    await expect(s.action('p1', 'click', { index: 1 })).rejects.toThrow('浏览器页面未打开或已关闭');
  });

  it('closeAll 幂等：未启动浏览器时也安全返回', async () => {
    const s = makeService();
    await expect(s.closeAll()).resolves.toEqual({ closed: true });
    expect(s.status().running).toBe(false);
    await s.onModuleDestroy();
  });
});

/** 工具层 stub：代替 BuiltInBrowserService 记录调用并返回假快照 */
function makeStubBrowser(calls: string[]) {
  return {
    assertObservation: async () => undefined,
    forSession() {
      return this;
    },
    async runOperation(_actor: string, fn: () => Promise<ToolResult>) {
      return fn();
    },
    navigate: (url: string) => {
      calls.push(`navigate:${url}`);
      // 模拟真实 service 的 URL 归一化（无协议补 https + 尾斜杠）
      const norm = /^https?:\/\//i.test(url) ? url : `https://${url}`;
      return Promise.resolve(fakeSnapshot({ url: norm.endsWith('/') ? norm : `${norm}/` }));
    },
    snapshot: () => {
      calls.push('snapshot');
      return Promise.resolve(fakeSnapshot());
    },
    action: (pageId: string, action: string, args: Record<string, unknown>) => {
      // 与真实 service 一致：元素操作缺 index 时抛错（工具层负责透传）
      if (
        ['click', 'fill', 'select', 'hover'].includes(action) &&
        typeof args['index'] !== 'number'
      ) {
        return Promise.reject(new Error('缺少元素索引 index'));
      }
      calls.push(`action:${action}:${JSON.stringify(args)}:${pageId}`);
      return Promise.resolve({ ...fakeSnapshot(), ok: true, action, detail: `${action} 完成` });
    },
    elementByIndex: (pageId: string, index: number) => {
      calls.push(`elementByIndex:${index}:${pageId}`);
      return Promise.resolve(
        index === 1
          ? {
              index: 1,
              tag: 'button',
              text: '登录',
              selector: '#login',
              outerHTML: '<button id="login">登录</button>',
              rect: { x: 10, y: 20, w: 60, h: 24 },
            }
          : null,
      );
    },
    history: (_pageId: string, dir: 'back' | 'forward') => {
      calls.push(`history:${dir}`);
      return Promise.resolve(fakeSnapshot());
    },
    reload: () => {
      calls.push('reload');
      return Promise.resolve(fakeSnapshot());
    },
    closePage: (pageId?: string) => {
      calls.push(`closePage:${pageId ?? ''}`);
      return Promise.resolve({ closed: true });
    },
    closeAll: () => {
      calls.push('closeAll');
      return Promise.resolve({ closed: true });
    },
    status: () => ({ running: false, pages: 0, activePageId: null, engine: null }),
  };
}

describe('builtin_browser 内置工具', () => {
  it('服务不可用（BrowserModule 未加载）时返回明确错误', async () => {
    const [tool] = createBuiltinBrowserTools(() => undefined);
    const r = await tool.execute({ action: 'status' }, ctx());
    expect(r.success).toBe(false);
    expect((r as { error: string }).error).toContain('内置浏览器服务不可用');
  });

  it('navigate 缺 url 参数报错；正常时输出含元素编号清单', async () => {
    const calls: string[] = [];
    const [tool] = createBuiltinBrowserTools(() => makeStubBrowser(calls) as never);
    const bad = await tool.execute({ action: 'navigate' }, ctx());
    expect(bad.success).toBe(false);

    const r = await tool.execute({ action: 'navigate', url: 'example.com' }, ctx());
    expect(r.success).toBe(true);
    expect(calls[0]).toBe('navigate:example.com');
    expect(String((r as { output: string }).output)).toContain('已打开 https://example.com/');
    expect(String((r as { output: string }).output)).toContain('#1 <button> "登录"');
  });

  it('click 缺 index 与坐标时抛"缺少元素索引"；带 index 走 action 分发', async () => {
    const calls: string[] = [];
    const [tool] = createBuiltinBrowserTools(() => makeStubBrowser(calls) as never);
    const bad = await tool.execute({ action: 'click' }, ctx());
    expect(bad.success).toBe(false);
    expect((bad as { error: string }).error).toContain('缺少元素索引');

    const r = (await tool.execute({ action: 'click', index: 1 }, ctx())) as {
      success: boolean;
      output: string;
    };
    expect(r.success).toBe(true);
    expect(calls.join('|')).toContain('action:click:');
    expect(calls.join('|')).toContain('"index":1');
  });

  it('fill 透传 text；scroll 透传 dy；key 透传 key', async () => {
    const calls: string[] = [];
    const [tool] = createBuiltinBrowserTools(() => makeStubBrowser(calls) as never);
    await tool.execute({ action: 'fill', index: 1, text: 'hello' }, ctx());
    await tool.execute({ action: 'scroll', dy: -300 }, ctx());
    await tool.execute({ action: 'key', key: 'Enter' }, ctx());
    const j = calls.join('|');
    expect(j).toContain('action:fill:');
    expect(j).toContain('"text":"hello"');
    expect(j).toContain('action:scroll:');
    expect(j).toContain('"dy":-300');
    expect(j).toContain('action:key:');
    expect(j).toContain('"key":"Enter"');
  });

  it('element 缺 index 报错；索引不存在报可读错误；存在时返回详情', async () => {
    const calls: string[] = [];
    const [tool] = createBuiltinBrowserTools(() => makeStubBrowser(calls) as never);
    const noIdx = await tool.execute({ action: 'element' }, ctx());
    expect(noIdx.success).toBe(false);

    const missing = await tool.execute({ action: 'element', index: 9 }, ctx());
    expect(missing.success).toBe(false);
    expect((missing as { error: string }).error).toContain('#9 不存在');

    const ok = await tool.execute({ action: 'element', index: 1 }, ctx());
    expect(ok.success).toBe(true);
    expect(String((ok as { output: string }).output)).toContain('#login');
  });

  it('history/reload/close/status 分发与输出', async () => {
    const calls: string[] = [];
    const [tool] = createBuiltinBrowserTools(() => makeStubBrowser(calls) as never);
    const back = await tool.execute({ action: 'back' }, ctx());
    expect(back.success).toBe(true);
    const fwd = await tool.execute({ action: 'forward' }, ctx());
    expect(fwd.success).toBe(true);
    const rl = await tool.execute({ action: 'reload' }, ctx());
    expect(rl.success).toBe(true);
    const cls = await tool.execute({ action: 'close', all: true }, ctx());
    expect(cls.success).toBe(true);
    expect(calls).toContain('closeAll');
    const st = await tool.execute({ action: 'status' }, ctx());
    expect(st.success).toBe(true);
    expect(String((st as { output: string }).output)).toContain('未启动');
  });

  it('不支持的 action 返回错误；缺 action 参数报参数错误', async () => {
    const [tool] = createBuiltinBrowserTools(() => makeStubBrowser([]) as never);
    const unknown = await tool.execute({ action: 'teleport' }, ctx());
    expect(unknown.success).toBe(false);
    expect((unknown as { error: string }).error).toContain('不支持的内置浏览器操作');

    const noAction = (await tool.execute({}, ctx())) as ToolResult;
    expect(noAction.success).toBe(false);
    expect(noAction.error).toContain('action');
  });
});

describe('browser scopes and takeover', () => {
  it('isolates controls by session and blocks AI while manually owned', async () => {
    const root = new BuiltInBrowserService(),
      a = root.forSession('a'),
      b = root.forSession('b');
    expect(a).toBe(root.forSession('a'));
    expect(a).not.toBe(b);
    a.setControl(true);
    const op = jest.fn().mockResolvedValue('ok');
    await expect(a.runOperation('agent', op)).rejects.toThrow('用户已接管');
    await expect(a.runOperation('user', op)).resolves.toBe('ok');
    await expect(b.runOperation('agent', op)).resolves.toBe('ok');
    a.setControl(false);
    await expect(a.runOperation('agent', op)).resolves.toBe('ok');
    await root.onModuleDestroy();
  });
  it('rejects overlapping user/AI operations rather than interleaving input', async () => {
    const s = new BuiltInBrowserService();
    let finish!: () => void;
    const task = s.runOperation(
      'agent',
      () =>
        new Promise<void>((r) => {
          finish = r;
        }),
    );
    await expect(s.runOperation('user', async () => {})).rejects.toThrow('尚未结束');
    finish();
    await task;
    await expect(s.runOperation('user', async () => true)).resolves.toBe(true);
  });
});

it('rejects file navigation outside authorized paths before launching a browser', async () => {
  const s = new BuiltInBrowserService();
  await expect(s.navigate('file:///C:/private.txt')).rejects.toThrow('路径未授权');
  expect(s.status().running).toBe(false);
});
