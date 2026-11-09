import { renderDesignPng } from './design-export.js';
import { Optional } from '@nestjs/common';
import { RemoteWorkspaceService } from '../../core/remote-workspace/remote-workspace.service.js';
import type { TextPatch } from './large-text.store.js';
import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpException,
  HttpStatus,
  Param,
  Post,
  Query,
  Res,
  StreamableFile,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  FilesService,
  type FileListResult,
  type FileReadResult,
  type FileTreeResult,
  type RootEntry,
} from './files.service.js';
import { ExecCommandDto, FileListDto, FileReadDto } from '../dto/misc.dto.js';
import { FileRollbackError, rollbackFileCheckpoints } from './checkpoint-store.js';
import { issueDesignFrameToken } from '../../core/security/design-frame-token.js';
import { CredentialResponse } from '../../core/logger/redact.interceptor.js';

/** 写文件 DTO */
interface FileWriteDto {
  path: string;
  content: string;
}

/** 回滚 DTO（前端"回退到本轮对话发起前"：sessionId + 被回退的用户消息时间戳） */
interface RollbackDto {
  sessionId?: string;
  sinceTs?: number;
}

/** 设置工程目录 DTO（sessionId 提供时绑定为该会话的项目文件夹，否则写全局） */
interface SetProjectDto {
  path: string;
  sessionId?: string;
}

/** 设计稿帧注册 DTO（画布视图渲染通道，见 FilesService design-frame 注释） */
interface DesignFrameDto {
  html: string;
}

/**
 * 文件服务 REST API（路由前缀 /api/files、/api/exec）
 *
 * 暴露端点（对齐旧版 start.cjs + IDE 工程模式新增）：
 *   GET  /api/files/serve?path=  - 静态文件服务（含 MIME 类型）
 *   GET/POST /api/files/read     - 读取文件（路径校验 + 5MB 上限）
 *   GET/POST /api/files/list     - 列出目录（路径校验）
 *   POST /api/files/write        - 写入文本文件（编辑器保存）
 *   GET  /api/files/tree         - 递归目录树（IDE 文件树）
 *   GET  /api/files/roots        - 可选根目录（盘符/用户目录）
 *   GET  /api/files/project      - 当前工程目录
 *   POST /api/files/project      - 设置工程目录（自动加入白名单）
 *   DELETE /api/files/project    - 清除工程目录
 *   POST /api/exec/command       - 执行命令（命令黑名单校验）
 */
@Controller()
export class FilesController {
  constructor(
    private readonly files: FilesService,
    @Optional() private readonly remote?: RemoteWorkspaceService,
  ) {}

  @Post('files/create-entry')
  createEntry(@Body() body: { directory: string; name: string; type: 'file' | 'dir' }) {
    return this.files.createEntry(body?.directory, body?.name, body?.type);
  }

  @Post('files/local-action')
  @HttpCode(HttpStatus.OK)
  localAction(@Body() body: { path: string; action: 'open' | 'reveal' }) {
    return this.files.localAction(body?.path, body?.action);
  }

  @Get('files/projects') projects() {
    return this.files.listProjects();
  }
  @Delete('files/projects') removeProject(@Query('path') path: string) {
    return this.files.removeProject(path);
  }
  @Post('files/projects') saveProject(@Body() body: { path: string; name?: string }) {
    return this.files.saveProject(body?.path, body?.name);
  }

  /** GET /files/project — 生效的工程目录（sessionId 提供时优先会话绑定，附来源） */
  @Get('files/project')
  getProject(@Query('sessionId') sessionId?: string): {
    path: string;
    source: 'session' | 'global' | '';
  } {
    return this.files.resolveProjectDir(sessionId || undefined);
  }

  /** POST /files/project — 设置工程目录（校验 + 自动加白名单；sessionId=会话绑定，否则全局） */
  @Post('files/project')
  @HttpCode(HttpStatus.OK)
  setProject(@Body() dto: SetProjectDto): { path: string } {
    const result = this.files.setProjectDir(dto?.path || '', dto?.sessionId || undefined);
    this.remote?.unbind(dto?.sessionId);
    return result;
  }

  /** DELETE /files/project — 清除工程目录（sessionId=仅解绑该会话，否则清全局） */
  @Delete('files/project')
  clearProject(@Query('sessionId') sessionId?: string): { cleared: boolean } {
    this.remote?.unbind(sessionId);
    return this.files.clearProjectDir(sessionId || undefined);
  }

  /** GET /files/roots — 可选根目录（盘符/用户目录/应用目录） */
  @Get('files/roots')
  roots(): { roots: RootEntry[] } {
    return this.files.listRoots();
  }

  /** GET /files/tree — 递归目录树（depth 缺省 3，最大 6） */
  @Get('files/tree')
  tree(@Query('path') dirPath?: string, @Query('depth') depth?: string): FileTreeResult {
    const d = parseInt(depth || '', 10);
    return this.files.tree(dirPath || '', Number.isFinite(d) ? d : undefined);
  }

  /** POST /files/write — 写入文本文件（编辑器保存） */
  @Post('files/design-export')
  async exportDesign(
    @Body() dto: { html: string; width: number; height: number },
    @Res({ passthrough: true }) res: Response,
  ) {
    const png = await renderDesignPng(dto.html, dto.width, dto.height);
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Content-Disposition', 'attachment; filename="design.png"');
    res.setHeader('Cache-Control', 'no-store');
    return new StreamableFile(png);
  }

  @Post('files/design-create')
  createDesign(@Body() dto: { directory: string; name: string; content: string }) {
    return this.files.createDesign(dto?.directory, dto?.name, dto?.content);
  }

