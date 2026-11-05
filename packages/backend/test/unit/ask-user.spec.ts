import { EventEmitter2 } from '@nestjs/event-emitter';
import { AskUserService } from '../../src/modules/tools/executor/ask-user.service.js';
import { AskUserController } from '../../src/modules/tools/executor/ask-user.controller.js';

describe('ask_user lifecycle', () => {
  let service: AskUserService;
  let controller: AskUserController;
  let events: EventEmitter2;
  let broadcast: jest.Mock;
  beforeEach(() => {
    events = new EventEmitter2(); broadcast = jest.fn();
    service = new AskUserService(events, {broadcast} as never, {info: jest.fn()} as never);
    controller = new AskUserController(service);
  });
  afterEach(() => { service.onModuleDestroy(); jest.useRealTimers(); });
  it('registers before broadcast, so immediate replies resolve the waiting tool', async () => {
    broadcast.mockImplementation(e => { if (e.type === 'ask_user_request') controller.respond({id:e.data.id,answer:['E:/music.wav']}); });
    await expect(service.askUser({sessionId:'one',question:'BGM path?',options:['provide path']}))
      .resolves.toEqual({answered:true,answer:['E:/music.wav']});
    expect(controller.pending().data).toEqual([]);
  });
  it('keeps independent pending questions across sessions and restores them after five minutes', async () => {
    jest.useFakeTimers();
    const one = service.askUser({sessionId:'one',question:'First'});
    const two = service.askUser({sessionId:'two',question:'Second'});
    jest.advanceTimersByTime(600_000);
    const pending = controller.pending().data;
    expect(pending.map(r=>r.sessionId)).toEqual(['one','two']);
    expect(controller.respond({id:pending[1]!.id,answer:['second']})).toMatchObject({success:true});
    await expect(two).resolves.toEqual({answered:true,answer:['second']});
    expect(service.listPending()).toHaveLength(1);
    controller.respond({id:pending[0]!.id,answer:[]});
    await expect(one).resolves.toMatchObject({answered:false,error:'用户取消了回答'});
    expect(controller.respond({id:pending[0]!.id,answer:['late']})).toMatchObject({success:false});
  });
  it('stop clears the request, resolves the tool and notifies all views', async () => {
    const abort = new AbortController();
    const result = service.askUser({sessionId:'one',question:'Pending'},abort.signal);
    const id = service.listPending()[0]!.id;
    abort.abort();
    await expect(result).resolves.toMatchObject({answered:false,error:'任务已停止'});
    expect(service.listPending()).toEqual([]);
    expect(events.listenerCount('ask_user.response.'+id)).toBe(0);
    expect(broadcast).toHaveBeenLastCalledWith({type:'ask_user_resolved',data:{id,sessionId:'one'}});
  });
});
