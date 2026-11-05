import { Global, Module, OnModuleInit } from '@nestjs/common';
import { LoggerService } from './logger.service.js';
import { RedactInterceptor } from './redact.interceptor.js';
import { ConfigService } from '../config/config.service.js';

/**
 * LoggerModule - 全局日志模块
 *
 * 在初始化阶段从 ConfigService 读取 log.redactKeys / log.level / log.maxBufferEntries
 * 配置 LoggerService，运行期可通过 ConfigService.reload() 后再次调用 setLevel 等热加载。
 */
@Global()
@Module({
  providers: [LoggerService, RedactInterceptor],
  exports: [LoggerService, RedactInterceptor],
})
export class LoggerModule implements OnModuleInit {
  constructor(
    private readonly logger: LoggerService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    this.applyConfig();
  }

  private applyConfig(): void {
    try {
      const logCfg = this.config.get<Record<string, unknown>>('log');
      const keys = logCfg['redactKeys'];
      if (Array.isArray(keys)) {
        this.logger.setRedactKeys(keys.map(String));
      }
      const level = logCfg['level'];
      if (typeof level === 'string') {
        this.logger.setLevel(level as 'debug' | 'info' | 'warn' | 'error');
      }
      const max = logCfg['maxBufferEntries'];
      if (typeof max === 'number' && max > 0) {
        this.logger.setBufferLimit(max);
      }
    } catch {
      // log 段缺失时使用默认配置
    }
  }
}
