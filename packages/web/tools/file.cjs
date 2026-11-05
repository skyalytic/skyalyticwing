/**
 * 文件类工具模块
 * 从 start.cjs 提取的文件操作工具集合
 *
 * 工具列表: file_read, file_write, file_edit, file_delete, glob, grep, directory_list, apply_patch, diff
 *
 * 每个工具的 execute 签名: function(args, ctx)
 * 通过 ctx 注入依赖: fs, path, APP_DIR, DATA_DIR, WORKSPACE_OUTPUT_DIR, fuzzyReplace, getWorkspaceOutputPath 等
 */

// Zip Slip 防护辅助函数 — 递归遍历 tmpDir 下所有条目，
// 校验每个文件的 resolved path 和符号链接目标均仍在 tmpDir 内。
// 若发现任何越界路径，抛出错误阻止后续读取（防御恶意 ZIP 条目含 ../ 或符号链接逃逸）。
function _verifyExtractedPathsInTmp(tmpDir, fsMod, pathMod) {
  var tmpResolved = pathMod.resolve(tmpDir);
  var prefix = tmpResolved + pathMod.sep;
  function _walk(dir) {
    var entries;
    try { entries = fsMod.readdirSync(dir, { withFileTypes: true }); } catch(e) { return; }
    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i];
      var fullPath = pathMod.join(dir, entry.name);
      var resolved = pathMod.resolve(fullPath);
      if (resolved !== tmpResolved && resolved.indexOf(prefix) !== 0) {
        throw new Error('Zip Slip detected: file path escapes tmpDir: ' + resolved);
      }
      // 符号链接可能指向 tmpDir 之外，需校验其 target
      if (entry.isSymbolicLink && entry.isSymbolicLink()) {
        var linkTarget = fsMod.readlinkSync(fullPath);
        var resolvedTarget = pathMod.resolve(dir, linkTarget);
        if (resolvedTarget !== tmpResolved && resolvedTarget.indexOf(prefix) !== 0) {
          throw new Error('Zip Slip detected: symlink target escapes tmpDir: ' + resolvedTarget);
        }
      }
      if (entry.isDirectory()) _walk(fullPath);
    }
  }
  _walk(tmpDir);
}

