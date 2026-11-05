/**
 * doc-writer.cjs - 企业级文档生成模块
 * 支持 DOCX/PDF/XLSX/PPTX 文档生成
 * 输入支持 Markdown 文本或结构化 JSON
 * 三端通用（Windows/macOS/Linux）
 */

var fs = require('fs');
var path = require('path');
var os = require('os');

// ══════════════════════════════════════════════════════════════
// 辅助函数
// ══════════════════════════════════════════════════════════════

var _logFn = function() {};
function setLogger(fn) { _logFn = fn; }
function _log(level, msg) { try { _logFn(level, msg); } catch(e) {} }

function _ensureDir(filePath) {
  var dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function _ext(name) { return path.extname(name).toLowerCase(); }

// ══════════════════════════════════════════════════════════════
// Markdown 解析器（轻量级，支持常用语法）
// 输出块级元素数组，每个块有 type 属性
// ══════════════════════════════════════════════════════════════

/**
 * 解析行内元素：加粗、斜体、删除线、行内代码、链接
 * @returns {Array} [{ text, bold, italic, code, strikethrough, link }]
 */
function parseInline(text) {
  var runs = [];
  var i = 0;
  var len = text.length;
  var buf = '';

  function flushBuf() {
    if (buf) { runs.push({ text: buf }); buf = ''; }
  }

  while (i < len) {
    // 加粗 **text**
    if (text[i] === '*' && text[i + 1] === '*') {
      flushBuf();
      var end = text.indexOf('**', i + 2);
      if (end !== -1) {
        runs.push({ text: text.substring(i + 2, end), bold: true });
        i = end + 2;
        continue;
      }
    }
    // 斜体 *text*（避免与加粗冲突）
    if (text[i] === '*' && text[i + 1] !== '*') {
      flushBuf();
      var end2 = text.indexOf('*', i + 1);
      if (end2 !== -1 && end2 > i + 1) {
        runs.push({ text: text.substring(i + 1, end2), italic: true });
        i = end2 + 1;
        continue;
      }
    }
    // 删除线 ~~text~~
    if (text[i] === '~' && text[i + 1] === '~') {
      flushBuf();
      var end3 = text.indexOf('~~', i + 2);
      if (end3 !== -1) {
        runs.push({ text: text.substring(i + 2, end3), strikethrough: true });
        i = end3 + 2;
        continue;
      }
    }
    // 行内代码 `code`
    if (text[i] === '`') {
      flushBuf();
      var end4 = text.indexOf('`', i + 1);
      if (end4 !== -1) {
        runs.push({ text: text.substring(i + 1, end4), code: true });
        i = end4 + 1;
        continue;
      }
    }
    // 链接 [text](url)
    if (text[i] === '[') {
      var closeBr = text.indexOf(']', i + 1);
      if (closeBr !== -1 && text[closeBr + 1] === '(') {
        var closePa = text.indexOf(')', closeBr + 2);
        if (closePa !== -1) {
          flushBuf();
          runs.push({ text: text.substring(i + 1, closeBr), link: text.substring(closeBr + 2, closePa) });
          i = closePa + 1;
          continue;
        }
      }
    }
    buf += text[i];
    i++;
  }
  flushBuf();
  return runs;
}

/**
 * 解析 Markdown 文本为块级元素数组
 * @returns {Array} blocks: [{ type, ... }]
 */
function parseMarkdown(text) {
  if (!text) return [];
  var lines = text.split(/\r?\n/);
  var blocks = [];
  var i = 0;

  while (i < lines.length) {
    var line = lines[i];

    // 空行
    if (!line.trim()) { i++; continue; }

    // 代码块 ```
    if (line.trim().startsWith('```')) {
      var lang = line.trim().substring(3).trim();
      var codeLines = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // 跳过结束 ```
      blocks.push({ type: 'code', lang: lang, content: codeLines.join('\n') });
      continue;
    }

    // 标题 # ~ ######
    var headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      blocks.push({ type: 'heading', level: headingMatch[1].length, runs: parseInline(headingMatch[2]) });
      i++;
      continue;
    }

    // 水平线 --- / ***
    if (/^(\s*[-*]\s*){3,}$/.test(line)) {
      blocks.push({ type: 'hr' });
      i++;
      continue;
    }

    // 引用 >
    if (line.trim().startsWith('>')) {
      var quoteLines = [];
      while (i < lines.length && lines[i].trim().startsWith('>')) {
        quoteLines.push(lines[i].trim().substring(1).trim());
        i++;
      }
      blocks.push({ type: 'blockquote', runs: parseInline(quoteLines.join(' ')) });
      continue;
    }

    // 表格 | ... |
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1])) {
      var headerCells = line.split('|').map(function(c) { return c.trim(); }).filter(function(c, idx, arr) {
        return !(idx === 0 && c === '') && !(idx === arr.length - 1 && c === '');
      });
      i += 2; // 跳过分隔行
      var tableRows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        var cells = lines[i].split('|').map(function(c) { return c.trim(); }).filter(function(c, idx, arr) {
          return !(idx === 0 && c === '') && !(idx === arr.length - 1 && c === '');
        });
        tableRows.push(cells);
        i++;
      }
      blocks.push({ type: 'table', headers: headerCells, rows: tableRows });
      continue;
    }

    // 无序列表 - / * / +
    if (/^\s*[-*+]\s+/.test(line)) {
      var listItems = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        var indent = lines[i].match(/^(\s*)/)[1].length;
        var itemText = lines[i].replace(/^\s*[-*+]\s+/, '');
        listItems.push({ level: Math.floor(indent / 2), runs: parseInline(itemText) });
        i++;
      }
      blocks.push({ type: 'list', ordered: false, items: listItems });
      continue;
    }

    // 有序列表 1. 2.
    if (/^\s*\d+\.\s+/.test(line)) {
      var olItems = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        var olIndent = lines[i].match(/^(\s*)/)[1].length;
        var olText = lines[i].replace(/^\s*\d+\.\s+/, '');
        olItems.push({ level: Math.floor(olIndent / 2), runs: parseInline(olText) });
        i++;
      }
      blocks.push({ type: 'list', ordered: true, items: olItems });
      continue;
    }

    // 图片 ![alt](path)
    var imgMatch = line.match(/^!\[([^\]]*)\]\(([^)]+)\)\s*$/);
    if (imgMatch) {
      blocks.push({ type: 'image', alt: imgMatch[1], src: imgMatch[2] });
      i++;
      continue;
    }

    // 段落（连续非空行合并）
    var paraLines = [line];
    i++;
    while (i < lines.length && lines[i].trim() &&
           !lines[i].trim().startsWith('#') &&
           !lines[i].trim().startsWith('>') &&
           !lines[i].trim().startsWith('```') &&
           !lines[i].trim().startsWith('- ') &&
           !lines[i].trim().startsWith('* ') &&
           !lines[i].trim().startsWith('+ ') &&
           !/^\s*\d+\.\s+/.test(lines[i]) &&
           !/^!\[/.test(lines[i].trim()) &&
           !/^(\s*[-*]\s*){3,}$/.test(lines[i]) &&
           !(lines[i].includes('|') && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]))) {
      paraLines.push(lines[i]);
      i++;
    }
    blocks.push({ type: 'paragraph', runs: parseInline(paraLines.join(' ')) });
  }

  return blocks;
}

