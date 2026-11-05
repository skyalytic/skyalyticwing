import { Injectable, OnModuleDestroy, Optional } from '@nestjs/common';
import type { ToolResult } from '@skyalyticwing/shared';
import { UiaService } from './uia.service.js';
import { ToolRegistryService } from '../tools/executor/tool-registry.service.js';
import { ConfigService } from '../core/config/config.service.js';
import type { DesktopControlService as Runtime, DesktopRequest } from '../../extensions/bundled/computer-use/runtime/desktop-control.service.js';
export type { DesktopRequest } from '../../extensions/bundled/computer-use/runtime/desktop-control.service.js';
/** Core owns the local stop/control endpoint. The installed package owns the driver and workflow. */
@Injectable()
export class DesktopControlService implements OnModuleDestroy {
  private runtime: Runtime | undefined;
  private paused = false;
  constructor(private readonly uia: UiaService, private readonly registry: ToolRegistryService, @Optional() _config?: ConfigService) {}
  status(): ReturnType<Runtime['status']> {
    return this.runtime?.status() || { phase: 'idle', active: false, updatedAt: Date.now(), inputMode: 'physical' as const,
      platform: process.platform, paused: this.paused, available: this.registry.has('computer_use') || this.registry.has('node_repl'),
      visualAvailable: this.registry.has('computer_use') || this.registry.has('node_repl'), queued: 0, requiresObservation: true };
  }
  pause() { this.paused = true; return this.runtime?.pause() || this.status(); }
  resume() { this.paused = false; return this.runtime?.resume() || this.status(); }
  stop() { this.paused = true; return this.runtime?.stop() || this.status(); }
  async execute(sessionId: string, request: DesktopRequest): Promise<ToolResult> {
    if (!this.registry.has('computer_use')) return { success: false, error: 'computer_use is not installed' };
    this.ensureRuntime();
    return this.runtime!.execute(sessionId, request);
  }
  private ensureRuntime(): void {
    if (!this.runtime) {
      const { DesktopControlService: RuntimeClass } = require('../../extensions/bundled/computer-use/runtime/desktop-control.service.js') as typeof import('../../extensions/bundled/computer-use/runtime/desktop-control.service.js');
      const { VisualDesktopDriver } = require('../../extensions/bundled/computer-use/runtime/visual-desktop-driver.js') as typeof import('../../extensions/bundled/computer-use/runtime/visual-desktop-driver.js');
      this.runtime = new RuntimeClass(this.uia, new VisualDesktopDriver());
      // Old persisted virtual preferences have no effect on this real-input runtime.
      if (this.paused) this.runtime.pause();
    }

  }
  async skyCall(sessionId: string, method: string, args: Record<string, unknown>, image: (value: Record<string, any>) => void): Promise<unknown> {
    if (!this.registry.has('node_repl')) throw new Error('Computer Use JavaScript runtime is not installed');
    this.ensureRuntime(); return this.runtime!.skyCall(sessionId, method, args, image);
  }
  invalidateSky(sessionId: string, preserveWindows = false): void { this.runtime?.invalidateSky(sessionId, preserveWindows); }
  release(): void { this.runtime?.stop(); this.runtime?.onModuleDestroy(); this.runtime = undefined; }
  onModuleDestroy(): void { this.release(); }
}
