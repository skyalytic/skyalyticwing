import { BaseChannel } from '../base-channel.js';

export class EmailChannel extends BaseChannel {
  readonly id = 'email';
  readonly name = '邮件';
  readonly icon = 'email';

  private smtpHost = '';
  private smtpPort = 465;
  private smtpUser = '';
  private smtpPass = '';

  override configure(config: { smtpHost: string; smtpPort: number; smtpUser: string; smtpPass: string }): void {
    this.smtpHost = config.smtpHost;
    this.smtpPort = config.smtpPort;
    this.smtpUser = config.smtpUser;
    this.smtpPass = config.smtpPass;
  }

  async connect(): Promise<void> {
    // 使用 _markConnecting() 防止 TOCTOU 竞态
    if (!this._markConnecting()) return;
    if (!this.smtpHost) { this._clearConnecting(); throw new Error('SMTP 主机未配置'); }
    if (this.smtpPort < 1 || this.smtpPort > 65535) { this._clearConnecting(); throw new Error('SMTP port invalid, must be 1-65535'); }
    if (!this.smtpUser) { this._clearConnecting(); throw new Error('SMTP 用户名未配置'); }
    if (!this.smtpPass) { this._clearConnecting(); throw new Error('SMTP 密码未配置'); }
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
