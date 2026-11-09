import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { OfficeService } from '../../tools/files/office.service.js';
import { createDocTools } from '../../../extensions/bundled/office/tools/doc-tools.js';
import type { SecurityManagerService } from '../security/security-manager.service.js';
import type { ToolContext } from '@skyalyticwing/shared';

type Request = (op: string, args: Record<string, unknown>) => Promise<any>;
const maximum = 25 * 1024 * 1024,
  chunkSize = 4 * 1024 * 1024;
const digest = (value: Buffer) => createHash('sha256').update(value).digest('hex');
export async function readRemoteDocument(request: Request, path: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let offset = 0,
    revision: string | undefined,
    size: number | undefined;
  do {
    const part = await request('binary-read', { path, offset, ...(revision ? { revision } : {}) });
    if (
      !Number.isSafeInteger(part.size) ||
      part.size < 0 ||
      part.size > maximum ||
      typeof part.data !== 'string' ||
      !/^[a-f0-9]{64}$/.test(part.revision) ||
      (revision && revision !== part.revision) ||
      (size !== undefined && size !== part.size)
    )
      throw Error('Invalid remote document response');
    const bytes = Buffer.from(part.data, 'base64');
    if (
      bytes.length > chunkSize ||
      offset + bytes.length > part.size ||
      bytes.toString('base64') !== part.data ||
      (part.nextOffset !== null && part.nextOffset !== offset + bytes.length)
    )
      throw Error('Invalid document chunk');
    chunks.push(bytes);
    offset += bytes.length;
    revision = part.revision;
    size = part.size;
    if (part.nextOffset === null) {
      if (offset !== size) throw Error('Incomplete remote document');
      break;
    }
    if (!bytes.length) throw Error('Empty document chunk');
  } while (offset < maximum);
  const value = Buffer.concat(chunks);
  if (value.length !== size || digest(value) !== revision)
    throw Error('Remote document checksum mismatch');
  return value;
}
export async function writeRemoteDocument(
  request: Request,
  path: string,
  revision: string | null,
  bytes: Buffer,
) {
  if (bytes.length > maximum) throw Error('Remote document exceeds 25 MiB');
  const upload = await request('binary-begin', {
    path,
    revision,
    size: bytes.length,
    digest: digest(bytes),
  });
  try {
    for (let offset = 0; offset < bytes.length; offset += chunkSize)
      await request('binary-chunk', {
        path,
        id: upload.id,
        offset,
        data: bytes.subarray(offset, offset + chunkSize).toString('base64'),
      });
    return await request('binary-commit', { path, id: upload.id });
  } catch (error) {
    await request('binary-abort', { path, id: upload.id }).catch(() => {});
    throw error;
  }
}
export async function remoteOfficeTool(root: string, name: string, args: any, request: Request) {
  const security = { isPathAllowed: () => false } as unknown as SecurityManagerService;
  const codec = new OfficeService(security);
  if (name === 'doc_generate') {
    const path = posix.resolve(root, args?.outputPath || 'doc-' + Date.now() + '.' + args?.format);
    const base = await request('binary-stat', { path });
    const tools = createDocTools(
      { isPathAllowed: (value: string) => value === path } as SecurityManagerService,
      {
        resolve: () => path,
        write: async (bytes) => {
          await writeRemoteDocument(request, path, base.revision, bytes);
        },
      },
    );
    return tools[0]!.execute({ ...args, outputPath: path }, { workspace: root } as ToolContext);
  }
  if (typeof args?.path !== 'string' || !args.path) throw Error('Office document path required');
  const format = posix.extname(args.path).slice(1).toLowerCase();
  if (!['docx', 'xlsx', 'pptx'].includes(format))
    throw Error('Office format must be docx, xlsx or pptx');
  const before = await readRemoteDocument(request, args.path);
  if (name === 'office_read') {
    const data = await codec.readBuffer(before, format);
    return { success: true, data, output: JSON.stringify(data) };
  }
  const next = await codec.editBuffer(before, format, args.revision, args.changes);
  const saved = await writeRemoteDocument(request, args.path, args.revision, next);
  const data = { revision: saved.revision, saved: args.changes.length };
  return { success: true, data, output: JSON.stringify(data) };
}
