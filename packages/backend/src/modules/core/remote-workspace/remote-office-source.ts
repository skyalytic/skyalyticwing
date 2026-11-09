import { posix } from 'node:path';
import { createOfficePreset } from '../../tools/files/office-presets.js';
import { readRemoteDocument, writeRemoteDocument } from './remote-office.js';

export interface RemoteOfficeSource {
  scope: string;
  path: string;
  check(): void;
  read(): Promise<Buffer>;
  write(bytes: Buffer, revision: string): Promise<{ revision: string }>;
  create(name: string, format: string, bytes?: Buffer): Promise<{ path: string; name: string }>;
}
const formats = ['docx', 'xlsx', 'pptx', 'doc', 'xls', 'ppt', 'odt', 'ods', 'odp'];
export function remoteOfficeSource(
  scope: string,
  root: string,
  raw: string,
  check: () => void,
  request: (op: string, args: Record<string, unknown>) => Promise<any>,
): RemoteOfficeSource {
  if (typeof raw !== 'string' || !raw || raw.includes('\0')) throw Error('Invalid document path');
  const path = posix.resolve(root, raw),
    relative = posix.relative(root, path);
  if (
    relative === '..' ||
    relative.startsWith('../') ||
    !formats.includes(posix.extname(path).slice(1).toLowerCase())
  )
    throw Error('Document must be inside the remote workspace');
  return {
    scope,
    path,
    check,
    read: () => readRemoteDocument(request, path),
    write: (bytes, revision) => writeRemoteDocument(request, path, revision, bytes),
    async create(name, format, bytes) {
      const title = typeof name === 'string' ? name.trim() : '';
      if (
        !title ||
        title.length > 80 ||
        /[<>:"/\\|?*\x00-\x1f]/.test(title) ||
        /[. ]$/.test(title) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(title) ||
        !formats.includes(format)
      )
        throw Error('Invalid document name or format');
      const content = bytes ?? (await createOfficePreset(format, 'blank'));
      for (let n = 0; n < 1000; n++) {
        const filename = title + (n ? ` (${n + 1})` : '') + '.' + format;
        const target = posix.join(posix.dirname(path), filename);
        if ((await request('binary-stat', { path: target })).revision !== null) continue;
        try {
          await writeRemoteDocument(request, target, null, content);
        } catch (error) {
          // A concurrent creator wins its filename; other failures must stay visible.
          if ((await request('binary-stat', { path: target })).revision !== null) continue;
          throw error;
        }
        return { path: target, name: filename };
      }
      throw Error('Too many documents with the same name');
    },
  };
}
