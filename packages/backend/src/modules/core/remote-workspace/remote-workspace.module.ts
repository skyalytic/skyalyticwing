import {
  Body,
  Controller,
  Delete,
  Get,
  Global,
  Module,
  Param,
  Post,
  Query,
  StreamableFile,
} from '@nestjs/common';
import { posix } from 'node:path';
import { RemoteWorkspaceService } from './remote-workspace.service.js';
import type { RemoteWorkspace } from './remote-connections.js';
const operations = new Set([
  'list',
  'read',
  'write',
  'edit',
  'delete',
  'git-status',
  'git-diff',
  'git-stage',
  'git-revert',
]);
@Controller('remote-workspaces')
export class RemoteWorkspaceController {
  constructor(private readonly workspaces: RemoteWorkspaceService) {}
  @Get() list(@Query('sessionId') sessionId?: string) {
    return this.workspaces.list(sessionId);
  }
  @Post() create(@Body() body: Omit<RemoteWorkspace, 'id'>) {
    return this.workspaces.create(body);
  }
  @Post('bind') bind(@Body() body: { sessionId: string; id: string | null }) {
    return this.workspaces.bind(body.sessionId, body.id);
  }
  @Post(':id/connect') connect(@Param('id') id: string) {
    return this.workspaces.connect(id);
  }
  @Post(':id/disconnect') disconnect(@Param('id') id: string) {
    return this.workspaces.disconnect(id);
  }
  @Get(':id/document') async document(
    @Param('id') id: string,
    @Query('path') path: string,
    @Query('inline') inline?: string,
  ) {
    const bytes = await this.workspaces.documentBytes(id, path);
    return new StreamableFile(bytes, {
      type:
        posix.extname(path).toLowerCase() === '.pdf'
          ? 'application/pdf'
          : 'application/octet-stream',
      disposition:
        (inline === '1' && posix.extname(path).toLowerCase() === '.pdf' ? 'inline' : 'attachment') +
        "; filename*=UTF-8''" +
        encodeURIComponent(posix.basename(path)),
    });
  }
  @Delete(':id') remove(@Param('id') id: string) {
    return this.workspaces.remove(id);
  }
  @Post(':id/operation') operation(
    @Param('id') id: string,
    @Body() body: { op: string; args?: Record<string, unknown> },
  ) {
    if (body?.op === 'office-read' || body?.op === 'office-edit')
      return this.workspaces.office(
        id,
        body.op === 'office-read' ? 'office_read' : 'office_edit',
        body.args || {},
      );
    if (!operations.has(body?.op)) throw Error('Unsupported workspace operation');
    return this.workspaces.request(id, body.op, body.args || {});
  }
}
@Global()
@Module({
  controllers: [RemoteWorkspaceController],
  providers: [RemoteWorkspaceService],
  exports: [RemoteWorkspaceService],
})
export class RemoteWorkspaceModule {}
