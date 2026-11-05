import { createRequire } from 'node:module';
import { resolve as resolvePath, extname } from 'node:path';
import { existsSync, mkdirSync, writeFileSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { withFileMutation } from '../../../../modules/tools/files/checkpoint-store.js';
import type { ToolDefinition, ToolResult, ToolContext } from '@skyalyticwing/shared';
import { SecurityManagerService } from '../../../../modules/core/security/security-manager.service.js';
import { jsonOut } from '../../reach/tools/agent-reach.js';

/** 可选依赖统一经 dynamicRequire 加载（与 media.ts 一致，便于降级） */
const dynamicRequire = createRequire(__filename);

function fail(error: string): ToolResult {
  return { success: false, error };
}

interface DocSection {
  heading?: string;
  content?: string;
  rows?: unknown[][];
}

interface DocGenerateArgs {
  format: 'docx' | 'xlsx' | 'pptx' | 'pdf';
  title: string;
  content?: string;
  sections?: DocSection[];
  outputPath?: string;
}

// ─── docx（@skyalyticwing/backend 依赖，动态加载） ───

/** docx 库最小接口 */
interface DocxModule {
  Document: new (opts: Record<string, unknown>) => {
    add: (children: unknown[]) => void;
  };
  Paragraph: new (opts: Record<string, unknown>) => unknown;
  HeadingLevel: { HEADING_1: string; HEADING_2: string };
  TextRun: new (opts: Record<string, unknown>) => unknown;
  Table: new (opts: Record<string, unknown>) => unknown;
  TableRow: new (opts: Record<string, unknown>) => unknown;
  TableCell: new (opts: Record<string, unknown>) => unknown;
  Packer: { toBuffer: (doc: unknown) => Promise<Buffer> };
}

let docxMod: DocxModule | null = null;
let docxLoaded = false;

function loadDocx(): DocxModule | null {
  if (docxLoaded) return docxMod;
  docxLoaded = true;
  try {
    docxMod = dynamicRequire('docx') as DocxModule;
  } catch {
    docxMod = null;
  }
  return docxMod;
}

// ─── xlsx ───

/** xlsx 库最小接口 */
interface XlsxModule {
  utils: {
    book_new: () => unknown;
    aoa_to_sheet: (rows: unknown[][]) => unknown;
    book_append_sheet: (wb: unknown, ws: unknown, name: string) => void;
  };
  write: (wb: unknown, opts: Record<string, unknown>) => unknown;
}

let xlsxMod: XlsxModule | null = null;
let xlsxLoaded = false;

function loadXlsx(): XlsxModule | null {
  if (xlsxLoaded) return xlsxMod;
  xlsxLoaded = true;
  try {
    xlsxMod = dynamicRequire('xlsx') as XlsxModule;
  } catch {
    xlsxMod = null;
  }
  return xlsxMod;
}

// ─── pptxgenjs ───

/** pptxgenjs 库最小接口 */
interface PptxGenModule {
  default?: new () => PptxGenInstance;
}
interface PptxGenInstance {
  layout: string;
  defineSlideMaster: (opts: Record<string, unknown>) => void;
  addSlide: (masterName?: string) => {
    addText: (text: string, opts: Record<string, unknown>) => void;
    addTable: (rows: unknown[][], opts: Record<string, unknown>) => void;
  };
  write: (opts: { outputType: 'nodebuffer' }) => Promise<Buffer>;
}

let pptxCtor: (new () => PptxGenInstance) | null = null;
let pptxLoaded = false;

function loadPptxGen(): (new () => PptxGenInstance) | null {
  if (pptxLoaded) return pptxCtor;
  pptxLoaded = true;
  try {
    const mod = dynamicRequire('pptxgenjs') as PptxGenModule;
    const ctor = mod.default ?? (mod as unknown as new () => PptxGenInstance);
    if (typeof ctor === 'function') pptxCtor = ctor;
  } catch {
    pptxCtor = null;
  }
  return pptxCtor;
}

// ─── pdfkit（@skyalyticwing/backend 依赖，动态加载，与 media.ts loadPdfKit 同模式） ───

/** pdfkit 文档最小接口（仅用到流式写入、字体注册与基础排版） */
interface PdfKitDoc {
  on: (ev: string, cb: (chunk?: unknown) => void) => void;
  registerFont: (name: string, src: string, family?: string) => unknown;
  font: (name: string) => PdfKitDoc;
  fontSize: (n: number) => PdfKitDoc;
  moveDown: (lines?: number) => PdfKitDoc;
  text: (t: string, opts?: Record<string, unknown>) => PdfKitDoc;
  end: () => void;
}

let pdfKitCtor: (new (opts?: Record<string, unknown>) => PdfKitDoc) | null = null;
let pdfKitLoaded = false;

/** 加载 pdfkit（失败返回 null，结果缓存） */
function loadPdfKit(): (new (opts?: Record<string, unknown>) => PdfKitDoc) | null {
  if (pdfKitLoaded) return pdfKitCtor;
  pdfKitLoaded = true;
  try {
    const mod = dynamicRequire('pdfkit') as unknown;
    const ctor =
      (mod as { PDFDocument?: unknown }).PDFDocument ??
      ((mod as { default?: unknown }).default ?? mod);
    if (typeof ctor === 'function') {
      pdfKitCtor = ctor as new (opts?: Record<string, unknown>) => PdfKitDoc;
    }
  } catch {
    pdfKitCtor = null;
  }
  return pdfKitCtor;
}

/** 中文字体候选（TTC 集合文件需指定内部 PostScript 名以定位子字体） */
interface ChineseFontCandidate {
  path: string;
  postScriptName?: string;
}

let cachedChineseFont: ChineseFontCandidate | null | undefined;

/** 探测系统字体（结果缓存；null 表示未找到，PDF 将降级 Helvetica，中文可能乱码） */
function findChineseFont(): ChineseFontCandidate | null {
  if (cachedChineseFont !== undefined) return cachedChineseFont;
  let candidates: ChineseFontCandidate[];
  if (process.platform === 'win32') {
    const fontsDir = `${process.env['WINDIR'] || 'C:\\Windows'}\\Fonts`;
    // 优先 TTF（TTC 集合对 pdfkit 支持有限，须给 PostScript 名；方案同旧版 doc-writer）
    candidates = [
      { path: `${fontsDir}\\simhei.ttf` },
      { path: `${fontsDir}\\simfang.ttf` },
      { path: `${fontsDir}\\simkai.ttf` },
      { path: `${fontsDir}\\msyh.ttf` },
      { path: `${fontsDir}\\msyh.ttc`, postScriptName: 'MicrosoftYaHei' },
      { path: `${fontsDir}\\simsun.ttc`, postScriptName: 'SimSun' },
    ];
  } else if (process.platform === 'darwin') {
    candidates = [
      { path: '/System/Library/Fonts/PingFang.ttc', postScriptName: 'PingFangSC-Regular' },
      { path: '/Library/Fonts/Arial Unicode.ttf' },
    ];
  } else {
    candidates = [
      { path: '/usr/share/fonts/truetype/wqy/wqy-microhei.ttc', postScriptName: 'WenQuanYiMicroHei' },
      { path: '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc', postScriptName: 'NotoSansCJKsc-Regular' },
    ];
  }
  cachedChineseFont = candidates.find((c) => existsSync(c.path)) ?? null;
  return cachedChineseFont;
}

/** 将 sections/content 统一为段落列表 */
function toBlocks(a: DocGenerateArgs): DocSection[] {
  if (Array.isArray(a.sections) && a.sections.length > 0) {
    return a.sections.filter((s) => s && typeof s === 'object');
  }
  if (typeof a.content === 'string' && a.content.length > 0) {
    return [{ content: a.content }];
  }
  return [];
}

/** 降级方案：生成 Markdown 文件并返回指引（JS 库不可用时） */
function fallbackMarkdown(
  a: DocGenerateArgs,
  reason: string,
): ToolResult {
  const blocks = toBlocks(a);
  const md: string[] = [`# ${a.title}`, ''];
  for (const s of blocks) {
    if (s.heading) md.push(`## ${s.heading}`, '');
    if (typeof s.content === 'string') md.push(s.content, '');
    if (Array.isArray(s.rows) && s.rows.length > 0) {
      const tableRows = s.rows.filter((r) => Array.isArray(r)) as unknown[][];
      if (tableRows.length > 0) {
        const cols = Math.max(...tableRows.map((r) => r.length));
        md.push('| ' + Array.from({ length: cols }, () => '---').join(' | ') + ' |');
        for (const r of tableRows) {
          md.push('| ' + Array.from({ length: cols }, (_, i) => String(r[i] ?? '')).join(' | ') + ' |');
        }
        md.push('');
      }
    }
  }
  const out = `${a.outputPath || `doc-${Date.now()}`}.md`;
  return {
    success: true,
    data: {
      format: 'markdown（降级）',
      file: out,
      degradedReason: reason,
      guidance:
        `原生 ${a.format.toUpperCase()} 生成库不可用（${reason}），已生成 Markdown 版本。` +
        '可将 .md 转换为目标格式（如 pandoc），或安装 docx/pptxgenjs/xlsx/pdfkit 依赖后重试。',
    },
    output: md.join('\n'),
  };
}

/**
 * 文档生成域内置工具：doc_generate。
 *
 * 移植自旧版 doc-writer 思路，真实实现基于后端已装依赖：
 *   - docx → docx 库（Document/Paragraph/Packer.toBuffer）
 *   - xlsx → xlsx 库（aoa_to_sheet + write，取 sections[].rows 或按行拆 content）
 *   - pptx → pptxgenjs（每 section 一页 slide）
 *   - pdf → pdfkit（A4 流式排版，系统字体注册支持中文，内容溢出自动分页）
 * 库加载失败时降级生成 Markdown 文件 + 转换指引。
 *
 * 安全：outputPath 经 PathGuard 写白名单；库经 dynamicRequire 动态加载。
 */
export function createDocTools(security: SecurityManagerService): ToolDefinition[] {
  return [
    // ═══ doc_generate ═══
    {
      name: 'doc_generate',
      description:
        '生成文档（docx/xlsx/pptx/pdf）。基于标题 + 分节内容（heading/content/rows 表格）构建，' +
        '输出路径须经路径白名单校验。生成库不可用时降级输出 Markdown。' +
        'pdf 由 pdfkit 生成（A4 自动分页），自动探测系统字体（微软雅黑/黑体等）支持中文，' +
        '含中文但缺少可用中文字体时明确失败并提示安装字体。',
      category: 'file',
      dangerous: false,
      parameters: {
        type: 'object',
        properties: {
          format: {
            type: 'string',
            enum: ['docx', 'xlsx', 'pptx', 'pdf'],
            description: '目标格式：docx=Word 文档，xlsx=Excel 表格，pptx=PowerPoint 幻灯片，pdf=PDF 文档',
          },
          title: { type: 'string', description: '文档标题' },
          content: { type: 'string', description: '正文内容（与 sections 二选一）' },
          sections: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                heading: { type: 'string', description: '节标题（docx/pdf 二级标题 / pptx 页标题 / xlsx 工作表名）' },
                content: { type: 'string', description: '节正文' },
                rows: {
                  type: 'array',
                  items: { type: 'array' },
                  description: '表格数据（docx/pptx/xlsx 原生表格；pdf 以文本行呈现）',
                },
              },
            },
            description: '分节内容（与 content 二选一）',
          },
          outputPath: { type: 'string', description: '输出文件绝对路径（须经路径白名单）' },
        },
        required: ['format', 'title'],
      },
      async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
        const a = (args || {}) as DocGenerateArgs;
        if (a.format !== 'docx' &&
          a.format !== 'xlsx' &&
          a.format !== 'pptx' &&
          a.format !== 'pdf'
        ) {
          return fail('Parameter "format" must be one of: docx, xlsx, pptx, pdf');
        }
        if (typeof a.title !== 'string' || a.title.length === 0) {
          return fail('Parameter "title" is required');
        }
        const blocks = toBlocks(a);
        if (blocks.length === 0 && a.format === 'xlsx') {
          return fail('xlsx 格式需要 sections[].rows 表格数据');
        }
        if (blocks.length === 0) {
          return fail('缺少 content 或 sections');
        }

        // 输出路径解析：PathGuard 写白名单
        const outPath = a.outputPath
          ? resolvePath(ctx.workspace || process.cwd(), a.outputPath)
          : resolvePath(ctx.workspace || process.cwd(), `doc-${Date.now()}.${a.format}`);
        if (outPath.includes('\0')) return fail('路径不得包含空字节');
        if (extname(outPath).toLowerCase() !== '.' + a.format) return fail('文件扩展名必须与 format 一致');
        if (!security.isPathAllowed(outPath, 'write')) {
          return { success: false, error: `输出路径不在白名单内: ${outPath}`, blocked: true };
        }

        try {
          const hash = (path: string) => existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : null;
          const baseRevision = hash(outPath);
          const writeOutput = (buffer: Buffer) => withFileMutation(outPath, async () => {
            if (hash(outPath) !== baseRevision) throw new Error('生成期间文件已被其他操作修改，请换一个输出文件名');
            const temp = outPath + '.' + randomUUID() + '.tmp';
            try { writeFileSync(temp,buffer); renameSync(temp,outPath); } finally { rmSync(temp,{force:true}); }
          });
          // 确保父目录存在
          const parent = resolvePath(outPath, '..');
          if (!existsSync(parent)) mkdirSync(parent, { recursive: true });

          if (a.format === 'docx') {
            const docx = loadDocx();
            if (!docx) {
              const r = fallbackMarkdown(a, 'docx 库加载失败');
              if (!r.data || typeof r.data !== 'object') return r;
              const mdPath = outPath.replace(/\.docx$/i, '.md');
              if (!security.isPathAllowed(mdPath, 'write')) {
                return fail(`降级 Markdown 路径不在白名单内: ${mdPath}`);
              }
              writeFileSync(mdPath, r.output || '', 'utf-8');
              return jsonOut({ ...r.data, file: mdPath });
            }
            const children: unknown[] = [
              new docx.Paragraph({ text: a.title, heading: docx.HeadingLevel.HEADING_1 }),
            ];
            for (const s of blocks) {
              if (s.heading) {
                children.push(
                  new docx.Paragraph({ text: s.heading, heading: docx.HeadingLevel.HEADING_2 }),
                );
              }
              if (typeof s.content === 'string' && s.content.length > 0) {
                for (const line of s.content.split('\n')) {
                  children.push(new docx.Paragraph({ text: line }));
                }
              }
              if (Array.isArray(s.rows) && s.rows.length) children.push(new docx.Table({ rows: s.rows.filter(Array.isArray).map(row => new docx.TableRow({ children: row.map(cell => new docx.TableCell({ children: [new docx.Paragraph({ text: String(cell ?? '') })] })) })) }));
            }
            const doc = new docx.Document({ sections: [{ children }] });
            const buf = await docx.Packer.toBuffer(doc);
            await writeOutput(buf);
            return jsonOut({ format: 'docx', file: outPath, bytes: buf.length, sections: blocks.length });
          }

          if (a.format === 'xlsx') {
            const xlsx = loadXlsx();
            if (!xlsx) {
              const r = fallbackMarkdown(a, 'xlsx 库加载失败');
              if (!r.data || typeof r.data !== 'object') return r;
              const mdPath = outPath.replace(/\.xlsx$/i, '.md');
              if (!security.isPathAllowed(mdPath, 'write')) {
                return fail(`降级 Markdown 路径不在白名单内: ${mdPath}`);
              }
              writeFileSync(mdPath, r.output || '', 'utf-8');
              return jsonOut({ ...r.data, file: mdPath });
            }
            const wb = xlsx.utils.book_new();
            let sheetIdx = 0;
            const names = new Set<string>();
            for (const s of blocks) {
              const rows = Array.isArray(s.rows) ? s.rows.filter(Array.isArray) : [];
              if (rows.length === 0 && typeof s.content === 'string') {
                rows.push(...s.content.split('\n').map((l) => [l]));
              }
              if (rows.length === 0) continue;
              const ws = xlsx.utils.aoa_to_sheet(rows);
              sheetIdx++;
              const base = (s.heading || `Sheet${sheetIdx}`).replace(/[\\/?*[\]:]/g, '_').slice(0, 31) || `Sheet${sheetIdx}`;
              let name = base, suffix = 1;
              while (names.has(name.toLowerCase())) { const tail = '_' + suffix++; name = base.slice(0, 31 - tail.length) + tail; }
              names.add(name.toLowerCase());
              xlsx.utils.book_append_sheet(wb, ws, name);
            }
            if (!sheetIdx) return fail('没有可生成的工作表数据');
            const buf = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
            await writeOutput(buf);
            return jsonOut({ format: 'xlsx', file: outPath, bytes: buf.length, sheets: sheetIdx });
          }

          if (a.format === 'pdf') {
            const PDFKitCtor = loadPdfKit();
            if (!PDFKitCtor) {
              const r = fallbackMarkdown(a, 'pdfkit 库加载失败');
              if (!r.data || typeof r.data !== 'object') return r;
              const mdPath = outPath.replace(/\.pdf$/i, '.md');
              if (!security.isPathAllowed(mdPath, 'write')) {
                return fail(`降级 Markdown 路径不在白名单内: ${mdPath}`);
              }
              writeFileSync(mdPath, r.output || '', 'utf-8');
              return jsonOut({ ...r.data, file: mdPath });
            }
            const doc = new PDFKitCtor({
              size: 'A4',
              margin: 72,
              info: { Title: a.title, Author: 'SkyalyticWing' },
            });
            const chunks: Buffer[] = [];
            const done = new Promise<void>((resolveDone, rejectDone) => {
              doc.on('data', (chunk?: unknown) => {
                if (chunk) chunks.push(chunk as Buffer);
              });
              doc.on('end', () => resolveDone());
              doc.on('error', (e: unknown) => rejectDone(e instanceof Error ? e : new Error(String(e))));
            });
            // 中文字体：注册系统字体（TTC 集合传 PostScript 名定位子字体），失败降级 Helvetica
            const zhFont = findChineseFont();
            let fontName = 'Helvetica';
            if (zhFont) {
              try {
                doc.registerFont('ChineseFont', zhFont.path, zhFont.postScriptName);
                doc.font('ChineseFont'); // 立即触发字体加载，验证可用
                fontName = 'ChineseFont';
              } catch {
                fontName = 'Helvetica';
              }
            }
            const boldFont = fontName === 'ChineseFont' ? 'ChineseFont' : 'Helvetica-Bold';
            if (fontName !== 'ChineseFont' && /[\u3400-\u9fff\uf900-\ufaff]/.test(a.title + JSON.stringify(blocks))) {
              doc.end(); await done;
              return fail('缺少可用中文字体，未生成乱码 PDF。请安装思源黑体 / Noto Sans CJK，或先生成 Word 文档。');
            }
            // 文档标题：大字号加粗居中
            doc.font(boldFont).fontSize(22).text(a.title, { align: 'center', lineGap: 4 });
            doc.moveDown(1);
            for (const s of blocks) {
              if (s.heading) {
                // 节标题：中字号加粗（内容溢出时 pdfkit 自动分页）
                doc.font(boldFont).fontSize(16).text(s.heading, { lineGap: 4 });
                doc.moveDown(0.3);
              }
              if (typeof s.content === 'string' && s.content.length > 0) {
                for (const line of s.content.split('\n')) {
                  const ul = line.match(/^\s*[-*•]\s+(.*)$/);
                  const ol = line.match(/^\s*(\d+)[.)]\s+(.*)$/);
                  if (ul) {
                    // 无序列表：项目符号前缀
                    doc.font(fontName).fontSize(11).text(`• ${ul[1]}`, { indent: 20, lineGap: 2 });
                  } else if (ol) {
                    // 有序列表：保留编号前缀
                    doc.font(fontName).fontSize(11).text(`${ol[1]}. ${ol[2]}`, { indent: 20, lineGap: 2 });
                  } else if (line.trim().length === 0) {
                    doc.moveDown(0.5);
                  } else {
                    doc.font(fontName).fontSize(11).text(line, { lineGap: 2 });
                  }
                }
                doc.moveDown(0.3);
              }
              if (Array.isArray(s.rows) && s.rows.length > 0) {
                // 表格数据：以 " | " 分隔的文本行呈现（原生表格见 xlsx 分支）
                for (const row of s.rows) {
                  if (!Array.isArray(row)) continue;
                  const cells = row.map((c) => String(c ?? '')).join(' | ');
                  doc.font(fontName).fontSize(10).text(cells, { lineGap: 1 });
                }
                doc.moveDown(0.5);
              }
            }
            doc.end();
            await done;
            const buf = Buffer.concat(chunks);
            await writeOutput(buf);
            const data: {
              format: string;
              file: string;
              bytes: number;
              sections: number;
              font: string;
              warning?: string;
            } = {
              format: 'pdf',
              file: outPath,
              bytes: buf.length,
              sections: blocks.length,
              font: fontName === 'ChineseFont' && zhFont ? zhFont.path : 'Helvetica',
            };
            return jsonOut(data);
          }

          // pptx
          const PptxGen = loadPptxGen();
          if (!PptxGen) {
            const r = fallbackMarkdown(a, 'pptxgenjs 库加载失败');
            if (!r.data || typeof r.data !== 'object') return r;
            const mdPath = outPath.replace(/\.pptx$/i, '.md');
            if (!security.isPathAllowed(mdPath, 'write')) {
              return fail(`降级 Markdown 路径不在白名单内: ${mdPath}`);
            }
            writeFileSync(mdPath, r.output || '', 'utf-8');
            return jsonOut({ ...r.data, file: mdPath });
          }
          const pptx = new PptxGen();
          pptx.layout = 'LAYOUT_16x9';
          // 封面页
          const cover = pptx.addSlide();
          cover.addText(a.title, {
            x: 0.5, y: 2.0, w: 9.0, h: 1.5,
            fontSize: 32, bold: true, align: 'center',
          });
          for (const s of blocks) {
            const slide = pptx.addSlide();
            if (s.heading) {
              slide.addText(s.heading, {
                x: 0.5, y: 0.4, w: 9.0, h: 0.8,
                fontSize: 24, bold: true,
              });
            }
            if (typeof s.content === 'string' && s.content.length > 0) {
              slide.addText(s.content, {
                x: 0.5, y: 1.4, w: 9.0, h: s.rows?.length ? 1.9 : 3.8,
                fontSize: 14, valign: 'top', fit: 'shrink',
              });
            }
            if (Array.isArray(s.rows) && s.rows.length) slide.addTable(s.rows.filter(Array.isArray).map(row => row.map(cell => String(cell ?? ''))), { x: 0.5, y: s.content ? 3.5 : 1.4, w: 9, fontSize: 12, border: { pt: 1, color: 'CCCCCC' } });
          }
          await writeOutput(await pptx.write({ outputType: 'nodebuffer' }));
          return jsonOut({ format: 'pptx', file: outPath, slides: blocks.length + 1 });
        } catch (err) {
          return fail(err instanceof Error ? err.message : String(err));
        }
      },
    },
  ];
}
