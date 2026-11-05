import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import {
  LspService,
  type DiagnosticsResult,
  type LspServerInfo,
  type LanguageQuery,
} from './lsp.service.js';

/**
 * LSP REST API（路由前缀 /api/lsp）
 *
 * 暴露端点（对齐旧版 start.cjs）：
 *   GET /api/lsp/diagnostics?file=  - 获取文件诊断
 *   GET /api/lsp/servers            - 列出注册的语言服务器
 */
@Controller('lsp')
export class LspController {
  constructor(private readonly lsp: LspService) {}

  /** Actual project diagnostics; unavailable servers return an explicit error. */
  @Get('diagnostics')
  async diagnostics(@Query('file') file?: string): Promise<DiagnosticsResult> {
    if (!file) {
      return {
        language: '',
        file: '',
        error: 'file parameter required',
        diagnostics: [],
        serverAvailable: false,
      };
    }
    return this.lsp.getDiagnostics(file);
  }

  @Post('query')
  query(@Body() body: LanguageQuery) {
    // Edit application is only exposed through the permission-checked tool executor.
    return this.lsp.query(body);
  }

  /** GET /lsp/servers — 语言服务器列表 */
  @Get('servers')
  servers(): { servers: LspServerInfo[] } {
    return { servers: this.lsp.listServers() };
  }
}