// ══════════════════════════════════════════════════════════════
// 中文字体检测
// ══════════════════════════════════════════════════════════════

var _cachedFont = null;
function findChineseFont() {
  if (_cachedFont !== null) return _cachedFont;
  var candidates = [];
  var platform = os.platform();

  if (platform === 'win32') {
    var winFonts = path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts');
    // 优先 TTF（pdfkit 对 TTC 支持有限，需要 fontkit）
    candidates = [
      path.join(winFonts, 'simhei.ttf'),
      path.join(winFonts, 'simfang.ttf'),
      path.join(winFonts, 'simkai.ttf'),
      path.join(winFonts, 'simsunb.ttf'),
      path.join(winFonts, 'msyh.ttf'),
      path.join(winFonts, 'msyh.ttc'),
      path.join(winFonts, 'simsun.ttc')
    ];
  } else if (platform === 'darwin') {
    candidates = [
      '/System/Library/Fonts/PingFang.ttc',
      '/System/Library/Fonts/STHeiti Medium.ttc',
      '/Library/Fonts/Arial Unicode.ttf'
    ];
  } else {
    candidates = [
      '/usr/share/fonts/truetype/wqy/wqy-microhei.ttc',
      '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc',
      '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
      '/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc',
      '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc'
    ];
  }

  for (var i = 0; i < candidates.length; i++) {
    try {
      if (fs.existsSync(candidates[i])) {
        _cachedFont = candidates[i];
        _log('INFO', 'doc-writer: 找到中文字体: ' + _cachedFont);
        return _cachedFont;
      }
    } catch(e) {}
  }

  _cachedFont = false;
  _log('WARN', 'doc-writer: 未找到中文字体，PDF中文将无法显示');
  return _cachedFont;
}

// ══════════════════════════════════════════════════════════════
// DOCX 生成
// ══════════════════════════════════════════════════════════════

