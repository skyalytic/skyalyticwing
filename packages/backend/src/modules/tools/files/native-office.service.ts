import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Injectable,
  Param,
  Post,
} from '@nestjs/common';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import JSZip from 'jszip';
import { CFB } from 'xlsx';
import { SecurityManagerService } from '../../core/security/security-manager.service.js';
import { getDefaultDataDir } from '../../core/utils/web-data.util.js';
import { withFileMutation } from './checkpoint-store.js';
import { documentSession, withDocumentSession } from './document-history.js';
import { OfficeService } from './office.service.js';
import { createWorkfile } from './create-workfile.js';
import { localOfficeFonts, type OfficeFont } from './office-fonts.js';
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const LIMIT = 50 * 1024 * 1024;
interface OfficeSession {
  id: string;
  key: string;
  path: string;
  revision: string;
  expires: number;
  ready: boolean;
  dirty: boolean;
  savedAt: number;
  error: string;
  navigation?: string;
  historySessionId?: string;
  commands: Array<{ id: string; action: string; args: Record<string, unknown> }>;
  results: Map<string, unknown>;
  fonts?: OfficeFont[];
}
@Injectable()
export class NativeOfficeService {
  private server?: Server;
  private port = 0;
  private starting: Promise<void> | undefined;
  private sessions = new Map<string, OfficeSession>();
  private assetsDirectory = '';
  constructor(private readonly security: SecurityManagerService) {}
  private assets() {
    if (this.assetsDirectory) return this.assetsDirectory;
    let directory = __dirname;
    for (let i = 0; i < 10; i++) {
      for (const folder of [
        join(directory, 'office-wasm'),
        join(directory, 'deploy', 'office-wasm'),
        join(directory, 'build', 'office-wasm-runtime'),
      ])
        if (
          [
            'soffice.wasm',
            'soffice.js',
            'soffice.data',
            'soffice.data.js.metadata',
            'zeta.js',
            'host.js',
            'input.js',
            'worker.js',
            'index.html',
            'editor.css',
          ].every((name) => existsSync(join(folder, name)))
        )
          return (this.assetsDirectory = folder);
      directory = dirname(directory);
    }
    return '';
  }
  status() {
    return { available: !!this.assets(), engine: 'local-wasm', requiresVirtualMachine: false };
  }
  private checked(raw: string) {
    if (typeof raw !== 'string' || !raw || raw.includes('\0'))
      throw new BadRequestException('文档路径无效');
    const path = resolve(raw);
    if (
      !['.docx', '.xlsx', '.pptx', '.doc', '.xls', '.ppt', '.odt', '.ods', '.odp'].includes(
        extname(path).toLowerCase(),
      )
    )
      throw new BadRequestException('请选择文档、表格或演示文稿');
    if (!this.security.isPathAllowed(path, 'read') || !this.security.isPathAllowed(path, 'write'))
      throw new BadRequestException('文档未授权');
    if (!statSync(path).isFile() || statSync(path).size > LIMIT)
      throw new BadRequestException('文档超过 50 MB');
    return path;
  }
  private session(id: string) {
    const s = this.sessions.get(id);
    if (!s || s.expires < Date.now()) throw new BadRequestException('Office 会话已过期');
    this.checked(s.path);
    s.expires = Date.now() + 86400000;
    return s;
  }
  async open(raw: string) {
    const path = this.checked(raw);
    const bytes = readFileSync(path);
    // Windows shell templates can be zero-byte placeholders. The local editor opens
    // a blank document and writes a valid Office container on the first save.
    if (bytes.length) await this.validateDocument(bytes, extname(path).toLowerCase());
    if (!this.assets()) throw new BadRequestException('当前预览版缺少内置 Office 组件');
    await this.listen();
    for (const [id, s] of this.sessions) if (s.expires < Date.now()) this.sessions.delete(id);
    let s = [...this.sessions.values()].find((item) => item.path === path);
    if (!s) {
      if (this.sessions.size >= 12) throw new BadRequestException('请先关闭不使用的 Office 文档');
      s = {
        id: randomBytes(20).toString('hex'),
        key: randomBytes(32).toString('hex'),
        path,
        revision: hash(bytes),
        expires: Date.now() + 86400000,
        ready: false,
        dirty: false,
        savedAt: 0,
        error: '',
        commands: [],
        results: new Map(),
      };
      this.sessions.set(s.id, s);
    }
    delete s.navigation;
    return {
      id: s.id,
      url: `http://127.0.0.1:${this.port}/edit/${s.id}#${s.key}`,
      name: basename(path),
    };
  }
  state(id: string) {
    const s = this.session(id);
    return {
      id,
      ready: s.ready,
      dirty: s.dirty,
      savedAt: s.savedAt,
      error: s.error,
      navigation: s.navigation,
    };
  }
  release(id: string) {
    this.session(id);
    this.sessions.delete(id);
    return { closed: true };
  }
  command(id: string, action: string, args: Record<string, unknown> = {}) {
    const s = this.session(id);
    if (!['read_selection', 'download'].includes(action) && documentSession()) s.historySessionId = documentSession()!;
    if (
      ![
        'save',
        'download',
        'insert_text',
        'set_cell',
        'insert_slide',
        'format',
        'read_selection',
      ].includes(action)
    )
      throw new BadRequestException('不支持的 Office 操作');
    if (s.commands.length >= 20) throw new BadRequestException('Office 操作队列繁忙');
    if (
      action === 'set_cell' &&
      (!Number.isInteger(args['row']) ||
        !Number.isInteger(args['column']) ||
        Number(args['row']) < 0 ||
        Number(args['column']) < 0 ||
        Number(args['row']) > 1048575 ||
        Number(args['column']) > 16383)
    )
      throw new BadRequestException('单元格坐标无效');
    if (
      action === 'set_cell' &&
      args['sheet'] !== undefined &&
      (!Number.isInteger(args['sheet']) || Number(args['sheet']) < 0)
    )
      throw new BadRequestException('工作表编号无效');
    if (JSON.stringify(args).length > 100000) throw new BadRequestException('操作内容过长');
    const command = { id: randomBytes(12).toString('hex'), action, args };
    s.commands.push(command);
    return { id: command.id, queued: true };
  }
  selection(id: string) {
    return this.live(this.session(id).path, 'read_selection');
  }
  result(id: string, commandId: string) {
    const s = this.session(id);
    return s.results.get(commandId) || { pending: true };
  }
  async live(path: string, action: string, args: Record<string, unknown> = {}) {
    const full = this.checked(path),
      s = [...this.sessions.values()].find((s) => s.path === full && s.ready);
    if (!s) throw new BadRequestException('请先在内置 Office 中打开此文档');
    const command = this.command(s.id, action, args);
    if (['save', 'download'].includes(action)) return command;
    const end = Date.now() + 12000;
    while (Date.now() < end) {
      const result = s.results.get(command.id) as { error?: string } | undefined;
      if (result) {
        s.results.delete(command.id);
        if (result.error) throw new BadRequestException(result.error);
        return result;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new BadRequestException('编辑器响应超时，请确认文档仍然打开');
  }
  private async listen() {
    if (this.server) return;
    if (this.starting) return this.starting;
    this.starting = new Promise<void>((ok, fail) => {
      const server = createServer((req, res) => {
        void this.handle(req, res).catch((e) => {
          if (!res.headersSent) res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end(e instanceof Error ? e.message : '请求失败');
        });
      });
      server.requestTimeout = 60000;
      const portFile = join(getDefaultDataDir(), 'office-runtime-port');
      let preferred = 0;
      try {
        const previous = Number(readFileSync(portFile, 'utf8'));
        if (Number.isInteger(previous) && previous >= 1024 && previous <= 65535)
          preferred = previous;
      } catch {
        /* First launch uses an available local port. */
      }
      server.on('error', (error: NodeJS.ErrnoException) => {
        if (preferred && error.code === 'EADDRINUSE') {
          preferred = 0;
          server.listen(0, '127.0.0.1');
        } else fail(error);
      });
      server.once('listening', () => {
        this.server = server;
        this.port = (server.address() as { port: number }).port;
        // A stable origin allows the webview to reuse its local engine assets.
        try {
          mkdirSync(dirname(portFile), { recursive: true });
          writeFileSync(portFile, String(this.port));
        } catch {}
        ok();
      });
      server.listen(preferred, '127.0.0.1');
    });
    try {
      await this.starting;
    } finally {
      this.starting = undefined;
    }
  }
  private async body(req: IncomingMessage, limit = LIMIT) {
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of req) {
      length += chunk.length;
      if (length > limit) throw new Error('内容过大');
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  private async handle(req: IncomingMessage, res: ServerResponse) {
    const base = `http://127.0.0.1:${this.port}`,
      url = new URL(req.url || '/', base);
    if (req.headers.host !== `127.0.0.1:${this.port}`) {
      res.writeHead(403);
      res.end();
      return;
    }
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval'; worker-src 'self' blob:; connect-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; object-src 'none'; frame-ancestors 'none'",
    );
    if (req.headers.origin && req.headers.origin !== base) {
      res.writeHead(403);
      res.end();
      return;
    }
    const match =
      /^\/documents\/([a-f0-9]{40})\/(info|file|status|commands|result|create|import|copy|fonts|font)$/.exec(
        url.pathname,
      );
    if (match) {
      res.setHeader('Cache-Control', 'no-store');
      const s = this.session(match[1]!);
      if (req.headers['x-wing-capability'] !== s.key) {
        res.writeHead(403);
        res.end();
        return;
      }
      const action = match[2];
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      if (req.method === 'GET' && action === 'info')
        res.end(JSON.stringify({ name: basename(s.path) }));
      else if (req.method === 'GET' && action === 'fonts') {
        s.fonts ||= localOfficeFonts();
        res.end(JSON.stringify(s.fonts.map(({ path: _path, ...font }) => font)));
      } else if (req.method === 'GET' && action === 'font') {
        const font = s.fonts?.find(f => f.id === url.searchParams.get('id'));
        if (!font) throw new BadRequestException('字体不可用');
        if (statSync(font.path).size !== font.bytes) throw new BadRequestException('字体已变化，请重新打开文档');
        res.setHeader('Content-Type', 'application/octet-stream');
        createReadStream(font.path).pipe(res);
      }
      else if (req.method === 'GET' && action === 'file') {
        res.setHeader('Content-Type', 'application/octet-stream');
        res.end(readFileSync(s.path));
      } else if (req.method === 'GET' && action === 'commands') {
        const commands = s.commands.splice(0);
        res.end(JSON.stringify({ commands }));
      } else if (req.method === 'POST' && action === 'file')
        res.end(JSON.stringify(await this.save(s.id, await this.body(req))));
      else if (req.method === 'POST' && action === 'create') {
        const data = JSON.parse((await this.body(req, 4096)).toString());
        const created = await new OfficeService(this.security).create(
          dirname(s.path),
          data.name,
          data.format,
        );
        s.navigation = created.path;
        res.end(JSON.stringify(created));
      } else if (req.method === 'POST' && (action === 'import' || action === 'copy')) {
        const name = url.searchParams.get('name') || '',
          ext = extname(name).slice(1).toLowerCase();
        if (!['docx', 'xlsx', 'pptx', 'doc', 'xls', 'ppt', 'odt', 'ods', 'odp'].includes(ext))
          throw new BadRequestException('不支持此文件格式');
        const bytes = await this.body(req);
        await this.validateDocument(bytes, '.' + ext);
        const created = createWorkfile(
          dirname(s.path),
          basename(name).slice(0, -ext.length - 1),
          ext,
          bytes,
          (p) => this.security.isPathAllowed(p, 'write'),
        );
        if (action === 'import') s.navigation = created.path;
        res.end(JSON.stringify(created));
      } else if (req.method === 'POST' && action === 'status') {
        const data = JSON.parse((await this.body(req, 8192)).toString());
        if (typeof data.ready === 'boolean') s.ready = data.ready;
        if (typeof data.dirty === 'boolean') s.dirty = data.dirty;
        if (typeof data.error === 'string') s.error = data.error.slice(0, 2000);
        res.end('{}');
      } else if (req.method === 'POST' && action === 'result') {
        const data = JSON.parse((await this.body(req, 128000)).toString());
        if (typeof data.id === 'string' && /^[a-f0-9]{24}$/.test(data.id)) {
          s.results.set(data.id, data);
          if (s.results.size > 30) s.results.delete(s.results.keys().next().value!);
        }
        res.end('{}');
      } else {
        res.writeHead(405);
        res.end();
      }
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405);
      res.end();
      return;
    }
    let name = url.pathname.slice(1);
    if (/^edit\/[a-f0-9]{40}$/.test(name)) {
      this.session(name.slice(5));
      name = 'index.html';
      res.setHeader('Cache-Control', 'no-store');
    }
    const types: Record<string, string> = {
      'index.html': 'text/html; charset=utf-8',
      'host.js': 'text/javascript',
      'input.js': 'text/javascript',
      'worker.js': 'text/javascript',
      'zeta.js': 'text/javascript',
      'soffice.js': 'text/javascript',
      'soffice.wasm': 'application/wasm',
      'soffice.data': 'application/octet-stream',
      'soffice.data.js.metadata': 'application/json',
      'editor.css': 'text/css',
    };
    if (!types[name]) {
      res.writeHead(404);
      res.end();
      return;
    }
    const file = join(this.assets(), name);
    res.setHeader('Content-Type', types[name]!);
    const stat = statSync(file);
    if (name !== 'index.html') {
      // Revalidate wrappers on each open; retain large engine assets and compiled
      // WASM in the browser cache instead of retransferring every document.
      const etag = `"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}"`;
      res.setHeader('Cache-Control', 'private, no-cache');
      res.setHeader('ETag', etag);
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304);
        res.end();
        return;
      }
    }
    res.setHeader('Content-Length', stat.size);
    if (req.method === 'HEAD') res.end();
    else createReadStream(file).pipe(res);
  }
  private async validateDocument(bytes: Buffer, ext: string) {
    if (bytes.length > LIMIT || bytes.length < 50)
      throw new BadRequestException('Office 文件大小无效');
    if (['.doc', '.xls', '.ppt'].includes(ext)) {
      if (!bytes.subarray(0, 8).equals(Buffer.from('d0cf11e0a1b11ae1', 'hex')))
        throw new BadRequestException('文件内容与扩展名不匹配，请确认文件格式');
      let entries: string[];
      try {
        entries = CFB.read(bytes, { type: 'buffer' }).FileIndex.map(
          (item: { name: string }) => item.name,
        );
      } catch {
        throw new BadRequestException('旧版 Office 文件结构无法读取');
      }
      const expected =
        ext === '.doc'
          ? ['WordDocument']
          : ext === '.xls'
            ? ['Workbook', 'Book']
            : ['PowerPoint Document'];
      if (!expected.some((name) => entries.includes(name)))
        throw new BadRequestException('文件内容与扩展名不匹配，请确认文件格式');
      return;
    }
    if (bytes.subarray(0, 8).equals(Buffer.from('d0cf11e0a1b11ae1', 'hex')))
      throw new BadRequestException('此文档使用了加密或旧版格式，请先解除密码保护或确认扩展名');
    const zip = await JSZip.loadAsync(bytes).catch(() => {
      throw new BadRequestException(
        '无法读取 Office 文件结构：请确认文件下载完整，且不是仅修改了扩展名',
      );
    });
    const required =
      ext === '.docx'
        ? 'word/document.xml'
        : ext === '.xlsx'
          ? 'xl/workbook.xml'
          : ext === '.pptx'
            ? 'ppt/presentation.xml'
            : 'content.xml';
    if (!zip.file(required)) throw new BadRequestException('保存文件格式不匹配');
  }
  async save(id: string, bytes: Buffer) {
    const s = this.session(id),
      ext = extname(s.path).toLowerCase();
    await this.validateDocument(bytes, ext);
    const sessionId = s.historySessionId;
    return withDocumentSession(sessionId, () => withFileMutation(s.path, async () => {
      this.checked(s.path);
      const previous = readFileSync(s.path);
      if (hash(previous) !== s.revision) {
        const folder = join(getDefaultDataDir(), 'office-conflicts');
        mkdirSync(folder, { recursive: true });
        writeFileSync(join(folder, s.id + ext), bytes);
        s.error =
          '原文件已被 AI 或其他程序修改，编辑副本已保存在 office-conflicts 中；请保留当前窗口并合并修改。';
        throw new BadRequestException(s.error);
      }
      const revision = hash(bytes);
      if (revision !== s.revision) {
        const folder = join(getDefaultDataDir(), 'office-backups');
        mkdirSync(folder, { recursive: true });
        const backup = join(folder, s.id + '-' + s.revision + ext);
        if (!existsSync(backup)) writeFileSync(backup, previous, { flag: 'wx' });
        const tmp = s.path + '.wing-' + randomBytes(8).toString('hex') + '.tmp';
        writeFileSync(tmp, bytes, { flag: 'wx' });
        renameSync(tmp, s.path);
        s.revision = revision;
      }
      s.savedAt = Date.now();
      s.dirty = false;
      s.error = '';
      delete s.historySessionId;
      return { savedAt: s.savedAt, revision: s.revision };
    }));
  }
  onModuleDestroy() {
    this.server?.closeAllConnections();
    this.server?.close();
  }
}
@Controller('office-native')
export class NativeOfficeController {
  constructor(private readonly office: NativeOfficeService) {}
  @Get('status') status() {
    return this.office.status();
  }
  @Post('open') open(@Body() body: { path: string }) {
    return this.office.open(body.path);
  }
  @Post('sessions/:id/selection') selection(@Param('id') id: string) {
    return this.office.selection(id);
  }
  @Get('sessions/:id') state(@Param('id') id: string) {
    return this.office.state(id);
  }
  @Post('sessions/:id/release') release(@Param('id') id: string) {
    return this.office.release(id);
  }
  @Post('sessions/:id/command') command(
    @Param('id') id: string,
    @Body() body: { action: string; args?: Record<string, unknown> },
  ) {
    return this.office.command(id, body.action, body.args);
  }
}
