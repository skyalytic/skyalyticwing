import 'reflect-metadata';
import { ChannelsService } from '../../src/modules/channels/channels.service.js';
import { replyContext, replyThread } from '../../src/modules/channels/reply-context.js';

describe('channel intake and target safety', () => {
  const make = () => {
    const inbox = { receive: jest.fn().mockReturnValue(true) };
    const logger = { warn: jest.fn() };
    const channels = new (ChannelsService as any)(
      logger,
      { broadcast: jest.fn() },
      {},
      {},
      {},
      {},
      {},
      {},
      {},
      {},
      {},
      {},
      inbox,
    ) as ChannelsService;
    const runtime = {
      config: { id: 'account', type: 'feishu' },
      status: 'connected',
      messages: [],
    };
    (channels as any).channels.set('account', runtime);
    return { channels, inbox, runtime };
  };
  it('persists every message before slow AI handling and executes each conversation in order', async () => {
    const { channels, inbox } = make();
    let release!: () => void;
    const called: string[] = [];
    channels.onMessage(async (_type, message) => {
      called.push(message.id);
      if (message.id === '1')
        await new Promise<void>((r) => {
          release = r;
        });
    });
    const session = {
      sessionId: 'group-1',
      agentId: 'main',
      conversationId: 'group-1',
      createdAt: 1,
    };
    const dispatch = (id: string) =>
      (channels as any).dispatchMessage(
        'feishu',
        { id, from: 'alice', text: id, timestamp: 1, raw: { chatId: 'group-1', messageId: id } },
        session,
      );
    const first = dispatch('1');
    await Promise.resolve();
    await Promise.resolve();
    const second = dispatch('2');
    expect(inbox.receive).toHaveBeenCalledTimes(2);
    expect(called).toEqual(['1']);
    release();
    await Promise.all([first, second]);
    expect(called).toEqual(['1', '2']);
  });
  it('does not record failed outbound messages as sent', async () => {
    const { channels, runtime } = make();
    (channels as any).providers.set('feishu', {
      sendMessage: jest.fn().mockResolvedValue({ success: false, error: 'offline' }),
    });
    await expect(channels.sendMessage('account', 'alice', 'reply')).rejects.toThrow('offline');
    expect(runtime.messages).toHaveLength(0);
  });
  it('snapshots source message, thread, group IDs and expiry instead of shared last-chat state', () => {
    const raw = {
      channel: 'C1',
      threadTs: '1.1',
      ts: '1.2',
      contextToken: 'private',
      client: { secret: 'do-not-copy' },
    };
    expect(replyContext(raw)).toMatchObject({
      channel: 'C1',
      chatId: 'C1',
      threadTs: '1.1',
      msgId: '1.2',
      replyMessageId: '1.2',
    });
    expect(replyContext(raw)['client']).toBeUndefined();
    expect(replyThread(raw, 'alice')).not.toBe(replyThread({ ...raw, threadTs: '2.1' }, 'alice'));
    expect(replyContext({})).toMatchObject({ skipReply: true });
    expect(replyContext({ messageType: 'group', groupId: '123' })).toMatchObject({
      isGroup: true,
      groupId: '123',
      chatId: '123',
    });
  });
});
