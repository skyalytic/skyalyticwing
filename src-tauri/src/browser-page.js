// Runs inside a separate, unprivileged webview. All returned page content is untrusted.
(() => {
  if (window.__wingBrowser) return;
  const ids = new WeakMap(),
    byId = new Map();
  let serial = 0,
    selecting = false,
    selected = null,
    highlight = null,
    shortcut = null;
  const documentId =
    typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : Array.from(crypto.getRandomValues(new Uint8Array(16)), (n) =>
          n.toString(16).padStart(2, '0'),
        ).join('');
  const interactive =
    'a,button,input,textarea,select,summary,label,iframe,[role=button],[role=link],[role=tab],[role=checkbox],[role=radio],[role=switch],[role=combobox],[role=option],[role=menuitem],[contenteditable=true],[onclick]';
  function* allElements(root = document) {
    for (const el of root.querySelectorAll('*')) {
      if (el.matches(interactive)) yield el;
      if (el.shadowRoot) yield* allElements(el.shadowRoot);
    }
  }
  function focused() {
    let el = document.activeElement;
    while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
    return el;
  }
  function visible(el) {
    const r = rect(el), style = getComputedStyle(el);
    return r.w >= 1 && r.h >= 1 && style.visibility !== 'hidden' && style.display !== 'none'
      && r.x + r.w > 0 && r.y + r.h > 0 && r.x < innerWidth && r.y < innerHeight;
  }
  function role(el) {
    return el.getAttribute('role') || ({ button: 'button', a: 'link', textarea: 'textbox', select: 'combobox', summary: 'button' })[el.localName]
      || (el.localName === 'input' ? ({ checkbox: 'checkbox', radio: 'radio', button: 'button', submit: 'button', range: 'slider' })[el.type] || 'textbox' : undefined);
  }
  function label(el) {
    const labelled = (el.getAttribute('aria-labelledby') || '').split(/\s+/).map(key => el.getRootNode().getElementById?.(key)?.textContent || '').join(' ').trim();
    return el.getAttribute('aria-label') || labelled || Array.from(el.labels || [], n => n.textContent).join(' ').trim()
      || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name') || '';
  }
  const rect = (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  };
  const id = (el) => {
    if (!ids.has(el)) {
      ids.set(el, ++serial);
      byId.set(serial, el);
    }
    return ids.get(el);
  };
  function text(el) {
    if (el.type === 'password') return '[password]';
    return String(
      el.matches('input,textarea,select') ? el.value : (el.innerText ?? el.textContent ?? ''),
    )
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120);
  }
  function selector(el) {
    if (el.id && document.querySelectorAll('#' + CSS.escape(el.id)).length === 1)
      return '#' + CSS.escape(el.id);
    const parts = [];
    for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
      let part = node.localName;
      if (node.parentElement) {
        const peers = [...node.parentElement.children].filter(
          (e) => e.localName === node.localName,
        );
        if (peers.length > 1) part += ':nth-of-type(' + (peers.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
      if (parts.length >= 12) break;
    }
    return parts.join(' > ');
  }
  function info(el, full = false) {
    const data = {
      index: id(el),
      tag: el.localName,
      role: role(el),
      text: text(el),
      hint: label(el).slice(0, 200),
      href: el.localName === 'a' ? el.href : undefined,
      rect: rect(el),
      input: el.matches('input,textarea,select,[contenteditable]'),
      disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
      readonly: el.readOnly === true,
      checked: el.checked === true || el.getAttribute('aria-checked') === 'true',
    };
    if (full) {
      const clone = el.cloneNode(true);
      if (clone.matches('input[type=password]')) clone.removeAttribute('value');
      for (const password of clone.querySelectorAll('input[type=password]'))
        password.removeAttribute('value');
      Object.assign(data, { selector: selector(el), outerHTML: clone.outerHTML.slice(0, 2000) });
    }
    return data;
  }
  function hideHighlight() {
    highlight?.remove();
    highlight = null;
  }
  function mark(el) {
    if (!highlight) {
      highlight = document.createElement('div');
      highlight.dataset.wingAnnotation = 'true';
      document.documentElement.append(highlight);
    }
    const r = rect(el);
    highlight.style.cssText = `position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #1677ff;background:#1677ff18;box-sizing:border-box;left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px`;
  }
  document.addEventListener(
    'pointermove',
    (e) => {
      if (selecting && e.target instanceof Element) mark(e.target);
    },
    true,
  );
  document.addEventListener(
    'click',
    (e) => {
      if (!selecting || !(e.target instanceof Element)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      selected = { ...info(e.target, true), url: location.href, title: document.title, documentId };
      selecting = false;
      hideHighlight();
    },
    true,
  );
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Escape' && selecting) {
        selecting = false;
        selected = null;
        hideHighlight();
        shortcut = 'cancelAnnotation';
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'l') {
        e.preventDefault();
        e.stopImmediatePropagation();
        shortcut = 'focusAddress';
      }
    },
    true,
  );
  const target = (a) => {
    const el = Number.isInteger(a.index)
      ? byId.get(a.index)
      : Number.isFinite(a.x) && Number.isFinite(a.y)
        ? document.elementFromPoint(a.x, a.y)
        : focused();
    if (!(el instanceof Element) || !el.isConnected)
      throw Error('元素不存在或已改变，请重新获取页面快照');
    return el;
  };
  function fill(el, value, append = false) {
    el.focus();
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      if (el.type === 'file') throw Error('请使用上传工具或直接选择文件');
      const setter = Object.getOwnPropertyDescriptor(
        el instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype,
        'value',
      ).set;
      const start = append ? (el.selectionStart ?? el.value.length) : 0,
        end = append ? (el.selectionEnd ?? el.value.length) : el.value.length;
      setter.call(el, el.value.slice(0, start) + value + el.value.slice(end));
      try {
        el.setSelectionRange(start + value.length, start + value.length);
      } catch {}
    } else if (el.isContentEditable) {
      if (!append) el.textContent = '';
      document.execCommand('insertText', false, value);
    } else throw Error('所选元素不能输入文本');
    el.dispatchEvent(
      new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }),
    );
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function snapshot() {
    const elements = [];
    for (const el of allElements()) {
      if (!visible(el)) continue;
      elements.push(info(el));
      if (elements.length >= 200) break;
    }
    return {
      url: location.href,
      title: document.title,
      documentId,
      readyState: document.readyState,
      activeElement: focused()?.matches(interactive) ? info(focused()) : null,
      viewport: { width: innerWidth, height: innerHeight },
      elements,
      elementsTruncated: elements.length >= 200,
      pageText: (document.body?.innerText || '').slice(0, 16000),
      screenshot: '',
      consoleTail: [],
      markedAt: Date.now(),
    };
  }
  window.__wingBrowser = function (op, a = {}) {
    try {
      if (op === 'snapshot') return { ok: true, value: snapshot() };
      if (op === 'metadata') {
        const value = {
          url: location.href,
          title: document.title,
          selected,
          selecting,
          shortcut,
          ready: document.readyState,
        };
        shortcut = null;
        return { ok: true, value };
      }
      if (op === 'annotate') {
        selecting = !!a.enabled;
        selected = null;
        if (!selecting) hideHighlight();
        return { ok: true, value: { selecting } };
      }
      if (op === 'point') return { ok: true, value: { x: innerWidth / 2, y: innerHeight / 2 } };
      if (op === 'element') return { ok: true, value: info(target(a), true) };
      if (op === 'back' || op === 'forward') {
        setTimeout(() => history.go(op === 'back' ? -1 : 1), 0);
        return { ok: true, value: {} };
      }
      if (op === 'reload') {
        setTimeout(() => location.reload(), 0);
        return { ok: true, value: {} };
      }
      if (op === 'scroll') {
        const el = target({ x: a.x ?? innerWidth / 2, y: a.y ?? innerHeight / 2 });
        let parent = el;
        while (parent && parent !== document.documentElement) {
          const s = getComputedStyle(parent);
          if (/auto|scroll/.test(s.overflowY) && parent.scrollHeight > parent.clientHeight) break;
          parent = parent.parentElement;
        }
        (parent || document.scrollingElement).scrollBy({ left: a.dx || 0, top: a.dy ?? 600 });
        return { ok: true, value: {} };
      }
      const el = target(a);
      if (['input-target', 'click', 'fill', 'type', 'select', 'focus', 'hover', 'upload'].includes(op)) {
        if (!visible(el) || el.disabled || el.getAttribute('aria-disabled') === 'true' || el.closest('[inert]'))
          throw Error('目标不可见或不可操作，请重新观察页面');
        const r = rect(el), x = Number.isFinite(a.x) ? a.x : Math.max(0, r.x) + (Math.min(innerWidth, r.x + r.w) - Math.max(0, r.x)) / 2,
          y = Number.isFinite(a.y) ? a.y : Math.max(0, r.y) + (Math.min(innerHeight, r.y + r.h) - Math.max(0, r.y)) / 2;
        let hit = document.elementFromPoint?.(x, y);
        while (hit?.shadowRoot?.elementFromPoint) {
          const next = hit.shadowRoot.elementFromPoint(x, y);
          if (!next || next === hit) break;
          hit = next;
        }
        if (hit && hit !== el && !el.contains(hit)) throw Error('目标被其他元素遮挡，请重新观察页面');
        if (op === 'input-target') return { ok: true, value: { x, y } };
      }
      if (op === 'focus') {
        if (
          !el.matches('input,textarea,[contenteditable=true]') ||
          el.disabled ||
          el.readOnly ||
          el.type === 'file'
        )
          throw Error('所选元素不能输入文本');
        el.focus?.();
        if (a.selectAll) {
          if (el.select) el.select();
          else if (el.isContentEditable) {
            const range = document.createRange();
            range.selectNodeContents(el);
            const selection = getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
          }
        }
      } else if (op === 'click') {
        el.focus?.();
        el.click();
      } else if (op === 'fill' || op === 'type')
        fill(el, String(a.text ?? a.value ?? ''), op === 'type');
      else if (op === 'select') {
        if (!(el instanceof HTMLSelectElement)) throw Error('不是下拉选项');
        const option = [...el.options].find((o) => o.value === a.value || o.text === a.text);
        if (!option) throw Error('找不到选项');
        el.value = option.value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } else if (op === 'hover') {
        el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
      } else if (op === 'key') {
        const key = String(a.key || '');
        if (key === 'Enter') {
          const accepted = el.dispatchEvent(
            new KeyboardEvent('keydown', { key, code: 'Enter', bubbles: true, cancelable: true }),
          );
          if (accepted) {
            if (el instanceof HTMLTextAreaElement || el.isContentEditable) fill(el, '\n', true);
            else if (el.form) el.form.requestSubmit();
            else if (el.matches('a,button')) el.click();
          }
        } else if (key === 'Tab') {
          const all = [...document.querySelectorAll(interactive)].filter(
            (n) => n.getClientRects().length && !n.disabled && n.tabIndex >= 0,
          );
          all[(all.indexOf(el) + 1) % all.length]?.focus();
        } else if (/^(Control|Ctrl|Meta)\+A$/i.test(key)) {
          el.select?.();
        } else if (key === 'Backspace') {
          if (
            el.setSelectionRange &&
            el.selectionStart === el.selectionEnd &&
            el.selectionStart > 0
          )
            el.setSelectionRange(el.selectionStart - 1, el.selectionEnd);
          fill(el, '', true);
        } else throw Error('此按键需在网页内直接操作，或使用 fill/click 工具');
        el.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }));
      } else if (op === 'upload') {
        if (!(el instanceof HTMLInputElement) || el.type !== 'file')
          throw Error('不是文件上传控件');
        const bytes = Uint8Array.from(atob(a.base64), (c) => c.charCodeAt(0));
        const dt = new DataTransfer();
        dt.items.add(new File([bytes], a.name, { type: a.mimeType }));
        el.files = dt.files;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } else throw Error('不支持的网页操作');
      return { ok: true, value: {} };
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  };
})();
