import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query } from '@nestjs/common';
import { SwarmService } from './swarm.service.js';
import { CreateSwarmDto, SwarmBroadcastDto, SwarmDeleteDto, SwarmSendDto } from './dto/swarm.dto.js';

/**
 * Swarm 蜂群 REST API（实际路由前缀 /api）
 *
 * 暴露端点：
 *   POST /api/swarm/create    - 创建蜂群（多代理协作编排）
 *   GET  /api/swarm/list      - 蜂群列表
 *   POST /api/swarm/send      - 定向消息
 *   POST /api/swarm/broadcast - 广播
 *   GET  /api/swarm/status    - 蜂群状态
 *   POST /api/swarm/delete    - 删除蜂群
 */
@Controller()
export class SwarmController {
  constructor(private readonly swarmService: SwarmService) {}

  @Post('swarm/create')
  @HttpCode(HttpStatus.CREATED)
  create(@Body() dto: CreateSwarmDto): Record<string, unknown> {
    return this.swarmService.createTeam(dto ?? {}) as unknown as Record<string, unknown>;
  }

  @Get('swarm/list')
  list(): Record<string, unknown> {
    return { teams: this.swarmService.listTeams() };
  }

  @Post('swarm/send')
  @HttpCode(HttpStatus.OK)
  send(@Body() dto: SwarmSendDto): Record<string, unknown> {
    return this.swarmService.sendMessage(dto.teamId, dto.fromId, dto.message);
  }

  @Post('swarm/broadcast')
  @HttpCode(HttpStatus.OK)
  broadcast(@Body() dto: SwarmBroadcastDto): Record<string, unknown> {
    return this.swarmService.broadcast(dto.teamId, dto.message);
  }

  @Get('swarm/status')
  status(@Query('teamId') teamId: string): Record<string, unknown> {
    const status = this.swarmService.getTeamStatus(teamId ?? '');
    return status ?? { error: 'Team not found' };
  }

  @Post('swarm/delete')
  @HttpCode(HttpStatus.OK)
  remove(@Body() dto: SwarmDeleteDto): Record<string, unknown> {
    return this.swarmService.deleteTeam(dto.teamId);
  }
}
