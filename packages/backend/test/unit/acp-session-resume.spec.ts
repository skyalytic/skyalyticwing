import 'reflect-metadata';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AcpSessionService } from '../../src/modules/ai/acp/acp-session.service';

describe('ACP control-plane resume', () => {
  const service = () => new AcpSessionService({ info() {}, warn() {}, error() {} } as never, new EventEmitter2(), {} as never);
  it('reopens a retained closed session with its original options', () => {
    const sessions = service();
    sessions.initializeSession({ sessionId: 'fixture', runtimeOptions: { model: 'fixture-model' } });
    sessions.closeSession({ sessionId: 'fixture' });
    expect(sessions.getSession('fixture')?.status).toBe('closed');
    expect(sessions.resumeSession('fixture').success).toBe(true);
    expect(sessions.getSession('fixture')).toMatchObject({ status: 'idle', runtimeOptions: { model: 'fixture-model' } });
    expect(sessions.getSession('fixture')?.closedAt).toBeUndefined();
  });
  it('rejects an unknown session', () => {
    expect(service().resumeSession('missing').success).toBe(false);
  });
});
