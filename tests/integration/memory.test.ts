import { describe, it, expect } from 'vitest';
import { MemoryStore } from '@skyalyticwing/core/memory';

describe('Memory Integration Tests', () => {
  it('should store and retrieve memories', async () => {
    const store = new MemoryStore();

    await store.store('test-agent', 'Hello world', 'fact');

    const result = await store.search('Hello');
    expect(result.entries.length).toBeGreaterThan(0);
    expect(result.entries[0].content).toContain('Hello');
  });

  it('should search memories by agent', async () => {
    const store = new MemoryStore();

    await store.store('agent-1', 'Machine learning basics', 'fact');
    await store.store('agent-2', 'Deep learning advanced', 'fact');

    const result = await store.search('learning', 'agent-1');
    expect(result.entries.every(e => e.agentId === 'agent-1')).toBe(true);
  });

  it('should delete memories', async () => {
    const store = new MemoryStore();

    const entry = await store.store('test-agent', 'To be deleted', 'fact');
    const deleted = await store.delete(entry.id);
    expect(deleted).toBe(true);

    const retrieved = await store.get(entry.id);
    expect(retrieved).toBeUndefined();
  });
});
