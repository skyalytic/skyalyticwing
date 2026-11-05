import { Global, Module } from '@nestjs/common';
import { SESSION_SERVICE } from '../ai/types.js';
import { SessionService } from './session.service.js';
import { SessionRestoreService } from './session-restore.service.js';
import { SessionSnapshotService } from './session-snapshot.service.js';
import { LifecycleService } from './lifecycle.service.js';
import { DoomLoopDetectorService } from './doom-loop-detector.service.js';
import { SessionController } from './session.controller.js';
import { LifecycleController } from './lifecycle.controller.js';

/**
 * SessionModule - 会话域模块
 *
 * 提供并导出 SessionService / SessionRestoreService / SessionSnapshotService /
 * LifecycleService / DoomLoopDetectorService。
 *
 * LifecycleService 通过构造注入依赖 DoomLoopDetectorService，因此本模块需将其
 * 注册为 provider。同时通过 SESSION_SERVICE token（与 ai/types.ts 中 ChatService
 * 注入的同一 token）将 SessionService 暴露给 AI 域，使用 useExisting 确保同一实例。
 *
 * Controllers:
 *   - SessionController: /api/sessions/*
 *   - LifecycleController: /api/lifecycle/diagnostics、/api/lifecycle/heartbeat
 */
@Global()
@Module({
  providers: [
    SessionService,
    SessionRestoreService,
    SessionSnapshotService,
    LifecycleService,
    DoomLoopDetectorService,
    {
      provide: SESSION_SERVICE,
      useExisting: SessionService,
    },
  ],
  controllers: [SessionController, LifecycleController],
  exports: [
    SessionService,
    SessionRestoreService,
    SessionSnapshotService,
    LifecycleService,
    DoomLoopDetectorService,
    SESSION_SERVICE,
  ],
})
export class SessionModule {}
