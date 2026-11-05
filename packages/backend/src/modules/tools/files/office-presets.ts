import { BadRequestException } from '@nestjs/common';
import JSZip from 'jszip';
import { defaultOfficeFonts } from './office-fonts.js';

export const officeTemplates = [
  { id: 'blank', format: 'docx', name: '空白文档', description: 'A4 · 中文正文与三级标题样式' },
  { id: 'report', format: 'docx', name: '工作报告', description: '摘要、进展、风险与下一步' },
  { id: 'meeting', format: 'docx', name: '会议纪要', description: '会议信息、决议与行动清单' },
  { id: 'letter', format: 'docx', name: '正式通知', description: '标题、称谓、正文、落款与日期' },
  { id: 'blank', format: 'xlsx', name: '空白表格', description: '中文字体 · 清晰列宽与行高' },
  { id: 'budget', format: 'xlsx', name: '费用预算', description: '数量、单价、自动小计与合计' },
  { id: 'tasks', format: 'xlsx', name: '任务跟踪', description: '负责人、期限、状态与优先级' },
  { id: 'sales', format: 'xlsx', name: '销售台账', description: '订单记录、金额公式与筛选' },
  { id: 'blank', format: 'pptx', name: '空白演示', description: '16:9 · 统一中英文字体' },
  { id: 'business', format: 'pptx', name: '工作汇报', description: '封面、概览、进展、计划 · 4 页' },
  { id: 'project', format: 'pptx', name: '项目方案', description: '目标、实施路径、里程碑 · 4 页' },
  { id: 'training', format: 'pptx', name: '培训课程', description: '目标、知识要点、练习 · 4 页' },
];
const xml = (text: string) => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);
export async function createOfficePreset(format: string, template = 'blank'): Promise<Buffer> {
  if (!officeTemplates.some(t => t.format === format && t.id === template)) throw new BadRequestException('请选择有效的 Office 模板');
  const fonts = defaultOfficeFonts();
  if (format === 'docx') {
    const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, Table, TableRow, TableCell, WidthType } = await import('docx');
    const body = template === 'letter' ? fonts.formal : fonts.body;
    const face = (name: string) => ({ ascii: name, hAnsi: name, eastAsia: name, cs: name });
    const text = (value: string) => new Paragraph({ children: [new TextRun(value)] });
    const heading = (value: string) => new Paragraph({ text: value, heading: HeadingLevel.HEADING_1 });
    const title = (value: string) => new Paragraph({ text: value, heading: HeadingLevel.TITLE, alignment: AlignmentType.CENTER });
    let children: Array<InstanceType<typeof Paragraph> | InstanceType<typeof Table>> = [text('')];
    if (template === 'report') children = [title('工作报告'), text('汇报人：________    日期：________'), heading('一、工作概述'), text('填写本期目标、工作范围和主要结论。'), heading('二、进展与成果'), text('按事项说明进展、成果及依据。'), heading('三、问题与风险'), text('说明问题、影响和拟采取的措施。'), heading('四、下一步计划'), text('明确行动、负责人和完成时间。')];
    if (template === 'meeting') children = [title('会议纪要'), text('会议主题：________'), text('时间：________    地点：________'), text('主持人：________    记录人：________'), text('参会人员：________'), heading('一、讨论要点'), text('填写讨论内容和待确认事项。'), heading('二、会议决议'), text('填写已达成一致的决议。'), heading('三、行动清单'), new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [['行动事项', '负责人', '截止时间'], ['', '', ''], ['', '', '']].map((row, i) => new TableRow({ tableHeader: i === 0, children: row.map(value => new TableCell({ children: [text(value)], ...(i === 0 ? { shading: { fill: 'EAF0F7' } } : {}) })) })) })];
    if (template === 'letter') children = [title('关于________的通知'), text('各有关部门：'), text('为________，现将有关事项通知如下：'), heading('一、主要事项'), text('填写事项内容、适用范围与要求。'), heading('二、工作安排'), text('填写责任分工、执行时间与联系方式。'), new Paragraph({ text: '________（单位名称）', alignment: AlignmentType.RIGHT }), new Paragraph({ text: '____年__月__日', alignment: AlignmentType.RIGHT })];
    return Packer.toBuffer(new Document({
      creator: 'Wing', title: template === 'blank' ? '' : officeTemplates.find(t => t.format === format && t.id === template)!.name,
      styles: { default: {
        document: { run: { font: face(body), size: template === 'letter' ? 32 : 24, language: { value: 'zh-CN', eastAsia: 'zh-CN' } }, paragraph: { spacing: { after: 120, line: 360 } } },
        title: { run: { font: face(fonts.heading), size: 44, bold: true, color: '18304C' }, paragraph: { spacing: { after: 320 } } },
        heading1: { run: { font: face(fonts.heading), size: 32, bold: true, color: '18304C' }, paragraph: { spacing: { before: 240, after: 120 }, keepNext: true } },
        heading2: { run: { font: face(fonts.heading), size: 28, bold: true }, paragraph: { keepNext: true } },
        heading3: { run: { font: face(fonts.heading), size: 24, bold: true }, paragraph: { keepNext: true } },
      } },
      sections: [{ properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 } } }, children }],
    }));
  }
  if (format === 'xlsx') {
    const XLSX = await import('xlsx');
    const headers: Record<string, string[]> = {
      budget: ['费用项目', '数量', '单价（元）', '小计（元）', '备注'],
      tasks: ['任务', '负责人', '开始日期', '截止日期', '状态', '优先级', '备注'],
      sales: ['订单日期', '客户', '产品', '数量', '单价（元）', '金额（元）', '备注'],
    };
    const rows = template === 'blank' ? [['']] : [headers[template]!, ...Array.from({ length: 10 }, () => headers[template]!.map(() => ''))];
    const sheet = XLSX.utils.aoa_to_sheet(rows);
    if (template === 'budget' || template === 'sales') {
      const total = template === 'budget' ? 'D' : 'F';
      const [quantity, price] = template === 'budget' ? ['B', 'C'] : ['D', 'E'];
      for (let row = 2; row <= 11; row++) sheet[`${total}${row}`] = { t: 'n', f: `IF(COUNT(${quantity}${row}:${price}${row})<2,"",${quantity}${row}*${price}${row})`, z: '#,##0.00' };
      sheet['A12'] = { t: 's', v: '合计' }; sheet[`${total}12`] = { t: 'n', f: `SUM(${total}2:${total}11)`, z: '#,##0.00' };
      sheet['!ref'] = `A1:${template === 'budget' ? 'E' : 'G'}12`;
    }
    sheet['!cols'] = Array.from({ length: rows[0]!.length || 8 }, (_, i) => ({ wch: i === 0 ? 24 : 18 }));
    sheet['!rows'] = rows.map((_, i) => ({ hpt: i === 0 && template !== 'blank' ? 30 : 24 }));
    if (template !== 'blank') sheet['!autofilter'] = { ref: `A1:${XLSX.utils.encode_col(rows[0]!.length - 1)}11` };
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, sheet, template === 'blank' ? '工作表1' : officeTemplates.find(t => t.id === template && t.format === format)!.name);
    const zip = await JSZip.loadAsync(XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }));
    zip.file('xl/styles.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="${xml(fonts.sans)}"/><charset val="134"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="${xml(fonts.sans)}"/><charset val="134"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF245A77"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"><alignment vertical="center"/></xf><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf><xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`);
    let sheetXml = await zip.file('xl/worksheets/sheet1.xml')!.async('string');
    sheetXml = sheetXml.replace(/<c\b([^>]*)>/g, (_, raw: string) => {
      const attrs = raw.replace(/\s+s="[^"]*"/g, ''), ref = /r="([A-Z]+)(\d+)"/.exec(attrs);
      let style = 0;
      if (ref && template !== 'blank') {
        if (ref[2] === '1') style = 1;
        else if ((template === 'budget' && ['C', 'D'].includes(ref[1]!)) || (template === 'sales' && ['E', 'F'].includes(ref[1]!))) style = 2;
        else if ((template === 'tasks' && ['C', 'D'].includes(ref[1]!)) || (template === 'sales' && ref[1] === 'A')) style = 3;
      }
      return '<c' + attrs + ` s="${style}">`;
    });
    if (template !== 'blank') sheetXml = sheetXml.replace(/<sheetViews>[\s\S]*?<\/sheetViews>/, '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>');
    zip.file('xl/worksheets/sheet1.xml', sheetXml);
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  }
  const { default: PptxGenJS } = await import('pptxgenjs');
  const presentation = new PptxGenJS();
  presentation.layout = 'LAYOUT_WIDE';
  presentation.author = 'Wing'; presentation.subject = '可编辑演示模板';
  presentation.theme = { headFontFace: fonts.sans, bodyFontFace: fonts.sans };
  if (template === 'blank') presentation.addSlide();
  else {
    const outlines: Record<string, string[][]> = {
      business: [['工作汇报', '汇报人 · 日期'], ['本期工作概览', '工作目标', '关键成果', '待解决事项'], ['重点工作进展', '已完成', '进行中', '风险与支持'], ['下一步计划', '行动与负责人', '时间安排', '预期成果']],
      project: [['项目方案', '项目名称 · 提案人 · 日期'], ['目标与范围', '业务背景', '项目目标', '交付范围'], ['实施路径', '调研与设计', '实施与验证', '交付与运营'], ['里程碑与资源', '关键节点', '责任分工', '资源与风险']],
      training: [['培训课程', '课程名称 · 讲师 · 日期'], ['学习目标', '了解背景', '掌握方法', '完成练习'], ['核心知识', '概念与原理', '操作步骤', '常见问题'], ['练习与回顾', '实践任务', '检查标准', '课后行动']],
    };
    const accent = template === 'training' ? '167568' : template === 'project' ? '6257A6' : '245A77';
    outlines[template]!.forEach((content, index) => {
      const slide = presentation.addSlide();
      slide.background = { color: index === 0 ? '142B40' : 'F6F8FB' };
      slide.addShape(presentation.ShapeType.rect, { x: 0.65, y: 0.65, w: 0.12, h: 0.5, fill: { color: accent }, line: { color: accent } });
      slide.addText(content[0]!, { x: 0.95, y: index === 0 ? 2.05 : 0.68, w: 11.4, h: 0.8, fontFace: fonts.sans, fontSize: index === 0 ? 36 : 28, bold: true, color: index === 0 ? 'FFFFFF' : '18304C', margin: 0, breakLine: false });
      if (index === 0) slide.addText(content[1]!, { x: 0.95, y: 3.3, w: 11, h: 0.65, fontFace: fonts.sans, fontSize: 18, color: 'B8CEDF', margin: 0 });
      else content.slice(1).forEach((value, i) => {
        const x = 0.95 + i * 4.08;
        slide.addShape(presentation.ShapeType.roundRect, { x, y: 2.15, w: 3.7, h: 3.6, rectRadius: 0.15, fill: { color: 'FFFFFF' }, line: { color: 'E0E7EF', width: 1 } });
        slide.addText(`0${i + 1}`, { x: x + 0.3, y: 2.5, w: 3.1, h: 0.55, fontFace: fonts.sans, fontSize: 26, bold: true, color: accent, margin: 0 });
        slide.addText(value, { x: x + 0.3, y: 3.3, w: 3.1, h: 0.65, fontFace: fonts.sans, fontSize: 21, bold: true, color: '18304C', margin: 0 });
        slide.addText('在此填写内容与依据', { x: x + 0.3, y: 4.25, w: 3.1, h: 0.9, fontFace: fonts.sans, fontSize: 16, color: '617185', margin: 0 });
      });
      slide.addText(String(index + 1).padStart(2, '0'), { x: 12.1, y: 6.85, w: 0.5, h: 0.3, fontFace: fonts.sans, fontSize: 11, color: '8A9EAE', align: 'right', margin: 0 });
      slide.addNotes('模板中的提示文字请替换为已核实的实际内容。');
    });
  }
  return await presentation.write({ outputType: 'nodebuffer' }) as Buffer;
}
