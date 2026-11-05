import { describe, it, expect } from 'vitest';
import { PermissionEngine } from '@skyalyticwing/core/permission';

describe('Permission Integration Tests', () => {
  it('should check permission with allow rule', () => {
    const engine = new PermissionEngine('ask', [
      { pattern: 'TestTool', action: 'allow' },
    ]);

    const decision = engine.check({
      tool: 'TestTool',
      input: {},
      agent: 'default',
    });

    expect(decision).toBe('allow');
  });

  it('should deny by rule', () => {
    const engine = new PermissionEngine('ask', [
      { pattern: 'DangerousTool', action: 'deny' },
    ]);

    const decision = engine.check({
      tool: 'DangerousTool',
      input: {},
      agent: 'default',
    });

    expect(decision).toBe('deny');
  });

  it('should fall back to default mode when no rule matches', () => {
    const engine = new PermissionEngine('ask', []);

    const decision = engine.check({
      tool: 'UnknownTool',
      input: {},
      agent: 'default',
    });

    expect(decision).toBe('ask');
  });

  it('should match wildcard pattern', () => {
    const engine = new PermissionEngine('ask', [
      { pattern: '*', action: 'allow' },
    ]);

    const decision = engine.check({
      tool: 'AnyTool',
      input: {},
      agent: 'default',
    });

    expect(decision).toBe('allow');
  });

  it('should allow changing mode', () => {
    const engine = new PermissionEngine('ask');

    expect(engine.check({ tool: 'X', input: {}, agent: 'default' })).toBe('ask');

    engine.setMode('auto');
    expect(engine.check({ tool: 'X', input: {}, agent: 'default' })).toBe('allow');
  });

  it('should add rules dynamically', () => {
    const engine = new PermissionEngine('ask');

    engine.addRule({ pattern: 'NewTool', action: 'deny' });

    const decision = engine.check({
      tool: 'NewTool',
      input: {},
      agent: 'default',
    });

    expect(decision).toBe('deny');
  });
});
