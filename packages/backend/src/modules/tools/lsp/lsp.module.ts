import { Module } from '@nestjs/common';
import { LspService } from './lsp.service.js';
import { LspController } from './lsp.controller.js';

/**
 * LspModule - LSP 诊断模块
 *
 * 依赖 LoggerService / SecurityManagerService（全局模块提供）。
 *
 * Controllers:
 *   - LspController: /api/lsp/diagnostics、/api/lsp/servers
 */
@Module({
  providers: [LspService],
  controllers: [LspController],
  exports: [LspService],
})
export class LspModule {}
