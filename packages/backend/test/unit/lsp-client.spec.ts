import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LspClient } from '../../src/modules/tools/lsp/lsp-client';
describe('stdio language server transport', () => {
  let root: string, client: LspClient;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'wing-lsp-wire-'));
    const file = join(root, 'server.cjs');
    writeFileSync(
      file,
      `let buf=Buffer.alloc(0); const send=m=>{const body=Buffer.from(JSON.stringify({jsonrpc:'2.0',...m}));const frame=Buffer.concat([Buffer.from('Content-Length: '+body.length+'\\r\\n\\r\\n'),body]);process.stdout.write(frame.subarray(0,9));process.stdout.write(frame.subarray(9));};process.stdin.on('data',b=>{buf=Buffer.concat([buf,b]);for(;;){const end=buf.indexOf('\\r\\n\\r\\n');if(end<0)return;const n=Number(/Content-Length: (\\d+)/i.exec(buf.subarray(0,end).toString())[1]);if(buf.length<end+4+n)return;const m=JSON.parse(buf.subarray(end+4,end+4+n));buf=buf.subarray(end+4+n);if(m.method==='initialize')send({id:m.id,result:{capabilities:{positionEncoding:'utf-16',hoverProvider:true}}});else if(m.method==='textDocument/hover')send({id:m.id,result:{contents:'中文 hover'}});else if(m.method==='shutdown')send({id:m.id,result:null});else if(m.method==='crash')process.exit(7);else if(m.method==='exit')process.exit(0);}});`,
    );
    client = new LspClient(process.execPath, [file], pathToFileURL(root).href, root);
  });
  afterEach(async () => {
    await client.close();
    rmSync(root, { recursive: true, force: true });
  });
  it('initializes and reads fragmented UTF-8 framed responses', async () => {
    await client.initialize();
    expect(await client.request('textDocument/hover', {})).toEqual({ contents: '中文 hover' });
  });
  it('cancels pending requests and remains usable', async () => {
    await client.initialize();
    const controller = new AbortController();
    const pending = client.request('hang', {}, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow('cancelled');
    expect(await client.request('textDocument/hover', {})).toEqual({ contents: '中文 hover' });
  });
  it('rejects requests when the server crashes', async () => {
    await client.initialize();
    await expect(client.request('crash', {})).rejects.toThrow('exited');
    expect(client.alive).toBe(false);
  });
});
