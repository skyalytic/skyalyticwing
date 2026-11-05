(() => {
  async function command(name, args = {}) {
    try {
      if (!window.__TAURI_INTERNALS__?.invoke) throw new Error('Desktop runtime unavailable');
      await window.__TAURI_INTERNALS__.invoke(name, args);
    } catch {
      document.getElementById('startup-status').textContent = '请退出 Wing 后重新打开。你的账号、聊天和文件会保留。';
      document.body.classList.add('startup-failed');
    }
  }
  document.getElementById('startup-retry').addEventListener('click', () => command('plugin:process|restart'));
  for (const id of ['startup-close', 'startup-exit']) {
    document.getElementById(id).addEventListener('click', () => command('plugin:process|exit', { code: 0 }));
  }
})();
