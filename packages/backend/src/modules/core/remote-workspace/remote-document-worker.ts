/** Serialized with the worker; no host filesystem paths are accepted by this transport. */
export function remoteDocumentWorker(target: (root: string, value: unknown) => string) {
  const fs = require('node:fs') as typeof import('node:fs');
  const path = require('node:path') as typeof import('node:path');
  const crypto = require('node:crypto') as typeof import('node:crypto');
  const maximum = 25 * 1024 * 1024,
    chunkSize = 4 * 1024 * 1024;
  type Upload = {
    root: string;
    file: string;
    temp: string;
    fd: number;
    revision: string | null;
    size: number;
    written: number;
    digest: string;
    hash: import('node:crypto').Hash;
  };
  const uploads = new Map<string, Upload>();
  const hash = (bytes: Buffer) => crypto.createHash('sha256').update(bytes).digest('hex');
  const read = (file: string) => {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > maximum)
      throw Error('Remote document exceeds 25 MiB or is not a file');
    const bytes = fs.readFileSync(file);
    if (bytes.length > maximum) throw Error('Remote document exceeds 25 MiB');
    return bytes;
  };
  const revision = (file: string) => (fs.existsSync(file) ? hash(read(file)) : null);
  const remove = (id: string) => {
    const upload = uploads.get(id);
    if (!upload) return;
    uploads.delete(id);
    try {
      fs.closeSync(upload.fd);
    } catch {}
    try {
      target(upload.root, upload.temp);
      fs.unlinkSync(upload.temp);
    } catch (e: any) {
      if (e.code !== 'ENOENT') throw e;
    }
  };
  const run = (root: string, op: string, a: any) => {
    const file = target(root, a.path);
    if (op === 'binary-stat')
      return { revision: revision(file), size: fs.existsSync(file) ? fs.statSync(file).size : 0 };
    if (op === 'binary-read') {
      const bytes = read(file),
        current = hash(bytes);
      if (a.revision !== undefined && a.revision !== current)
        throw Error('Document changed; reload before reading');
      const offset = a.offset ?? 0;
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > bytes.length)
        throw Error('Invalid document offset');
      const end = Math.min(offset + chunkSize, bytes.length);
      return {
        revision: current,
        size: bytes.length,
        data: bytes.subarray(offset, end).toString('base64'),
        nextOffset: end < bytes.length ? end : null,
      };
    }
    if (op === 'binary-begin') {
      if (uploads.size >= 8) throw Error('Remote upload queue full');
      if (
        !Number.isSafeInteger(a.size) ||
        a.size < 0 ||
        a.size > maximum ||
        !/^[a-f0-9]{64}$/.test(a.digest || '') ||
        !(
          a.revision === null ||
          (typeof a.revision === 'string' && /^[a-f0-9]{64}$/.test(a.revision))
        )
      )
        throw Error('Invalid document upload');
      if (file === root || (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()))
        throw Error('Cannot replace root or link');
      if (revision(file) !== a.revision) throw Error('Document changed; reload before saving');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      target(root, file);
      const id = crypto.randomUUID(),
        temp = path.join(path.dirname(file), '.wing-upload-' + id);
      const fd = fs.openSync(temp, 'wx', fs.existsSync(file) ? fs.statSync(file).mode : 0o600);
      uploads.set(id, {
        root,
        file,
        temp,
        fd,
        revision: a.revision,
        size: a.size,
        written: 0,
        digest: a.digest,
        hash: crypto.createHash('sha256'),
      });
      return { id, chunkSize };
    }
    const upload = uploads.get(a.id);
    if (!upload || upload.root !== root || upload.file !== file)
      throw Error('Document upload not found');
    if (op === 'binary-abort') {
      remove(a.id);
      return { aborted: true };
    }
    if (op === 'binary-chunk') {
      if (
        a.offset !== upload.written ||
        typeof a.data !== 'string' ||
        a.data.length > Math.ceil(chunkSize / 3) * 4
      )
        throw Error('Invalid document chunk');
      const bytes = Buffer.from(a.data, 'base64');
      if (
        !bytes.length ||
        bytes.toString('base64') !== a.data ||
        bytes.length > chunkSize ||
        upload.written + bytes.length > upload.size
      )
        throw Error('Invalid document bytes');
      let offset = 0;
      while (offset < bytes.length)
        offset += fs.writeSync(upload.fd, bytes, offset, bytes.length - offset);
      upload.hash.update(bytes);
      upload.written += bytes.length;
      return { written: upload.written };
    }
    if (op === 'binary-commit') {
      try {
        if (upload.written !== upload.size || upload.hash.digest('hex') !== upload.digest)
          throw Error('Incomplete or corrupt document upload');
        target(root, file);
        if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink())
          throw Error('Cannot replace link');
        if (revision(file) !== upload.revision) throw Error('Document changed during save');
        fs.fsyncSync(upload.fd);
        fs.closeSync(upload.fd);
        upload.fd = -1;
        fs.renameSync(upload.temp, file);
        uploads.delete(a.id);
        return { path: file, revision: upload.digest, size: upload.size };
      } finally {
        remove(a.id);
      }
    }
    throw Error('Unsupported binary operation');
  };
  return {
    run,
    read,
    revision,
    close: () => {
      for (const id of uploads.keys())
        try {
          remove(id);
        } catch {}
    },
  };
}
