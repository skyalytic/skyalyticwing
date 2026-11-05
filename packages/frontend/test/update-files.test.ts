import { describe, it, expect, vi } from 'vitest';
import { prepareAllFilesForUpdate, registerFileCloseGuard, registerPendingDraftCheck } from '../src/components/project/file-tab-lifecycle';
describe('update document preparation', () => {
  it('waits for all mounted editors including hidden tabs', async () => {
    const saves: string[]=[];
    const one=registerFileCloseGuard('one',async()=>{await Promise.resolve(); saves.push('one');});
    const two=registerFileCloseGuard('two',async()=>{saves.push('two');});
    try { await prepareAllFilesForUpdate(); expect(saves).toEqual(['one','two']); } finally {one();two();}
  });
  it('save failure prevents installation and names the affected document', async () => {
    const clear=registerFileCloseGuard('report.docx',async()=>{throw Error('write failed');});
    try { await expect(prepareAllFilesForUpdate()).rejects.toThrow('report.docx: write failed'); } finally {clear();}
  });
  it('detects an unmounted failed draft and existing unsaved-content guards', async () => {
    let pending=true; registerPendingDraftCheck(()=>pending);
    await expect(prepareAllFilesForUpdate()).rejects.toThrow('草稿'); pending=false;
    const guard=vi.fn((e:Event)=>e.preventDefault()); window.addEventListener('beforeunload',guard);
    try { await expect(prepareAllFilesForUpdate()).rejects.toThrow('未保存'); } finally {window.removeEventListener('beforeunload',guard);}
    await expect(prepareAllFilesForUpdate()).resolves.toBeUndefined();
  });
});
