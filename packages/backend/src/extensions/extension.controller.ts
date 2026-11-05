import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { ExtensionHostService } from './extension-host.service.js';
@Controller('extensions')
export class ExtensionController {
  constructor(private readonly host: ExtensionHostService) {}
  @Get() async list() { return { success: true, data: await this.host.list() }; }
  @Post(':id/install') async install(@Param('id') id: string) { await this.host.install(id); return { success: true }; }
  @Delete(':id') async uninstall(@Param('id') id: string) { await this.host.uninstall(id); return { success: true }; }
  @Post(':id/reload') async reload(@Param('id') id: string, @Body() _body?: unknown) { await this.host.reload(id); return { success: true }; }
}
