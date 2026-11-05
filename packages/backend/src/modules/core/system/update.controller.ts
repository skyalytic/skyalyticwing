import { Body, Controller, Post, Req, ForbiddenException } from '@nestjs/common';
import type { Request } from 'express';
import { updateMaintenance } from './update-maintenance.js';

@Controller('update')
export class UpdateController {
  private local(req: Request) {
    if (process.env['SKYALYTICWING_DESKTOP'] !== '1' || !['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress || '')) throw new ForbiddenException('仅本机桌面应用可准备更新');
  }
  @Post('shutdown') shutdown(@Body() body: { id: string }, @Req() req: Request) { this.local(req); updateMaintenance.stop(body.id); return { success: true }; }
  @Post('prepare') prepare(@Body() body: { id: string }, @Req() req: Request) { this.local(req); return { success: true, data: updateMaintenance.begin(body.id) }; }
  @Post('status') status(@Body() body: { id: string }, @Req() req: Request) { this.local(req); return { success: true, data: updateMaintenance.status(body.id) }; }
  @Post('freeze') freeze(@Body() body: { id: string }, @Req() req: Request) { this.local(req); return { success: true, data: updateMaintenance.freeze(body.id) }; }
  @Post('cancel') cancel(@Body() body: { id: string }, @Req() req: Request) { this.local(req); updateMaintenance.cancel(body.id); return { success: true }; }
}
