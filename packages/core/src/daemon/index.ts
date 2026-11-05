import { createLogger, type Logger } from '@skyalyticwing/shared';

export type DaemonType = 'systemd' | 'launchd' | 'schtasks';

export class DaemonManager {
  private logger: Logger;
  private type: DaemonType;

  constructor(logger?: Logger) {
    this.logger = logger ?? createLogger({ name: 'daemon' });
    this.type = this.detectDaemonType();
    // TS-11 fix: logger and type are used for future platform-specific logic; reference to satisfy noUnusedLocals
    void this.logger;
    void this.type;
  }

  private detectDaemonType(): DaemonType {
    const platform = process.platform;
    if (platform === 'win32') return 'schtasks';
    if (platform === 'darwin') return 'launchd';
    return 'systemd';
  }

  async install(): Promise<void> {
    // TS-13 fix: 抛出未实现错误而非静默成功
    throw new Error('DaemonManager.install not implemented yet');
  }

  async uninstall(): Promise<void> {
    // TS-13 fix: 抛出未实现错误而非静默成功
    throw new Error('DaemonManager.uninstall not implemented yet');
  }

  async status(): Promise<{ installed: boolean; running: boolean }> {
    // TS-13 fix: 抛出未实现错误而非静默成功
    throw new Error('DaemonManager.status not implemented yet');
  }
}
