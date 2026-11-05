import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { mergePdf } from '../../src/modules/tools/files/pdf-merge';
describe('local PDF merge', () => {
  let root: string;
  const security = { isPathAllowed: jest.fn(() => true) };
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'wing-pdf-')); security.isPathAllowed.mockReturnValue(true);
    for (const [name,width] of [['a',100],['b',200]] as const) { const d = await PDFDocument.create(); d.addPage([width,300]); writeFileSync(join(root,name+'.pdf'),await d.save()); }
  });
  afterEach(() => rmSync(root, { recursive:true,force:true }));
  it('preserves page order and dimensions and refuses overwriting', async () => {
    const r=await mergePdf(security as never,root,['b.pdf','a.pdf'],'out.pdf'); expect(r.pages).toBe(2);
    const doc=await PDFDocument.load(readFileSync(r.file));expect(doc.getPages().map(p=>p.getWidth())).toEqual([200,100]);
    await expect(mergePdf(security as never,root,['a.pdf','b.pdf'],'a.pdf')).rejects.toThrow('已存在');
  });
  it('denies unapproved reads/writes and leaves no output after parse failure', async () => {
    security.isPathAllowed.mockReturnValue(false);
    await expect(mergePdf(security as never,root,['a.pdf','b.pdf'],'out.pdf')).rejects.toThrow('权限');
    security.isPathAllowed.mockReturnValue(true);writeFileSync(join(root,'a.pdf'),'invalid');
    await expect(mergePdf(security as never,root,['a.pdf','b.pdf'],'out.pdf')).rejects.toThrow();expect(existsSync(join(root,'out.pdf'))).toBe(false);
  });
});