async function generateDocx(options) {
  _log('INFO', 'doc-writer: 开始生成 DOCX');
  var docx;
  try { docx = require('docx'); } catch(e) { throw new Error('docx 模块不可用: ' + e.message); }

  var Document = docx.Document;
  var Packer = docx.Packer;
  var Paragraph = docx.Paragraph;
  var TextRun = docx.TextRun;
  var HeadingLevel = docx.HeadingLevel;
  var Table = docx.Table;
  var TableRow = docx.TableRow;
  var TableCell = docx.TableCell;
  var WidthType = docx.WidthType;
  var AlignmentType = docx.AlignmentType;
  var BorderStyle = docx.BorderStyle;
  var ImageRun = docx.ImageRun;
  var PageBreak = docx.PageBreak;
  var Header = docx.Header;
  var Footer = docx.Footer;
  var PageNumber = docx.PageNumber;
  var ShadingType = docx.ShadingType;

  // 解析内容
  var blocks;
  if (typeof options.content === 'string') {
    blocks = parseMarkdown(options.content);
  } else if (Array.isArray(options.content)) {
    blocks = options.content; // 已经是结构化数据
  } else if (Array.isArray(options.sections)) {
    // 多节内容
    blocks = [];
    for (var si = 0; si < options.sections.length; si++) {
      var sec = options.sections[si];
      if (sec.heading) {
        blocks.push({ type: 'heading', level: sec.headingLevel || 1, runs: parseInline(sec.heading) });
      }
      if (sec.content) {
        var secBlocks = typeof sec.content === 'string' ? parseMarkdown(sec.content) : (Array.isArray(sec.content) ? sec.content : []);
        blocks = blocks.concat(secBlocks);
      }
    }
  } else {
    blocks = [];
  }

  _log('INFO', 'doc-writer: 解析到 ' + blocks.length + ' 个块');

  // 构建 docx 子元素
  var children = [];
  var headingLevels = { 1: HeadingLevel.HEADING_1, 2: HeadingLevel.HEADING_2, 3: HeadingLevel.HEADING_3, 4: HeadingLevel.HEADING_4, 5: HeadingLevel.HEADING_5, 6: HeadingLevel.HEADING_6 };

  for (var bi = 0; bi < blocks.length; bi++) {
    var block = blocks[bi];

    switch (block.type) {
      case 'heading':
        var headingRuns = (block.runs || []).map(function(r) {
          return new TextRun({ text: r.text, bold: r.bold, italics: r.italic, color: r.link ? '0563C1' : undefined });
        });
        children.push(new Paragraph({ heading: headingLevels[block.level] || HeadingLevel.HEADING_1, children: headingRuns }));
        break;

      case 'paragraph':
        var paraRuns = (block.runs || []).map(function(r) {
          return new TextRun({ text: r.text, bold: r.bold, italics: r.italic, strikethrough: r.strikethrough, color: r.link ? '0563C1' : undefined, underline: r.link ? {} : undefined });
        });
        children.push(new Paragraph({ children: paraRuns, spacing: { after: 200 } }));
        break;

      case 'blockquote':
        var quoteRuns = (block.runs || []).map(function(r) {
          return new TextRun({ text: r.text, bold: r.bold, italics: r.italic, color: '666666' });
        });
        children.push(new Paragraph({ children: quoteRuns, indent: { left: 720 }, spacing: { after: 200 }, border: { left: { style: BorderStyle.SINGLE, size: 3, color: 'CCCCCC', space: 10 } } }));
        break;

      case 'code':
        var codeLines = block.content.split('\n');
        for (var ci = 0; ci < codeLines.length; ci++) {
          children.push(new Paragraph({
            children: [new TextRun({ text: codeLines[ci], font: 'Consolas', size: 20 })],
            shading: { type: ShadingType.SOLID, color: 'F5F5F5' },
            spacing: { after: 0, line: 276 }
          }));
        }
        children.push(new Paragraph({ spacing: { after: 200 } }));
        break;

      case 'list':
        for (var li = 0; li < block.items.length; li++) {
          var item = block.items[li];
          var itemRuns = (item.runs || []).map(function(r) {
            return new TextRun({ text: r.text, bold: r.bold, italics: r.italic });
          });
          children.push(new Paragraph({
            children: itemRuns,
            bullet: block.ordered ? undefined : { level: item.level || 0 },
            numbering: block.ordered ? { reference: 'numbered-list', level: item.level || 0 } : undefined,
            indent: { left: (item.level || 0) * 360 + 720 },
            spacing: { after: 100 }
          }));
        }
        break;

      case 'table':
        if (block.headers && block.headers.length > 0) {
          var colCount = block.headers.length;
          var tableRows = [];

          // 表头
          var headerCells = block.headers.map(function(h) {
            return new TableCell({
              children: [new Paragraph({ children: [new TextRun({ text: h, bold: true })], alignment: AlignmentType.CENTER })],
              shading: { type: ShadingType.SOLID, color: 'D9E2F3' },
              width: { size: Math.floor(9000 / colCount), type: WidthType.DXA }
            });
          });
          tableRows.push(new TableRow({ children: headerCells, tableHeader: true }));

          // 数据行
          for (var ri = 0; ri < block.rows.length; ri++) {
            var rowData = block.rows[ri];
            var dataCells = [];
            for (var dc = 0; dc < colCount; dc++) {
              dataCells.push(new TableCell({
                children: [new Paragraph({ children: [new TextRun({ text: rowData[dc] || '' })] })],
                width: { size: Math.floor(9000 / colCount), type: WidthType.DXA }
              }));
            }
            tableRows.push(new TableRow({ children: dataCells }));
          }

          children.push(new Table({
            rows: tableRows,
            width: { size: 9000, type: WidthType.DXA },
            borders: {
              top: { style: BorderStyle.SINGLE, size: 1, color: '999999' },
              bottom: { style: BorderStyle.SINGLE, size: 1, color: '999999' },
              left: { style: BorderStyle.SINGLE, size: 1, color: '999999' },
              right: { style: BorderStyle.SINGLE, size: 1, color: '999999' },
              insideHorizontal: { style: BorderStyle.SINGLE, size: 1, color: 'CCCCCC' },
              insideVertical: { style: BorderStyle.SINGLE, size: 1, color: 'CCCCCC' }
            }
          }));
          children.push(new Paragraph({ spacing: { after: 200 } }));
        }
        break;

      case 'hr':
        children.push(new Paragraph({
          border: { bottom: { style: BorderStyle.SINGLE, size: 1, color: 'CCCCCC', space: 1 } },
          spacing: { after: 200 }
        }));
        break;

      case 'image':
        try {
          var imgPath = block.src;
          // 校验图片路径，限制到工作区目录（process.cwd()）内
          // 防止 Markdown ![](C:\Windows\System32\config\SAM) 等任意文件读取
          var _dImgResolved = path.resolve(imgPath);
          var _dCwd = process.cwd();
          if (_dImgResolved !== _dCwd && _dImgResolved.indexOf(_dCwd + path.sep) !== 0) {
            children.push(new Paragraph({ children: [new TextRun({ text: '[图片: ' + block.alt + ' (路径超出工作区: ' + imgPath + ')]', italics: true, color: '999999' })] }));
            break;
          }
          var imgBuffer;
          if (fs.existsSync(imgPath)) {
            imgBuffer = fs.readFileSync(imgPath);
          }
          if (imgBuffer) {
            var imgExt = _ext(imgPath);
            var imgType = imgExt === '.png' ? 'png' : (imgExt === '.jpg' || imgExt === '.jpeg' ? 'jpg' : (imgExt === '.gif' ? 'gif' : 'png'));
            children.push(new Paragraph({
              children: [new ImageRun({ data: imgBuffer, transformation: { width: 500, height: 300 }, type: imgType })],
              alignment: AlignmentType.CENTER
            }));
          } else {
            children.push(new Paragraph({ children: [new TextRun({ text: '[图片: ' + block.alt + ' (未找到: ' + imgPath + ')]', italics: true, color: '999999' })] }));
          }
        } catch(imgErr) {
          children.push(new Paragraph({ children: [new TextRun({ text: '[图片加载失败: ' + imgErr.message + ']', italics: true, color: 'CC0000' })] }));
        }
        break;
    }
  }

  // 页眉页脚
  var docHeader = options.header ? new Header({ children: [new Paragraph({ children: [new TextRun({ text: options.header, size: 18, color: '999999' })], alignment: AlignmentType.CENTER })] }) : undefined;
  var docFooter = new Footer({ children: [new Paragraph({ children: [new TextRun({ children: [PageNumber.CURRENT], size: 18, color: '999999' }), new TextRun({ text: ' / ', size: 18, color: '999999' }), new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 18, color: '999999' })], alignment: AlignmentType.CENTER })] });

  var doc = new Document({
    creator: options.author || 'SkyalyticWing',
    title: options.title || 'Document',
    description: options.description || '',
    sections: [{
      properties: {
        page: { margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } }
      },
      headers: docHeader ? { default: docHeader } : undefined,
      footers: { default: docFooter },
      children: children.length > 0 ? children : [new Paragraph({ children: [new TextRun({ text: '(空文档)' })] })]
    }],
    numbering: {
      config: [{
        reference: 'numbered-list',
        levels: [
          { level: 0, format: 'decimal', text: '%1.', alignment: AlignmentType.START, style: { paragraph: { indent: { left: 720, hanging: 360 } } } },
          { level: 1, format: 'lowerLetter', text: '%2.', alignment: AlignmentType.START, style: { paragraph: { indent: { left: 1440, hanging: 360 } } } },
          { level: 2, format: 'lowerRoman', text: '%3.', alignment: AlignmentType.START, style: { paragraph: { indent: { left: 2160, hanging: 360 } } } }
        ]
      }]
    }
  });

  var buffer = await Packer.toBuffer(doc);
  return buffer;
}

