import { Body, Controller, ForbiddenException, Get, Param, Post, Query, Res, StreamableFile } from '@nestjs/common';
import { createReadStream } from 'node:fs';
import type { Response } from 'express';
import { SecurityManagerService } from '../../core/security/security-manager.service.js';
import { documentChangeReview, documentSnapshot, listDocumentChanges, readDocumentChange, restoreDocumentChange } from './document-history.js';
import { withFileMutation } from './checkpoint-store.js';

@Controller('files/changes')
export class DocumentHistoryController {
  constructor(private readonly security: SecurityManagerService) {}
  private check(path: string, mode: 'read' | 'write' = 'read') {
    if (!path || !this.security.isPathAllowed(path, mode)) throw new ForbiddenException('该文件路径没有访问权限');
  }
  @Get() list(@Query('dir') dir: string) {
    this.check(dir);
    return { changes: listDocumentChanges(dir).filter(c => this.security.isPathAllowed(c.path, 'read')) };
  }
  @Get(':id') detail(@Param('id') id: string) {
    this.check(readDocumentChange(id).path);
    return documentChangeReview(id);
  }
  @Post(':id/restore') async restore(@Param('id') id: string, @Body() body: { state?: string }) {
    const change = readDocumentChange(id); this.check(change.path, 'write');
    return withFileMutation(change.path, async () => {
      this.check(change.path, 'write');
      if (readDocumentChange(id).state !== body?.state) throw new ForbiddenException('变更状态已更新，请刷新后重试');
      return restoreDocumentChange(id);
    }, false);
  }
  @Get(':id/snapshot') download(@Param('id') id: string, @Query('version') version: string, @Res({ passthrough: true }) res: Response) {
    this.check(readDocumentChange(id).path);
    const snapshot = documentSnapshot(id, version);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(snapshot.name)}`);
    return new StreamableFile(createReadStream(snapshot.path));
  }
}
