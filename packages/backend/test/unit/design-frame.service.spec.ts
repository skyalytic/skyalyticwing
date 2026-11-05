import 'reflect-metadata';
import { FilesService } from '../../src/modules/tools/files/files.service.js';

/** design-frame 不依赖 security/config（内存缓存），stub 构造即可 */
function makeService(): FilesService {
  return new FilesService(null as never, null as never);
}

describe('FilesService design-frame（设计稿画布帧缓存）', () => {
  it('create + get 往返：注册 HTML 后按 id 取回原文', () => {
    const svc = makeService();
    const id = svc.createDesignFrame('<!doctype html><p>hello</p>');
    expect(id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(svc.getDesignFrame(id)).toBe('<!doctype html><p>hello</p>');
  });

  it('空 html 抛 BadRequest', () => {
    const svc = makeService();
    expect(() => svc.createDesignFrame('')).toThrow('html 不能为空');
  });

  it('超过大小上限抛 PayloadTooLarge', () => {
    const svc = makeService();
    expect(() => svc.createDesignFrame('x'.repeat(6 * 1024 * 1024 + 1))).toThrow('设计稿过大');
    expect(() => svc.createDesignFrame('中'.repeat(2 * 1024 * 1024 + 1))).toThrow('设计稿过大');
  });

  it('不存在的 id 抛 NotFound', () => {
    const svc = makeService();
    expect(() => svc.getDesignFrame('nope')).toThrow('设计稿帧不存在或已过期');
  });

  it('容量超限丢最旧（Map 插入序）：第 33 个注册后第 1 个被清理', () => {
    const svc = makeService();
    const first = svc.createDesignFrame('<p>first</p>');
    for (let i = 0; i < 32; i++) svc.createDesignFrame(`<p>${i}</p>`);
    expect(() => svc.getDesignFrame(first)).toThrow('设计稿帧不存在或已过期');
    // 最近注册的仍在
    const last = svc.createDesignFrame('<p>last</p>');
    expect(svc.getDesignFrame(last)).toBe('<p>last</p>');
  });
});
