import { ToolController } from '../../src/modules/tools/tool.controller.js';

describe('manual tool approval', () => {
  function setup(approved: boolean) {
    const executor = {
      execute: jest
        .fn()
        .mockResolvedValueOnce({ success: false, approvalRequired: true })
        .mockResolvedValueOnce({ success: true, output: 'DONE' }),
    };
    const approvals = { requestApproval: jest.fn().mockResolvedValue(approved) };
    const args = [
      executor,
      { get: () => ({ name: 'fixture' }) },
      {},
      { isPathAllowed: () => true, isCommandAllowed: () => true },
      { get: () => ({}), getAll: () => ({}) },
      { info: jest.fn(), debug: jest.fn(), error: jest.fn() },
      approvals,
    ] as unknown as ConstructorParameters<typeof ToolController>;
    return { controller: new ToolController(...args), executor, approvals };
  }
  it('creates an approval and only retries with the server-approved decision', async () => {
    const { controller, executor, approvals } = setup(true);
    expect(
      (await controller.executeTool({ tool: 'fixture', args: {}, sessionId: 'test' })).success,
    ).toBe(true);
    expect(approvals.requestApproval).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: 'fixture', sessionId: 'test' }),
    );
    expect(executor.execute.mock.calls[1]?.[3]).toEqual({ approvalGranted: true });
  });
  it('does not execute again after rejection', async () => {
    const { controller, executor } = setup(false);
    expect((await controller.executeTool({ tool: 'fixture', args: {} })).success).toBe(false);
    expect(executor.execute).toHaveBeenCalledTimes(1);
  });
});
