import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { describe, it, expect } from 'vitest';
const source = readFileSync(
  resolve(process.cwd(), '../../src-tauri/src/browser-page.js'),
  'utf8',
);
function fixture() {
  const dom = new JSDOM(
    '<main id="page"><h1>文章正文</h1><input id="name" placeholder="姓名"><input type="password" value="private-secret"><button id="buy">立即购买</button></main>',
    { url: 'https://fixture.test/', runScripts: 'outside-only' },
  );
  const w = dom.window;
  w.CSS = { escape: (s: string) => s } as any;
  w.Element.prototype.getBoundingClientRect = () => ({
    x: 10,
    y: 20,
    width: 100,
    height: 30,
    left: 10,
    top: 20,
    right: 110,
    bottom: 50,
    toJSON() {},
  });
  Object.defineProperty(w.HTMLElement.prototype, 'innerText', {
    get() {
      return this.textContent;
    },
  });
  w.eval(source);
  return { dom, w, cmd: (op: string, args: any = {}) => (w as any).__wingBrowser(op, args) };
}
describe('native web page observation and annotation', () => {
  it('observes labels, focus, states and open shadow controls without confusing text with values', () => {
    const { w, cmd } = fixture();
    w.document.getElementById('name')!.setAttribute('aria-label', '联系人姓名');
    const host = w.document.createElement('section'); w.document.body.append(host);
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<label for="query">搜索联系人</label><input id="query"><button disabled>发送</button>';
    const input = shadow.querySelector('input')!;
    input.value = '文宇'; input.focus();
    const s = cmd('snapshot').value;
    expect(s.elements.find((e: any) => e.hint === '联系人姓名').role).toBe('textbox');
    expect(s.activeElement).toMatchObject({ text: '文宇', hint: '搜索联系人', role: 'textbox' });
    const send = s.elements.find((e: any) => e.text === '发送');
    expect(send.disabled).toBe(true);
    expect(cmd('click', { index: send.index }).ok).toBe(false);
    w.close();
  });
  it('rejects an obscured click rather than clicking a different control', () => {
    const { w, cmd } = fixture();
    const button = cmd('snapshot').value.elements.find((e: any) => e.text === '立即购买');
    const overlay = w.document.createElement('div'); w.document.body.append(overlay);
    (w.document as any).elementFromPoint = () => overlay;
    expect(cmd('input-target', { index: button.index })).toMatchObject({ ok: false });
    w.close();
  });
  it('reads visible button labels even when their value property is empty', () => {
    const { dom, cmd } = fixture();
    const page = cmd('snapshot').value;
    expect(page.elements.some((e: any) => e.tag === 'button' && e.text === '立即购买')).toBe(true);
    expect(page.pageText).toContain('文章正文');
    expect(JSON.stringify(page)).not.toContain('private-secret');
    dom.window.close();
  });
  it('does not mark normal browsing and only selects while annotation is enabled', () => {
    const { dom, w, cmd } = fixture();
    const button = w.document.getElementById('buy')!;
    button.click();
    expect(cmd('metadata').value.selected).toBeNull();
    expect(w.document.querySelector('[data-wing-annotation]')).toBeNull();
    cmd('annotate', { enabled: true });
    button.dispatchEvent(new w.MouseEvent('pointermove', { bubbles: true }));
    expect(w.document.querySelector('[data-wing-annotation]')).not.toBeNull();
    button.click();
    const meta = cmd('metadata').value;
    expect(meta.selected.selector).toBe('#buy');
    expect(meta.selected.url).toBe('https://fixture.test/');
    expect(meta.selecting).toBe(false);
    expect(w.document.querySelector('[data-wing-annotation]')).toBeNull();
    cmd('annotate', { enabled: false });
    expect(cmd('metadata').value.selected).toBeNull();
    w.close();
  });
  it('redacts descendant password values when a parent is annotated', () => {
    const { w, cmd } = fixture();
    cmd('annotate', { enabled: true });
    w.document.getElementById('page')!.click();
    expect(cmd('metadata').value.selected.outerHTML).not.toContain('private-secret');
    w.close();
  });
  it('does not reuse an element index after its DOM node is removed', () => {
    const { w, cmd } = fixture();
    const index = cmd('snapshot').value.elements.find((e: any) => e.tag === 'button').index;
    w.document.getElementById('buy')!.remove();
    expect(cmd('element', { index })).toMatchObject({ ok: false });
    w.close();
  });
});
