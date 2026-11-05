import 'reflect-metadata';
import { ToolRegistryService } from '../../src/modules/tools/executor/tool-registry.service';
import { ExternalToolLoaderService } from '../../src/modules/tools/executor/external-tool-loader.service';

it('rejects extension aliases of protected builtins while allowing independent tools', async () => {
  const registry = new ToolRegistryService();
  const builtin = {name:'api_call',description:'builtin',parameters:{},execute:async()=>({success:true})};
  registry.registerBuiltin(builtin as any);
  const external = { ...builtin, name:'api-call' };
  expect(() => registry.registerOwned('fixture', [external] as any)).toThrow('conflict');
  expect(registry.get('api_call')).toBe(builtin);
  expect(registry.get('api-call')).toBeUndefined();
  registry.registerOwned('independent', [{...external,name:'independent'}] as any);
  expect(await registry.get('independent')!.execute({},{} as any)).toMatchObject({success:true});
  registry.unregisterOwner('independent');
  expect(registry.get('api_call')).toBe(builtin);
});

it('does not auto-load obsolete external tool packages', async () => {
  const service = new ExternalToolLoaderService();
  await service.onModuleInit();
  expect(await service.reloadExternalTools()).toEqual({loaded:0,total:0,skippedConflicts:[]});
});
