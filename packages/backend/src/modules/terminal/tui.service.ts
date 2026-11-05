import { BadRequestException, Body, Controller, Get, Injectable, NotFoundException, Param, Post, Req } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { createHash, randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { SessionService } from '../session/session.service.js';
import { AgentLoopService } from '../ai/agent/agent-loop.service.js';
import { ChatControlRegistry } from '../ai/chat/chat-control.registry.js';

interface TuiSession { id: string; owner: string; sessionId: string; model?: string; running: boolean; closed: boolean; lines: string[]; revision: number; task?: Promise<void>; }
const clean = (s: string) => Array.from(s).filter(c=>{const n=c.codePointAt(0)!;return n===9||n===10||(n>=32&&(n<127||n>159));}).join('').slice(0,32000);
@Injectable()
export class TuiService {
  private readonly sessions = new Map<string, TuiSession>();
  constructor(private readonly modules: ModuleRef) {}
  start(owner: string, model?: string) {
    if (this.sessions.size >= 8) throw new BadRequestException('最多同时打开 8 个 TUI，请先停止不用的会话');
    if (model !== undefined && (typeof model !== 'string' || model.length > 200)) throw new BadRequestException('模型名称无效');
    const session = this.modules.get(SessionService, { strict: false }).createSession('Wing TUI');
    const s: TuiSession = { id: randomUUID(), owner, sessionId: session.id, ...(model ? { model } : {}), running: false, closed: false, lines: ['Wing TUI · /help /status /history /clear /cancel /quit'], revision: 1 };
    this.sessions.set(s.id, s);
    return this.status(owner, s.id);
  }
  private get(owner: string, id: string) {
    const s = this.sessions.get(id);
    if (!s || s.owner !== owner) throw new NotFoundException('TUI 会话不存在或不属于当前调用方');
    return s;
  }
  private append(s: TuiSession, line: string) {
    s.lines.push(clean(line));
    while (s.lines.length > 100 || s.lines.join('\n').length > 100000) s.lines.shift();
    s.revision++;
  }
  status(owner: string, id?: string) {
    if (!id) return { sessions: [...this.sessions.values()].filter(s => s.owner === owner).map(s => ({ id: s.id, sessionId: s.sessionId, running: s.running, closed: s.closed })) };
    const s = this.get(owner, id);
    return { id: s.id, sessionId: s.sessionId, running: s.running, closed: s.closed, revision: s.revision, text: s.lines.join('\n') };
  }
  send(owner: string, id: string, message: string) {
    const s = this.get(owner, id);
    if (s.closed) throw new BadRequestException('TUI 正在停止');
    if (typeof message !== 'string' || !message.trim() || message.length > 20000) throw new BadRequestException('请输入 1–20000 字符');
    const command = message.trim();
    if (command === '/quit') return this.stop(owner, id);
    if (command === '/cancel') { if (s.running) ChatControlRegistry.requestAbort(s.sessionId); this.append(s, '已请求停止；等待当前模型/工具返回。'); return this.status(owner, id); }
    if (command === '/clear') { s.lines = []; s.revision++; return this.status(owner, id); }
    if (command === '/help') { this.append(s, '输入文字发送给当前模型；/status 状态，/history 历史，/clear 清屏，/cancel 停止生成，/quit 关闭。原会话记录会保留。'); return this.status(owner, id); }
    if (command === '/history') {
      const messages = this.modules.get(SessionService, { strict: false }).getSession(s.sessionId)?.messages || [];
      this.append(s, messages.slice(-20).map(m => `${m.role}: ${typeof m.content === 'string' ? m.content : '[多模态内容]'}`).join('\n'));
      return this.status(owner, id);
    }
    if (command === '/status') return this.status(owner, id);
    if (command.startsWith('/')) throw new BadRequestException('未知命令；输入 /help 查看命令列表');
    if (s.running) throw new BadRequestException('当前请求尚未完成，可 /cancel 后再发送');
    s.running = true; this.append(s, `你: ${message}`);
    s.task = this.run(s, message);
    return this.status(owner, id);
  }
  private async run(s: TuiSession, message: string) {
    try {
      const agent = this.modules.get(AgentLoopService, { strict: false });
      for await (const e of agent.run(s.sessionId, message, { ...(s.model ? { model: s.model } : {}) })) {
        if (e.type === 'assistant_message') this.append(s, `Wing: ${e.content}`);
        else if (e.type === 'error') this.append(s, `错误: ${e.error}`);
        else if (e.type === 'tool_call') this.append(s, `调用工具: ${e.toolName}`);
        else if (e.type === 'tool_result') this.append(s, `工具 ${e.toolName}: ${e.result.success ? '完成' : '失败'}`);
        else if (e.type === 'approval_request') this.append(s, '等待审批：请在 Wing 工作台查看并处理。TUI 不会自动批准。');
      }
    } catch (e) { this.append(s, `错误: ${e instanceof Error ? e.message : String(e)}`); }
    finally { s.running = false; s.revision++; if (s.closed) this.sessions.delete(s.id); }
  }
  stop(owner: string, id: string) {
    const s = this.get(owner, id); s.closed = true;
    if (s.running) ChatControlRegistry.requestAbort(s.sessionId); else this.sessions.delete(id);
    return { stopped: !s.running, stopping: s.running, sessionId: s.sessionId };
  }
  onModuleDestroy() {
    for (const s of this.sessions.values()) { s.closed = true; if (s.running) ChatControlRegistry.requestAbort(s.sessionId); }
  }
}
function owner(req: Request) { return 'cli:' + createHash('sha256').update(String(req.headers.authorization || req.headers.cookie || req.headers['x-auth-token'] || 'local')).digest('hex'); }
@Controller('tui')
export class TuiController {
  constructor(private readonly tui: TuiService) {}
  @Post('start') start(@Req() req: Request, @Body() body: { model?: string }) { return this.tui.start(owner(req), body?.model); }
  @Get(':id') status(@Req() req: Request, @Param('id') id: string) { return this.tui.status(owner(req), id); }
  @Post(':id/send') send(@Req() req: Request, @Param('id') id: string, @Body() body: { message: string }) { return this.tui.send(owner(req), id, body?.message); }
  @Post(':id/stop') stop(@Req() req: Request, @Param('id') id: string) { return this.tui.stop(owner(req), id); }
}
