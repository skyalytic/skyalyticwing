import { BaseChannel } from '../base-channel.js';
import type { ChannelMessage } from '@skyalyticwing/sdk';

export class FeishuChannel extends BaseChannel {
  readonly id = 'feishu';
  readonly name = '飞书';
  readonly icon = 'feishu';

  private appId = '';
  private appSecret = '';

  override configure(config: { appId: string; appSecret: string }): void {
    this.appId = config.appId;
    this.appSecret = config.appSecret;
  }

  async connect(): Promise<void> {
    // 使用 _markConnecting() 防止 TOCTOU 竞态
    if (!this._markConnecting()) return;
    if (!this.appId || !this.appSecret) {
      this._clearConnecting();
      throw new Error('飞书 appId/appSecret 未配置');
    }
    // 此基础适配器只管理生命周期；网络收发需由实际渠道实现提供。
    this._markConnected();
  }

  // 移除 disconnect() 重写，继承 BaseChannel.disconnect() 模板方法，
  // 由基类统一置 connected=false 并调用 clearHandlers() 清理处理器（原逻辑已并入基类）。

  async sendMessage(peerId: string, content: string): Promise<void> {
    this.validateSendMessage(peerId, content);
    // TS-6 fix: 与其他渠道一致，抛出未实现错误而非静默成功
    throw new Error('Channel sendMessage() not implemented yet');
  }
}
