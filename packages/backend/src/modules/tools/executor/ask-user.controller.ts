import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import type { ApiResponse } from '@skyalyticwing/shared';
import { AskUserService } from './ask-user.service.js';

/** ask_user 回复请求体 */
interface AskUserRespondBody {
  /** 提问请求 ID（ask_user_request 事件中的 id） */
  id?: string;
  /** 用户选择的答案（单选传单元素数组，多选传多项） */
  answer?: string[];
}

/**
 * AskUser REST API（实际路由前缀 /api/tools/ask-user）
 *
 * 暴露端点：
 *   POST /api/tools/ask-user/respond - 提交 ask_user 提问的回复
 *
 * body: { id: string; answer: string[] }
 * 由前端在收到 WS 事件 ask_user_request 后调用，解除 AskUserService 的等待。
 */
@Controller('tools/ask-user')
export class AskUserController {
  constructor(private readonly askUserService: AskUserService) {}

  @Get('pending')
  pending() {
    return { success: true, data: this.askUserService.listPending() };
  }

  @Post('respond')
  @HttpCode(HttpStatus.OK)
  respond(@Body() body: AskUserRespondBody): ApiResponse<{ success: boolean }> {
    if (!body || typeof body.id !== 'string' || body.id.length === 0) {
      return { success: false, error: 'id 必填（提问请求 ID）' };
    }
    if (
      !Array.isArray(body.answer) ||
      !body.answer.every((a) => typeof a === 'string' && a.length > 0)
    ) {
      return { success: false, error: 'answer 必须为字符串数组，取消回答请传空数组' };
    }
    if (!this.askUserService.respond(body.id, body.answer))
      return { success: false, error: '该问题已经结束，请返回对话继续' };
    return { success: true, data: { success: true } };
  }
}
