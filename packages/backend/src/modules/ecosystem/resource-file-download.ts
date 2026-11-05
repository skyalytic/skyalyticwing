import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, open, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';

export function safeResourcePath(path: unknown): path is string {
  return (
    typeof path === 'string' &&
    !!path &&
    path === path.normalize('NFC') &&
    !/[\\\x00-\x1f<>:"|?*]/.test(path) &&
    !path
      .split('/')
      .some(
        (p) =>
          !p ||
          p === '.' ||
          p === '..' ||
          /[. ]$/.test(p) ||
          /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p),
      ) &&
    !['.skyalytic-install.json', 'wing-enterprise-entry.cjs'].includes(path)
  );
}
export async function downloadResourceFiles(
  descriptor: any,
  id: string,
  digest: string,
  parent: string,
  request: (path: string) => Promise<any>,
  current: () => boolean,
) {
  if (
    descriptor.format !== 'wing-files-v2' ||
    !Number.isSafeInteger(descriptor.count) ||
    descriptor.count < 1 ||
    !Number.isSafeInteger(descriptor.totalBytes) ||
    descriptor.totalBytes < 0 ||
    !/^[a-f0-9]{64}$/.test(descriptor.indexSha256)
  )
    throw Error('资源清单无效');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, '.download-'));
  const files: Array<{ path: string; source: string }> = [],
    names = new Set<string>(),
    indexHash = createHash('sha256');
  let cursor: number | null = 0,
    total = 0;
  const base = 'enterprise/artifact-files/' + encodeURIComponent(id) + '?digest=' + digest;
  try {
    do {
      if (!current()) throw Error('登录身份已变化，下载已停止');
      const page = await request(base + '&cursor=' + cursor);
      if (
        typeof page.lines !== 'string' ||
        Buffer.byteLength(page.lines) > 262144 ||
        (page.next !== null && (!Number.isSafeInteger(page.next) || page.next <= cursor!))
      )
        throw Error('资源清单分页无效');
      indexHash.update(page.lines);
      const entries = page.lines.trim()
        ? page.lines
            .trimEnd()
            .split('\n')
            .map((line: string) => JSON.parse(line))
        : [];
      for (const f of entries) {
        if (
          !safeResourcePath(f.path) ||
          names.has(f.path.toLowerCase()) ||
          !/^[a-f0-9]{64}$/.test(f.key) ||
          !/^[a-f0-9]{64}$/.test(f.sha256) ||
          !Number.isSafeInteger(f.size) ||
          f.size < 0 ||
          total + f.size > descriptor.totalBytes ||
          files.length >= descriptor.count
        )
          throw Error('资源文件清单无效');
        names.add(f.path.toLowerCase());
        total += f.size;
        const source = join(root, f.path);
        await mkdir(dirname(source), { recursive: true });
        const h = await open(source, 'wx'),
          hash = createHash('sha256');
        try {
          let offset = 0;
          while (offset < f.size) {
            if (!current()) throw Error('登录身份已变化，下载已停止');
            const part = await request(base + '&key=' + f.key + '&offset=' + offset),
              data = Buffer.from(part.content || '', 'base64');
            if (
              !data.length ||
              data.length > 1024 * 1024 ||
              part.offset !== offset ||
              part.next !== offset + data.length ||
              part.size !== f.size ||
              part.next > f.size
            )
              throw Error('文件分块校验失败');
            await h.writeFile(data);
            hash.update(data);
            offset = part.next;
          }
          if (hash.digest('hex') !== f.sha256) throw Error('文件完整性校验失败');
        } finally {
          await h.close();
        }
        files.push({ path: f.path, source });
      }
      cursor = page.next;
    } while (cursor !== null);
    if (
      files.length !== descriptor.count ||
      total !== descriptor.totalBytes ||
      indexHash.digest('hex') !== descriptor.indexSha256
    )
      throw Error('资源清单摘要不匹配');
    return { root, files, cleanup: () => rm(root, { recursive: true, force: true }) };
  } catch (e) {
    await rm(root, { recursive: true, force: true });
    throw e;
  }
}
