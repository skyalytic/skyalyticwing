import { describe, it, expect } from 'vitest';
import { AgentEngine } from '@skyalyticwing/core/agent';
import { loadConfig } from '@skyalyticwing/core/config';

describe('Agent Integration Tests', () => {
  it('should create agent engine', () => {
    const config = loadConfig('./config/default.yaml');
    const engine = new AgentEngine(config);
    expect(engine).toBeDefined();
  });

  it('should resolve default agent', () => {
    const config = loadConfig('./config/default.yaml');
    const engine = new AgentEngine(config);
    const agent = engine.resolveAgent('default');
    expect(agent).toBeDefined();
    expect(agent.id).toBe('default');
  });

  it('should resolve agent without specifying id', () => {
    const config = loadConfig('./config/default.yaml');
    const engine = new AgentEngine(config);
    const agent = engine.resolveAgent();
    expect(agent).toBeDefined();
    expect(agent.id).toBe('default');
  });

  it('should create and list sessions', () => {
    const config = loadConfig('./config/default.yaml');
    const engine = new AgentEngine(config);
    const sessionId = engine.createSession('default');
    expect(sessionId).toBeDefined();
    const sessions = engine.listSessions();
    expect(sessions.length).toBeGreaterThan(0);
  });

  it('should get session by id', () => {
    const config = loadConfig('./config/default.yaml');
    const engine = new AgentEngine(config);
    const sessionId = engine.createSession('default');
    const session = engine.getSession(sessionId);
    expect(session).toBeDefined();
    expect(session?.agentId).toBe('default');
  });

  it('should delete session', () => {
    const config = loadConfig('./config/default.yaml');
    const engine = new AgentEngine(config);
    const sessionId = engine.createSession('default');
    const deleted = engine.deleteSession(sessionId);
    expect(deleted).toBe(true);
    expect(engine.getSession(sessionId)).toBeUndefined();
  });

  it('should throw for non-existent agent', () => {
    const config = loadConfig('./config/default.yaml');
    const engine = new AgentEngine(config);
    // Remove all agents to ensure 'nonexistent' won't fall back to default
    expect(() => engine.resolveAgent('nonexistent')).toThrow();
  });
});
