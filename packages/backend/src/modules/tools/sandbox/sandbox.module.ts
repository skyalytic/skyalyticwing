import { Module } from '@nestjs/common';
import { SandboxSystemService } from './sandbox.service.js';
import { SandboxEnhancedService } from './sandbox-enhanced.service.js';
import { SandboxController } from './sandbox.controller.js';
import { ToolExecutorModule } from '../executor/tool-executor.module.js';

/**
 * SandboxModule - 沙箱执行模块
 *
 * 复用 SecurityManagerService 的命令 / 路径安全能力（全局模块提供），
 * 配置持久化到 packages/web/data/sandbox.json。
 * SandboxProfileService（三级档位）由全局 ToolExecutorModule 提供并导出，
 * 本模块导入后供 SandboxController 的档位端点注入。
 */
@Module({
  imports: [ToolExecutorModule],
  providers: [SandboxSystemService, SandboxEnhancedService],
  controllers: [SandboxController],
  exports: [SandboxSystemService, SandboxEnhancedService],
})
export class SandboxModule {}
