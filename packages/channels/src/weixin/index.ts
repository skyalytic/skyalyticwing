import { BaseChannel } from '../base-channel.js';

export class WeixinChannel extends BaseChannel {
  readonly id = 'weixin';
  readonly name = '微信';
  readonly icon = 'weixin';

  private botToken = '';
  private baseUrl = '';

  override configure(config: { botToken: string; baseUrl: string }): void {
    this.botToken = config.botToken;
    this.baseUrl = config.baseUrl;
  }

  async connect(): Promise<void> {
    // 使用 _markConnecting() 防止 TOCTOU 竞态
    if (!this._markConnecting()) return;
    if (!this.botToken) { this._clearConnecting(); throw new Error('微信 botToken 未配置'); }
    if (!this.baseUrl) { this._clearConnecting(); throw new Error('微信 baseUrl 未配置'); }
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