// 辅助函数：从 Office 文档（DOCX/XLSX/PPTX）中提取文本（ZIP解压+XML解析）
function _extractOfficeDocText(filePath, ext, fsMod, pathMod) {
  var os = require('os');
  var execSync = require('child_process').execSync;
  var tmpDir = pathMod.join(os.tmpdir(), 'sc-office-' + Date.now() + '-' + Math.random().toString(36).substr(2,6));
  fsMod.mkdirSync(tmpDir, { recursive: true });
  try {
    var execFileSync = require('child_process').execFileSync;
    execFileSync('tar', ['-xf', filePath, '-C', tmpDir], { timeout: 30000, encoding: 'utf8' });
    // Zip Slip 防护 — 解压后遍历所有文件，校验 resolved path 仍在 tmpDir 内
    // 防止恶意 ZIP 条目含 ../ 路径或符号链接将文件提取到 tmpDir 之外（任意文件写入）
    _verifyExtractedPathsInTmp(tmpDir, fsMod, pathMod);

    if (ext === '.docx') {
      var docXml = pathMod.join(tmpDir, 'word', 'document.xml');
      if (!fsMod.existsSync(docXml)) return '(无法找到 word/document.xml)';
      var docContent = fsMod.readFileSync(docXml, 'utf-8');
      var docLines = [];
      var docParts = docContent.split('</w:p>');
      for (var di = 0; di < docParts.length; di++) {
        var docTexts = [];
        var docRe = /<w:t[^>]*>([^<]*)<\/w:t>/g;
        var docMatch;
        while ((docMatch = docRe.exec(docParts[di])) !== null) docTexts.push(docMatch[1]);
        if (docTexts.length > 0) docLines.push(docTexts.join(''));
      }
      return docLines.join('\n') || '(文档为空或无法提取文本)';
    }

    if (ext === '.xlsx') {
      var ssXml = pathMod.join(tmpDir, 'xl', 'sharedStrings.xml');
      var ssStrings = [];
      if (fsMod.existsSync(ssXml)) {
        var ssContent = fsMod.readFileSync(ssXml, 'utf-8');
        var ssRe = /<si[^>]*>([\s\S]*?)<\/si>/g;
        var ssMatch;
        while ((ssMatch = ssRe.exec(ssContent)) !== null) {
          var siTexts = [];
          var siRe = /<t[^>]*>([^<]*)<\/t>/g;
          var siMatch;
          while ((siMatch = siRe.exec(ssMatch[1])) !== null) siTexts.push(siMatch[1]);
          ssStrings.push(siTexts.join(''));
        }
      }
      var sheetsDir = pathMod.join(tmpDir, 'xl', 'worksheets');
      var sheetFiles = [];
      if (fsMod.existsSync(sheetsDir)) {
        sheetFiles = fsMod.readdirSync(sheetsDir).filter(function(f) { return /^sheet\d+\.xml$/.test(f); }).sort(function(a,b){ return parseInt(a.match(/\d+/)[0])-parseInt(b.match(/\d+/)[0]); });
      }
      var xlsxLines = [];
      for (var si = 0; si < sheetFiles.length; si++) {
        var sheetPath = pathMod.join(sheetsDir, sheetFiles[si]);
        var sheetXml = fsMod.readFileSync(sheetPath, 'utf-8');
        xlsxLines.push('=== Sheet ' + (si + 1) + ' ===');
        var rowRe = /<row[^>]*>([\s\S]*?)<\/row>/g;
        var rowMatch;
        while ((rowMatch = rowRe.exec(sheetXml)) !== null) {
          var cellTexts = [];
          var cellRe = /<c[^>]*?(?:\st="(\w+)")?[^>]*>(?:<v>([^<]*)<\/v>)?<\/c>/g;
          var cellMatch;
          while ((cellMatch = cellRe.exec(rowMatch[1])) !== null) {
            var cellType = cellMatch[1] || '';
            var cellVal = cellMatch[2] || '';
            if (cellType === 's' && ssStrings[parseInt(cellVal)]) cellTexts.push(ssStrings[parseInt(cellVal)]);
            else if (cellVal) cellTexts.push(cellVal);
          }
          if (cellTexts.length > 0) xlsxLines.push(cellTexts.join('\t'));
        }
      }
      return xlsxLines.join('\n') || '(表格为空或无法提取文本)';
    }

    if (ext === '.pptx') {
      var slidesDir = pathMod.join(tmpDir, 'ppt', 'slides');
      var slideFiles = [];
      if (fsMod.existsSync(slidesDir)) {
        slideFiles = fsMod.readdirSync(slidesDir).filter(function(f) { return /^slide\d+\.xml$/.test(f); }).sort(function(a,b){ return parseInt(a.match(/\d+/)[0])-parseInt(b.match(/\d+/)[0]); });
      }
      var pptxLines = [];
      for (var pi = 0; pi < slideFiles.length; pi++) {
        var slidePath = pathMod.join(slidesDir, slideFiles[pi]);
        var slideXml = fsMod.readFileSync(slidePath, 'utf-8');
        pptxLines.push('=== Slide ' + (pi + 1) + ' ===');
        var slideTexts = [];
        var slideRe = /<a:t[^>]*>([^<]*)<\/a:t>/g;
        var slideMatch;
        while ((slideMatch = slideRe.exec(slideXml)) !== null) slideTexts.push(slideMatch[1]);
        if (slideTexts.length > 0) pptxLines.push(slideTexts.join('\n'));
      }
      return pptxLines.join('\n') || '(演示文稿为空或无法提取文本)';
    }

    return '(不支持的格式: ' + ext + ')';
  } finally {
    try { fsMod.rmSync(tmpDir, { recursive: true, force: true }); } catch(e) {}
  }
}

