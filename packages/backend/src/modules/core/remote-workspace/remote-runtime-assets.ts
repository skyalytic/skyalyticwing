import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { getDefaultDataDir } from '../utils/web-data.util.js';
import { REMOTE_RUNTIME_ASSETS, REMOTE_NODE_VERSION, REMOTE_RG_VERSION } from './remote-runtime.js';

export async function downloadRemoteAsset(
  kind: 'node' | 'rg',
  target: string,
  signal: AbortSignal,
): Promise<Buffer> {
  const asset = Object.values(REMOTE_RUNTIME_ASSETS)
    .map((entry) => entry[kind])
    .find((entry) => entry[0] === target);
  if (!asset) throw Error('Unknown remote runtime asset');
  const digest = asset[1],
    folder = join(getDefaultDataDir(), 'remote-runtime-assets'),
    file = join(folder, digest + '.tgz');
  const valid = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex') === digest;
  try {
    const bytes = await readFile(file);
    if (valid(bytes)) return bytes;
  } catch {}
  const urls =
    kind === 'node'
      ? [
          'https://nodejs.org/dist/v' +
            REMOTE_NODE_VERSION +
            '/node-v' +
            REMOTE_NODE_VERSION +
            '-' +
            target +
            '.tar.gz',
          'https://cdn.npmmirror.com/binaries/node/v' +
            REMOTE_NODE_VERSION +
            '/node-v' +
            REMOTE_NODE_VERSION +
            '-' +
            target +
            '.tar.gz',
        ]
      : [
          'https://github.com/BurntSushi/ripgrep/releases/download/' +
            REMOTE_RG_VERSION +
            '/ripgrep-' +
            REMOTE_RG_VERSION +
            '-' +
            target +
            '.tar.gz',
        ];
  let reason = 'Download unavailable';
  for (const url of urls) {
    if (signal.aborted) throw Error('Runtime preparation cancelled');
    try {
      const response = await fetch(url, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(120000)]),
      });
      if (!response.ok || !response.body) throw Error('Runtime download HTTP ' + response.status);
      const reader = response.body.getReader(),
        parts: Buffer[] = [];
      let size = 0;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 128 * 1024 * 1024) throw Error('Runtime archive exceeds size limit');
          parts.push(Buffer.from(value));
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      const bytes = Buffer.concat(parts);
      if (!valid(bytes)) throw Error('Runtime download checksum mismatch');
      if (signal.aborted) throw Error('Runtime preparation cancelled');
      await mkdir(folder, { recursive: true });
      const temp = file + '.' + randomUUID() + '.tmp';
      try {
        await writeFile(temp, bytes, { flag: 'wx', mode: 0o600 });
        await rename(temp, file);
      } finally {
        await unlink(temp).catch(() => {});
      }
      return bytes;
    } catch (error) {
      reason = error instanceof Error ? error.message : String(error);
    }
  }
  throw Error(reason);
}
