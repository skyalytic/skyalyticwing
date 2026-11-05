import { Module } from '@nestjs/common';
import { WechatService } from './wechat.service.js';
import { WeixinController, WecomController } from './wechat.controller.js';

/**
 * WechatModule - 微信 / 企业微信扫码登录模块
 *
 * 依赖 LoggerService / HttpClientService / SecurityManagerService，均由各自
 * 全局模块提供。
 *
 * Controllers:
 *   - WeixinController: /api/weixin/*（iLink Bot 扫码登录 + CLI 安装）
 *   - WecomController:  /api/wecom/*（企业微信授权 + CLI 安装）
 */
@Module({
  providers: [WechatService],
  controllers: [WeixinController, WecomController],
  exports: [WechatService],
})
export class WechatModule {}
