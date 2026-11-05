import { describe, it, expect } from 'vitest';
import { ChannelRegistry, BaseChannel } from '@skyalyticwing/core/channel';

class TestChannel extends BaseChannel {
  readonly id = 'test-channel';
  readonly name = 'Test Channel';
  readonly icon = 'test';

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async sendMessage(): Promise<void> {}
}

describe('Channel Integration Tests', () => {
  it('should register channel', () => {
    const registry = new ChannelRegistry();
    const channel = new TestChannel();

    registry.register(channel);

    const found = registry.get('test-channel');
    expect(found).toBeDefined();
    expect(found?.id).toBe('test-channel');
  });

  it('should list all channels', () => {
    const registry = new ChannelRegistry();
    const channels = registry.list();
    expect(Array.isArray(channels)).toBe(true);
  });

  it('should unregister channel', () => {
    const registry = new ChannelRegistry();
    const channel = new TestChannel();

    registry.register(channel);
    registry.unregister('test-channel');

    const found = registry.get('test-channel');
    expect(found).toBeUndefined();
  });
});