  @Post('files/design-save')
  saveDesign(@Body() dto: FileWriteDto & { expectedContent?: string; expectedRevision?: string }) {
    return this.files.saveDesign(
      dto?.path,
      dto?.content,
      dto?.expectedContent,
      dto?.expectedRevision,
    );
  }

  @Post('files/write')
  @HttpCode(HttpStatus.OK)
  write(@Body() dto: FileWriteDto & { revision?: string }) {
    if (dto?.revision !== undefined)
      return this.files.saveText(dto.path, dto.content, dto.revision);
    return this.files.write(dto?.path || '', typeof dto?.content === 'string' ? dto.content : '');
  }

  /** POST /files/rollback — 回滚 AI 文件更改（恢复该会话 sinceTs 之后写过的文件到写入前内容） */
  @Post('files/rollback')
  @HttpCode(HttpStatus.OK)
  async rollback(
    @Body() dto: RollbackDto,
  ): Promise<{ success: boolean; restored: string[]; data: { restored: string[] } }> {
    const sinceTs = Number(dto?.sinceTs) || 0;
    try {
      const sessionId = dto?.sessionId || '__global__';
      const documents = (await this.files.rollbackConversation?.(sessionId, sinceTs)) || [];
      const restored = [
        ...new Set([...documents, ...(await rollbackFileCheckpoints(sessionId, sinceTs))]),
      ];
      return { success: true, restored, data: { restored } };
    } catch (err) {
      if (err instanceof FileRollbackError) {
        throw new HttpException(
          { success: false, error: err.message, restored: err.restored, failed: err.failed },
          HttpStatus.CONFLICT,
        );
      }
      throw err;
    }
  }

  /** GET /files/serve — 静态文件（图片/音视频/文档等） */
  @Get('files/serve')
  @Header('Cache-Control', 'private, no-store')
  serve(
    @Query('path') filePath?: string,
    @Res({ passthrough: true }) res?: Response,
  ): StreamableFile {
    const result = this.files.serve(filePath || '');
    if (res) {
      res.setHeader('Content-Type', result.mime);
      res.setHeader('Content-Length', String(result.size));
      res.setHeader('X-Content-Type-Options', 'nosniff');
      if (/html|svg|xml/i.test(result.mime)) {
        res.setHeader(
          'Content-Security-Policy',
          "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; base-uri 'none'; form-action 'none'",
        );
      }
    }
    return result.stream;
  }

  /** GET /files/read — 读取文件（兼容 GET query） */
  @Get('files/read')
  async readGet(@Query('path') filePath?: string, @Query('editor') editor?: string) {
    if (editor === 'true') {
      const info = await this.files.largeText.info(filePath || '');
      if (info.segmented) return info;
    }
    return this.files.read(filePath || '');
  }

  @Get('files/text-page')
  textPage(@Query('path') path: string, @Query('offset') offset?: string) {
    return this.files.largeText.page(path, offset === undefined ? 0 : Number(offset));
  }

  @Get('files/text-draft')
  textDraft(@Query('path') path: string) {
    return this.files.largeText.draft(path);
  }

  @Post('files/text-autosave')
  textAutosave(@Body() patch: TextPatch) {
    return this.files.largeText.start(patch);
  }

  @Get('files/text-save/:id')
  textSaveStatus(@Param('id') id: string) {
    return this.files.largeText.status(id);
  }

  /** POST /files/read — 读取文件（旧版为 POST body，保持兼容） */
  @Post('files/read')
  @HttpCode(HttpStatus.OK)
  readPost(@Body() dto: FileReadDto): FileReadResult {
    return this.files.read(dto?.path || '');
  }

  /** GET /files/list — 列目录（兼容 GET query） */
  @Get('files/list')
  listGet(@Query('path') dirPath?: string): FileListResult {
    return this.files.list(dirPath || '');
  }

  /** POST /files/list — 列目录（旧版为 POST body，保持兼容） */
  @Post('files/list')
  @HttpCode(HttpStatus.OK)
  listPost(@Body() dto: FileListDto): FileListResult {
    return this.files.list(dto?.path || '');
  }

  /** POST /exec/command — 执行 shell 命令 */
  @Post('exec/command')
  @HttpCode(HttpStatus.OK)
  async execCommand(@Body() dto: ExecCommandDto) {
    const result = await this.files.exec(dto?.command || '', dto?.cwd, dto?.timeout);
    return result;
  }

  /** GET /files/git-changes?dir= — git 变更（status+diff；dir 白名单校验，工作区"代码变更"tab） */
  @Get('files/git-changes')
  gitChanges(@Query('dir') dir?: string) {
    return this.files.gitChanges(dir || '');
  }

  /** POST /files/design-frame — 注册设计稿帧（前端注入标记脚本后的 HTML → 随机 id） */
  @Post('files/design-frame')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @CredentialResponse('renderToken')
  createDesignFrame(@Body() dto: DesignFrameDto): { id: string; renderToken: string } {
    const id = this.files.createDesignFrame(dto?.html || '');
    return { id, renderToken: issueDesignFrameToken(id) };
  }

  /**
   * GET /files/design-frame/:id — 渲染设计稿帧（iframe src 消费）。
   * 响应头 CSP：sandbox allow-scripts（opaque origin 隔离，设计稿脚本不可访问
   * 应用数据）+ connect-src 'none'（禁止帧内 fetch/XHR 外联，标记脚本仅用
   * postMessage 通信不受影响）。http URL 文档不继承页面 CSP，内联标记脚本可执行。
   */
  @Get('files/design-frame/:id')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Content-Security-Policy', "sandbox allow-scripts; connect-src 'none'")
  @Header('Cache-Control', 'no-store')
  @Header('Referrer-Policy', 'no-referrer')
  getDesignFrame(@Param('id') id: string): string {
    return this.files.getDesignFrame(id);
  }
}
