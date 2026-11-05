import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { TerminalService } from './terminal.service.js';

/** 打开终端 DTO */
interface TerminalOpenDto {
  cwd?: string; cols?: number; rows?: number;
}

/** 输入 DTO */
interface TerminalInputDto {
  text: string; raw?: boolean;
}

/**
 * 工作区终端 REST API（前端"终端"tab 轮询驱动）
 *
 *   GET  /api/terminal/status        - 会话数
 *   POST /api/terminal/open          - 打开会话（cwd 白名单校验）→ {id, cwd}
 *   POST /api/terminal/:id/input     - 写入一行命令
 *   GET  /api/terminal/:id/output    - 增量拉取输出（since=游标）
 *   POST /api/terminal/:id/close     - 关闭会话
 */
@Controller('terminal')
export class TerminalController {
  constructor(private readonly terminal: TerminalService) {}

  @Get('status')
  status() {
    return this.terminal.status();
  }

  @Post('open')
  @HttpCode(HttpStatus.OK)
  open(@Body() dto: TerminalOpenDto) {
    return this.terminal.open(dto?.cwd, dto?.cols, dto?.rows);
  }

  @Post(':id/input')
  @HttpCode(HttpStatus.OK)
  input(@Param('id') id: string, @Body() dto: TerminalInputDto) {
    return this.terminal.input(id, typeof dto?.text === 'string' ? dto.text : '', dto?.raw === true);
  }

  @Post(':id/resize')
  resize(@Param('id') id: string, @Body() dto: { cols: number; rows: number }) {
    return this.terminal.resize(id, dto?.cols, dto?.rows);
  }

  @Get(':id/output')
  output(@Param('id') id: string, @Query('since') since?: string) {
    return this.terminal.output(id, Number(since) || 0);
  }

  @Post(':id/close')
  @HttpCode(HttpStatus.OK)
  close(@Param('id') id: string) {
    return this.terminal.close(id);
  }
}
