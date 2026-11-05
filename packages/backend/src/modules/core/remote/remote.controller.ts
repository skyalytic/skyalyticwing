import { BadRequestException, Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { RemoteService } from './remote.service.js';
import { DispatchDto, NodeActionDto, RegisterNodeDto, RemoveNodeDto } from './dto/remote.dto.js';

/**
 * Remote 远程节点 REST API（实际路由前缀 /api）
 *
 * 暴露端点：
 *   GET  /api/remote/nodes       - 节点列表（统计）
 *   POST /api/remote/nodes       - 注册节点（对齐旧版）
 *   POST /api/remote/dispatch    - 分派任务到节点
 *   GET  /api/remote/node/:id    - 节点详情
 *   POST /api/remote/remove      - 移除节点
 *   POST /api/remote/connect     - 连接节点
 *   POST /api/remote/disconnect  - 断开节点
 */
@Controller()
export class RemoteController {
  constructor(private readonly remoteService: RemoteService) {}

  @Get('remote/nodes')
  nodes(): Record<string, unknown> {
    return this.remoteService.getStats();
  }

  @Post('remote/nodes')
  @HttpCode(HttpStatus.CREATED)
  register(@Body() dto: RegisterNodeDto): Record<string, unknown> {
    const result = this.remoteService.registerNode(dto);
    // 注册失败（如 SSRF 防护拒绝）时抛异常，避免 @HttpCode(201) 把失败响应也标成 CREATED
    if ('error' in result) throw new BadRequestException(result.error);
    return { success: true, node: result };
  }

  @Post('remote/dispatch')
  @HttpCode(HttpStatus.OK)
  dispatch(@Body() dto: DispatchDto): Promise<Record<string, unknown>> {
    return this.remoteService
      .dispatchToRemote(dto.nodeId, dto.task)
      .then((r) => r as unknown as Record<string, unknown>);
  }

  @Get('remote/node/:id')
  detail(@Param('id') id: string): Record<string, unknown> {
    const node = this.remoteService.getNodeStatus(id);
    return node ?? { error: 'Node not found' };
  }

  @Post('remote/remove')
  @HttpCode(HttpStatus.OK)
  remove(@Body() dto: RemoveNodeDto): Record<string, unknown> {
    return this.remoteService.removeNode(dto.nodeId);
  }

  @Post('remote/connect')
  @HttpCode(HttpStatus.OK)
  connect(@Body() dto: NodeActionDto): Record<string, unknown> {
    return this.remoteService.connectNode(dto.nodeId) as Record<string, unknown>;
  }

  @Post('remote/disconnect')
  @HttpCode(HttpStatus.OK)
  disconnect(@Body() dto: NodeActionDto): Record<string, unknown> {
    return this.remoteService.disconnectNode(dto.nodeId) as Record<string, unknown>;
  }
}
