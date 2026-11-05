import { Module } from '@nestjs/common';
import { TerminalService } from './terminal.service.js';
import { TerminalController } from './terminal.controller.js';
import { TuiService, TuiController } from './tui.service.js';

/**
 * 工作区终端模块：持久 PowerShell 会话（stdin 写命令、stdout/stderr 缓冲、
 * 前端增量轮询渲染），供工作区面板"终端"tab 使用。
 */
@Module({
  controllers: [TerminalController, TuiController],
  providers: [TerminalService, TuiService],
})
export class TerminalModule {}
