import { Body, Controller, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { AgentLoopService } from '../agent/agent-loop.service.js';
import { SendMessageDto } from './dto/send-message.dto.js';
import { redact } from '../../core/logger/redact.interceptor.js';

/** CLI is a transport for the desktop harness, never a second agent implementation. */
@Controller('cli')
export class CliController {
  constructor(private readonly loop: AgentLoopService) {}

  @Post('turn')
  async turn(@Body() dto: SendMessageDto, @Res() res: Response): Promise<void> {
    const controller = new AbortController();
    const close = () => controller.abort();
    res.once('close', close);
    res.status(200).set({
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    // Keep long model/tool waits alive through HTTP clients and reverse proxies.
    const heartbeat = setInterval(() => {
      if (!res.destroyed && !res.writableNeedDrain) res.write('{"type":"heartbeat"}\n');
    }, 15_000);
    heartbeat.unref();
    try {
      for await (const event of this.loop.run(dto.session, dto.message, {
        ...(dto.agent ? { agentId: dto.agent } : {}),
        ...(dto.model ? { model: dto.model } : {}),
        ...(dto.attachments ? { attachments: dto.attachments } : {}),
        signal: controller.signal,
      })) {
        if (res.destroyed) break;
        if (!res.write(JSON.stringify(redact({ ...event, sessionId: dto.session })) + '\n')) {
          await new Promise<void>((resolve) => {
            const cleanup = () => {
              res.off('drain', cleanup);
              res.off('close', cleanup);
              resolve();
            };
            res.once('drain', cleanup);
            res.once('close', cleanup);
          });
        }
      }
    } catch (error) {
      if (!res.destroyed)
        res.write(
          JSON.stringify({
            type: 'error',
            error: error instanceof Error ? error.message : String(error),
          }) + '\n',
        );
    } finally {
      clearInterval(heartbeat);
      res.off('close', close);
      res.end();
    }
  }
}
