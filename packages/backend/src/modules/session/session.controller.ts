import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
  Optional,
} from '@nestjs/common';
import type { ApiResponse, ChatMessage, SessionInfo, SessionStoreItem } from '@skyalyticwing/shared';
import { ApiTags } from '../core/swagger/swagger-decorators.js';
import { SessionService } from './session.service.js';
import { SessionSnapshotService } from './session-snapshot.service.js';
import { CreateSessionDto } from './dto/create-session.dto.js';
import { RestoreSessionDto } from './dto/restore-session.dto.js';
import { SecurityManagerService } from '../core/security/security-manager.service.js';
import { deduplicateMessageMedia } from '../core/utils/media-attachments.util.js';
import { repairBinaryFileReadContent } from '../tools/files/file-content-kind.js';

/** 暂停任务条目（对齐 .cjs /sessions/paused-tasks 响应结构） */
interface PausedTaskItem {
  sessionId: string;
  task: unknown;
}

/**
 * 会话 REST API
 *
 * 全局前缀已由 main.ts 设置为 /api，因此 @Controller('sessions') 实际路由为 /api/sessions。
 *
 * 暴露端点：
 *   GET    /api/sessions               - 列出所有会话
 *   POST   /api/sessions               - 创建新会话
 *   DELETE /api/sessions               - 批量清空全部会话（可保留指定会话）
 *   GET    /api/sessions/:id           - 单会话详情（元数据+消息数）
 *   DELETE /api/sessions/:id           - 删除会话
 *   GET    /api/sessions/:id/messages   - 获取会话消息
 *   PUT    /api/sessions/:id/meta      - 更新会话元数据
 *   GET    /api/sessions/paused-tasks  - 暂停的任务列表（.cjs 行 39378-39390）
 *   GET    /api/sessions/snapshots     - 会话快照列表（.cjs 行 40110-40113）
 *   POST   /api/sessions/restore       - 从快照恢复会话（.cjs 行 40114-40130）
 */
@ApiTags('Sessions')
@Controller('sessions')
export class SessionController {
  constructor(
    private readonly sessionService: SessionService,
    private readonly snapshotService: SessionSnapshotService,
    @Optional() private readonly security?: SecurityManagerService,
  ) {}

  @Get('recovery')
  recovery(): ApiResponse<ReturnType<SessionService['getRecoveryNotice']>> {
    return { success: true, data: this.sessionService.getRecoveryNotice() };
  }

  @Get()
  list(
    @Query('includeSystem') includeSystem?: string,
  ): ApiResponse<SessionInfo[]> {
    // 过滤后台任务内部执行会话（bg-task-* 前缀）：后台任务的执行过程
    // 会话由 BackgroundTaskService 驱动（AgentLoop 隐式创建），属于系统内部
    // 会话，不应出现在用户会话列表抢夺"最新会话"位置；其进度经
    // background_task WS 事件实时推送，结果完成后回流发起会话。
    // includeSystem=1 时返回全部（子代理/系统会话只读透视入口）
    const visible = this.sessionService
      .listSessions()
      .filter((s) => includeSystem === '1' || !s.id.startsWith('bg-task-'));
    return { success: true, data: visible };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() dto: CreateSessionDto): Promise<ApiResponse<SessionInfo>> {
    const session = this.sessionService.createSession(dto?.title);
    await this.sessionService.flush();
    return { success: true, data: session };
  }

  /** GET /api/sessions/search?q= — 会话搜索（标题命中优先 + 消息内容命中带摘要） */
  @Get('search')
  search(@Query('q') q?: string, @Query('limit') limit?: string): ApiResponse<ReturnType<SessionService['searchSessions']>> {
    const n = parseInt(limit || '', 10);
    return {
      success: true,
      data: this.sessionService.searchSessions(q ?? '', Number.isFinite(n) && n > 0 ? n : 20),
    };
  }

  /** POST /api/sessions/:id/fork — 从指定时间戳分叉出新会话（复制该时刻前的全部消息） */
  @Post(':id/fork')
  @HttpCode(HttpStatus.CREATED)
  async fork(
    @Param('id') id: string,
    @Body() body: { sinceTs?: number; title?: string },
  ): Promise<ApiResponse<SessionInfo | null>> {
    const sinceTs = Number(body?.sinceTs);
    const forked = this.sessionService.forkSession(
      id,
      Number.isFinite(sinceTs) ? sinceTs : Number.MAX_SAFE_INTEGER,
      body?.title,
    );
    await this.sessionService.flush();
    return { success: true, data: forked };
  }

