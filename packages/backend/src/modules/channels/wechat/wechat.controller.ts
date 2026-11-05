import { Body, Controller, Get, Header, HttpCode, HttpStatus, Post, Query } from '@nestjs/common';
import { CredentialResponse } from '../../core/logger/redact.interceptor.js';
import { WechatService } from './wechat.service.js';
import { CliInstallDto, WeixinQrDto } from './dto/wechat.dto.js';

/**
 * 微信（iLink Bot）扫码登录 REST API
 *
 * 全局前缀已由 main.ts 设置为 /api，因此 @Controller('weixin') 实际路由为 /api/weixin。
 *
 * 暴露端点（对齐旧版 start.cjs）：
 *   GET/POST /api/weixin/qr          - 获取微信登录二维码
 *   GET      /api/weixin/poll        - 轮询扫码状态
 *   POST     /api/weixin/cli-install - 安装 wx CLI 工具（npx 后台进程）
 *   GET      /api/weixin/cli-status  - 查询 CLI 安装状态（增量输出）
 */
@Controller('weixin')
export class WeixinController {
  constructor(private readonly wechat: WechatService) {}

  /**
   * 获取微信登录二维码（旧版为 POST only，此处同时兼容 GET）。
   * 注意：NestJS 不支持在同一方法上叠加 @Get/@Post（后执行的装饰器会覆盖
   * method 元数据导致另一方法路由丢失 → 404），须拆为独立方法。
   */
  @Post('qr')
  @HttpCode(HttpStatus.OK)
  async qrPost(@Query('bot_type') botType?: string, @Body() _dto?: WeixinQrDto) {
    return this.wechat.getWeixinQr(botType || '3');
  }

  @Get('qr')
  async qrGet(@Query('bot_type') botType?: string) {
    return this.wechat.getWeixinQr(botType || '3');
  }

  /** 轮询微信扫码状态 */
  @Get('poll')
  @CredentialResponse('botToken')
  @Header('Cache-Control', 'no-store')
  async poll(@Query('sessionId') sessionId?: string) {
    if (!sessionId) {
      return { status: 'error', error: 'sessionId required' };
    }
    return this.wechat.pollWeixin(sessionId);
  }

  /** 安装微信 CLI 工具 */
  @Post('cli-install')
  @HttpCode(HttpStatus.OK)
  cliInstall(@Body() _dto?: CliInstallDto) {
    return this.wechat.startWeixinCli();
  }

  /** 查询微信 CLI 安装状态 */
  @Get('cli-status')
  @CredentialResponse('botToken')
  @Header('Cache-Control', 'no-store')
  cliStatus(@Query('cliId') cliId?: string, @Query('since') since?: string) {
    if (!cliId) {
      return { status: 'not_found' };
    }
    const sinceTs = parseInt(since || '0', 10) || 0;
    return this.wechat.getCliStatus(cliId, sinceTs);
  }
}

/**
 * 企业微信扫码授权 REST API（路由前缀 /api/wecom）
 *
 * 暴露端点（对齐旧版 start.cjs）：
 *   GET/POST /api/wecom/qr          - 获取企业微信授权二维码
 *   GET      /api/wecom/poll        - 轮询授权状态
 *   POST     /api/wecom/cli-install - 安装企业微信 CLI
 *   GET      /api/wecom/cli-status  - 查询 CLI 安装状态
 */
@Controller('wecom')
export class WecomController {
  constructor(private readonly wechat: WechatService) {}

  /**
   * 获取企业微信授权二维码（旧版为 POST only，此处同时兼容 GET）。
   * 同上：叠加 @Get/@Post 会导致其中一路由丢失，须拆为独立方法。
   */
  @Post('qr')
  @HttpCode(HttpStatus.OK)
  async qrPost() {
    return this.wechat.getWecomQr();
  }

  @Get('qr')
  async qrGet() {
    return this.wechat.getWecomQr();
  }

  /** 轮询企业微信授权状态 */
  @Get('poll')
  @CredentialResponse('secret')
  @Header('Cache-Control', 'no-store')
  async poll(@Query('sessionId') sessionId?: string) {
    if (!sessionId) {
      return { status: 'error', error: 'sessionId required' };
    }
    return this.wechat.pollWecom(sessionId);
  }

  /** 安装企业微信 CLI */
  @Post('cli-install')
  @HttpCode(HttpStatus.OK)
  cliInstall(@Body() _dto?: CliInstallDto) {
    return this.wechat.startWecomCli();
  }

  /** 查询企业微信 CLI 安装状态 */
  @Get('cli-status')
  @CredentialResponse('secret')
  @Header('Cache-Control', 'no-store')
  cliStatus(@Query('cliId') cliId?: string, @Query('since') since?: string) {
    if (!cliId) {
      return { status: 'not_found' };
    }
    const sinceTs = parseInt(since || '0', 10) || 0;
    return this.wechat.getCliStatus(cliId, sinceTs);
  }
}
