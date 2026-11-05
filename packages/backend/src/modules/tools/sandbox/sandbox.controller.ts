import { Body, Controller, Get, HttpCode, HttpStatus, Post, Put } from '@nestjs/common';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { SandboxSystemService } from './sandbox.service.js';
import { SandboxEnhancedService } from './sandbox-enhanced.service.js';
import { SandboxProfileService } from './sandbox-profile.service.js';
import {
  SANDBOX_MODES,
  type SandboxMode,
} from './sandbox-profiles.js';
import {
  CreateSandboxContainerDto,
  DestroySandboxContainerDto,
  ExecSandboxContainerDto,
  SandboxExecuteDto,
  SandboxValidateDto,
  UpdateSandboxEnhancedDto,
} from './dto/sandbox.dto.js';

/** 沙箱档位设置 DTO（PUT /sandbox/profile） */
class SandboxProfileDto {
  @IsIn(SANDBOX_MODES as unknown as string[])
  mode!: SandboxMode;
}

/** 会话级档位覆盖 DTO（PUT /sandbox/profile/session） */
class SandboxSessionModeDto {
  @IsString()
  @MaxLength(256)
  sessionId!: string;

  /** null/缺省 = 清除覆盖回落全局档位（@IsOptional 同时跳过 null 与 undefined） */
  @IsIn([...(SANDBOX_MODES as unknown as string[])])
  @IsOptional()
  mode?: SandboxMode | null;
}

/**
 * Sandbox 沙箱 REST API（实际路由前缀 /api）
 *
 * 暴露端点：
 *   GET  /api/sandbox/status             - 沙箱状态
 *   POST /api/sandbox/execute            - 沙箱执行
 *   POST /api/sandbox/validate           - 验证命令安全性
 *   GET  /api/sandbox/allowed            - 允许的操作列表
 *   GET  /api/sandbox/profile            - 三级沙箱档位（全局配置 + 会话覆盖）
 *   PUT  /api/sandbox/profile            - 设置全局档位（mode 或 presetId）
 *   PUT  /api/sandbox/profile/session    - 设置/清除会话级档位覆盖
 *   GET  /api/sandbox/presets            - 内置权限预设（档位+审批策略捆绑）
 *   GET  /api/sandbox-enhanced           - 增强沙箱配置
 *   PUT  /api/sandbox-enhanced           - 更新配置
 *   POST /api/sandbox-enhanced/create    - 创建沙箱容器
 *   POST /api/sandbox-enhanced/exec      - 容器内执行
 *   POST /api/sandbox-enhanced/destroy   - 销毁容器
 */
@Controller()
export class SandboxController {
  constructor(
    private readonly sandboxService: SandboxSystemService,
    private readonly sandboxEnhancedService: SandboxEnhancedService,
    private readonly sandboxProfile: SandboxProfileService,
  ) {}

  // ── 三级沙箱档位（read-only / workspace-write / danger-full-access） ──

  /** GET /sandbox/profile — 当前档位配置与会话覆盖 */
  @Get('sandbox/profile')
  profile(): Record<string, unknown> {
    return {
      success: true,
      data: {
        config: this.sandboxProfile.getConfig(),
        modes: this.sandboxProfile.listModes(),
      },
    };
  }

  /** PUT /sandbox/profile — 设置全局档位（mode 直接指定，或 presetId 应用预设） */
  @Put('sandbox/profile')
  @HttpCode(HttpStatus.OK)
  setProfile(@Body() dto: Partial<SandboxProfileDto & { presetId?: string | null }>): Record<string, unknown> {
    try {
      const config = this.sandboxProfile.setMode({
        ...(dto?.mode !== undefined ? { mode: dto.mode } : {}),
        ...(dto?.presetId !== undefined ? { presetId: dto.presetId } : {}),
      });
      return { success: true, data: { config } };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** PUT /sandbox/profile/session — 会话级覆盖（mode=null 清除） */
  @Put('sandbox/profile/session')
  @HttpCode(HttpStatus.OK)
  setSessionMode(@Body() dto: SandboxSessionModeDto): Record<string, unknown> {
    try {
      this.sandboxProfile.setSessionMode(dto?.sessionId ?? '', dto?.mode ?? null);
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** GET /sandbox/presets — 内置权限预设 */
  @Get('sandbox/presets')
  presets(): Record<string, unknown> {
    return { success: true, data: { presets: this.sandboxProfile.listPresets() } };
  }


  @Get('sandbox/status')
  status(): Record<string, unknown> {
    return this.sandboxService.getStatus();
  }

  @Post('sandbox/execute')
  @HttpCode(HttpStatus.OK)
  execute(@Body() dto: SandboxExecuteDto): Promise<Record<string, unknown>> {
    return this.sandboxService
      .executeSafe(dto.command ?? '', dto.options)
      .then((r) => r as unknown as Record<string, unknown>);
  }

  @Post('sandbox/validate')
  @HttpCode(HttpStatus.OK)
  validate(@Body() dto: SandboxValidateDto): Record<string, unknown> {
    return this.sandboxService.validateCommand(dto.command ?? '');
  }

  @Get('sandbox/allowed')
  allowed(): Record<string, unknown> {
    return this.sandboxService.getAllowed();
  }

  @Get('sandbox-enhanced')
  enhanced(): Promise<Record<string, unknown>> {
    return Promise.all([this.sandboxEnhancedService.isAvailable(), this.sandboxEnhancedService.isBackendReady()]).then(
      ([available, backendReady]) => ({
        config: this.sandboxEnhancedService.getConfig(),
        available,
        backendReady,
        containers: this.sandboxEnhancedService.listContainers(),
      }),
    );
  }

  @Put('sandbox-enhanced')
  updateConfig(@Body() dto: UpdateSandboxEnhancedDto): Record<string, unknown> {
    return { success: true, config: this.sandboxEnhancedService.updateConfig(dto ?? {}) };
  }

  @Post('sandbox-enhanced/create')
  @HttpCode(HttpStatus.OK)
  create(@Body() dto: CreateSandboxContainerDto): Promise<Record<string, unknown>> {
    return this.sandboxEnhancedService
      .createContainer(dto.sessionKey ?? 'default')
      .then((r) => r as unknown as Record<string, unknown>);
  }

  @Post('sandbox-enhanced/exec')
  @HttpCode(HttpStatus.OK)
  exec(@Body() dto: ExecSandboxContainerDto): Promise<Record<string, unknown>> {
    return this.sandboxEnhancedService
      .execInContainer(dto.containerName, dto.command ?? 'echo hello')
      .then((r) => r as unknown as Record<string, unknown>);
  }

  @Post('sandbox-enhanced/destroy')
  @HttpCode(HttpStatus.OK)
  destroy(@Body() dto: DestroySandboxContainerDto): Promise<Record<string, unknown>> {
    return this.sandboxEnhancedService
      .destroyContainer(dto.containerName)
      .then((r) => r as unknown as Record<string, unknown>);
  }
}