  /** 暂停的任务列表：扫描全部会话的 _pausedTask 附加字段 */
  @Get('paused-tasks')
  pausedTasks(): ApiResponse<{ pausedTasks: PausedTaskItem[] }> {
    const paused: PausedTaskItem[] = [];
    for (const info of this.sessionService.listSessions()) {
      const store = this.sessionService.getSession(info.id) as
        | (SessionStoreItem & { _pausedTask?: unknown })
        | undefined;
      if (store && store._pausedTask) {
        paused.push({ sessionId: info.id, task: store._pausedTask });
      }
    }
    return { success: true, data: { pausedTasks: paused } };
  }

  /** 会话快照列表 */
  @Get('snapshots')
  snapshots(): ApiResponse<{ snapshots: ReturnType<SessionSnapshotService['listSnapshots']> }> {
    return { success: true, data: { snapshots: this.snapshotService.listSnapshots() } };
  }

  /** 从快照恢复会话 */
  @Post('restore')
  @HttpCode(HttpStatus.OK)
  restore(@Body() dto: RestoreSessionDto): ApiResponse<unknown> {
    const snapshot = this.snapshotService.restoreSession(dto?.sessionId || '');
    if (!snapshot) {
      return { success: false, error: 'Snapshot not found' };
    }
    return {
      success: true,
      data: {
        id: snapshot.id,
        messageCount: (snapshot.messages || []).length,
        title: snapshot.title,
        savedAt: snapshot.savedAt,
      },
    };
  }

  /** GET /api/sessions/:id — 单会话详情（元数据 + 消息数） */
  @Get(':id')
  detail(@Param('id') id: string): ApiResponse<Record<string, unknown>> {
    const store = this.sessionService.getSession(id);
    if (!store) {
      return { success: false, error: 'Session not found', code: 'NOT_FOUND' };
    }
    return {
      success: true,
      data: {
        id: store.id,
        title: store.title,
        createdAt: store.createdAt,
        updatedAt: store.updatedAt,
        messageCount: store.messages.length,
        ...(store.model !== undefined ? { model: store.model } : {}),
        ...(store.agent !== undefined ? { agent: store.agent } : {}),
        ...(store.pinned !== undefined ? { pinned: store.pinned } : {}),
      },
    };
  }

  /** DELETE /api/sessions — 批量清空全部会话（可选保留指定会话，如当前活跃会话） */
  @Delete()
  @HttpCode(HttpStatus.OK)
  async clearAll(
    @Query('keepSessionId') keepSessionId?: string,
  ): Promise<ApiResponse<{ deleted: number; kept: string[] }>> {
    const keep = keepSessionId ? [keepSessionId] : [];
    const deleted = this.sessionService.deleteAllSessions(keep);
    await this.sessionService.flush();
    return { success: true, data: { deleted, kept: keep } };
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  async delete(@Param('id') id: string): Promise<ApiResponse<{ deleted: boolean }>> {
    const existed = this.sessionService.getSession(id) !== undefined;
    this.sessionService.deleteSession(id);
    await this.sessionService.flush();
    return { success: true, data: { deleted: existed } };
  }

  @Get(':id/messages')
  async messages(@Param('id') id: string): Promise<ApiResponse<ChatMessage[]>> {
    const messages = this.sessionService.getMessages(id).map(message => message.role === 'tool'
      ? {...message, content:repairBinaryFileReadContent(message.content,message.toolName)} : message);
    return { success: true, data: await deduplicateMessageMedia(messages, path => this.security?.isPathAllowed(path, 'read') === true) };
  }

  /**
   * PUT /api/sessions/:id/messages — 整体替换会话消息。
   * 前端"删除单条消息 / 回退到本轮对话发起前"后同步调用，
   * 保证会话管理的消息计数与重新打开时的历史与前端一致。
   */
  @Put(':id/messages')
  @HttpCode(HttpStatus.OK)
  async replaceMessages(
    @Param('id') id: string,
    @Body() body: { messages?: ChatMessage[] },
  ): Promise<ApiResponse<{ replaced: boolean }>> {
    const replaced = this.sessionService.replaceMessages(id, Array.isArray(body?.messages) ? body.messages : []);
    await this.sessionService.flush();
    return { success: true, data: { replaced } };
  }

  @Put(':id/meta')
  @HttpCode(HttpStatus.OK)
  async updateMeta(
    @Param('id') id: string,
    @Body() body: Partial<Pick<import('@skyalyticwing/shared').SessionStoreItem, 'title' | 'model' | 'agent' | 'pinned' | 'archived'>>,
  ): Promise<ApiResponse<{ updated: boolean }>> {
    const existed = this.sessionService.getSession(id) !== undefined;
    if (existed) {
      this.sessionService.updateSessionMeta(id, body ?? {});
    }
    await this.sessionService.flush();
    return { success: true, data: { updated: existed } };
  }
}
