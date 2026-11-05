import { UpdateMaintenance } from '../../src/modules/core/system/update-maintenance';
import { EventEmitter } from 'node:events';
const id = 'update-request-12345678';
describe('update admission and draining', () => {
  it('waits for existing tasks, admits their tools, rejects new work, and freezes only after completion', () => {
    const gate = new UpdateMaintenance();
    const finish = gate.enter('AI', 'session');
    expect(gate.begin(id).blockers).toEqual(['AI']);
    expect(() => gate.enter('new AI', 'another')).toThrow();
    const finishTool = gate.enter('tool', 'session', true);
    expect(() => gate.freeze(id)).toThrow();
    finishTool(); finish();
    expect(gate.freeze(id)).toEqual({ready:true});
    expect(() => gate.enter('tool', 'session', true)).toThrow();
    gate.cancel(id);
    expect(() => gate.enter('next')()).not.toThrow();
  });
  it('existing workflow continuation survives draining, but detached work cannot reuse expired activity', async () => {
    const gate = new UpdateMaintenance();
    await gate.run('workflow', async () => {
      gate.begin(id);
      await Promise.resolve();
      const done = gate.enter('child agent'); done();
    });
    expect(gate.status(id).blockers).toEqual([]);
    expect(() => gate.enter('new workflow')).toThrow();
  });
  it('keeps terminal and asynchronous file writers as blockers', () => {
    const gate = new UpdateMaintenance(); let active = 1;
    gate.register('file save', () => active);
    gate.begin(id); expect(() => gate.freeze(id)).toThrow('file save');
    active = 0; expect(gate.freeze(id).ready).toBe(true);
  });
  it('failed/missing heartbeat releases the barrier and stale owners cannot cancel newer work', () => {
    jest.useFakeTimers();
    try {
      const gate = new UpdateMaintenance(); gate.begin(id);
      jest.advanceTimersByTime(120_001);
      expect(() => gate.enter('new')()).not.toThrow();
      gate.begin(id+'new'); gate.cancel(id);
      expect(() => gate.enter('new')).toThrow();
      expect(() => gate.freeze(id)).toThrow();
    } finally { jest.useRealTimers(); }
  });
  it('allows document flush while draining, tracks in-flight writes, and blocks writes after freeze', () => {
    const gate = new UpdateMaintenance(); gate.begin(id);
    const res = Object.assign(new EventEmitter(), {status: jest.fn().mockReturnThis(),json:jest.fn()});
    const next = jest.fn();
    gate.middleware({path:'/api/files/write',method:'POST'} as any,res as any,next);
    expect(next).toHaveBeenCalledTimes(1); expect(() => gate.freeze(id)).toThrow();
    res.emit('finish'); gate.freeze(id);
    gate.middleware({path:'/api/files/write',method:'POST'} as any,res as any,next);
    expect(res.status).toHaveBeenCalledWith(503); expect(next).toHaveBeenCalledTimes(1);
  });
});
