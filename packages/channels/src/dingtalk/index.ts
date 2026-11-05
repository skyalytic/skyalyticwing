import { BaseChannel } from '../base-channel.js';

export class DingtalkChannel extends BaseChannel {
  readonly id = 'dingtalk';
  readonly name = '钉钉';
  readonly icon = 'dingtalk';

  private appKey = '';
  private appSecret = '';

  override configure(config: { appKey: string; appSecret: string }): void {
    this.appKey = config.appKey;
    this.appSecret = config.appSecret;
  }

  async connect(): Promise<void> {
    // 使用 _markConnecting() 防止 TOCTOU 竞态（同时检查 connected 与 _connecting）
    if (!this._markConnecting()) return;
    if (!this.appKey || !this.appSecret) {
      this._clearConnecting();
      throw new Error('钉钉 appKey/appSecret 未配置');
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