module.exports = [

  // ═══ file_read ═══
  {
    name: 'file_read',
    description: '读取文件内容并返回文本。支持PDF/DOCX/XLSX/PPTX办公文档自动解析提取文字。用这个工具而不是bash的cat/head/tail。路径需通过安全策略校验。大文件可用limit参数限制行数。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径(支持.pdf/.docx/.xlsx/.pptx/.txt/.js/.json/.md等所有格式，绝对或相对路径均可，需通过安全策略校验)' },
        encoding: { type: 'string', description: '编码，默认utf-8' },
        limit: { type: 'number', description: '最大读取行数(大文件时使用)' }
      },
      required: ['path']
    },
    category: 'file',
    dangerous: false,
    execute: async function(args, ctx) {
      var fs = ctx.fs, path = ctx.path;
      var filePath = path.resolve(process.cwd(), args.path || '');
      // 添加 SecurityManager.isPathAllowed() 路径校验，与 file_write/file_edit/file_delete 保持一致
      var SecurityManager = ctx.SecurityManager;
      if (!SecurityManager || typeof SecurityManager.isPathAllowed !== 'function') {
        return { success:false, error:'SecurityManager not available', blocked: true };
      }
      if (!SecurityManager.isPathAllowed(filePath, 'read')) {
        return { success:false, error:'路径被安全策略拒绝: ' + filePath, blocked: true };
      }
      if (!fs.existsSync(filePath)) return { success:false, error:'文件不存在: '+filePath };
      var ext = path.extname(filePath).toLowerCase();
      var limit = args.limit;
      // fix(第十三轮): 文件大小检查，防止 OOM
      var FILE_READ_MAX_SIZE = 50 * 1024 * 1024; // 50MB
      try {
        var _fileStat = fs.statSync(filePath);
        if (_fileStat.size > FILE_READ_MAX_SIZE) {
          return { success:false, error:'文件过大(' + (_fileStat.size / 1024 / 1024).toFixed(1) + 'MB)，超过50MB限制。请使用grep工具搜索或指定更小的limit' };
        }
      } catch(statErr) {
        return { success:false, error:'无法获取文件信息: ' + statErr.message };
      }

      // PDF 文件：使用 pdf-parse 提取文本
      if (ext === '.pdf') {
        try {
          var pdfParse = require('pdf-parse');
          var pdfBuffer = fs.readFileSync(filePath);
          var pdfResult = await pdfParse(pdfBuffer);
          var pdfText = (pdfResult.text || '').trim();
          if (!pdfText || pdfText.length < 10) {
            return { success:false, error:'PDF为扫描版（图片型），无法提取文字层。页数: '+(pdfResult.numpages||'?')+'，需要OCR处理' };
          }
          if (limit && pdfText.split('\n').length > limit) pdfText = pdfText.split('\n').slice(0, limit).join('\n') + '\n... (truncated)';
          return { success:true, content:pdfText, size:Buffer.byteLength(pdfText,'utf-8'), path:filePath, type:'pdf', pages:pdfResult.numpages||0 };
        } catch(pdfErr) {
          return { success:false, error:'PDF解析失败: '+pdfErr.message };
        }
      }

      // DOCX/XLSX/PPTX 文件：解压ZIP + 提取XML文本
      if (ext === '.docx' || ext === '.xlsx' || ext === '.pptx') {
        try {
          var officeText = _extractOfficeDocText(filePath, ext, fs, path);
          if (limit && officeText.split('\n').length > limit) officeText = officeText.split('\n').slice(0, limit).join('\n') + '\n... (truncated)';
          return { success:true, content:officeText, size:Buffer.byteLength(officeText,'utf-8'), path:filePath, type:ext.substring(1) };
        } catch(officeErr) {
          return { success:false, error:ext.substring(1).toUpperCase()+'解析失败: '+officeErr.message };
        }
      }

      // 普通文本文件
      var content = fs.readFileSync(filePath, args.encoding || 'utf-8');
      if (limit && content.split('\n').length > limit) content = content.split('\n').slice(0, limit).join('\n') + '\n... (truncated)';
      return { success:true, content:content, size:Buffer.byteLength(content,'utf-8'), path:filePath };
    }
  },

  // ═══ file_write ═══
  {
    name: 'file_write',
    description: '创建新文件或覆盖写入内容。用这个工具而不是bash的echo/cat/heredoc。路径无硬性限制，敏感路径通过审批系统确认。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件绝对路径' },
        content: { type: 'string', description: '文件内容' },
        mode: { type: 'string', enum: ['utf8','base64'], description: '写入模式' }
      },
      required: ['path','content']
    },
    category: 'file',
    dangerous: true,
    execute: function(args, ctx) {
      var fs = ctx.fs, path = ctx.path;
      var APP_DIR = ctx.APP_DIR;
      var getWorkspaceOutputPath = ctx.getWorkspaceOutputPath;
      var writePath = args.path ? path.resolve(process.cwd(), args.path) : getWorkspaceOutputPath('file-' + Date.now() + '.txt');
      // 安全策略校验：防止路径穿越到系统敏感目录
      // 默认拒绝——SecurityManager 不存在或方法不可用时拒绝写入（而非静默放行）
      var SecurityManager = ctx.SecurityManager;
      if (!SecurityManager || typeof SecurityManager.isPathAllowed !== 'function') {
        return { success:false, error:'SecurityManager not available', blocked: true };
      }
      if (!SecurityManager.isPathAllowed(writePath, 'write')) {
        return { success:false, error:'路径被安全策略拒绝: ' + writePath, blocked: true };
      }
      var dir = path.dirname(writePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive:true });
      fs.writeFileSync(writePath, args.content || '', 'utf-8');
      return { success:true, bytesWritten:Buffer.byteLength(args.content||'','utf-8'), path:writePath };
    }
  },

  // ═══ file_edit ═══
  {
    name: 'file_edit',
    description: '编辑文件（正则替换）',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径' },
        searchPattern: { type: 'string', description: '搜索正则表达式' },
        replacement: { type: 'string', description: '替换文本' },
        flags: { type: 'string', description: '正则标志' }
      },
      required: ['path','searchPattern','replacement']
    },
    category: 'file',
    dangerous: true,
    execute: function(args, ctx) {
      var fs = ctx.fs, path = ctx.path;
      var WORKSPACE_OUTPUT_DIR = ctx.WORKSPACE_OUTPUT_DIR;
      var DATA_DIR = ctx.DATA_DIR;
      var fuzzyReplace = ctx.fuzzyReplace;
      var _fePath = args.file_path || args.path || '';
      var _feOld = args.old_string || args.search || args.oldString || '';
      var _feNew = args.new_string || args.replace || args.newString || '';
      var _feReplaceAll = args.replace_all || args.replaceAll || false;
      if (!_fePath || !_feOld) return {ok:false,error:'请提供file_path和old_string'};
      var _feResolved = path.resolve(_fePath);
      // 安全策略校验：防止路径穿越到系统敏感目录
      // 默认拒绝——SecurityManager 不存在或方法不可用时拒绝写入（而非静默放行）
      var SecurityManager = ctx.SecurityManager;
      if (!SecurityManager || typeof SecurityManager.isPathAllowed !== 'function') {
        return {ok:false, error:'SecurityManager not available', blocked: true};
      }
      if (!SecurityManager.isPathAllowed(_feResolved, 'write')) {
        return {ok:false, error:'路径被安全策略拒绝: ' + _feResolved, blocked: true};
      }
      try {
        if (!fs.existsSync(_feResolved)) return {ok:false,error:'文件不存在: '+_fePath};
        var _feContent = fs.readFileSync(_feResolved, 'utf8');
        var _feResult = fuzzyReplace(_feContent, _feOld, _feNew, _feReplaceAll);
        if (!_feResult.ok) return _feResult;
        fs.writeFileSync(_feResolved, _feResult.result, 'utf8');
        return {ok:true, file:_feResolved, method:_feResult.method, count:_feResult.count||1, similarity:_feResult.similarity};
      } catch(e) { return {ok:false,error:'文件编辑失败: '+e.message}; }
    }
  },

  // ═══ file_delete ═══
  {
    name: 'file_delete',
    description: '删除文件。用这个工具而不是bash的rm。敏感路径通过审批系统确认。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '要删除的文件绝对路径' }
      },
      required: ['path']
    },
    category: 'file',
    dangerous: true,
    execute: function(args, ctx) {
      var fs = ctx.fs, path = ctx.path;
      var delPath = path.resolve(process.cwd(), args.path || '');
      // 安全策略校验：防止路径穿越到系统敏感目录
      // 默认拒绝——SecurityManager 不存在或方法不可用时拒绝删除（而非静默放行）
      var SecurityManager = ctx.SecurityManager;
      if (!SecurityManager || typeof SecurityManager.isPathAllowed !== 'function') {
        return { success:false, error:'SecurityManager not available', blocked: true };
      }
      if (!SecurityManager.isPathAllowed(delPath, 'write')) {
        return { success:false, error:'路径被安全策略拒绝: ' + delPath, blocked: true };
      }
      if (!fs.existsSync(delPath)) return { success:false, error:'文件不存在: '+delPath };
      fs.unlinkSync(delPath);
      return { success:true, deletedPath:delPath };
    }
  },

  // ═══ glob ═══
  {
    name: 'glob',
    description: '按模式查找文件（支持通配符*?**）。用这个工具而不是bash的find/ls。路径需通过安全策略校验，按修改时间排序返回。',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '文件名模式如*.ts, **/*.js' },
        directory: { type: 'string', description: '搜索根目录' },
        ignore: { type: 'array', items: { type: 'string' }, description: '忽略的模式' }
      },
      required: ['pattern']
    },
    category: 'file',
    dangerous: false,
    execute: function(args, ctx) {
      var fs = ctx.fs, path = ctx.path;
      var _globToRegex = ctx._globToRegex;
      var globDir = path.resolve(process.cwd(), args.directory || '.');
      // 添加 SecurityManager.isPathAllowed() 路径校验
      var SecurityManager = ctx.SecurityManager;
      if (!SecurityManager || typeof SecurityManager.isPathAllowed !== 'function') {
        return { success:false, error:'SecurityManager not available', blocked: true };
      }
      if (!SecurityManager.isPathAllowed(globDir, 'read')) {
        return { success:false, error:'路径被安全策略拒绝: ' + globDir, blocked: true };
      }
      var pattern = args.pattern || '*';
      var results = [];
      function walk(dir, depth) {
        depth = depth || 0;
        if (depth > 15) return;
        if (!fs.existsSync(dir)) return;
        fs.readdirSync(dir).forEach(function(f) {
          if (f === 'node_modules' || f === '.git') return;
          var full = path.join(dir,f);
          var stat = fs.statSync(full);
          if (stat.isDirectory()) walk(full, depth + 1);
          else { var re = (typeof _globToRegex === 'function') ? _globToRegex(pattern) : new RegExp('^'+pattern.replace(/[.+^${}()|[\]\\]/g,'\\$&').replace(/\*/g,'.*').replace(/\?/g,'.')+'$'); if(re.test(f)) results.push(full); }
        });
      }
      walk(globDir, 0);
      return { success:true, files:results, count:results.length };
    }
  },

  // ═══ grep ═══
  {
    name: 'grep',
    description: '在文件中搜索文本模式（支持正则表达式）。用这个工具而不是bash的grep/rg。路径需通过安全策略校验，可指定文件类型和上下文行数。',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '搜索的正则表达式' },
        directory: { type: 'string', description: '搜索目录' },
        glob: { type: 'string', description: '文件名过滤如*.ts' },
        contextLines: { type: 'number', description: '上下文行数，默认2' }
      },
      required: ['pattern']
    },
    category: 'file',
    dangerous: false,
    execute: function(args, ctx) {
      var fs = ctx.fs, path = ctx.path;
      var grepDir = path.resolve(process.cwd(), args.directory || '.');
      // 添加 SecurityManager.isPathAllowed() 路径校验
      var SecurityManager = ctx.SecurityManager;
      if (!SecurityManager || typeof SecurityManager.isPathAllowed !== 'function') {
        return { success:false, error:'SecurityManager not available', blocked: true };
      }
      if (!SecurityManager.isPathAllowed(grepDir, 'read')) {
        return { success:false, error:'路径被安全策略拒绝: ' + grepDir, blocked: true };
      }
      var grepPattern = args.pattern || '';
      var _safeGrepPattern = grepPattern;
      if (_safeGrepPattern.length > 200) _safeGrepPattern = _safeGrepPattern.substring(0, 200);
      if (/\([^)]*[+*][^)]*\)[+*{]/.test(_safeGrepPattern) || /(\+|\*)\1/.test(_safeGrepPattern)) {
        _safeGrepPattern = _safeGrepPattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      }
      // grep 无文件大小限制（OOM）——读取大文件前先检查 stat.size，超过 50MB 跳过
      var GREP_MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB
      var _skipped = [];
      var grepResults = [];
      function grepWalk(dir, depth) {
        depth = depth || 0;
        if (depth > 15) return;
        if (!fs.existsSync(dir)) return;
        fs.readdirSync(dir).forEach(function(f) {
          if (f === 'node_modules' || f === '.git') return;
          var full = path.join(dir,f);
          try {
            var stat = fs.statSync(full);
            if (stat.isDirectory()) grepWalk(full, depth + 1);
            else {
              // 大文件跳过，避免 readFileSync OOM
              if (stat.size > GREP_MAX_FILE_SIZE) {
                _skipped.push({ file: full, size: stat.size, reason: 'exceeds 50MB limit (M-C4)' });
                return;
              }
              var c = fs.readFileSync(full,'utf-8');
              var lines = c.split('\n');
              lines.forEach(function(line,idx){
                if (line.match(new RegExp(_safeGrepPattern))) grepResults.push({file:full,line:idx+1,content:line.trim()});
              });
            }
          } catch(e){}
        });
      }
      grepWalk(grepDir, 0);
      return { success:true, matches:grepResults, count:grepResults.length, skipped: _skipped };
    }
  },

  // ═══ directory_list ═══
  {
    name: 'directory_list',
    description: '列出目录内容（文件和文件夹）。用这个工具而不是bash的ls。路径需通过安全策略校验，一次调用看到全部文件，避免多次glob尝试不同格式。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '目录路径' },
        showHidden: { type: 'boolean', description: '显示隐藏文件' },
        depth: { type: 'number', description: '递归深度，默认1' }
      }
    },
    category: 'file',
    dangerous: false,
    execute: function(args, ctx) {
      var fs = ctx.fs, path = ctx.path;
      var listDir = path.resolve(process.cwd(), args.path || '.');
      // 添加 SecurityManager.isPathAllowed() 路径校验
      var SecurityManager = ctx.SecurityManager;
      if (!SecurityManager || typeof SecurityManager.isPathAllowed !== 'function') {
        return { success:false, error:'SecurityManager not available', blocked: true };
      }
      if (!SecurityManager.isPathAllowed(listDir, 'read')) {
        return { success:false, error:'路径被安全策略拒绝: ' + listDir, blocked: true };
      }
      if (!fs.existsSync(listDir)) return { success:false, error:'目录不存在: '+listDir };
      var entries = fs.readdirSync(listDir, { withFileTypes:true }).map(function(e){
        return { name:e.name, type:e.isDirectory()?'directory':'file', size:e.isFile()?fs.statSync(path.join(listDir,e.name)).size:0 };
      });
      return { success:true, path:listDir, entries:entries, total:entries.length };
    }
  },

  // ═══ apply_patch ═══
  {
    name: 'apply_patch',
    description: '应用多块文件补丁。一次编辑文件中的多个位置，比file_edit更高效。每个补丁包含search和replace对。支持unified diff格式和模糊匹配（对齐Hermes-Agent patch_parser.py）。',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: '文件绝对路径' },
        patches: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              search: { type: 'string', description: '要查找的文本' },
              replace: { type: 'string', description: '替换后的文本' }
            },
            required: ['search','replace']
          },
          description: '补丁列表，每个包含search和replace'
        },
        unified_diff: { type: 'string', description: '可选：unified diff格式补丁（与patches二选一）' }
      },
      required: ['file_path']
    },
    category: 'file',
    dangerous: true,
    execute: function(args, ctx) {
      var fs = ctx.fs, path = ctx.path;
      var SafetyManager = ctx.SafetyManager;
      var _apPath = args.file_path || args.path || '';
      var _apResolvedPath = path.resolve(process.cwd(), _apPath);
      var _apPatches = args.patches || [];
      var _apDiff = args.unified_diff || args.diff || '';
      if (!_apPath) return {ok:false,error:'缺少file_path'};
      if (_apPatches.length === 0 && !_apDiff) return {ok:false,error:'缺少patches或unified_diff'};
      // apply_patch 标记为 dangerous:true 但此前无任何 SecurityManager.isPathAllowed 校验，
      // 形成 C5 绕过（file_write/edit/delete 都有检查，apply_patch 没有）。
      // 这里采用与其他三个工具一致的默认拒绝语义（与 H-C3 一并修复）：SecurityManager 不可用时拒绝执行。
      var SecurityManager = ctx.SecurityManager;
      if (!SecurityManager || typeof SecurityManager.isPathAllowed !== 'function') {
        return {ok:false, error:'SecurityManager not available', blocked: true};
      }
      if (!SecurityManager.isPathAllowed(_apResolvedPath, 'readwrite')) {
        return {ok:false, error:'路径被安全策略拒绝: ' + _apResolvedPath, blocked: true};
      }
      try {
        if (!fs.existsSync(_apResolvedPath)) return {ok:false,error:'文件不存在: '+_apPath};
        var _apContent = fs.readFileSync(_apResolvedPath, 'utf-8');
        var _apApplied = 0;

        // 模式 1: unified diff 格式（对齐 Hermes-Agent patch_parser.py）
        if (_apDiff && SafetyManager && typeof SafetyManager.parseUnifiedDiff === 'function') {
          var _hunks = SafetyManager.parseUnifiedDiff(_apDiff);
          if (_hunks.length > 0) {
            _apContent = SafetyManager.applyHunks(_apContent, _hunks);
            _apApplied = _hunks.length;
          }
        }

        // 模式 2: search/replace 补丁列表
        for (var _api = 0; _api < _apPatches.length; _api++) {
          var _apPatch = _apPatches[_api];
          if (_apContent.indexOf(_apPatch.search) >= 0) {
            _apContent = _apContent.replace(_apPatch.search, _apPatch.replace);
            _apApplied++;
          } else if (SafetyManager && typeof SafetyManager.fuzzyFind === 'function') {
            // 模糊匹配兜底（对齐 Hermes-Agent fuzzy_match.py）
            var _fuzzy = SafetyManager.fuzzyFind(_apContent, _apPatch.search, Math.floor(_apPatch.search.length * 0.15));
            if (_fuzzy.found) {
              _apContent = _apContent.substring(0, _fuzzy.start) + _apPatch.replace + _apContent.substring(_fuzzy.start + _fuzzy.match.length);
              _apApplied++;
            }
          }
        }
        fs.writeFileSync(_apResolvedPath, _apContent);
        return {ok:true,applied:_apApplied,total:_apPatches.length||_apApplied,file:_apPath};
      } catch(e) { return {ok:false,error:e.message}; }
    }
  },

  // ═══ diff ═══
  {
    name: 'diff',
    description: '比较两个文件或文本的差异。支持unified diff格式输出，用于代码审查和变更追踪。',
    parameters: {
      type: 'object',
      properties: {
        file1: { type: 'string', description: '第一个文件路径' },
        file2: { type: 'string', description: '第二个文件路径' },
        text1: { type: 'string', description: '第一段文本（与file1二选一）' },
        text2: { type: 'string', description: '第二段文本（与file2二选一）' },
        contextLines: { type: 'number', description: '上下文行数，默认3' },
        label1: { type: 'string', description: '第一个文件标签' },
        label2: { type: 'string', description: '第二个文件标签' }
      },
      required: []
    },
    category: 'file',
    dangerous: false,
    execute: function(args, ctx) {
      var fs = ctx.fs, path = ctx.path;
      try {
        var _diffT1 = args.text1, _diffT2 = args.text2;
        var _diffCwdBase = path.resolve(process.cwd()) + path.sep;
        if (args.file1) { var _df1 = path.resolve(args.file1); if (_df1 !== path.resolve(process.cwd()) && _df1.indexOf(_diffCwdBase) !== 0) return {ok:false,error:'路径不允许: 仅限当前工作目录'}; if (fs.existsSync(_df1)) { try { _diffT1 = fs.readFileSync(_df1, 'utf-8'); } catch(e) { return {ok:false,error:'无法读取文件1: '+e.message}; } } }
        if (args.file2) { var _df2 = path.resolve(args.file2); if (_df2 !== path.resolve(process.cwd()) && _df2.indexOf(_diffCwdBase) !== 0) return {ok:false,error:'路径不允许: 仅限当前工作目录'}; if (fs.existsSync(_df2)) { try { _diffT2 = fs.readFileSync(_df2, 'utf-8'); } catch(e) { return {ok:false,error:'无法读取文件2: '+e.message}; } } }
        if (!_diffT1 && !_diffT2) return {ok:false,error:'请提供file1/file2或text1/text2'};
        var _diffCtx = args.contextLines || 3;
        var _l1 = (_diffT1||'').split('\n'), _l2 = (_diffT2||'').split('\n');
        var _diffOutput = [], _diffChanges = 0;
        var _max = Math.max(_l1.length, _l2.length);
        for (var _di = 0; _di < _max; _di++) {
          var _dl1 = _di < _l1.length ? _l1[_di] : undefined;
          var _dl2 = _di < _l2.length ? _l2[_di] : undefined;
          if (_dl1 !== _dl2) {
            _diffChanges++;
            if (_dl1 !== undefined) _diffOutput.push('- ' + (_di+1) + ': ' + _dl1);
            if (_dl2 !== undefined) _diffOutput.push('+ ' + (_di+1) + ': ' + _dl2);
          }
        }
        return {ok:true, changes:_diffChanges, diff:_diffOutput.join('\n'), file1Lines:_l1.length, file2Lines:_l2.length};
      } catch(e) { return {ok:false,error:e.message}; }
    }
  }

];
