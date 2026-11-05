import 'reflect-metadata';
import { SessionController } from '../../src/modules/session/session.controller.js';

describe('session mutation acknowledgement durability', () => {
  it('does not acknowledge creation before the persistent snapshot is committed', async () => {
    let finish!: () => void;
    const persisted = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const service = {
      createSession: jest.fn().mockReturnValue({ id: 'fixture' }),
      flush: jest.fn().mockReturnValue(persisted),
    };
    const controller = new SessionController(service as never, {} as never);
    let acknowledged = false;
    const response = controller.create({ title: 'test' }).then((result) => {
      acknowledged = true;
      return result;
    });
    await Promise.resolve();
    expect(acknowledged).toBe(false);
    finish();
    await expect(response).resolves.toEqual({ success: true, data: { id: 'fixture' } });
  });
  it('propagates persistence failure instead of acknowledging a durable session', async () => {
    const controller = new SessionController(
      {
        createSession: () => ({ id: 'fixture' }),
        flush: async () => {
          throw new Error('disk full');
        },
      } as never,
      {} as never,
    );
    await expect(controller.create({ title: 'test' })).rejects.toThrow('disk full');
  });
});
