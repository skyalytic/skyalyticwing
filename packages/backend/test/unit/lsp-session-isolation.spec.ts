import 'reflect-metadata';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LspService } from '../../src/modules/tools/lsp/lsp.service';

it('isolates concurrent unsaved language buffers by conversation and account', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wing-lsp-sessions-'));
  const server = join(root, 'server.cjs'), file = join(root, 'main.py');
  writeFileSync(file, 'saved = 1\n');
  writeFileSync(server, `
let buffer=Buffer.alloc(0), text='';
const send=(id,result)=>{const b=Buffer.from(JSON.stringify({jsonrpc:'2.0',id,result}));process.stdout.write(Buffer.concat([Buffer.from('Content-Length: '+b.length+'\\r\\n\\r\\n'),b]));};
process.stdin.on('data',b=>{buffer=Buffer.concat([buffer,b]);for(;;){const end=buffer.indexOf('\\r\\n\\r\\n');if(end<0)return;const length=Number(/Content-Length: (\\d+)/i.exec(buffer.subarray(0,end).toString())[1]);if(buffer.length<end+4+length)return;const m=JSON.parse(buffer.subarray(end+4,end+4+length));buffer=buffer.subarray(end+4+length);
if(m.method==='initialize')send(m.id,{capabilities:{hoverProvider:true}});
else if(m.method==='textDocument/didOpen')text=m.params.textDocument.text;
else if(m.method==='textDocument/didChange')text=m.params.contentChanges[0].text;
else if(m.method==='textDocument/hover')setTimeout(()=>send(m.id,{contents:text}),100);
else if(m.method==='shutdown')send(m.id,null);
else if(m.method==='exit')process.exit(0);
}});`);
  let identity = 'personal';
  const service = new LspService(
    { warn: jest.fn() } as any,
    { isPathAllowed: () => true } as any,
    { getAll: () => ({ lsp: { servers: { python: { command: process.execPath, args: [server] } } } }) } as any,
    { credentialIdentity: () => identity } as any,
  );
  try {
    const values = await Promise.all(['a', 'b'].map(owner => service.query({action:'hover',file,root,text:owner}, undefined, owner)));
    expect(values.map(value => value.contents)).toEqual(['a','b']);
    identity = 'enterprise';
    expect((await service.query({action:'hover',file,root,text:'enterprise'}, undefined, 'a')).contents).toBe('enterprise');
    expect((service as any).clients.size).toBe(3);
  } finally {
    await service.onModuleDestroy();
    rmSync(root,{recursive:true,force:true});
  }
}, 20000);
