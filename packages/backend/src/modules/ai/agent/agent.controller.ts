import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  HttpException,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join, resolve as resolvePath } from 'node:path';
import { homedir, platform } from 'node:os';
import type { ApiResponse } from '@skyalyticwing/shared';
import { ApiTags } from '../../core/swagger/swagger-decorators.js';
import { AgentService } from './agent.service.js';
import { AgentMessengerService, type AgentMessage } from './agent-messenger.service.js';
import { SecurityManagerService } from '../../core/security/security-manager.service.js';
import { LoggerService } from '../../core/logger/logger.service.js';
import type {
  AgentInfo,
  AgentMemory,
  CreateAgentDto,
  UpdateAgentDto,
} from '../types.js';

/**
 * Agent REST API（实际路由前缀 /api/agents）
 *
 * 暴露端点：
 *   GET    /api/agents                     - 列出全部 Agent
 *   POST   /api/agents                     - 创建 Agent
 *   POST   /api/agents/message             - 发送 Agent 间消息
 *   GET    /api/agents/inbox               - 收件箱（默认 main，支持 ?agentId=）
 *   GET    /api/agents/inbox/:id           - 指定 Agent 收件箱
 *   GET    /api/agents/conversation        - 对话历史（?agent1=&agent2=）
 *   POST   /api/agents/markread            - 标记已读
 *   GET    /api/agents/:id                 - 获取单个 Agent
 *   PUT    /api/agents/:id                 - 更新 Agent
 *   DELETE /api/agents/:id                 - 删除 Agent
 *   GET    /api/agents/:id/memory          - 获取 Agent 记忆
 *   PUT    /api/agents/:id/memory          - 设置 Agent 记忆
 *   GET    /api/agents/:id/workspace       - 读取 Agent 工作区文件
 *   POST   /api/agents/:id/workspace       - 写入 Agent 工作区文件
 *   DELETE /api/agents/:id/workspace       - 删除 Agent 工作区文件
 *
 * 路由顺序：字面量路径（inbox/conversation/message/markread）必须在 :id 之前声明，
 * 否则会被 :id 参数捕获。:id/workspace 等带子路径的路由对 :id 不构成冲突。
 */
@ApiTags('Agents')
@Controller('agents')
export class AgentController {
  constructor(
    private readonly agentService: AgentService,
    private readonly messenger: AgentMessengerService,
    private readonly security: SecurityManagerService,
    private readonly logger: LoggerService,
  ) {}

  // ─── 团队（多智能体协作单元，必须在 :id 之前声明） ───────────────────

  /** GET /api/agents/teams - 列出全部团队 */
  @Get('teams')
  listTeams(): ApiResponse<unknown> {
    return { success: true, data: this.agentService.listTeams() };
  }

  /** POST /api/agents/teams - 创建团队 */
  @Post('teams')
  @HttpCode(HttpStatus.OK)
  createTeam(
    @Body() body: { name?: string; description?: string; memberIds?: string[]; avatar?: string },
  ): ApiResponse<unknown> {
    assertAvatarValid(body?.avatar);
    try {
      return { success: true, data: this.agentService.createTeam(body ?? {}) };
    } catch (err) {
      return { success: false, error: errMsg(err) };
    }
  }

  /** PUT /api/agents/teams/:id - 更新团队（名称/描述/成员清单） */
  @Put('teams/:id')
  updateTeam(
    @Param('id') id: string,
    @Body() body: { name?: string; description?: string; memberIds?: string[]; avatar?: string },
  ): ApiResponse<unknown> {
    assertAvatarValid(body?.avatar);
    try {
      return { success: true, data: this.agentService.updateTeam(id, body ?? {}) };
    } catch (err) {
      return { success: false, error: errMsg(err) };
    }
  }

  /** DELETE /api/agents/teams/:id - 删除团队 */
  @Delete('teams/:id')
  deleteTeam(@Param('id') id: string): ApiResponse<unknown> {
    try {
      this.agentService.deleteTeam(id);
      return { success: true, data: { deleted: true } };
    } catch (err) {
      return { success: false, error: errMsg(err) };
    }
  }

