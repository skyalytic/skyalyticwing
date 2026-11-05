/* Qt 5's canvas consumes key events but has no browser IME text-input surface.
 * Keep a real textarea focused and send only committed text to the editor. */
'use strict';
function attachOfficeInput(canvas) {
  const input = document.createElement('textarea');
  input.id = 'office-input';
  input.setAttribute('aria-label', '文档文字输入');
  input.setAttribute('autocomplete', 'off');
  input.setAttribute('autocapitalize', 'off');
  input.spellcheck = false;
  document.body.append(input);
  let composing = false;
  let justCommitted = false;
  const sendKey = (type, source) =>
    canvas.dispatchEvent(
      new KeyboardEvent(type, {
        key: source.key,
        code: source.code || '',
        keyCode: source.keyCode || 0,
        charCode: source.charCode || 0,
        which: source.which || 0,
        ctrlKey: !!source.ctrlKey,
        altKey: !!source.altKey,
        shiftKey: !!source.shiftKey,
        metaKey: !!source.metaKey,
        repeat: !!source.repeat,
        bubbles: true,
        cancelable: true,
      }),
    );
  const commit = (text) => {
    for (const key of text || '') {
      sendKey('keydown', { key });
      sendKey('keyup', { key });
    }
  };
  function focus(event) {
    if (composing) return;
    if (event) {
      input.style.left = Math.max(0, Math.min(event.clientX, innerWidth - 10)) + 'px';
      input.style.top = Math.max(0, Math.min(event.clientY, innerHeight - 24)) + 'px';
    }
    input.focus({ preventScroll: true });
  }
  // Let Qt finish moving its internal caret before focusing the IME surface.
  canvas.addEventListener('pointerup', (event) => setTimeout(() => focus(event), 0));
  canvas.addEventListener('focus', () => queueMicrotask(() => focus()));
  for (const type of ['keydown', 'keyup'])
    window.addEventListener(
      type,
      (event) => {
        if (event.target !== input) return;
        event.stopImmediatePropagation();
        // Do not cancel Windows' Process/229 events: doing so prevents candidate commit.
        if (composing || event.isComposing || event.keyCode === 229 || event.key === 'Process')
          return;
        event.preventDefault();
        sendKey(type, event);
      },
      true,
    );
  input.addEventListener('compositionstart', () => {
    composing = true;
    justCommitted = false;
  });
  input.addEventListener('compositionend', (event) => {
    composing = false;
    commit(event.data);
    justCommitted = true;
    // Chromium may deliver the final input event after compositionend.
    setTimeout(() => {
      input.value = '';
      justCommitted = false;
    }, 0);
  });
  input.addEventListener('beforeinput', (event) => {
    if (composing || event.isComposing || event.inputType === 'insertCompositionText') return;
    if (event.inputType === 'insertText' || event.inputType === 'insertFromPaste') {
      event.preventDefault();
      if (!justCommitted) commit(event.data);
    }
  });
  input.addEventListener('input', () => {
    if (!composing) input.value = '';
  });
  return { focus, input };
}
