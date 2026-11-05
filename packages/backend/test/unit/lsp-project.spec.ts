import 'reflect-metadata';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LspService } from '../../src/modules/tools/lsp/lsp.service';

describe('real project language services', () => {
  let root: string, service: LspService, file: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'wing-lsp-'));
    writeFileSync(
      join(root, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: { strict: true, target: 'ES2022', module: 'commonjs', types: [] },
        include: ['*.ts'],
      }),
    );
    writeFileSync(
      join(root, 'math.ts'),
      'export function add(a: number, b: number): number { return a + b; }\n',
    );
    file = join(root, 'main.ts');
    writeFileSync(
      file,
      "import { add } from './math';\nexport const result: number = add(1, 2);\n",
    );
    service = new LspService({ warn: jest.fn() } as any, { isPathAllowed: () => true } as any);
  });
  afterEach(async () => {
    await service.onModuleDestroy();
    rmSync(root, { recursive: true, force: true });
  });
  it('resolves definitions/references across files and reports actual semantic errors', async () => {
    const defs = await service.query({ action: 'definition', file, line: 2, col: 31 });
    expect(defs.some((d: any) => d.file === join(root, 'math.ts'))).toBe(true);
    const refs = await service.query({ action: 'references', file, line: 2, col: 31 });
    expect(new Set(refs.map((d: any) => d.file)).size).toBe(2);
    writeFileSync(
      file,
      "import { add } from './math';\nexport const result: number = add('bad', 2);\n",
    );
    const diagnostics = await service.query({ action: 'projectDiagnostics', file });
    expect(
      diagnostics.diagnostics.some((d: any) => d.code === 2345 && d.severity === 'error'),
    ).toBe(true);
  });
  it('renames a symbol across files, applies only to the originating session, and rejects stale writes', async () => {
    const preview = await service.query(
      { action: 'rename', file: join(root, 'math.ts'), line: 1, col: 18, newName: 'sum' },
      undefined,
      'session-a',
    );
    expect(preview.files).toHaveLength(2);
    await expect(service.apply(preview.id, 'session-b')).rejects.toThrow('another session');
    writeFileSync(file, readFileSync(file, 'utf8') + '// concurrent edit\n');
    await expect(service.apply(preview.id, 'session-a')).rejects.toThrow('changed since preview');
    expect(readFileSync(join(root, 'math.ts'), 'utf8')).toContain('function add');
    const fresh = await service.query(
      { action: 'rename', file: join(root, 'math.ts'), line: 1, col: 18, newName: 'sum' },
      undefined,
      'session-a',
    );
    await service.apply(fresh.id, 'session-a');
    expect(readFileSync(file, 'utf8')).toContain('sum(1, 2)');
    expect(readFileSync(join(root, 'math.ts'), 'utf8')).toContain('function sum');
    expect((await service.getDiagnostics(file)).diagnostics).toHaveLength(0);
  });
  it('supports hover/completion/symbols/signatures and never writes unsaved overlays', async () => {
    expect((await service.query({ action: 'hover', file, line: 2, col: 31 })).contents).toContain(
      'add',
    );
    expect((await service.query({ action: 'symbols', file })).childItems.length).toBeGreaterThan(0);
    expect(
      (await service.query({ action: 'completion', file, line: 2, col: 30 })).entries.length,
    ).toBeGreaterThan(0);
    expect(
      (await service.query({ action: 'signature', file, line: 2, col: 36 })).items.length,
    ).toBeGreaterThan(0);
    await expect(
      service.query({ action: 'format', file, text: 'const unsaved=1;' }),
    ).rejects.toThrow('Save the buffer');
  });
  it('reports an unavailable external server honestly', async () => {
    const py = join(root, 'main.py');
    writeFileSync(py, 'x=1\n');
    service = new LspService(
      { warn: jest.fn() } as any,
      { isPathAllowed: () => true } as any,
      {
        getAll: () => ({
          lsp: { servers: { python: { command: 'wing-missing-language-server', args: [] } } },
        }),
      } as any,
    );
    const result = await service.getDiagnostics(py);
    expect(result.serverAvailable).toBe(false);
    expect(result.error).toContain('unavailable');
  });
  it('persists a preview across CLI-owned backend restarts and applies import cleanup', async()=>{
    writeFileSync(file,"import { add } from './math';\nexport const value = 1;\n");
    const preview=await service.query({action:'organizeImports',file},undefined,'restart-session');
    expect(preview.files).toHaveLength(1);
    await service.onModuleDestroy();
    service=new LspService({warn:jest.fn()} as any,{isPathAllowed:()=>true} as any);
    await service.apply(preview.id,'restart-session');
    expect(readFileSync(file,'utf8')).not.toContain('import');
    await expect(service.apply(preview.id,'restart-session')).rejects.toThrow('expired');
  });
  it('offers an actual compiler code action for a missing cross-file import',async()=>{
    writeFileSync(file,'export const value = add(1,2);\n');
    const actions=await service.query({action:'codeActions',file,line:1,col:22},undefined,'fix-session');
    const fix=actions.find((a:any)=>a.preview.files.some((f:any)=>f.after.includes('import')));
    expect(fix).toBeDefined();
    await service.apply(fix.preview.id,'fix-session');
    expect((await service.getDiagnostics(file)).diagnostics).toHaveLength(0);
  });
});
