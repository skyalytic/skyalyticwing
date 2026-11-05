import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { randomUUID } from 'node:crypto';
import type { WsEvent } from '@skyalyticwing/shared';
import { LoggerService } from '../../core/logger/logger.service.js';
import { WebSocketService } from '../../core/websocket/websocket.service.js';

export interface AskUserRequest {
  sessionId?: string;
  question: string;
  options?: string[];
  multiple?: boolean;
}
export interface AskUserResult {
  answered: boolean;
  answer?: string[];
  error?: string;
}
interface PendingAskUser {
  request: AskUserRequest & { id: string; options: string[]; multiple: boolean };
  finish: (result: AskUserResult) => void;
}

/** Human replies wait until answered or stopped, without an execution timeout. */
@Injectable()
export class AskUserService implements OnModuleDestroy {
  private readonly pending = new Map<string, PendingAskUser>();
  constructor(
    private readonly events: EventEmitter2,
    private readonly ws: WebSocketService,
    private readonly logger: LoggerService,
  ) {}

  listPending() {
    return [...this.pending.values()].map(entry => entry.request);
  }

  async askUser(req: AskUserRequest, signal?: AbortSignal): Promise<AskUserResult> {
    if (signal?.aborted) return { answered: false, error: '任务已停止' };
    const request = {
      id: randomUUID(),
      ...(req.sessionId !== undefined ? { sessionId: req.sessionId } : {}),
      question: req.question,
      options: Array.isArray(req.options) ? req.options.filter(o => typeof o === 'string') : [],
      multiple: req.multiple === true,
    };
    return new Promise(resolve => {
      const event = 'ask_user.response.' + request.id;
      const finish = (result: AskUserResult) => {
        if (!this.pending.delete(request.id)) return;
        signal?.removeEventListener('abort', abort);
        this.events.removeListener(event, response);
        this.ws.broadcast({ type: 'ask_user_resolved', data: { id: request.id, sessionId: req.sessionId } } as unknown as WsEvent);
        resolve(result);
      };
      const abort = () => finish({ answered: false, error: '任务已停止' });
      const response = (answer: string[]) => finish(answer.length
        ? { answered: true, answer }
        : { answered: false, error: '用户取消了回答' });
      // Register before publishing so immediate replies cannot be lost.
      this.pending.set(request.id, { request, finish });
      this.events.once(event, response);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      this.logger.info('Waiting for user response', { scope: 'ask-user', askId: request.id, sessionId: req.sessionId });
      this.ws.broadcast({ type: 'ask_user_request', data: request } as unknown as WsEvent);
      this.events.emit('ask_user.request', request);
    });
  }

  respond(id: string, answer: string[]): boolean {
    if (!this.pending.has(id)) return false;
    this.events.emit('ask_user.response.' + id, answer);
    return true;
  }

  onModuleDestroy() {
    for (const entry of [...this.pending.values()]) entry.finish({ answered: false, error: '服务已关闭，请重新提问' });
  }
}