// ══════════════════════════════════════════════════════════════
// PDF 生成
// ══════════════════════════════════════════════════════════════

async function generatePdf(options) {
  _log('INFO', 'doc-writer: 开始生成 PDF');
  var PDFDocument;
  try { PDFDocument = require('pdfkit'); } catch(e) { throw new Error('pdfkit 模块不可用: ' + e.message); }

  // 解析内容
  var blocks;
  if (typeof options.content === 'string') {
    blocks = parseMarkdown(options.content);
  } else if (Array.isArray(options.content)) {
    blocks = options.content;
  } else {
    blocks = [];
  }
  _log('INFO', 'doc-writer: PDF 解析到 ' + blocks.length + ' 个块');

  // 检测中文字体
  var fontPath = findChineseFont();
  var fontName = fontPath ? 'ChineseFont' : 'Helvetica';

  var doc = new PDFDocument({
    size: options.pageSize || 'A4',
    margins: { top: 72, bottom: 72, left: 72, right: 72 },
    info: { Title: options.title || 'Document', Author: options.author || 'SkyalyticWing' }
  });

  if (fontPath) {
    try { doc.registerFont('ChineseFont', fontPath); } catch(e) { _log('WARN', 'doc-writer: 注册中文字体失败: ' + e.message); }
  }

  // 页眉
  if (options.header) {
    doc.on('pageAdded', function() {
      doc.font(fontName).fontSize(9).fillColor('#999999').text(options.header, 72, 36, { width: doc.page.width - 144, align: 'center' });
      doc.fillColor('#000000');
    });
  }

  // 页码（通过页脚）
  var _pageCount = 0;
  doc.on('pageAdded', function() { _pageCount++; });

  var pageWidth = doc.page.width - 144; // 内容区宽度

  for (var bi = 0; bi < blocks.length; bi++) {
    var block = blocks[bi];

    switch (block.type) {
      case 'heading':
        var hSize = block.level === 1 ? 24 : (block.level === 2 ? 20 : (block.level === 3 ? 16 : 14));
        var hBold = true;
        var hText = (block.runs || []).map(function(r) { return r.text; }).join('');
        // 检查剩余空间
        if (doc.y > doc.page.height - 100) doc.addPage();
        doc.font(fontPath ? 'ChineseFont' : 'Helvetica-Bold').fontSize(hSize).fillColor('#1a1a1a').text(hText, { align: block.level <= 2 ? 'left' : 'left', lineGap: 4 });
        doc.moveDown(0.3);
        break;

      case 'paragraph':
        var pRuns = block.runs || [];
        if (doc.y > doc.page.height - 100) doc.addPage();
        // 简化处理：逐个 run 输出
        for (var pri = 0; pri < pRuns.length; pri++) {
          var r = pRuns[pri];
          var font = fontPath ? 'ChineseFont' : 'Helvetica';
          if (r.bold) font = fontPath ? 'ChineseFont' : 'Helvetica-Bold';
          if (r.italic) font = fontPath ? 'ChineseFont' : 'Helvetica-Oblique';
          if (r.code) { font = 'Courier'; }
          doc.font(font).fontSize(11).fillColor(r.link ? '#0563C1' : '#000000').text(r.text, { continued: pri < pRuns.length - 1, lineGap: 2 });
        }
        doc.fillColor('#000000');
        doc.moveDown(0.5);
        break;

      case 'blockquote':
        if (doc.y > doc.page.height - 100) doc.addPage();
        var qText = (block.runs || []).map(function(r) { return r.text; }).join('');
        doc.font(fontPath ? 'ChineseFont' : 'Helvetica-Oblique').fontSize(11).fillColor('#666666').text(qText, { indent: 36, lineGap: 2 });
        // 左边线
        doc.moveTo(60, doc.y - 20).lineTo(60, doc.y).strokeColor('#CCCCCC').lineWidth(2).stroke();
        doc.fillColor('#000000');
        doc.moveDown(0.5);
        break;

      case 'code':
        if (doc.y > doc.page.height - 100) doc.addPage();
        var codeLines = block.content.split('\n');
        doc.font('Courier').fontSize(9).fillColor('#333333');
        for (var cli = 0; cli < codeLines.length; cli++) {
          if (doc.y > doc.page.height - 80) doc.addPage();
          doc.text(codeLines[cli], { indent: 14, lineGap: 1 });
        }
        doc.fillColor('#000000');
        doc.moveDown(0.5);
        break;

      case 'list':
        var items = block.items || [];
        for (var li2 = 0; li2 < items.length; li2++) {
          if (doc.y > doc.page.height - 80) doc.addPage();
          var item = items[li2];
          var itemText = (item.runs || []).map(function(r) { return r.text; }).join('');
          var prefix = block.ordered ? (li2 + 1) + '. ' : '• ';
          var indent = (item.level || 0) * 20;
          doc.font(fontPath ? 'ChineseFont' : 'Helvetica').fontSize(11).fillColor('#000000').text(prefix + itemText, { indent: 20 + indent, lineGap: 2 });
        }
        doc.moveDown(0.5);
        break;

      case 'table':
        if (!block.headers || block.headers.length === 0) break;
        var colCount = block.headers.length;
        var colWidth = Math.floor(pageWidth / colCount);
        if (doc.y > doc.page.height - 120) doc.addPage();

        // 表头
        doc.font(fontPath ? 'ChineseFont' : 'Helvetica-Bold').fontSize(10).fillColor('#000000');
        var startY = doc.y;
        for (var thi = 0; thi < colCount; thi++) {
          var cellX = 72 + thi * colWidth;
          doc.rect(cellX, startY, colWidth, 24).fillAndStroke('#D9E2F3', '#999999');
          doc.fillColor('#000000').text(block.headers[thi], cellX + 4, startY + 6, { width: colWidth - 8, align: 'center' });
        }
        doc.y = startY + 24;

        // 数据行
        doc.font(fontPath ? 'ChineseFont' : 'Helvetica').fontSize(10);
        for (var tri = 0; tri < block.rows.length; tri++) {
          if (doc.y > doc.page.height - 40) doc.addPage();
          var rowData = block.rows[tri];
          var rowY = doc.y;
          var maxRowHeight = 24;
          for (var tci = 0; tci < colCount; tci++) {
            var cellText = String(rowData[tci] || '');
            // 估算高度
            var lines = Math.ceil(cellText.length / Math.floor((colWidth - 8) / 6)) || 1;
            if (lines * 14 + 10 > maxRowHeight) maxRowHeight = lines * 14 + 10;
          }
          for (var tci2 = 0; tci2 < colCount; tci2++) {
            var dCellX = 72 + tci2 * colWidth;
            doc.rect(dCellX, rowY, colWidth, maxRowHeight).fillAndStroke('#FFFFFF', '#CCCCCC');
            doc.fillColor('#000000').text(String(rowData[tci2] || ''), dCellX + 4, rowY + 6, { width: colWidth - 8 });
          }
          doc.y = rowY + maxRowHeight;
        }
        doc.moveDown(0.5);
        break;

      case 'hr':
        if (doc.y > doc.page.height - 60) doc.addPage();
        doc.moveTo(72, doc.y).lineTo(doc.page.width - 72, doc.y).strokeColor('#CCCCCC').lineWidth(1).stroke();
        doc.moveDown(0.5);
        break;

      case 'image':
        try {
          var pImgPath = block.src;
          // 校验图片路径，限制到工作区目录（process.cwd()）内，防止任意文件读取
          var _pImgResolved = path.resolve(pImgPath);
          var _pCwd = process.cwd();
          if (_pImgResolved !== _pCwd && _pImgResolved.indexOf(_pCwd + path.sep) !== 0) {
            _log('WARN', 'doc-writer: PDF图片路径超出工作区，已拒绝: ' + pImgPath);
            break;
          }
          if (fs.existsSync(pImgPath)) {
            if (doc.y > doc.page.height - 250) doc.addPage();
            var imgWidth = Math.min(460, pageWidth);
            doc.image(pImgPath, 72, doc.y, { width: imgWidth, align: 'center' });
            doc.moveDown(0.5);
          }
        } catch(pImgErr) {
          _log('WARN', 'doc-writer: PDF图片插入失败: ' + pImgErr.message);
        }
        break;
    }
  }

  // 页脚页码
  var range = doc.bufferedPageRange();
  for (var pg = range.start; pg <= range.start + range.count - 1; pg++) {
    doc.switchToPage(pg);
    doc.font(fontPath ? 'ChineseFont' : 'Helvetica').fontSize(9).fillColor('#999999').text('第 ' + (pg + 1) + ' 页 / 共 ' + range.count + ' 页', 72, doc.page.height - 50, { width: pageWidth, align: 'center' });
  }

  return doc;
}

