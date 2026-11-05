import { BaseChannel } from '../base-channel.js';

export class DiscordChannel extends BaseChannel {
  readonly id = 'discord';
  readonly name = 'Discord';
  readonly icon = 'discord';

  private botToken = '';

  override configure(config: { botToken: string }): void { this.botToken = config.botToken; }

  async connect(): Promise<void> {
    // 使用 _markConnecting() 防止 TOCTOU 竞态
    if (!this._markConnecting()) return;
    if (!this.botToken) {
      this._clearConnecting();
      throw new Error('Discord botToken 未配置');
    }
    this._markConnected();
  }

  // 移除 disconnect() 重写，继承 BaseChannel.disconnect() 模板方法，
  // 由基类统一置 connected=false 并调用 clearHandlers() 清理处理器。
  // sendMessage() 是桩实现，不应静默返回成功（仅校验参数后即返回）。改为显式抛出错误，与 tools 包保持一致。
  async sendMessage(peerId: string, content: string): Promise<void> {
    this.validateSendMessage(peerId, content);
    throw new Error('Channel sendMessage() not implemented yet');
  }
}
