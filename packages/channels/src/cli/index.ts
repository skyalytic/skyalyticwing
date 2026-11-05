import { BaseChannel } from '../base-channel.js';

export class CLIChannel extends BaseChannel {
  readonly id = 'cli';
  readonly name = 'CLI';
  readonly icon = 'terminal';

  // 使用 _markConnecting()/_markConnected() 防止 TOCTOU 竞态
  async connect(): Promise<void> {
    if (!this._markConnecting()) return;
    this._markConnected();
  }
  // 移除 disconnect() 重写，继承 BaseChannel.disconnect() 模板方法，
  // 由基类统一置 connected=false 并调用 clearHandlers() 清理处理器。
  async sendMessage(peerId: string, content: string): Promise<void> {
    this.validateSendMessage(peerId, content);
    // TS-12 fix: 抛出未实现错误而非静默成功
    throw new Error('Channel sendMessage() not implemented yet');
  }
}
