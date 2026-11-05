import { createOfficePreset, officeTemplates } from '../../src/modules/tools/files/office-presets';
import { localOfficeFonts, officeFontRoots } from '../../src/modules/tools/files/office-fonts';
import JSZip from 'jszip';

describe('Chinese Office presets', () => {
  it('generates all offered templates as real Office containers with Chinese defaults', async () => {
    for (const t of officeTemplates) {
      const zip = await JSZip.loadAsync(await createOfficePreset(t.format, t.id));
      expect(zip.file('[Content_Types].xml')).not.toBeNull();
      if (t.format === 'docx') expect(await zip.file('word/styles.xml')!.async('string')).toMatch(/eastAsia="(?:Sim|Noto|Songti)/);
      if (t.format === 'pptx') expect(Object.keys(zip.files).filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n))).toHaveLength(t.id === 'blank' ? 1 : 4);
      if (t.id === 'budget') {
        const sheet = await zip.file('xl/worksheets/sheet1.xml')!.async('string');
        expect(sheet).toContain('SUM(D2:D11)'); expect(sheet).toContain('state="frozen"');
        expect(sheet).toContain('autoFilter'); expect(await zip.file('xl/styles.xml')!.async('string')).toContain('charset val="134"');
      }
    }
  });
  it('rejects unknown and mismatched templates, uses optional platform fonts only', async () => {
    await expect(createOfficePreset('docx', 'budget')).rejects.toThrow('模板');
    await expect(createOfficePreset('ppt', 'blank')).rejects.toThrow('模板');
    expect(localOfficeFonts([])).toEqual([]);
    expect(officeFontRoots('darwin')).toContain('/System/Library/Fonts');
    expect(officeFontRoots('linux')).toContain('/usr/share/fonts/truetype/wqy');
  });
});
