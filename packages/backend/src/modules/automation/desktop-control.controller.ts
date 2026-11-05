import { Body, ConflictException, Controller, Get, Post } from '@nestjs/common';
import { DesktopControlService } from './desktop-control.service.js';

/** Local authenticated user controls. Resume is deliberately not exposed as an AI tool. */
@Controller('automation/desktop/control')
export class DesktopControlController {
  constructor(private readonly control: DesktopControlService) {}
  @Get()
  status() { return { success: true, data: this.control.status() }; }
  @Post('pause')
  pause(@Body() body?: { sessionId?: string }) { this.checkOwner(body); return { success: true, data: this.control.pause() }; }
  @Post('resume')
  resume(@Body() body?: { sessionId?: string }) { this.checkOwner(body); return { success: true, data: this.control.resume() }; }
  @Post('stop')
  stop(@Body() body?: { sessionId?: string }) { this.checkOwner(body); return { success: true, data: this.control.stop() }; }
  private checkOwner(body?: { sessionId?: string }) {
    if (body?.sessionId && this.control.status().sessionId !== body.sessionId) throw new ConflictException('桌面控制会话已改变，请刷新后再操作。');
  }
}
