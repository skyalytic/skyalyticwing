import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Injectable,
  Param,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { basename, extname, join, resolve } from 'node:path';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { Request, Response } from 'express';
import { DOMParser } from '@xmldom/xmldom';
import { SecurityManagerService } from '../../core/security/security-manager.service.js';
import { getDefaultDataDir } from '../../core/utils/web-data.util.js';
import { withFileMutation } from './checkpoint-store.js';
import JSZip from 'jszip';
import { readJsonRecover, writeJsonAtomicSync } from '../../core/utils/atomic-json.util.js';

interface EditSession {
  id: string;
  path: string;
  revision: string;
  expires: number;
  savedAt?: number;
  error?: string;
}
interface EngineSettings {
  url: string;
  internal: string;
  callback: string;
  frameOrigin: string;
}
const digest = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const LIMIT = 50 * 1024 * 1024;
const services = new Set<OfficeEngineService>();
export function allowsOfficeEngineRequest(rawUrl: string, method: string): boolean {
  try {
    const url = new URL(rawUrl, 'http://localhost');
    const match = /^\/api\/office-engine\/wopi\/files\/([a-f0-9]{48})(\/contents)?$/.exec(
      url.pathname,
    );
    if (!match || !['GET', 'POST'].includes(method) || (method === 'POST' && !match[2]))
      return false;
    return [...services].some((service) =>
      service.validCapability(match[1]!, url.searchParams.get('access_token') || ''),
    );
  } catch {
    return false;
  }
}
/** Wing-owned WOPI storage integration. The Office engine is a separate MPL component. */
@Injectable()
export class OfficeEngineService {
  private readonly sessions = new Map<string, EditSession>();
  private readonly secret: Buffer;
  private readonly statePath = join(getDefaultDataDir(), 'office-engine-state.json');
  private readonly configPath = join(getDefaultDataDir(), 'office-engine-config.json');
  constructor(private readonly security: SecurityManagerService) {
    const state = readJsonRecover<{ secret?: string; sessions?: EditSession[] }>(
      this.statePath,
      {},
    );
    this.secret =
      typeof state.secret === 'string' && /^[a-f0-9]{64}$/.test(state.secret)
        ? Buffer.from(state.secret, 'hex')
        : randomBytes(32);
    for (const s of Array.isArray(state.sessions) ? state.sessions : [])
      if (s && typeof s.id === 'string' && typeof s.path === 'string' && s.expires > Date.now())
        this.sessions.set(s.id, s);
    services.add(this);
  }
  private persist() {
    writeJsonAtomicSync(this.statePath, {
      secret: this.secret.toString('hex'),
      sessions: [...this.sessions.values()],
    });
  }
  onModuleDestroy() {
    services.delete(this);
  }
  private normalizeSettings(raw: Partial<EngineSettings>): EngineSettings {
    const result = { url: '', internal: '', callback: '', frameOrigin: '' };
    for (const key of Object.keys(result) as Array<keyof EngineSettings>) {
      const value = raw[key];
      if (value !== undefined && typeof value !== 'string')
        throw new BadRequestException('Office 服务地址无效');
      if (!value) continue;
      try {
        const parsed = new URL(value.trim());
        if (
          !['http:', 'https:'].includes(parsed.protocol) ||
          parsed.username ||
          parsed.password ||
          parsed.search ||
          parsed.hash ||
          parsed.pathname !== '/'
        )
          throw new Error();
        result[key] = parsed.origin;
      } catch {
        throw new BadRequestException('请填写完整的 http(s) 服务地址，不包含路径或密码');
      }
    }
    result.internal ||= result.url;
    return result;
  }
  private settings() {
    const saved = readJsonRecover<Partial<EngineSettings>>(this.configPath, {});
    const cfg = this.normalizeSettings({
      url: process.env['WING_OFFICE_URL'] || saved.url || '',
      internal: process.env['WING_OFFICE_INTERNAL_URL'] || saved.internal || '',
      callback: process.env['WING_OFFICE_CALLBACK_BASE_URL'] || saved.callback || '',
      frameOrigin: process.env['WING_OFFICE_FRAME_ORIGIN'] || saved.frameOrigin || '',
    });
    return { ...cfg, configured: !!cfg.url && !!cfg.callback };
  }
  configuration() {
    return { ...this.settings(), managed: !!process.env['WING_OFFICE_URL'] };
  }
  configure(raw: Partial<EngineSettings>) {
    if (process.env['WING_OFFICE_URL'])
      throw new BadRequestException('当前引擎由部署配置管理，请联系实例管理员修改');
    const cfg = this.normalizeSettings(raw);
    if (!cfg.url || !cfg.callback || !cfg.frameOrigin)
      throw new BadRequestException('请填写编辑引擎、文件回传和工作台地址');
    writeJsonAtomicSync(this.configPath, cfg);
    return { saved: true };
  }
  private access(s: EditSession) {
    return createHmac('sha256', this.secret)
      .update(s.id + ':' + s.expires)
      .digest('hex');
  }
  private session(id: string) {
    const s = this.sessions.get(id);
    if (!s || s.expires < Date.now())
      throw new UnauthorizedException('Office 会话过期，请重新打开');
    if (
      !this.security.isPathAllowed(s.path, 'read') ||
      !this.security.isPathAllowed(s.path, 'write')
    )
      throw new UnauthorizedException('Office 文件权限已撤销');
    return s;
  }
  validCapability(id: string, credential: string) {
    try {
      const s = this.session(id),
        actual = Buffer.from(credential),
        expected = Buffer.from(this.access(s));
      return actual.length === expected.length && timingSafeEqual(actual, expected);
    } catch {
      return false;
    }
  }
  private authorize(id: string, credential: string) {
    if (!this.validCapability(id, credential))
      throw new UnauthorizedException('Office 文件凭据无效');
    return this.session(id);
  }
  async status() {
    const cfg = this.settings();
    if (!cfg.configured)
      return { configured: false, ready: false, reason: '尚未启动本地或私有 Office 编辑引擎' };
    try {
      const response = await fetch(cfg.internal + '/hosting/discovery', {
        signal: AbortSignal.timeout(5000),
        redirect: 'error',
      });
      return {
        configured: true,
        ready: response.ok && (await response.text()).includes('wopi-discovery'),
      };
    } catch {
      return { configured: true, ready: false, reason: 'Office 编辑引擎无法连接' };
    }
  }
  async open(raw: string) {
    const cfg = this.settings();
    if (!cfg.configured) throw new BadRequestException('请先启动本地或私有 Office 编辑引擎');
    if (typeof raw !== 'string' || !raw) throw new BadRequestException('文件路径不能为空');
    const path = resolve(raw),
      ext = extname(path).slice(1).toLowerCase();
    if (!['docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp'].includes(ext))
      throw new BadRequestException('不支持此 Office 文件格式');
    if (!this.security.isPathAllowed(path, 'read') || !this.security.isPathAllowed(path, 'write'))
      throw new UnauthorizedException('Office 路径未授权');
    if (!statSync(path).isFile() || statSync(path).size > LIMIT)
      throw new BadRequestException('文档超过 50 MB');
    const response = await fetch(cfg.internal + '/hosting/discovery', {
      signal: AbortSignal.timeout(8000),
      redirect: 'error',
    });
    if (!response.ok) throw new BadRequestException('Office 引擎未就绪');
    const xml = await response.text();
    if (xml.length > 2_000_000 || /<!DOCTYPE|<!ENTITY/i.test(xml))
      throw new BadRequestException('Office discovery 无效');
    const discovery = new DOMParser().parseFromString(xml, 'application/xml');
    const action = Array.from(discovery.getElementsByTagName('action')).find(
      (a) => a.getAttribute('ext') === ext && a.getAttribute('name') === 'edit',
    );
    if (!action) throw new BadRequestException('当前 Office 引擎不支持编辑此格式');
    const source = new URL(action.getAttribute('urlsrc')!.replace(/<[^>]*>/g, ''));
    for (const [id, s] of this.sessions) if (s.expires < Date.now()) this.sessions.delete(id);
    const revision = digest(readFileSync(path));
    let s = [...this.sessions.values()].find(
      (s) => s.path === path && s.revision === revision && !s.error,
    );
    if (!s) {
      if (this.sessions.size >= 100) throw new BadRequestException('Office 会话过多');
      s = {
        id: randomBytes(24).toString('hex'),
        path,
        revision,
        expires: Date.now() + 24 * 60 * 60 * 1000,
      };
      this.sessions.set(s.id, s);
    }
    this.persist();
    const editor = new URL(cfg.url + source.pathname);
    editor.searchParams.set('WOPISrc', cfg.callback + '/api/office-engine/wopi/files/' + s.id);
    editor.searchParams.set('lang', 'zh-CN');
    editor.searchParams.set('closebutton', '1');
    return {
      id: s.id,
      editorUrl: editor.toString(),
      credential: this.access(s),
      expires: s.expires,
    };
  }
  info(id: string, credential: string) {
    const s = this.authorize(id, credential);
    return {
      BaseFileName: basename(s.path),
      OwnerId: 'wing-local',
      Size: statSync(s.path).size,
      Version: s.revision,
      UserId: 'wing-' + s.id,
      UserFriendlyName: 'Wing 用户',
      UserCanWrite: true,
      SupportsUpdate: true,
      SupportsLocks: false,
      UserCanNotWriteRelative: true,
      PostMessageOrigin: this.settings().frameOrigin || 'http://127.0.0.1:3000',
    };
  }
  download(id: string, credential: string) {
    return readFileSync(this.authorize(id, credential).path);
  }
  state(id: string) {
    const s = this.session(id);
    return { savedAt: s.savedAt || null, error: s.error || null, revision: s.revision };
  }
  async save(id: string, credential: string, bytes: Buffer) {
    const s = this.authorize(id, credential);
    if (bytes.length > LIMIT) throw new BadRequestException('Office 文件超过 50 MB');
    const zip = await JSZip.loadAsync(bytes).catch(() => {
      throw new BadRequestException('Office 文件损坏或加密，保存被拒绝');
    });
    const ext = extname(s.path).toLowerCase();
    const part: Record<string, string> = {
      '.docx': 'word/document.xml',
      '.xlsx': 'xl/workbook.xml',
      '.pptx': 'ppt/presentation.xml',
      '.odt': 'content.xml',
      '.ods': 'content.xml',
      '.odp': 'content.xml',
    };
    if (!zip.file(part[ext]!)) throw new BadRequestException('Office 文件格式不匹配');
    return withFileMutation(s.path, async () => {
      this.authorize(id, credential);
      if (digest(readFileSync(s.path)) !== s.revision) {
        const copy = s.path + '.office-conflict-' + Date.now() + ext;
        if (!this.security.isPathAllowed(copy, 'write'))
          throw new UnauthorizedException('冲突副本目录不可写，请保持编辑器打开并恢复目录权限');
        writeFileSync(copy, bytes);
        s.error = '原文件已被 AI 或其他程序修改，编辑内容已保存为同目录冲突副本，请合并';
        this.persist();
        return { conflict: true };
      }
      const backups = join(getDefaultDataDir(), 'office-backups');
      mkdirSync(backups, { recursive: true });
      writeFileSync(join(backups, digest(Buffer.from(s.path)) + ext), readFileSync(s.path));
      const temp = s.path + '.office-' + s.id + '.tmp';
      try {
        writeFileSync(temp, bytes);
        renameSync(temp, s.path);
      } finally {
        rmSync(temp, { force: true });
      }
      s.revision = digest(bytes);
      s.savedAt = Date.now();
      delete s.error;
      this.persist();
      return { conflict: false, version: s.revision };
    }).catch((error) => {
      s.error = '保存失败：' + (error instanceof Error ? error.message : '无法写入原文件');
      this.persist();
      throw error;
    });
  }
}
@Controller('office-engine')
export class OfficeEngineController {
  constructor(private readonly office: OfficeEngineService) {}
  @Get('status') status() {
    return this.office.status();
  }
  @Get('configuration') configuration() {
    return this.office.configuration();
  }
  @Post('configuration') configure(@Body() body: Partial<EngineSettings>) {
    return this.office.configure(body);
  }
  @Post('open') open(@Body() body: { path: string }) {
    return this.office.open(body.path);
  }
  @Get('sessions/:id') state(@Param('id') id: string) {
    return this.office.state(id);
  }
  @Get('wopi/files/:id') info(
    @Param('id') id: string,
    @Query('access_token') credential: string,
    @Res() res: Response,
  ) {
    res.json(this.office.info(id, credential));
  }
  @Get('wopi/files/:id/contents') download(
    @Param('id') id: string,
    @Query('access_token') credential: string,
    @Res() res: Response,
  ) {
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-store');
    res.send(this.office.download(id, credential));
  }
  @Post('wopi/files/:id/contents') async save(
    @Param('id') id: string,
    @Query('access_token') credential: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    if (!this.office.validCapability(id, credential)) throw new UnauthorizedException();
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > LIMIT) throw new BadRequestException('Office 文件过大');
      chunks.push(Buffer.from(chunk));
    }
    const result = await this.office.save(id, credential, Buffer.concat(chunks));
    if (result.conflict) {
      res.status(409).setHeader('X-WOPI-Lock', '');
      res.json({ error: '文件版本冲突' });
    } else {
      res.status(200).setHeader('X-WOPI-ItemVersion', result.version!);
      res.json({ LastModifiedTime: new Date().toISOString() });
    }
  }
}
