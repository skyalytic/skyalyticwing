import 'reflect-metadata';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InboxService } from '../../src/modules/channels/inbox.service.js';

describe('durable inbox and reviewed delivery', () => {
  let dir: string, service: InboxService;
  const original = process.env['SKYALYTICWING_DATA_DIR'];
  const load = () => {
    const s = new InboxService();
    s.onModuleInit();
    return s;
  };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sky-inbox-test-'));
    process.env['SKYALYTICWING_DATA_DIR'] = dir;
    service = load();
  });
  afterEach(() => {
    if (original === undefined) delete process.env['SKYALYTICWING_DATA_DIR'];
    else process.env['SKYALYTICWING_DATA_DIR'] = original;
    rmSync(dir, { recursive: true, force: true });
  });
  it('deduplicates provider IDs per channel and retains unread/tasks across restart', () => {
    service.receive('feishu', '1', 'alice', 'hello', 1, {
      chatId: 'group',
      contextToken: 'secret',
    });
    service.receive('feishu', '1', 'alice', 'duplicate', 2);
    service.receive('slack', '1', 'alice', 'other channel', 3);
    service.update('feishu:1', { unread: false, task: 'todo' });
    expect(load().list().items).toHaveLength(2);
    expect(
      load()
        .list()
        .items.find((i) => i.id === 'feishu:1'),
    ).toMatchObject({ content: 'hello', unread: false, task: 'todo' });
    expect(JSON.stringify(service.list())).not.toContain('secret');
  });
  it('deletes one message and its drafts, persists deletion and keeps messages received after the clear snapshot', () => {
    service.receive('feishu','1','alice','first',1);service.receive('feishu','2','alice','second',2);
    service.draft('feishu:1','draft');
    expect(service.remove(['feishu:1'])).toEqual({deleted:1});
    expect(load().list().drafts).toEqual([]);
    const ids=service.list().items.map(i=>i.id);
    service.receive('feishu','3','alice','new',3);
    expect(service.remove(ids)).toEqual({deleted:1});
    expect(load().list().items.map(i=>i.id)).toEqual(['feishu:3']);
    writeFileSync(join(dir,'inbox.json'),'{broken');
    expect(load().list().items.map(i=>i.id)).toEqual(['feishu:3']);
  });
  it('does not delete a message while an outbound reply is in flight', async () => {
    service.receive('feishu','1','alice','first',1);const draft=service.draft('feishu:1','reply');
    let finish!:()=>void;const sending=service.send(draft.id,'reply',()=>new Promise<void>(r=>{finish=r;}));
    expect(()=>service.remove(['feishu:1'])).toThrow('正在发送');
    finish();await sending;expect(service.remove(['feishu:1'])).toEqual({deleted:1});
  });
  it('binds confirmation to exact content and sends the same draft once even concurrently', async () => {
    service.receive('feishu', '1', 'alice', 'hello', 1, { chatId: 'group', messageId: 'remote-1' });
    const d = service.draft('feishu:remote-1', 'reply');
    const sender = jest.fn().mockResolvedValue(undefined);
    await expect(service.send(d.id, 'stale content', sender)).rejects.toThrow('内容已变化');
    await Promise.allSettled([
      service.send(d.id, 'reply', sender),
      service.send(d.id, 'reply', sender),
    ]);
    await load().send(d.id, 'reply', sender);
    expect(sender).toHaveBeenCalledTimes(1);
    expect(sender).toHaveBeenCalledWith(
      expect.objectContaining({
        peer: 'alice',
        options: expect.objectContaining({ chatId: 'group', msgId: 'remote-1' }),
      }),
      'reply',
    );
    expect(load().list().drafts[0]!.status).toBe('sent');
    expect(() => service.draft('feishu:remote-1', 'changed', d.id)).toThrow('已提交');
  });
  it('does not retry ambiguous failures or interrupted sends after restart', async () => {
    service.receive('slack', '1', 'alice', 'hello', 1);
    const d = service.draft('slack:1', 'reply');
    const sender = jest.fn().mockRejectedValue(new Error('connection reset after submit'));
    expect((await service.send(d.id, 'reply', sender)).status).toBe('unknown');
    await expect(load().send(d.id, 'reply', sender)).rejects.toThrow('禁止重复');
    const path = join(dir, 'inbox.json'),
      state = JSON.parse(readFileSync(path, 'utf8'));
    state.drafts[0].status = 'sending';
    writeFileSync(path, JSON.stringify(state));
    expect(load().list().drafts[0]).toMatchObject({
      status: 'unknown',
      error: expect.stringContaining('服务重启'),
    });
    expect(sender).toHaveBeenCalledTimes(1);
  });
  it('selects correct group when a person sends messages in multiple groups', () => {
    service.receive('feishu', '1', 'alice', 'one', 1, { chatId: 'one' });
    service.receive('feishu', '2', 'alice', 'two', 2, { chatId: 'two' });
    const d = service.suggest('feishu', 'alice', 'reply', { chatId: 'one' });
    expect(d.itemId).toBe('feishu:1');
  });
});
