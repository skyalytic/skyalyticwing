import 'reflect-metadata';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import { OfficeService } from '../../src/modules/tools/files/office.service';
import { createDocTools } from '../../src/modules/tools/executor/built-in/doc-tools';
import { visualObservation } from '../../src/modules/ai/agent/visual-observation';

describe('Office generation and in-place editing', () => {
  let root: string;
  const prior = process.env['SKYALYTICWING_DATA_DIR'];
  const security = { isPathAllowed: jest.fn(() => true) };
  const service = new OfficeService(security as never);
  const tool = createDocTools(security as never)[0]!;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'wing-office-'));
    process.env['SKYALYTICWING_DATA_DIR'] = root;
    security.isPathAllowed.mockReturnValue(true);
  });
  afterEach(() => {
    if (prior === undefined) delete process.env['SKYALYTICWING_DATA_DIR'];
    else process.env['SKYALYTICWING_DATA_DIR'] = prior;
    rmSync(root, { recursive: true, force: true });
  });
  it.each(['docx', 'xlsx'])(
    'generates real %s, edits content, preserves unrelated ZIP members and detects stale saves',
    async (format) => {
      const file = join(root, 'demo.' + format);
      const result = await tool.execute(
        {
          format,
          title: 'Wing & 办公',
          sections: [
            {
              heading: '报告',
              content: '可编辑正文',
              rows: [
                ['名称', '值'],
                ['销售', 73],
              ],
            },
            { heading: '报告', rows: [['第二页', 42]] },
          ],
          outputPath: file,
        },
        { workspace: root } as never,
      );
      expect(result.success).toBe(true);
      const before = await JSZip.loadAsync(readFileSync(file));
      const snapshot = await service.read(file);
      expect(snapshot.sections.flatMap((s) => s.fields).some((f) => f.value === '73')).toBe(true);
      const field = snapshot.sections.flatMap((s) => s.fields).find((f) => f.value === '73')!;
      const saved = await service.save(file, snapshot.revision, [{ id: field.id, value: '85' }]);
      expect(saved.revision).not.toBe(snapshot.revision);
      const next = await service.read(file);
      expect(next.sections.flatMap((s) => s.fields).find((f) => f.id === field.id)?.value).toBe(
        '85',
      );
      await expect(
        service.save(file, snapshot.revision, [{ id: field.id, value: '99' }]),
      ).rejects.toThrow('修改');
      const after = await JSZip.loadAsync(readFileSync(file));
      expect(await before.file('[Content_Types].xml')!.async('string')).toEqual(
        await after.file('[Content_Types].xml')!.async('string'),
      );
      if (format === 'xlsx') {
        expect(snapshot.sections).toHaveLength(2);
        expect(snapshot.sections[0]!.fields[0]!.value).toBe('名称');
      }
      if (format === 'pptx') expect(snapshot.sections[0]!.fields[0]!.value).toBe('Wing & 办公');
    },
  );
  it('rejects denied paths, format mismatches and malformed updates without overwriting bytes', async () => {
    const file = join(root, 'bad.docx');
    expect(
      (
        await tool.execute({ format: 'pptx', title: 'x', content: 'x', outputPath: file }, {
          workspace: root,
        } as never)
      ).success,
    ).toBe(false);
    writeFileSync(file, 'not-a-zip');
    security.isPathAllowed.mockReturnValue(false);
    await expect(service.read(file)).rejects.toThrow('授权');
    expect(readFileSync(file, 'utf8')).toBe('not-a-zip');
  });
  it('routes ephemeral screenshots into multimodal messages, never tool text', () => {
    const raw = {
      success: true,
      data: { visualObservation: { base64: 'aGVsbG8=' }, page: 'test' },
    };
    const vision = visualObservation(raw, 'qwen3-vl-plus', 'qwen');
    expect(Array.isArray(vision.message?.content)).toBe(true);
    expect(JSON.stringify(vision.result)).not.toContain('aGVsbG8');
    expect(typeof visualObservation(raw, 'text-only-test').message?.content).toBe('string');
    expect(Array.isArray(visualObservation(raw, 'qwen3-vl-plus', 'qwen_2').message?.content)).toBe(
      true,
    );
    expect(Array.isArray(visualObservation(raw, 'qwen3-vl-8b', 'lmstudio').message?.content)).toBe(
      true,
    );
    expect(Array.isArray(visualObservation(raw, 'wing/auto', 'skyalytic').message?.content)).toBe(
      false,
    );
    expect(
      Array.isArray(visualObservation(raw, 'wing/official-image', 'skyalytic').message?.content),
    ).toBe(false);
  });
  it('protects shared formulas and requests recalculation after regular formula edits', async () => {
    const file = join(root, 'formulas.xlsx');
    await tool.execute(
      {
        format: 'xlsx',
        title: 'test',
        sections: [{ heading: '预算', rows: [[1, 2]] }],
        outputPath: file,
      },
      { workspace: root } as never,
    );
    let zip = await JSZip.loadAsync(readFileSync(file));
    const xml = await zip.file('xl/worksheets/sheet1.xml')!.async('string');
    zip.file(
      'xl/worksheets/sheet1.xml',
      xml.replace('<v>1</v>', '<f t="shared" si="0" ref="A1:B1">1+1</f><v>2</v>'),
    );
    writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer' }));
    const shared = await service.read(file);
    expect(shared.sections[0]!.name).toBe('预算');
    expect(shared.sections[0]!.fields.every((f) => f.readOnly)).toBe(true);
    await expect(
      service.save(file, shared.revision, [{ id: shared.sections[0]!.fields[1]!.id, value: '3' }]),
    ).rejects.toThrow('共享');
    zip.file('xl/worksheets/sheet1.xml', xml);
    writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer' }));
    const regular = await service.read(file);
    await service.save(file, regular.revision, [
      { id: regular.sections[0]!.fields[0]!.id, value: '=B1*2' },
    ]);
    zip = await JSZip.loadAsync(readFileSync(file));
    expect(await zip.file('xl/workbook.xml')!.async('string')).toContain('fullCalcOnLoad="1"');
    expect((await service.read(file)).sections[0]!.fields[0]!.value).toBe('=B1*2');
  });
});
