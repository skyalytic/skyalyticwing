import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { InboxService } from './inbox.service.js';
import { ChannelsService } from './channels.service.js';

@Controller('inbox')
export class InboxController {
  constructor(
    private readonly inbox: InboxService,
    private readonly channels: ChannelsService,
  ) {}
  @Get() list() {
    return this.inbox.list();
  }
  @Delete('items/:id') remove(@Param('id') id: string) {
    return this.inbox.remove([id]);
  }
  @Post('clear') clear(@Body() body: { ids?: unknown }) {
    return this.inbox.remove(body.ids);
  }
  @Post('items/:id') update(
    @Param('id') id: string,
    @Body() body: { unread?: boolean; task?: string },
  ) {
    return this.inbox.update(id, body);
  }
  @Post('drafts') draft(@Body() body: { itemId: string; content: string; draftId?: string }) {
    return this.inbox.draft(body.itemId, body.content, body.draftId);
  }
  @Post('drafts/:id/send') send(
    @Param('id') id: string,
    @Body() body: { confirmedContent: string },
  ) {
    return this.inbox.send(id, body.confirmedContent, (item, content) =>
      this.channels.sendMessage(item.channelId, item.peer, content, {
        ...item.options,
        deliveryKey: 'draft:' + id,
      }),
    );
  }
}
