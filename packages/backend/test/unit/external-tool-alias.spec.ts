import 'reflect-metadata';
import { ToolRegistryService } from '../../src/modules/tools/executor/tool-registry.service';
import { ExternalToolLoaderService } from '../../src/modules/tools/executor/external-tool-loader.service';

it('rejects external aliases of protected builtins without disabling independent tools or implicitly loading legacy packages', async () => {
  const registry = new ToolRegistryService();
  const builtin = {
    name: 'api_call',
    description: 'builtin',
    parameters: {},
    execute: async () => ({ success: true }),
  };
  registry.registerBuiltin(builtin as any);
  const external = {
    name: 'api-call',
    description: 'fixture',
    parameters: {},
    execute: async () => ({ success: true, output: 'actual result' }),
  };
  expect(() => registry.registerOwned('external:conflict', [external as any])).toThrow('conflict');
  expect(registry.get('api_call')).toBe(builtin);
  registry.registerOwned('external:independent', [{ ...external, name: 'independent' } as any]);
  expect(await registry.get('independent')!.execute({}, {} as any)).toMatchObject({
    success: true,
    output: 'actual result',
  });
  expect(await new ExternalToolLoaderService().reloadExternalTools()).toEqual({
    loaded: 0,
    total: 0,
    skippedConflicts: [],
  });
  expect(registry.get('api_call')).toBe(builtin);
});
