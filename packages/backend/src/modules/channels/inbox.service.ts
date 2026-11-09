import { Optional } from '@nestjs/common';
import { SchedulerService } from '../core/scheduler/scheduler.service.js';
import { replyContext, replyThread } from './reply-context.js';
import { BadRequestException, ConflictException, Injectable, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { readJsonRecover, writeJsonAtomicSync } from '../core/utils/atomic-json.util.js';
import type { SendOptions } from './providers/base.provider.js';

export interface InboxItem {
  id: string;
  channelId: string;
  peer: string;
  thread: string;
  content: string;
  timestamp: number;
  direction: 'inbound' | 'outbound';
  unread: boolean;
  task: 'none' | 'todo' | 'done';
  options: SendOptions;
}
export interface ReplyDraft {
  id: string;
  itemId: string;
  content: string;
  status: 'draft' | 'sending' | 'sent' | 'unknown';
  createdAt: number;
  sentAt?: number;
  error?: string;
}
interface InboxState {
  version: 1;
  items: InboxItem[];
  drafts: ReplyDraft[];
}

/** One durable store per trusted workspace instance; never shared across tenant instances. */
@Injectable()
export class InboxService implements OnModuleInit {
  constructor(@Optional() private readonly scheduler?: SchedulerService) {}
  private file = '';
  private state: InboxState = { version: 1, items: [], drafts: [] };
  onModuleInit() {
    this.file = join(
      process.env['SKYALYTICWING_DATA_DIR'] ||
        process.env['SKYALYTIC_DATA_DIR'] ||
        (process.platform === 'win32'
          ? join(process.env['APPDATA'] || join(homedir(), 'AppData', 'Roaming'), 'SkyalyticWing')
          : join(homedir(), '.config', 'skyalyticwing')),
      'inbox.json',
    );
    this.state = readJsonRecover<InboxState>(this.file, this.state);
    if (
      this.state.version !== 1 ||
      !Array.isArray(this.state.items) ||
      !Array.isArray(this.state.drafts)
    )
      throw new Error('Invalid inbox store');
    if (this.state.drafts.some((d) => d.status === 'sending'))
      this.commit((next) => {
        for (const d of next.drafts)
          if (d.status === 'sending') {
            d.status = 'unknown';
            d.error = '发送期间服务重启，请核对渠道实际记录，系统不会自动重发。';
          }
      });
  }
  private commit(edit: (state: InboxState) => void) {
    const next = structuredClone(this.state);
    edit(next);
    writeJsonAtomicSync(this.file, next);
    this.state = next;
  }
  list() {
    if (this.scheduler) {
      const receipts = this.scheduler.snapshot().deliveries;
      const updates = this.state.drafts.filter(
        (d) =>
          d.status !== 'sent' &&
          receipts.some((r) => r.key === 'draft:' + d.id && r.state === 'sent'),
      );
      if (updates.length)
        this.commit((next) => {
          for (const draft of next.drafts)
            if (updates.some((d) => d.id === draft.id)) {
              draft.status = 'sent';
              draft.sentAt = Date.now();
              delete draft.error;
            }
        });
    }
    return structuredClone({
      ...this.state,
      items: [...this.state.items].reverse().map((item) => ({ ...item, options: undefined })),
    });
  }
  receive(
    channelId: string,
    id: string,
    peer: string,
    content: string,
    timestamp: number,
    raw: Record<string, unknown> = {},
  ) {
    const options = replyContext(raw, id);
    const key = `${channelId}:${options.msgId}`;
    if (this.state.items.some((item) => item.id === key)) return false;
    this.commit((next) =>
      next.items.push({
        id: key,
        channelId,
        peer,
        thread: replyThread(raw, peer),
        content,
        timestamp,
        direction: 'inbound',
        unread: true,
        task: 'none',
        options,
      }),
    );
    return true;
  }
  update(id: string, changes: { unread?: boolean; task?: string }) {
    if (!this.state.items.some((i) => i.id === id)) throw new BadRequestException('消息不存在');
    if (changes.task !== undefined && !['none', 'todo', 'done'].includes(changes.task))
      throw new BadRequestException('任务状态无效');
    if (changes.unread !== undefined && typeof changes.unread !== 'boolean')
      throw new BadRequestException('未读状态无效');
    this.commit((next) => {
      const item = next.items.find((i) => i.id === id)!;
      if (changes.unread !== undefined) item.unread = changes.unread;
      if (changes.task !== undefined) item.task = changes.task as InboxItem['task'];
    });
    return { updated: true };
  }
  remove(ids: unknown) {
    if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string' && id.length > 0))
      throw new BadRequestException('请选择需要删除的消息');
    const selected = new Set<string>(ids);
    if (this.state.drafts.some((d) => selected.has(d.itemId) && d.status === 'sending'))
      throw new ConflictException('所选消息有回复正在发送，请发送结束后再删除');
    const deleted = this.state.items.filter((item) => selected.has(item.id)).length;
    if (deleted) {
      this.commit((next) => {
        next.items = next.items.filter((item) => !selected.has(item.id));
        next.drafts = next.drafts.filter((draft) => !selected.has(draft.itemId));
      });
      // The recovery copy must not resurrect messages explicitly deleted by the user.
      writeJsonAtomicSync(this.file, this.state);
    }
    return { deleted };
  }
  draft(itemId: string, content: string, draftId?: string) {
    this.validateContent(content);
    if (!this.state.items.some((i) => i.id === itemId && i.direction === 'inbound'))
      throw new BadRequestException('原消息不存在');
    const existing = draftId
      ? this.state.drafts.find((d) => d.id === draftId && d.itemId === itemId)
      : undefined;
    if (draftId && (!existing || existing.status !== 'draft'))
      throw new ConflictException('草稿不存在或已提交发送');
    const id = existing?.id || randomUUID();
    this.commit((next) => {
      const d = next.drafts.find((d) => d.id === id);
      if (d) d.content = content;
      else next.drafts.push({ id, itemId, content, status: 'draft', createdAt: Date.now() });
    });
    return structuredClone(this.state.drafts.find((d) => d.id === id)!);
  }
  suggest(channelId: string, peer: string, content: string, raw: Record<string, unknown> = {}) {
    const thread = replyThread(raw, peer);
    const originalId = replyContext(raw).msgId;
    const item = [...this.state.items]
      .reverse()
      .find(
        (i) =>
          i.channelId === channelId &&
          i.peer === peer &&
          i.thread === thread &&
          (!originalId || i.options.msgId === originalId) &&
          i.direction === 'inbound',
      );
    if (!item) throw new BadRequestException('未找到回复目标');
    return this.draft(item.id, content);
  }
  async send(
    id: string,
    confirmedContent: unknown,
    sender: (item: InboxItem, content: string) => Promise<void>,
  ) {
    const d = this.state.drafts.find((d) => d.id === id);
    if (!d) throw new BadRequestException('草稿不存在');
    if (confirmedContent !== d.content)
      throw new ConflictException('草稿内容已变化，请重新核对后发送');
    if (d.status === 'sent') return structuredClone(d);
    if (d.status !== 'draft') throw new ConflictException('已提交发送，结果待核对；禁止重复提交');
    const item = this.state.items.find((i) => i.id === d.itemId)!;
    this.commit((next) => {
      next.drafts.find((x) => x.id === id)!.status = 'sending';
    });
    try {
      await sender(structuredClone(item), d.content);
      this.commit((next) => {
        const current = next.drafts.find((x) => x.id === id)!;
        current.status = 'sent';
        current.sentAt = Date.now();
        next.items.push({
          ...item,
          id: `sent:${id}`,
          direction: 'outbound',
          content: d.content,
          timestamp: Date.now(),
          unread: false,
          task: 'none',
        });
      });
    } catch (e) {
      this.commit((next) => {
        const current = next.drafts.find((x) => x.id === id)!;
        current.status = 'unknown';
        current.error = e instanceof Error ? e.message : String(e);
      });
    }
    return structuredClone(this.state.drafts.find((x) => x.id === id)!);
  }
  private validateContent(content: unknown) {
    if (typeof content !== 'string' || !content.trim() || content.length > 20000)
      throw new BadRequestException('回复内容应为 1–20000 字符');
  }
}