  // ─── Agent 间消息（必须在 :id 之前声明） ─────────────────────────────

  @Post('message')
  @HttpCode(HttpStatus.OK)
  sendMessage(
    @Body('from') from: string,
    @Body('to') to: string,
    @Body('message') message: string,
    @Body('type') type?: string,
  ): ApiResponse<unknown> {
    if (!to || !message) {
      return { success: false, error: 'to 和 message 必填' };
    }
    try {
      const result = this.messenger.send(from || 'main', to, message, type || 'text');
      return { success: result.success, data: result, ...(result.error ? { error: result.error } : {}) };
    } catch (err) {
      return { success: false, error: errMsg(err) };
    }
  }

  @Get('inbox')
  inbox(@Query('agentId') agentId?: string, @Query('unread') unread?: string): ApiResponse<{
    agentId: string;
    messages: AgentMessage[];
    unreadCount: number;
  }> {
    const id = agentId || 'main';
    const onlyUnread = unread === 'true';
    const msgs = onlyUnread ? this.messenger.getUnread(id) : this.messenger.getInbox(id);
    return {
      success: true,
      data: {
        agentId: id,
        messages: msgs,
        unreadCount: this.messenger.getUnread(id).length,
      },
    };
  }

  @Get('inbox/:id')
  inboxForAgent(
    @Param('id') id: string,
    @Query('unread') unread?: string,
  ): ApiResponse<{ agentId: string; messages: AgentMessage[]; unreadCount: number }> {
    const onlyUnread = unread === 'true';
    const msgs = onlyUnread ? this.messenger.getUnread(id) : this.messenger.getInbox(id);
    return {
      success: true,
      data: {
        agentId: id,
        messages: msgs,
        unreadCount: this.messenger.getUnread(id).length,
      },
    };
  }

  @Get('conversation')
  conversation(
    @Query('agent1') agent1: string,
    @Query('agent2') agent2: string,
  ): ApiResponse<{ agent1: string; agent2: string; messages: AgentMessage[] }> {
    if (!agent1 || !agent2) {
      return { success: false, error: 'agent1 和 agent2 参数必填' };
    }
    return {
      success: true,
      data: {
        agent1,
        agent2,
        messages: this.messenger.getConversation(agent1, agent2),
      },
    };
  }

  @Post('markread')
  @HttpCode(HttpStatus.OK)
  markRead(@Body('agentId') agentId?: string, @Body('msgId') msgId?: string): ApiResponse<unknown> {
    try {
      const result = this.messenger.markRead(agentId || 'main', msgId || undefined);
      return { success: result.success, data: result };
    } catch (err) {
      return { success: false, error: errMsg(err) };
    }
  }

  // ─── Agent CRUD ──────────────────────────────────────────────────────

  @Get()
  list(): ApiResponse<AgentInfo[]> {
    return { success: true, data: this.agentService.listAgents() };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Body() body: CreateAgentDto): ApiResponse<AgentInfo> {
    assertAvatarValid(body?.avatar);
    try {
      return { success: true, data: this.agentService.createAgent(body) };
    } catch (err) {
      return { success: false, error: errMsg(err) };
    }
  }

  @Get(':id')
  get(@Param('id') id: string): ApiResponse<AgentInfo> {
    try {
      return { success: true, data: this.agentService.getAgent(id) };
    } catch (err) {
      return { success: false, error: errMsg(err), code: 'NOT_FOUND' };
    }
  }