// ══════════════════════════════════════════════════════════════
// XLSX 生成
// ══════════════════════════════════════════════════════════════

async function generateXlsx(options) {
  _log('INFO', 'doc-writer: 开始生成 XLSX');
  var XLSX;
  try { XLSX = require('xlsx'); } catch(e) { throw new Error('xlsx 模块不可用: ' + e.message); }

  var sheets = options.sheets || [];
  if (sheets.length === 0 && options.data) {
    // 简单模式：单 sheet
    sheets = [{ name: options.sheetName || 'Sheet1', data: options.data, headers: options.headers }];
  }
  if (sheets.length === 0) throw new Error('没有数据需要导出');

  var wb = XLSX.utils.book_new();

  for (var si = 0; si < sheets.length; si++) {
    var sheet = sheets[si];
    var ws;

    if (sheet.headers && sheet.data) {
      // headers + data 模式
      var aoa = [sheet.headers];
      for (var ri = 0; ri < sheet.data.length; ri++) {
        if (Array.isArray(sheet.data[ri])) {
          aoa.push(sheet.data[ri]);
        } else {
          // 对象模式
          var rowArr = sheet.headers.map(function(h) { return sheet.data[ri][h] !== undefined ? sheet.data[ri][h] : ''; });
          aoa.push(rowArr);
        }
      }
      ws = XLSX.utils.aoa_to_sheet(aoa);
    } else if (sheet.rows) {
      // rows 对象数组模式
      ws = XLSX.utils.json_to_sheet(sheet.rows);
    } else if (sheet.aoa || sheet.data) {
      // 纯数组模式
      ws = XLSX.utils.aoa_to_sheet(sheet.aoa || sheet.data);
    } else {
      ws = XLSX.utils.aoa_to_sheet([['(空表)']]);
    }

    // 列宽自适应（简单估算）
    if (sheet.headers) {
      var colWidths = sheet.headers.map(function(h, idx) {
        var maxLen = String(h).length;
        for (var dr = 0; dr < (sheet.data || []).length; dr++) {
          var cellVal = Array.isArray(sheet.data[dr]) ? sheet.data[dr][idx] : (sheet.data[dr] && sheet.data[dr][h]);
          var cellLen = cellVal !== undefined && cellVal !== null ? String(cellVal).length : 0;
          if (cellLen > maxLen) maxLen = cellLen;
        }
        return { wch: Math.min(Math.max(maxLen + 2, 8), 50) };
      });
      ws['!cols'] = colWidths;
    }

    var sheetName = sheet.name || ('Sheet' + (si + 1));
    // Excel sheet name 最多 31 字符，且不能包含特殊字符
    sheetName = sheetName.substring(0, 31).replace(/[\\\/\?\*\[\]:]/g, '_');
    XLSX.utils.book_append_sheet(wb, ws, sheetName);
  }

  var buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  return buffer;
}

