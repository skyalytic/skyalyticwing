import { createSystemTools } from '../../src/modules/tools/executor/built-in/system';

describe('environment tool credential and runtime boundary', () => {
  const tools = createSystemTools(() => undefined);
  it.each(['OPENAI_API_KEY','DASHSCOPE_API_KEY','WING_ACCESS_TOKEN','CUSTOM_PASSWORD','CLIENT_SECRET','PYTHONPATH','NODE_PATH','COMSPEC'])(
    'blocks reads and changes to %s without exposing the value', async name => {
      const previous=process.env[name];process.env[name]='synthetic-sensitive-fixture';
      try {
        for(const toolName of ['env_get','env_set']) {
          const result=await tools.find(t=>t.name===toolName)!.execute({name,value:'replacement'},{} as never);
          expect(result.success).toBe(false);expect(JSON.stringify(result)).not.toContain('synthetic-sensitive-fixture');
          expect(process.env[name]).toBe('synthetic-sensitive-fixture');
        }
      } finally {if(previous===undefined)delete process.env[name];else process.env[name]=previous;}
    },
  );
  it('preserves ordinary process-local settings',async()=>{
    const name='WING_TOOL_TEST_LABEL',previous=process.env[name];
    try {
      expect((await tools.find(t=>t.name==='env_set')!.execute({name,value:'office'},{} as never)).success).toBe(true);
      expect((await tools.find(t=>t.name==='env_get')!.execute({name},{} as never)).data).toMatchObject({value:'office'});
    } finally {if(previous===undefined)delete process.env[name];else process.env[name]=previous;}
  });
});