  @Put(':id')
  @HttpCode(HttpStatus.OK)
  update(@Param('id') id: string, @Body() body: UpdateAgentDto): ApiResponse<AgentInfo> {
    assertAvatarValid(body?.avatar);
    try {
      return { success: true, data: this.agentService.updateAgent(id, body) };
    } catch (err) {
      return { success: false, error: errMsg(err) };
    }
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  remove(@Param('id') id: string): ApiResponse<{ id: string }> {
    try {
      // 内置智能体（builtin）不可删除——deleteAgent 内部抛错，此处转结构化响应
      this.agentService.deleteAgent(id);
      return { success: true, data: { id } };
    } catch (err) {
      return { success: false, error: errMsg(err) };
    }
  }

  // ─── Agent 记忆 ──────────────────────────────────────────────────────

  @Get(':id/memory')
  getMemory(@Param('id') id: string): ApiResponse<AgentMemory> {
    return { success: true, data: this.agentService.getMemory(id) };
  }

  @Put(':id/memory')
  @HttpCode(HttpStatus.OK)
  setMemory(@Param('id') id: string, @Body() body: AgentMemory): ApiResponse<AgentMemory> {
    this.agentService.setMemory(id, body);
    return { success: true, data: this.agentService.getMemory(id) };
  }

  // ─── Agent 工作区文件管理 ────────────────────────────────────────────
  //
  // 移植自 start.cjs /agents/:id/workspace 路由（GET/POST/DELETE）。
  // 工作区根目录：${dataDir}/workspaces/${agentId}/，agentId 经 sanitize 去除 ".." 与路径分隔符。
  // 所有 FS 操作前调用 SecurityManager.isPathAllowed 校验白名单。

  @Get(':id/workspace')
  getWorkspace(@Param('id') id: string): ApiResponse<{ files: Record<string, string> }> {
    const dir = this.resolveWorkspaceDir(id);
    try {
      if (!this.security.isPathAllowed(dir, 'readwrite')) {
        return { success: false, error: '路径未在白名单内：' + dir };
      }
      // 对齐旧版 _ensureAgentWorkspace：首次访问自动初始化默认工作区文件
      // （SOUL/AGENTS/IDENTITY/USER/MEMORY，模板与旧版 getAgentWorkspaceTemplate 逐字一致）
      this.ensureAgentWorkspace(id, dir);
      const files: Record<string, string> = {};
      if (existsSync(dir)) {
        for (const fn of readdirSync(dir)) {
          const fp = join(dir, fn);
          try {
            if (statSync(fp).isFile()) {
              files[fn] = readFileSync(fp, 'utf-8');
            }
          } catch {
            // 忽略单文件读取失败
          }
        }
      }
      return { success: true, data: { files } };
    } catch (err) {
      return { success: false, error: errMsg(err) };
    }
  }

  /**
   * 确保代理工作区已初始化（移植旧版 _ensureAgentWorkspace，start.cjs 16719-16739）：
   * 目录不存在则创建；SOUL.md/AGENTS.md/IDENTITY.md/USER.md/MEMORY.md 缺失则写默认模板。
   */
  private ensureAgentWorkspace(agentId: string, dir: string): void {
    const templates: Record<string, string> = {
      'IDENTITY.md': `# 身份信息\n\n名称: ${agentId}\n类型: 自定义代理\n`,
      'SOUL.md': `# 代理人格\n\n你是 ${agentId}，一个AI助手。\n`,
      'AGENTS.md': '# 代理配置\n\n## 工具策略\n- 允许所有工具\n',
      'USER.md': '# 用户信息\n\n（待填充）\n',
    };
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    for (const fn of Object.keys(templates)) {
      const fp = join(dir, fn);
      if (!existsSync(fp)) {
        writeFileSync(fp, templates[fn]!, 'utf8');
        this.logger.info('Agent workspace file initialized', { agentId, file: fn });
      }
    }
    const memPath = join(dir, 'MEMORY.md');
    if (!existsSync(memPath)) {
      writeFileSync(memPath, '# 长期记忆\n\n此文件用于存储代理的重要持久化信息。\n', 'utf8');
    }
  }

  @Post(':id/workspace')
  @HttpCode(HttpStatus.OK)
  setWorkspaceFile(
    @Param('id') id: string,
    @Body() body: { file?: string; content?: string },
  ): ApiResponse<{ success: boolean }> {
    if (!body?.file) {
      return { success: false, error: 'file required' };
    }
    const dir = this.resolveWorkspaceDir(id);
    try {
      if (!this.security.isPathAllowed(dir, 'write')) {
        return { success: false, error: '路径未在白名单内：' + dir };
      }
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      // 仅取 basename 防止路径遍历；无扩展名追加 .md
      let fname = basename(body.file);
      if (!fname.includes('.')) fname += '.md';
      const fp = join(dir, fname);
      if (!this.security.isPathAllowed(fp, 'write')) {
        return { success: false, error: '路径未在白名单内：' + fp };
      }
      writeFileSync(fp, body.content || '', 'utf8');
      this.logger.info('Agent workspace file saved', { agentId: id, file: fname });
      return { success: true, data: { success: true } };
    } catch (err) {
      return { success: false, error: errMsg(err) };
    }
  }

  @Delete(':id/workspace')
  @HttpCode(HttpStatus.OK)
  deleteWorkspaceFile(
    @Param('id') id: string,
    @Body() body: { file?: string },
  ): ApiResponse<{ success: boolean }> {
    if (!body?.file) {
      return { success: false, error: 'file required' };
    }
    const dir = this.resolveWorkspaceDir(id);
    try {
      if (!this.security.isPathAllowed(dir, 'write')) {
        return { success: false, error: '路径未在白名单内：' + dir };
      }
      const fname = basename(body.file);
      const fp = join(dir, fname);
      if (!this.security.isPathAllowed(fp, 'write')) {
        return { success: false, error: '路径未在白名单内：' + fp };
      }
      if (existsSync(fp)) {
        unlinkSync(fp);
        this.logger.info('Agent workspace file deleted', { agentId: id, file: fname });
      }
      return { success: true, data: { success: true } };
    } catch (err) {
      return { success: false, error: errMsg(err) };
    }
  }

  // ─── 内部工具 ────────────────────────────────────────────────────────

  /** 解析 Agent 工作区目录：${dataDir}/workspaces/${agentId} */
  private resolveWorkspaceDir(agentId: string): string {
    const safe = String(agentId || '')
      .replace(/\.\./g, '')
      .replace(/[\\/]/g, '');
    const dataDir = process.env['SKYALYTICWING_DATA_DIR'] || this.getDefaultDataDir();
    return resolvePath(dataDir, 'workspaces', safe);
  }

  private getDefaultDataDir(): string {
    const plat = platform();
    if (plat === 'win32') {
      const appData = process.env['APPDATA'] || join(homedir(), 'AppData', 'Roaming');
      return join(appData, 'SkyalyticWing');
    }
    if (plat === 'darwin') {
      return join(homedir(), 'Library', 'Application Support', 'SkyalyticWing');
    }
    const xdg = process.env['XDG_CONFIG_HOME'] || join(homedir(), '.config');
    return join(xdg, 'skyalyticwing');
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 头像 dataURL 长度上限（≈200KB 二进制经 base64 编码后约 ≤ 280000 字符） */
const AVATAR_MAX_LENGTH = 280000;
/** 头像 dataURL 允许的前缀（仅 PNG/JPEG/WebP 的 base64 dataURL） */
const AVATAR_PREFIX_RE = /^data:image\/(png|jpeg|webp);base64,/;

/**
 * 校验头像字段（base64 dataURL 直接存字段，无独立文件存储）：
 * 允许缺省/空串（表示未设置头像）；否则必须以 data:image/(png|jpeg|webp);base64, 开头
 * 且总长度 ≤ 280000 字符。违规时抛出 HTTP 400（响应体保持 ApiResponse 形状，
 * 前端 apiClient 会读取 error 字段提示）。
 */
function assertAvatarValid(avatar?: string): void {
  if (avatar === undefined || avatar === '') return;
  // 请求体运行时类型不受 TS 约束，先做 string 防御再校验前缀
  if (typeof avatar !== 'string' || !AVATAR_PREFIX_RE.test(avatar)) {
    throw new HttpException(
      { success: false, error: '头像格式无效：仅支持 PNG/JPEG/WebP 的 base64 dataURL' },
      HttpStatus.BAD_REQUEST,
    );
  }
  if (avatar.length > AVATAR_MAX_LENGTH) {
    throw new HttpException(
      { success: false, error: '头像过大：需 ≤ 200KB（base64 ≤ 280000 字符）' },
      HttpStatus.BAD_REQUEST,
    );
  }
}
