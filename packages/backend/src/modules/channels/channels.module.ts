import { InboxService } from './inbox.service.js';
import { InboxController } from './inbox.controller.js';
import { Module } from '@nestjs/common';
import { ChannelsService } from './channels.service.js';
import { ChannelsController } from './channels.controller.js';
import { ChannelRouterService } from './channel-router.service.js';
import { DingTalkProvider } from './providers/dingtalk.service.js';
import { FeishuProvider } from './providers/feishu.service.js';
import { WeChatWorkProvider } from './providers/wechat-work.service.js';
import { DiscordProvider } from './providers/discord.service.js';
import { QQProvider } from './providers/qq.service.js';
import { TelegramProvider } from './providers/telegram.service.js';
import { SlackProvider } from './providers/slack.service.js';
import { WeComProvider } from './providers/wecom.service.js';
import { WeixinProvider } from './providers/weixin.service.js';
import { BindingService } from './binding.service.js';
import { BindingController } from './binding.controller.js';
import { ChannelAiHandler } from './channel-ai.handler.js';

/**
 * ChannelsModule - 渠道域模块
 *
 * 依赖 LoggerService / WebSocketService / HttpClientService（由各自全局模块提供）。
 *
 * 注册的 providers：
 *   - ChannelRouterService：消息路由（LRU 上限 10000）
 *   - 九个渠道 provider：DingTalk / Feishu / WeChatWork / Discord / QQ /
 *     Telegram / Slack / WeCom / Weixin
 *     （均 @Injectable()，由 ChannelsService 通过依赖注入持有）
 *   - BindingService：路由绑定（8 层优先级解析，移植自 .cjs BindingRouter）
 *
 * 导出 ChannelsService / ChannelRouterService / BindingService 供其它模块调用。
 */
@Module({
  providers: [
    InboxService,
    ChannelRouterService,
    DingTalkProvider,
    FeishuProvider,
    WeChatWorkProvider,
    DiscordProvider,
    QQProvider,
    TelegramProvider,
    SlackProvider,
    WeComProvider,
    WeixinProvider,
    ChannelsService,
    BindingService,
    ChannelAiHandler,
  ],
  controllers: [InboxController, ChannelsController, BindingController],
  exports: [ChannelsService, ChannelRouterService, BindingService],
})
export class ChannelsModule {}
