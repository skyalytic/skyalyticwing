/* Local document host. Human and AI edits share one version-checked document. */
'use strict';
const canvas = document.getElementById('qtcanvas'),
  loading = document.getElementById('loading'),
  error = document.getElementById('error');
const session = location.pathname.split('/').pop(),
  credential = location.hash.slice(1),
  endpoint = '/documents/' + session;
let port,
  filename,
  ready = false,
  saving = false,
  changed = false,
  saveTimer,
  conflict = false,
  generation = 0,
  downloadNext = false;
let saveWaiters = [];
let localFonts = [];
const request = async (action, options = {}) => {
  const r = await fetch(endpoint + '/' + action, {
    ...options,
    headers: { 'X-Wing-Capability': credential, ...options.headers },
  });
  if (!r.ok) throw Error(await r.text());
  return r;
};
const json = (action, data) =>
  request(action, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
function fail(message) {
  error.hidden = false;
  error.textContent = message;
  json('status', { error: message }).catch(() => {});
}
var Module = {
  canvas,
  arguments: ['--language=zh-CN'],
  uno_scripts: [location.origin + '/zeta.js', location.origin + '/worker.js'],
  locateFile: (name) => location.origin + '/' + name,
  onAbort: (reason) => fail('Office 启动失败：' + String(reason)),
  preRun: [function () {
    addRunDependency('wing-system-fonts');
    (async () => {
      localFonts = await (await request('fonts')).json();
      FS.mkdirTree('/instdir/share/fonts/truetype/wing-local');
      for (const font of localFonts) {
        const bytes = new Uint8Array(await (await request('font?id=' + font.id)).arrayBuffer());
        FS.writeFile('/instdir/share/fonts/truetype/wing-local/' + font.filename, bytes);
      }
    })().catch(e => {
      localFonts = [];
      document.getElementById('font-status').textContent = '本机字体未能载入，已使用内置中文字体';
      console.warn('Office system fonts:', e.message);
    }).finally(() => removeRunDependency('wing-system-fonts'));
  }],
};
window.Module = Module;
const officeInput = attachOfficeInput(canvas);
const fontPicker = document.getElementById('font-picker');
fontPicker.onchange = () => {
  if (!ready || !fontPicker.value) return;
  port.postMessage({ cmd: 'set-font', family: fontPicker.value });
  fontPicker.disabled = true;
};
function showFonts(families) {
  const available = new Set(families);
  const common = [
    ...localFonts.map(f => [available.has(f.family) ? f.family : f.label, f.label]),
    ['Noto Sans CJK SC', '思源黑体'], ['Noto Serif CJK SC', '思源宋体'],
    ['Liberation Sans', 'Liberation Sans'], ['Liberation Serif', 'Liberation Serif'],
    ['Liberation Mono', 'Liberation Mono'],
  ];
  const seen = new Set();
  for (const [family, label] of [...common, ...families.map(f => [f, f])]) {
    if (!available.has(family) || seen.has(family)) continue;
    seen.add(family);
    const option = document.createElement('option'); option.value = family; option.textContent = label;
    fontPicker.append(option);
  }
  fontPicker.disabled = !ready;
}
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('wheel', (e) => e.preventDefault(), { passive: false });
canvas.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    save();
  }
});
function save(download = false) {
  if (!ready) return;
  downloadNext ||= download;
  if (saving) return;
  if (conflict && !download) return;
  saving = true;
  port.postMessage({ cmd: 'save', generation, download: downloadNext });
  downloadNext = false;
}
function saved() {
  return new Promise((resolve, reject) => {
    if (conflict) {
      reject(Error('请先处理保存冲突，或另存副本'));
      return;
    }
    const timeout = setTimeout(() => reject(Error('保存尚未完成，请保留编辑窗口')), 15000);
    saveWaiters.push({
      resolve: () => {
        clearTimeout(timeout);
        resolve();
      },
      reject: (e) => {
        clearTimeout(timeout);
        reject(e);
      },
    });
    save();
  });
}
function downloadBytes(bytes) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([bytes]));
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
async function chooseFile(accept) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = () => resolve(input.files[0]);
    input.oncancel = () => resolve(null);
    input.click();
  });
}
function askName(title, initial) {
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog');
    dialog.className = 'file-dialog';
    const form = document.createElement('form');
    form.method = 'dialog';
    const heading = document.createElement('h3');
    heading.textContent = title;
    const input = document.createElement('input');
    input.value = initial;
    input.maxLength = 100;
    input.required = true;
    const row = document.createElement('div');
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = '取消';
    cancel.onclick = () => dialog.close();
    const ok = document.createElement('button');
    ok.textContent = '保存';
    row.append(cancel, ok);
    form.append(heading, input, row);
    dialog.append(form);
    document.body.append(dialog);
    let value = null;
    form.onsubmit = () => {
      value = input.value;
    };
    dialog.onclose = () => {
      resolve(value);
      dialog.remove();
    };
    dialog.showModal();
    input.focus();
    input.select();
  });
}
async function menuAction(url) {
  try {
    if (url === '.uno:Save') {
      save();
      return;
    }
    if (['.uno:SaveAs', '.uno:SaveACopy'].includes(url)) {
      const name = await askName('另存副本到项目文件夹', filename.replace(/(\.[^.]+)$/, '-副本$1'));
      if (!name) return;
      const bytes = await exportBytes();
      const result = await (
        await request('copy?name=' + encodeURIComponent(name), { method: 'POST', body: bytes })
      ).json();
      error.hidden = false;
      error.textContent = '副本已保存：' + result.path;
      return;
    }
    if (['.uno:Open', '.uno:OpenFromWriter'].includes(url)) {
      const file = await chooseFile('.docx,.xlsx,.pptx,.doc,.xls,.ppt,.odt,.ods,.odp');
      if (!file) return;
      await saved();
      await request('import?name=' + encodeURIComponent(file.name), {
        method: 'POST',
        body: await file.arrayBuffer(),
      });
      return;
    }
    if (url.startsWith('private:factory/') || ['.uno:NewDoc', '.uno:AddDirect'].includes(url)) {
      const format = url.includes('scalc')
        ? 'xlsx'
        : url.includes('simpress')
          ? 'pptx'
          : url.startsWith('private:factory/')
            ? 'docx'
            : filename.endsWith('.xlsx')
              ? 'xlsx'
              : filename.endsWith('.pptx')
                ? 'pptx'
                : 'docx';
      const name = await askName(
        '新建' + { docx: '文档', xlsx: '表格', pptx: '演示文稿' }[format],
        '未命名',
      );
      if (!name) return;
      await saved();
      await json('create', { name, format });
      return;
    }
    if (url === '.uno:InsertGraphic') {
      const file = await chooseFile('image/png,image/jpeg,image/webp');
      if (!file) return;
      if (file.size > 10000000) throw Error('请选择 10 MB 以内的图片');
      const name = 'image-' + Date.now() + '.' + file.name.split('.').pop();
      FS.writeFile('/tmp/wing/' + name, new Uint8Array(await file.arrayBuffer()));
      port.postMessage({ cmd: 'dispatch', url, image: name });
      return;
    }
    if (['.uno:CloseDoc', '.uno:Quit'].includes(url)) {
      await saved();
      error.hidden = false;
      error.textContent = '文档已保存，可以关闭 Office 标签页。';
      return;
    }
    port.postMessage({ cmd: 'dispatch', url });
  } catch (e) {
    fail(e.message);
  }
}
let exportPending;
function exportBytes() {
  return new Promise((resolve, reject) => {
    if (exportPending) {
      reject(Error('正在导出，请稍候'));
      return;
    }
    const timeout = setTimeout(() => {
      exportPending = null;
      reject(Error('导出超时'));
    }, 15000);
    exportPending = {
      resolve: () => {
        clearTimeout(timeout);
        resolve(FS.readFile('/tmp/wing/' + filename));
      },
    };
    port.postMessage({ cmd: 'export' });
  });
}
let menus = [];
const menuPanels = new Map();
function renderMenus(items) {
  menus = items;
  const bar = document.getElementById('menus');
  menuPanels.clear();
  bar.replaceChildren();
  function item(data, top = false) {
    if (!data.label) return document.createElement('hr');
    if (data.lazy || data.children?.length) {
      const group = document.createElement('details');
      group.className = top ? 'menu' : 'submenu';
      const label = document.createElement('summary');
      label.textContent = data.label;
      const panel = document.createElement('div');
      panel.className = 'menu-items';
      (data.children || []).forEach((child) => panel.append(item(child)));
      menuPanels.set(data.path, (children) => {
        if (/^文件/.test(data.label))
          children = children.filter((child) => !/(远程文档|检入|检出|签名)/.test(child.label));
        if (/^新建/.test(data.label))
          children = [
            { label: '文档', url: 'private:factory/swriter' },
            { label: '表格', url: 'private:factory/scalc' },
            { label: '演示文稿', url: 'private:factory/simpress' },
          ];
        data.children = children;
        data.lazy = false;
        panel.replaceChildren(...children.map((child) => item(child)));
      });
      group.append(label, panel);
      group.addEventListener('toggle', () => {
        if (group.open && data.lazy) port.postMessage({ cmd: 'menu-expand', path: data.path });
        if (group.open)
          for (const other of group.parentElement.children)
            if (other !== group && other.tagName === 'DETAILS') other.open = false;
      });
      return group;
    }
    const button = document.createElement('button');
    button.textContent = data.label;
    button.disabled = !data.url;
    button.onclick = () => {
      bar.querySelectorAll('details').forEach((d) => (d.open = false));
      void menuAction(data.url);
    };
    return button;
  }
  for (const menu of menus) {
    if (/^文件/.test(menu.label)) {
      menu.children = menu.children.filter((m) => !/(远程文档|检入|检出|签名)/.test(m.label));
      const newItem = menu.children.find((m) => /^新建/.test(m.label));
      if (newItem)
        newItem.children = [
          { label: '文档', url: 'private:factory/swriter' },
          { label: '表格', url: 'private:factory/scalc' },
          { label: '演示文稿', url: 'private:factory/simpress' },
        ];
    }
    bar.append(item(menu, true));
  }
  bar.hidden = false;
  document.body.classList.add('has-menus');
  window.dispatchEvent(new Event('resize'));
}
let contextPosition = { x: 20, y: 60 };
canvas.addEventListener('pointerdown', (event) => {
  contextPosition = { x: event.clientX, y: event.clientY };
});
function closeContextMenu() {
  document.getElementById('office-context-menu')?.remove();
}
function renderContextMenu(menus) {
  closeContextMenu();
  const menu = document.createElement('div');
  menu.id = 'office-context-menu';
  menu.setAttribute('role', 'menu');
  function append(items, parent) {
    for (const data of items) {
      if (!data.label) {
        parent.append(document.createElement('hr'));
        continue;
      }
      if (data.children?.length) {
        const group = document.createElement('details');
        const label = document.createElement('summary');
        label.textContent = data.label;
        const sub = document.createElement('div');
        sub.className = 'context-submenu';
        append(data.children, sub);
        group.append(label, sub);
        parent.append(group);
      } else {
        const button = document.createElement('button');
        button.setAttribute('role', 'menuitem');
        button.textContent = data.label;
        button.disabled = !data.url;
        button.onclick = () => {
          closeContextMenu();
          officeInput.focus();
          void menuAction(data.url);
        };
        parent.append(button);
      }
    }
  }
  append(menus, menu);
  document.body.append(menu);
  menu.style.left =
    Math.max(4, Math.min(contextPosition.x, innerWidth - menu.offsetWidth - 4)) + 'px';
  menu.style.top =
    Math.max(4, Math.min(contextPosition.y, innerHeight - menu.offsetHeight - 4)) + 'px';
  menu.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeContextMenu();
      officeInput.focus();
      event.preventDefault();
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const controls = [...menu.querySelectorAll('button:not(:disabled),summary')].filter(
        (el) => el.getClientRects().length,
      );
      const index = controls.indexOf(document.activeElement);
      controls[
        (index + (event.key === 'ArrowDown' ? 1 : -1) + controls.length) % controls.length
      ]?.focus();
      event.preventDefault();
    }
  });
  menu.querySelector('button:not(:disabled),summary')?.focus();
}
document.addEventListener('pointerdown', (e) => {
  if (!e.target.closest('#office-context-menu')) closeContextMenu();
  if (!e.target.closest('#menus'))
    document.querySelectorAll('#menus details').forEach((d) => (d.open = false));
});
async function receive(e) {
  const data = e.data;
  try {
    if (data.cmd === 'running') {
      await json('status', { ready: false, error: '' });
      const info = await (await request('info')).json();
      filename = info.name;
      const bytes = new Uint8Array(await (await request('file')).arrayBuffer());
      try {
        FS.mkdir('/tmp/wing');
      } catch {}
      FS.writeFile('/tmp/wing/' + filename, bytes);
      port.postMessage({ cmd: 'open', filename, blank: bytes.length === 0 });
    } else if (data.cmd === 'ready') {
      ready = true;
      loading.style.display = 'none';
      canvas.style.visibility = 'visible';
      fontPicker.disabled = false;
      window.dispatchEvent(new Event('resize'));
      await json('status', { ready: true });
    } else if (data.cmd === 'font-list') showFonts(data.families);
    else if (data.cmd === 'font-result') {
      fontPicker.disabled = false; fontPicker.value = '';
      document.getElementById('font-status').textContent = data.error || '';
      officeInput.focus();
    } else if (data.cmd === 'menus') renderMenus(data.menus);
    else if (data.cmd === 'menu-items') menuPanels.get(data.path)?.(data.items);
    else if (data.cmd === 'context-menu') renderContextMenu(data.menus);
    else if (data.cmd === 'menu-error') console.error('Office menu:', data.error);
    else if (data.cmd === 'menu-action') void menuAction(data.url);
    else if (data.cmd === 'changed') {
      changed = true;
      void json('status', { dirty: true }).catch(() => {});
      generation++;
      clearTimeout(saveTimer);
      saveTimer = setTimeout(save, 1500);
    } else if (data.cmd === 'exported') {
      const pending = exportPending;
      exportPending = null;
      pending?.resolve();
    } else if (data.cmd === 'saved') {
      const bytes = FS.readFile('/tmp/wing/' + filename);
      if (data.download) downloadBytes(bytes);
      try {
        if (conflict) throw Error('原文件已变化，请另存副本');
        await request('file', {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: bytes,
        });
        changed = generation !== data.generation;
        await json('status', { dirty: changed });
        error.hidden = true;
      } catch (e) {
        conflict = true;
        fail('保存未完成，编辑内容已保留。' + e.message);
        saveWaiters.splice(0).forEach((w) => w.reject(e));
      } finally {
        saving = false;
      }
      if (!conflict) {
        if (changed || downloadNext) save(downloadNext);
        else saveWaiters.splice(0).forEach((w) => w.resolve());
      }
    } else if (data.cmd === 'result') {
      await json('result', data);
      if (data.changed) save();
    } else if (data.cmd === 'error') {
      saving = false;
      saveWaiters.splice(0).forEach((w) => w.reject(Error(data.error)));
      fail(data.error);
    }
  } catch (e) {
    saving = false;
    fail(e.message);
  }
}
window.addEventListener('beforeunload', (e) => {
  if (changed || saving) {
    e.preventDefault();
    e.returnValue = '';
  }
});
setInterval(async () => {
  if (!ready) return;
  try {
    const state = await (await request('commands')).json();
    for (const command of state.commands) {
      if (command.action === 'save') save();
      else if (command.action === 'download') save(true);
      else port.postMessage({ cmd: 'action', ...command });
    }
  } catch {
    /* Keep unsaved edits alive during host interruptions. */
  }
}, 700);
const script = document.createElement('script');
script.src = '/soffice.js';
script.onload = () => {
  Module.uno_main
    .then((p) => {
      port = p;
      port.onmessage = receive;
    })
    .catch((e) => fail(e.message));
};
script.onerror = () => fail('Office 组件加载失败');
document.body.appendChild(script);