// ══════════════════════════════════════════════════════════════
// PPTX 生成
// ══════════════════════════════════════════════════════════════

async function generatePptx(options) {
  _log('INFO', 'doc-writer: 开始生成 PPTX');
  var PptxGenJS;
  try { PptxGenJS = require('pptxgenjs'); } catch(e) { throw new Error('pptxgenjs 模块不可用: ' + e.message); }

  var pres = new PptxGenJS();
  pres.author = options.author || 'SkyalyticWing';
  pres.company = options.company || 'SkyalyticWing';
  pres.subject = options.title || 'Presentation';

  // 主题
  if (options.theme) {
    if (options.theme.masterName) pres.defineLayout({ name: 'CUSTOM', width: 13.333, height: 7.5 });
    if (options.theme.color) pres.theme = { color: options.theme.color };
  }

  // 定义母版
  pres.defineSlideMaster({
    title: 'SKY_MASTER',
    background: { color: 'FFFFFF' },
    objects: [
      { rect: { x: 0, y: 7.0, w: '100%', h: 0.5, fill: { color: options.theme && options.theme.color || '1a73e8' } } },
      { text: { text: options.author || 'SkyalyticWing', options: { x: 11.5, y: 7.05, w: 1.5, h: 0.3, fontSize: 8, color: 'FFFFFF', align: 'right' } } }
    ],
    slideNumber: { x: 0.5, y: 7.05, w: 1, h: 0.3, fontSize: 8, color: 'FFFFFF' }
  });

  var slides = options.slides || [];
  if (slides.length === 0 && options.content) {
    // 从 Markdown 内容生成幻灯片
    var blocks = parseMarkdown(options.content);
    var currentSlide = null;
    for (var bi = 0; bi < blocks.length; bi++) {
      var block = blocks[bi];
      if (block.type === 'heading' && block.level <= 2) {
        // 新幻灯片
        if (currentSlide) pres.addSlide(currentSlide);
        var slideTitle = (block.runs || []).map(function(r) { return r.text; }).join('');
        currentSlide = { masterName: 'SKY_MASTER', title: slideTitle, bullets: [] };
      } else if (currentSlide && (block.type === 'paragraph' || block.type === 'list')) {
        if (block.type === 'list') {
          for (var li = 0; li < block.items.length; li++) {
            currentSlide.bullets.push({ text: (block.items[li].runs || []).map(function(r) { return r.text; }).join(''), level: block.items[li].level || 0 });
          }
        } else {
          currentSlide.bullets.push({ text: (block.runs || []).map(function(r) { return r.text; }).join('') });
        }
      }
    }
    if (currentSlide) slides.push(currentSlide);
  }

  for (var si = 0; si < slides.length; si++) {
    var slideDef = slides[si];
    var slide = pres.addSlide({ masterName: slideDef.masterName || 'SKY_MASTER' });

    var layout = slideDef.layout || 'content';
    var themeColor = options.theme && options.theme.color || '1a73e8';

    if (layout === 'title') {
      // 标题页
      slide.addText(slideDef.title || '', { x: 0.5, y: 2.5, w: 12.3, h: 1.5, fontSize: 40, bold: true, color: themeColor, align: 'center' });
      if (slideDef.subtitle) {
        slide.addText(slideDef.subtitle, { x: 1, y: 4, w: 11.3, h: 1, fontSize: 22, color: '666666', align: 'center' });
      }
    } else if (layout === 'section') {
      // 章节页
      slide.addShape(pres.ShapeType.rect, { x: 0, y: 2.5, w: '100%', h: 2, fill: { color: themeColor } });
      slide.addText(slideDef.title || '', { x: 0.5, y: 2.8, w: 12.3, h: 1.4, fontSize: 36, bold: true, color: 'FFFFFF', align: 'center' });
    } else {
      // 内容页
      if (slideDef.title) {
        slide.addText(slideDef.title, { x: 0.5, y: 0.3, w: 12.3, h: 0.8, fontSize: 28, bold: true, color: themeColor });
        // 标题下划线
        slide.addShape(pres.ShapeType.line, { x: 0.5, y: 1.1, w: 12.3, h: 0, line: { color: themeColor, width: 2 } });
      }

      var contentY = 1.3;
      if (slideDef.bullets && slideDef.bullets.length > 0) {
        // 要点列表
        var bulletText = slideDef.bullets.map(function(b) {
          var prefix = '';
          for (var bl = 0; bl < (b.level || 0); bl++) prefix += '  ';
          return prefix + (b.level > 0 ? '– ' : '• ') + b.text;
        }).join('\n');
        slide.addText(bulletText, {
          x: 0.5, y: contentY, w: 12.3, h: 5.5,
          fontSize: 18, color: '333333', lineSpacingMultiple: 1.5,
          valign: 'top'
        });
      } else if (slideDef.content) {
        // 文本内容
        var contentBlocks = typeof slideDef.content === 'string' ? parseMarkdown(slideDef.content) : [];
        var allText = [];
        for (var cb = 0; cb < contentBlocks.length; cb++) {
          var cbItem = contentBlocks[cb];
          if (cbItem.type === 'paragraph' || cbItem.type === 'heading') {
            allText.push((cbItem.runs || []).map(function(r) { return r.text; }).join(''));
          } else if (cbItem.type === 'list') {
            for (var cl = 0; cl < cbItem.items.length; cl++) {
              allText.push('• ' + (cbItem.items[cl].runs || []).map(function(r) { return r.text; }).join(''));
            }
          } else if (cbItem.type === 'code') {
            allText.push(cbItem.content);
          }
        }
        slide.addText(allText.join('\n\n'), {
          x: 0.5, y: contentY, w: 12.3, h: 5.5,
          fontSize: 16, color: '333333', lineSpacingMultiple: 1.3,
          valign: 'top'
        });
      }

      // 表格
      if (slideDef.table) {
        var tableData = [];
        if (slideDef.table.headers) {
          tableData.push(slideDef.table.headers.map(function(h) { return { text: h, options: { bold: true, fill: { color: 'D9E2F3' }, align: 'center' } }; }));
        }
        for (var tr = 0; tr < (slideDef.table.rows || []).length; tr++) {
          tableData.push(slideDef.table.rows[tr].map(function(c) { return { text: String(c) }; }));
        }
        slide.addTable(tableData, { x: 0.5, y: contentY, w: 12.3, fontSize: 14, border: { type: 'solid', color: 'CCCCCC' } });
      }

      // 图片
      if (slideDef.image) {
        try {
          var imgData;
          if (fs.existsSync(slideDef.image.path || slideDef.image)) {
            var imgPath = slideDef.image.path || slideDef.image;
            imgData = 'image/' + _ext(imgPath).substring(1) + ',' + fs.readFileSync(imgPath).toString('base64');
          } else if (slideDef.image.data) {
            imgData = slideDef.image.data;
          }
          if (imgData) {
            slide.addImage({ data: imgData, x: slideDef.image.x || 1, y: slideDef.image.y || contentY, w: slideDef.image.w || 8, h: slideDef.image.h || 4 });
          }
        } catch(pptxImgErr) {
          _log('WARN', 'doc-writer: PPTX图片插入失败: ' + pptxImgErr.message);
        }
      }

      // 备注
      if (slideDef.notes) {
        slide.addNotes(slideDef.notes);
      }
    }
  }

  // 返回 buffer
  var result = await pres.write({ outputType: 'nodebuffer' });
  return result;
}

