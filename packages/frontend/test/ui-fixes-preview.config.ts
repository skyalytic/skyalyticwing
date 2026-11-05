import { defineConfig, mergeConfig } from 'vite';
import config from '../vite.config';
import { mkdirSync, readdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const fixture = resolve(__dirname, '../../../build/ui-fixes-20261020/fixture-project');
mkdirSync(fixture, { recursive: true });
export default mergeConfig(config, defineConfig({
  server: { host: '127.0.0.1', port: 19377, strictPort: true },
  plugins: [{ name: 'isolated-ui-qa', configureServer(server) {
    server.middlewares.use('/api/files/serve', (_req, res) => { res.setHeader('Content-Type', 'image/jpeg'); res.end(readFileSync(resolve(fixture, 'preview.jpg'))); });
    server.middlewares.use('/__qa', (req, res, next) => {
      if (req.url === '/browser-image') { res.end(readFileSync(resolve(fixture, 'preview.jpg')).toString('base64')); }
      else if (req.url === '/files' && req.method === 'GET') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ entries: readdirSync(fixture).map(name => ({ name, type: 'file', size: 0 })) }));
      } else if (req.url === '/write' && req.method === 'POST') {
        writeFileSync(resolve(fixture, 'snake.html'), '<!doctype html><title>隔离文件刷新验证</title><h1>文件已写入</h1>');
        res.end('ok');
      } else next();
    });
  } }],
}));
