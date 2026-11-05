import 'reflect-metadata';
import { DesktopControlService } from '../../src/modules/automation/desktop-control.service';
import { ConfigService } from '../../src/modules/core/config/config.service';
describe('real input migration', () => {
  it.each([undefined, 'virtual', 'physical'])('ignores obsolete saved mode %s while keeping lazy tool loading', saved => {
    const config = new ConfigService(); config.set('desktopControl', { inputMode: saved, retained: true });
    const service = new DesktopControlService({ dispose() {}, isAvailable: () => true } as any, { has: () => true } as any, config);
    try {
      expect(service.status()).toMatchObject({ active: false, inputMode: 'physical' });
      expect((service as any).runtime).toBeUndefined();
      (service as any).ensureRuntime();
      expect(service.status().inputMode).toBe('physical');
      expect(config.getAll()['desktopControl']).toEqual({ inputMode: saved, retained: true });
    } finally { service.onModuleDestroy(); }
  });
});