// ══════════════════════════════════════════════════════════════
// 统一入口
// ══════════════════════════════════════════════════════════════

/**
 * 生成文档
 * @param {string} format - 'docx' | 'pdf' | 'xlsx' | 'pptx'
 * @param {object} options - 文档选项（content/sheets/slides 等）
 * @param {string} outputPath - 输出文件路径（可选，不传则返回 buffer）
 * @returns {Promise<{ok, path?, buffer?, size, format, type}>}
 */
async function generateDocument(format, options, outputPath) {
  options = options || {};
  format = (format || '').toLowerCase();

  _log('INFO', 'doc-writer: generateDocument format=' + format + ' outputPath=' + (outputPath || '(none)'));

  var buffer;

  switch (format) {
    case 'docx':
      buffer = await generateDocx(options);
      break;
    case 'pdf':
      var pdfDoc = await generatePdf(options);
      // PDF 需要流式输出
      if (outputPath) {
        try { _ensureDir(outputPath); } catch(dirErr) { return { ok: false, error: '创建目录失败: ' + dirErr.message }; }
        return new Promise(function(resolve, reject) {
          var chunks = [];
          pdfDoc.on('data', function(chunk) { chunks.push(chunk); });
          pdfDoc.on('end', function() {
            var buf = Buffer.concat(chunks);
            try {
              fs.writeFileSync(outputPath, buf);
              _log('INFO', 'doc-writer: PDF 已保存到 ' + outputPath + ' (' + buf.length + ' bytes)');
              resolve({ ok: true, path: outputPath, size: buf.length, format: 'pdf', type: 'application/pdf' });
            } catch(writeErr) {
              _log('ERROR', 'doc-writer: PDF 写入失败: ' + writeErr.message);
              reject(writeErr);
            }
          });
          pdfDoc.on('error', reject);
          pdfDoc.end();
        });
      } else {
        return new Promise(function(resolve, reject) {
          var chunks = [];
          pdfDoc.on('data', function(chunk) { chunks.push(chunk); });
          pdfDoc.on('end', function() {
            var buf = Buffer.concat(chunks);
            resolve({ ok: true, buffer: buf, size: buf.length, format: 'pdf', type: 'application/pdf' });
          });
          pdfDoc.on('error', reject);
          pdfDoc.end();
        });
      }
      break;
    case 'xlsx':
      buffer = await generateXlsx(options);
      break;
    case 'pptx':
      buffer = await generatePptx(options);
      break;
    default:
      throw new Error('不支持的格式: ' + format + '（支持 docx/pdf/xlsx/pptx）');
  }

  // 保存到文件
  if (outputPath) {
    try {
      _ensureDir(outputPath);
      fs.writeFileSync(outputPath, buffer);
    } catch(writeErr) {
      _log('ERROR', 'doc-writer: ' + format.toUpperCase() + ' 写入失败: ' + writeErr.message);
      return { ok: false, error: '文件写入失败: ' + writeErr.message };
    }
    _log('INFO', 'doc-writer: ' + format.toUpperCase() + ' 已保存到 ' + outputPath + ' (' + buffer.length + ' bytes)');
    return { ok: true, path: outputPath, size: buffer.length, format: format, type: _getMimeType(format) };
  }

  return { ok: true, buffer: buffer, size: buffer.length, format: format, type: _getMimeType(format) };
}

function _getMimeType(format) {
  var mimes = { docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', pdf: 'application/pdf', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' };
  return mimes[format] || 'application/octet-stream';
}

module.exports = {
  // 标记为库模块：被 start.cjs 直接 require 使用，不应被 ToolLoader 当作独立工具加载（避免每次启动输出 "No valid tool modules found" 警告）
  _notTools: true,
  setLogger: setLogger,
  parseMarkdown: parseMarkdown,
  parseInline: parseInline,
  findChineseFont: findChineseFont,
  generateDocx: generateDocx,
  generatePdf: generatePdf,
  generateXlsx: generateXlsx,
  generatePptx: generatePptx,
  generateDocument: generateDocument
};
