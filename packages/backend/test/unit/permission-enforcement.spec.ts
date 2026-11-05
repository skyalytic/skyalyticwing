import 'reflect-metadata';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ToolController } from '../../src/modules/tools/tool.controller.js';
import { ToolExecutorService } from '../../src/modules/tools/executor/tool-executor.service.js';
import { ToolRegistryService } from '../../src/modules/tools/executor/tool-registry.service.js';
import { ApprovalService } from '../../src/modules/tools/executor/approval.service.js';
import { ApprovalController } from '../../src/modules/core/security/approval.controller.js';
import { PermissionController } from '../../src/modules/core/security/permission.controller.js';
import { AgentLoopService } from '../../src/modules/ai/agent/agent-loop.service.js';
import { YoloClassifierService } from '../../src/modules/tools/executor/yolo-classifier.service.js';

function setup() {
  const state: { security: any; tools: any; [key: string]: any } = { security: { yolo: 'ask' }, tools: {} };
  const config = { get: (s: string) => state[s] || {}, getAll: () => state,
    set: (s: string, v: unknown) => { state[s] = v; }, save: jest.fn() };
  const log = { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const ws = { broadcast: jest.fn() }, events = new EventEmitter2();
  const guard = { isCommandBlacklisted: jest.fn(() => false), isCommandWhitelisted: jest.fn(() => false), addCommandRule: jest.fn() };
  const security = { isPathAllowed: () => true, isCommandAllowed: () => true, getCommandGuard: () => guard };
  const registry = new ToolRegistryService();
  const effect = jest.fn(async () => ({ success: true, output: 'executed' }));
  registry.registerBuiltin({ name: 'fixture', category: 'test', description: 'fixture', parameters: { type: 'object', properties: {} }, dangerous: true, execute: effect });
  const executor = new ToolExecutorService(registry, security as never, {} as never, ws as never, log as never, config as never, {} as never);
  const approvals = new ApprovalService(events, ws as never, log as never, guard as never, config as never);
  const controller = new ToolController(executor, registry, {} as never, security as never, config as never, log as never, approvals);
  const classifier = new YoloClassifierService();
  const modes = new PermissionController(security as never, guard as never, classifier, approvals, config as never, log as never);
  const replies = new ApprovalController(approvals, config as never, log as never);
  const agent: any = Object.create(AgentLoopService.prototype);
  Object.assign(agent, { config, commandGuard: guard, yoloClassifier: classifier, toolPolicy: { checkTool: () => null }, toolExecutor: executor });
  const set = (permission: string, disabled = false) => controller.setToolPermission({ toolId: 'fixture', permission, disabled });
  const execute = () => controller.executeTool({ tool: 'fixture', args: {}, sessionId: 'permission-fixture' });
  const request = (id: string, toolName = 'fixture') => ({ id, toolName, args: {}, sessionId: 'permission-fixture', timestamp: Date.now(), reason: 'fixture' });
  return { state, config, controller, approvals, modes, replies, agent, effect, ws, guard, set, execute, request };
}

describe('permissions from configuration through actual tool dispatch', () => {
  it.each(['ask', 'auto', 'yolo'])('auto/legacy allow execute and disabled blocks in %s mode, including AI gate', async mode => {
    const f = setup(); f.modes.switchMode({ mode: mode as any });
    for (const value of ['auto', 'allow']) {
      expect(f.set(value).success).toBe(true);
      expect(f.state.tools.toolSettings.fixture.permission).toBe('auto');
      expect(f.agent.checkToolGate('fixture', {}).action).toBe('pass');
      expect((await f.execute()).success).toBe(true);
    }
    expect(f.effect).toHaveBeenCalledTimes(2);
    f.set('auto', true);
    expect((await f.execute()).success).toBe(false);
    expect(f.agent.checkToolGate('fixture', {}).action).toBe('reject');
    expect(f.agent.getToolPermission('fixture')).toBe('disabled');
    expect(f.effect).toHaveBeenCalledTimes(2);
  });
  it('full access bypasses ask; returning to manual requires a decision before execution', async () => {
    const f = setup(); f.set('ask'); f.modes.switchMode({ mode: 'yolo' });
    expect(f.agent.checkToolGate('fixture', {}).action).toBe('pass');
    expect((await f.execute()).success).toBe(true);
    expect(f.approvals.getPendingApprovals()).toHaveLength(0);
    f.modes.switchMode({ mode: 'ask' });
    expect(f.agent.checkToolGate('fixture', {}).action).toBe('ask');
    const waiting = f.execute(); await new Promise(resolve => setImmediate(resolve));
    expect(f.effect).toHaveBeenCalledTimes(1);
    const pending = f.approvals.getPendingApprovals(); expect(pending).toHaveLength(1);
    f.replies.processApproval(pending[0]!.id, { decision: 'allow-once' });
    expect((await waiting).success).toBe(true); expect(f.effect).toHaveBeenCalledTimes(2);
  });
  it('switching to full access releases pending requests, but never re-enables a disabled tool', async () => {
    const f = setup();
    const allowed = f.approvals.requestApproval(f.request('allowed'));
    const banned = f.approvals.requestApproval(f.request('banned', 'other'));
    f.state.tools.toolSettings = { other: { disabled: true } };
    expect(f.modes.switchMode({ mode: 'yolo' }).success).toBe(true);
    await expect(allowed).resolves.toBe(true); await expect(banned).resolves.toBe(false);
    expect(f.approvals.getPendingApprovals()).toHaveLength(0);
    await expect(f.approvals.requestApproval(f.request('again', 'other'))).resolves.toBe(false);
  });
  it('does not approve pending calls or change live permissions when mode saving fails', async () => {
    const f = setup(), waiting = f.approvals.requestApproval(f.request('save-failure'));
    f.config.save.mockImplementation(() => { throw Error('disk full'); });
    expect(f.modes.switchMode({ mode: 'yolo' }).success).toBe(false);
    expect(f.state.security.yolo).toBe('ask'); expect(f.approvals.getPendingApprovals()).toHaveLength(1);
    f.approvals.cancelApproval('save-failure'); await waiting;
  });
  it('rolls back failed per-tool saves and rejects unknown permission values', () => {
    const f = setup(); f.set('ask');
    f.config.save.mockImplementation(() => { throw Error('disk full'); });
    expect(f.set('auto').success).toBe(false); expect(f.state.tools.toolSettings.fixture.permission).toBe('ask');
    expect(f.set('anything').success).toBe(false);
  });
  it('keeps permission rules unchanged if their update cannot be saved', () => {
    const f = setup();
    f.state.security.permissionRules = [{ id: 'manual', type: 'ask', tool: 'fixture' }];
    f.config.save.mockImplementation(() => { throw Error('disk full'); });
    expect(f.modes.changePermissionRule({ id: 'manual', type: 'allow' }).success).toBe(false);
    expect(f.state.security.permissionRules[0].type).toBe('ask');
  });
  it('rechecks disabling while approval is pending, even if the user approves an old prompt', async () => {
    const f = setup(); f.set('ask');
    const waiting = f.execute(); await new Promise(resolve => setImmediate(resolve));
    const [pending] = f.approvals.getPendingApprovals(); expect(pending).toBeDefined();
    f.set('auto', true); f.replies.processApproval(pending!.id, { decision: 'allow-once' });
    expect((await waiting).success).toBe(false); expect(f.effect).not.toHaveBeenCalled();
  });
  it('REST always-allow persists only the selected command, matching the WebSocket decision path', async () => {
    const f = setup();
    const waiting = f.approvals.requestApproval({ ...f.request('command', 'powershell'), args: { command: 'git status' } });
    f.replies.processApproval('command', { decision: 'allow-always' }); await waiting;
    expect(f.guard.addCommandRule).toHaveBeenCalledWith('allow', expect.stringContaining('git'), expect.any(String));
    expect(f.state.security.permissionRules).toBeUndefined();
    expect(f.state.tools.toolSettings?.powershell).toBeUndefined();
    expect(f.agent.checkToolGate('powershell', { command: 'npm install unrelated' }).action).toBe('ask');
  });
  it('does not expand historical automatic command rules, while manual deny rules still apply', () => {
    const f = setup();
    f.state.security.permissionRules = [{ id: 'perm-auto-old', tool: 'powershell', type: 'allow' }];
    expect(f.agent.checkToolGate('powershell', { command: 'npm install unrelated' }).action).toBe('ask');
    f.state.security.yolo = 'yolo'; f.state.security.permissionRules.push({ id: 'manual', tool: 'powershell', type: 'deny' });
    expect(f.agent.checkToolGate('powershell', { command: 'git status' }).action).toBe('reject');
  });
  it('changing a tool to ask supersedes the redundant historical approval record', () => {
    const f = setup();
    f.state.security.permissionRules = [{ id: 'perm-auto-old', tool: 'fixture', type: 'allow' }];
    f.set('ask'); expect(f.agent.checkToolGate('fixture', {}).action).toBe('ask');
  });
});
