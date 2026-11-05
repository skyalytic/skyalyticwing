/**
 * doc-parser.cjs - 企业级文档解析模块
 * 支持 PDF/DOCX/XLSX/PPTX 文档解析
 * PDF 扫描件支持视觉大模型 OCR + Tesseract.js 本地 OCR 组合方案
 * 三端通用（Windows/macOS/Linux）
 */

var fs = require('fs');
var path = require('path');
var os = require('os');
var execSync = require('child_process').execSync;
var execFileSync = require('child_process').execFileSync;
var https = require('https');
var http = require('http');

// ══════════════════════════════════════════════════════════════
// 辅助函数
// ══════════════════════════════════════════════════════════════

/**
 * 日志输出（可被外部覆盖）
 */
var _logFn = function() {};
function setLogger(fn) { _logFn = fn; }
function _log(level, msg) { try { _logFn(level, msg); } catch(e) {} }

/**
 * 临时目录创建
 */
function _createTempDir(prefix) {
  var tmpDir = path.join(os.tmpdir(), (prefix || 'docparse-') + Date.now() + '-' + Math.random().toString(36).substr(2, 6));
  fs.mkdirSync(tmpDir, { recursive: true });
  return tmpDir;
}

/**
 * 递归删除目录
 */
function _cleanupDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch(e) {}
}

/**
 * Zip Slip 防护 — 递归遍历 tmpDir 下所有条目，
 * 校验每个文件的 resolved path 和符号链接目标均仍在 tmpDir 内。
 * 若发现任何越界路径，抛出错误阻止后续读取（防御恶意 ZIP 条目含 ../ 或符号链接逃逸）。
 */
function _verifyExtractedPathsInTmp(tmpDir) {
  var tmpResolved = path.resolve(tmpDir);
  var prefix = tmpResolved + path.sep;
  function _walk(dir) {
    var entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch(e) { return; }
    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i];
      var fullPath = path.join(dir, entry.name);
      var resolved = path.resolve(fullPath);
      if (resolved !== tmpResolved && resolved.indexOf(prefix) !== 0) {
        throw new Error('Zip Slip detected: file path escapes tmpDir: ' + resolved);
      }
      if (entry.isSymbolicLink && entry.isSymbolicLink()) {
        var linkTarget = fs.readlinkSync(fullPath);
        var resolvedTarget = path.resolve(dir, linkTarget);
        if (resolvedTarget !== tmpResolved && resolvedTarget.indexOf(prefix) !== 0) {
          throw new Error('Zip Slip detected: symlink target escapes tmpDir: ' + resolvedTarget);
        }
      }
      if (entry.isDirectory()) _walk(fullPath);
    }
  }
  _walk(tmpDir);
}

/**
 * HTTP 请求封装
 */
function _httpRequest(url, options, postData) {
  return new Promise(function(resolve, reject) {
    var urlObj = new URL(url);
    var mod = urlObj.protocol === 'https:' ? https : http;
    var opts = {
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname + urlObj.search,
      method: options.method || 'POST',
      headers: options.headers || {}
    };
    var req = mod.request(opts, function(res) {
      var data = '';
      res.on('data', function(chunk) { data += chunk; if (data.length > 50000000) { req.destroy(); reject(new Error('响应过大(>50MB)')); } });
      res.on('end', function() {
        resolve({ status: res.statusCode, headers: res.headers, text: data });
      });
    });
    req.on('error', reject);
    req.setTimeout(120000, function() { req.destroy(); reject(new Error('请求超时(120s)')); });
    if (postData) req.write(postData);
    req.end();
  });
}

// ══════════════════════════════════════════════════════════════
// PDF 解析
// ══════════════════════════════════════════════════════════════

/**
 * 检测文本是否为乱码（非可打印字符比例高）
 */
function _isGarbledText(text) {
  if (!text || text.length < 10) return true;
  var garbled = 0;
  var total = text.length;
  for (var i = 0; i < total; i++) {
    var code = text.charCodeAt(i);
    // C1 控制字符 (U+0080-U+009F)、替换字符 (U+FFFD)、私有区
    if ((code >= 0x80 && code <= 0x9F) || code === 0xFFFD || (code >= 0xE000 && code <= 0xF8FF)) {
      garbled++;
    }
  }
  var ratio = garbled / total;
  _log('INFO', 'doc-parser: 乱码检测 - ' + garbled + '/' + total + ' = ' + (ratio * 100).toFixed(1) + '%');
  return ratio > 0.1; // 超过10%是乱码
}

/**
 * 1. PDF 文字层提取（pdf-parse v1 API）
 * @returns { text, pages, info, isScanned }
 */
async function extractPdfText(filePath) {
  var pdfParse = require('pdf-parse');
  var buffer = fs.readFileSync(filePath);
  var result = await pdfParse(buffer);
  var text = (result.text || '').trim();

  // 乱码检测：如果提取的文字是乱码，标记为需要 OCR
  if (text.length >= 10 && _isGarbledText(text)) {
    _log('WARN', 'doc-parser: pdf-parse 提取的文字疑似乱码，将走OCR路径');
    return {
      text: '',
      pages: result.numpages || 0,
      info: result.info || {},
      isScanned: true
    };
  }

  // 扫描件检测：去除页码分隔符、空白后的有效文字太少 → 判定为扫描件
  var _effectiveText = text.replace(/--\s*\d+\s+of\s+\d+\s*--/g, '').replace(/\s+/g, '');
  var _isScanned = !text || _effectiveText.length < 20;

  return {
    text: text,
    pages: result.numpages || 0,
    info: result.info || {},
    isScanned: _isScanned
  };
}

/**
 * 1b. 用 pdfjs-dist 提取 PDF 文字层（对字体编码支持更好）
 */
async function _extractTextWithPdfjs(filePath) {
  var canvasModule = require('canvas');

  // Node.js 环境 polyfill
  if (typeof global.DOMMatrix === 'undefined') {
    global.DOMMatrix = canvasModule.DOMMatrix || function() { this.a=1;this.b=0;this.c=0;this.d=1;this.e=0;this.f=0; };
  }
  if (typeof global.HTMLCanvasElement === 'undefined') {
    global.HTMLCanvasElement = canvasModule.Canvas || function() {};
  }
  if (typeof global.document === 'undefined') {
    global.document = { createElement: function() { return canvasModule.createCanvas(1,1); } };
  }
  if (typeof global.window === 'undefined') { global.window = global; }
  if (typeof global.requestAnimationFrame === 'undefined') { global.requestAnimationFrame = function(cb) { return setTimeout(cb, 0); }; }
  if (typeof global.cancelAnimationFrame === 'undefined') { global.cancelAnimationFrame = function(id) { clearTimeout(id); }; }
  if (global.window && typeof global.window.requestAnimationFrame === 'undefined') { global.window.requestAnimationFrame = global.requestAnimationFrame; }

  var pdfjsLib = require('pdfjs-dist');
  try { if (pdfjsLib.GlobalWorkerOptions) pdfjsLib.GlobalWorkerOptions.workerSrc = ''; } catch(e) {}

  var data = new Uint8Array(fs.readFileSync(filePath));
  var loadingTask = pdfjsLib.getDocument({ data: data, disableWorker: true, isEvalSupported: false, useSystemFonts: true });
  var pdfDoc = await loadingTask.promise;
  var totalPages = pdfDoc.numPages;
  var allText = [];

  for (var i = 1; i <= totalPages; i++) {
    var page = await pdfDoc.getPage(i);
    var textContent = await page.getTextContent();
    var pageText = [];
    for (var j = 0; j < textContent.items.length; j++) {
      if (textContent.items[j].str) pageText.push(textContent.items[j].str);
    }
    allText.push(pageText.join(' '));
    page.cleanup();
  }

  return allText.join('\n\n');
}

/**
 * 2. PDF 页面渲染为图片（使用 pdf-parse v2 内部的 pdfjs-dist + canvas）
 * @param {string} filePath - PDF 文件路径
 * @param {object} options - { pages?: number[], scale?: number, format?: 'png'|'jpeg', maxPages?: number }
 * @returns {Array<{page:number, buffer:Buffer, width:number, height:number}>}
 */
async function renderPdfToImages(filePath, options) {
  options = options || {};
  var pagesToRender = options.pages || [];
  var scale = options.scale || 2.0;
  var maxPages = options.maxPages || 50;

  _log('INFO', 'doc-parser: 开始渲染PDF为图片: ' + filePath + ' scale=' + scale);

  // 加载 canvas
  var canvasModule;
  try { canvasModule = require('canvas'); } catch(e) { throw new Error('canvas 模块不可用: ' + e.message); }
  var createCanvas = canvasModule.createCanvas;

  // Node.js 环境 polyfill
  if (typeof global.DOMMatrix === 'undefined') { global.DOMMatrix = canvasModule.DOMMatrix || function(){this.a=1;this.b=0;this.c=0;this.d=1;this.e=0;this.f=0;}; }
  if (typeof global.HTMLCanvasElement === 'undefined') { global.HTMLCanvasElement = canvasModule.Canvas || function(){}; }
  if (typeof global.document === 'undefined') { global.document = { createElement: function() { return createCanvas(1,1); } }; }
  if (typeof global.window === 'undefined') { global.window = global; }
  if (typeof global.requestAnimationFrame === 'undefined') { global.requestAnimationFrame = function(cb) { return setTimeout(cb, 0); }; }
  if (typeof global.cancelAnimationFrame === 'undefined') { global.cancelAnimationFrame = function(id) { clearTimeout(id); }; }
  if (global.window && typeof global.window.requestAnimationFrame === 'undefined') { global.window.requestAnimationFrame = global.requestAnimationFrame; }

  // 设置 canvas factory（pdf-parse v2 内部的 pdfjs-dist 需要）
  var NodeCanvasFactory = function() {};
  NodeCanvasFactory.prototype = {
    create: function(width, height) {
      var canvas = createCanvas(width, height);
      var ctx = canvas.getContext('2d');
      return { canvas: canvas, context: ctx };
    },
    reset: function(canvasAndContext, width, height) {
      canvasAndContext.canvas.width = width;
      canvasAndContext.canvas.height = height;
    },
    destroy: function(canvasAndContext) {
      canvasAndContext.canvas.width = 0;
      canvasAndContext.canvas.height = 0;
    }
  };

  // 使用 pdfjs-dist v3 加载 PDF（不依赖 pdf-parse v2 内部的 pdfjs-dist）
  var pdfjsLib;
  try {
    pdfjsLib = require('pdfjs-dist');
  } catch(e) {
    throw new Error('pdfjs-dist 模块不可用: ' + e.message);
  }
  try { if (pdfjsLib.GlobalWorkerOptions) pdfjsLib.GlobalWorkerOptions.workerSrc = ''; } catch(e) {}

  var data = new Uint8Array(fs.readFileSync(filePath));
  var loadingTask = pdfjsLib.getDocument({
    data: data,
    disableWorker: true,
    canvasFactory: new NodeCanvasFactory(),
    isEvalSupported: false,
    useSystemFonts: true
  });

  var pdfDoc = await loadingTask.promise;
  var totalPages = pdfDoc.numPages;
  _log('INFO', 'doc-parser: PDF总页数: ' + totalPages);

  // 确定要渲染的页码
  var pageList = [];
  if (pagesToRender.length > 0) {
    pageList = pagesToRender.filter(function(p) { return p >= 1 && p <= totalPages; });
  } else {
    for (var i = 1; i <= totalPages && i <= maxPages; i++) pageList.push(i);
  }

  var factory = new NodeCanvasFactory();
  var results = [];

  for (var pi = 0; pi < pageList.length; pi++) {
    var pageNum = pageList[pi];
    _log('INFO', 'doc-parser: 渲染第 ' + pageNum + '/' + totalPages + ' 页...');
    try {
      var page = await pdfDoc.getPage(pageNum);
      var viewport = page.getViewport({ scale: scale });
      var width = Math.floor(viewport.width);
      var height = Math.floor(viewport.height);

      var canvasAndContext = factory.create(width, height);
      await page.render({
        canvasContext: canvasAndContext.context,
        viewport: viewport,
        canvasFactory: factory
      }).promise;

      var imageBuffer = canvasAndContext.canvas.toBuffer('image/png');
      results.push({
        page: pageNum,
        buffer: imageBuffer,
        width: width,
        height: height,
        mimeType: 'image/png'
      });

      factory.destroy(canvasAndContext);
      page.cleanup();
    } catch(renderErr) {
      _log('WARN', 'doc-parser: 渲染第 ' + pageNum + ' 页失败: ' + renderErr.message);
    }
  }

  try { pdfDoc.destroy(); } catch(e) {}
  _log('INFO', 'doc-parser: 渲染完成，共 ' + results.length + ' 页');
  return results;
}

/**
 * 3. 视觉大模型 OCR
 * @param {Array<{buffer:Buffer, mimeType:string}>} images - 图片数组
 * @param {object} providerConfig - { id, apiKey, baseUrl, model }
 * @param {string} prompt - OCR 提示词
 * @returns { text, model, pages }
 */
async function ocrWithVisionModel(images, providerConfig, prompt) {
  if (!providerConfig || !providerConfig.apiKey) {
    throw new Error('未配置视觉模型提供商');
  }
  if (!images || images.length === 0) {
    throw new Error('没有图片需要OCR');
  }

  prompt = prompt || '请识别图片中的所有文字内容，保持原文格式，输出纯文本。如果是表格请用制表符分隔。支持中文和英文。';
  var providerId = providerConfig.id || 'openai';
  var apiKey = providerConfig.apiKey;
  var baseUrl = (providerConfig.baseUrl || '').replace(/\/$/, '');
  var model = providerConfig.model || 'gpt-4o';

  _log('INFO', 'doc-parser: 使用视觉模型 OCR: ' + providerId + '/' + model + ' 处理 ' + images.length + ' 张图片');

  // 构建消息内容
  var content = [{ type: 'text', text: prompt }];
  for (var i = 0; i < images.length; i++) {
    var b64Data = images[i].buffer.toString('base64');
    var mimeType = images[i].mimeType || 'image/png';

    if (providerId === 'anthropic') {
      // Anthropic 格式
      content.push({ type: 'image', source: { type: 'base64', media_type: mimeType, data: b64Data } });
    } else if (providerId === 'qwen') {
      // Qwen DashScope 原生格式
      content.push({ image: 'data:' + mimeType + ';base64,' + b64Data });
    } else {
      // OpenAI 兼容格式（默认）
      content.push({ type: 'image_url', image_url: { url: 'data:' + mimeType + ';base64,' + b64Data } });
    }
  }

  var messages = [{ role: 'user', content: content }];

  // 构建 API 请求
  var apiUrl, headers, body;

  if (providerId === 'anthropic') {
    // Anthropic Claude API
    apiUrl = baseUrl ? baseUrl + '/v1/messages' : 'https://api.anthropic.com/v1/messages';
    headers = {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    };
    body = JSON.stringify({
      model: model,
      max_tokens: 8192,
      messages: messages
    });
  } else if (providerId === 'qwen' && !baseUrl) {
    // Qwen DashScope 原生 API（无 baseUrl 时使用默认）
    apiUrl = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';
    headers = {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + apiKey
    };
    body = JSON.stringify({
      model: model,
      input: { messages: messages }
    });
  } else {
    // OpenAI 兼容 API（默认）
    if (providerId === 'qwen' && baseUrl) {
      apiUrl = baseUrl + '/compatible-mode/v1/chat/completions';
    } else {
      apiUrl = baseUrl ? baseUrl + '/v1/chat/completions' : 'https://api.openai.com/v1/chat/completions';
    }
    headers = {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + apiKey
    };
    body = JSON.stringify({
      model: model,
      max_tokens: 8192,
      messages: messages
    });
  }

  // 发送请求
  var response = await _httpRequest(apiUrl, { method: 'POST', headers: headers }, body);

  if (response.status < 200 || response.status >= 300) {
    throw new Error('视觉模型API错误[' + response.status + ']: ' + response.text.substring(0, 500));
  }

  // 解析返回结果
  var result;
  try {
    result = JSON.parse(response.text);
  } catch(e) {
    throw new Error('视觉模型返回解析失败: ' + response.text.substring(0, 200));
  }

  var extractedText = '';

  if (providerId === 'anthropic') {
    // Anthropic 格式
    if (result.content && Array.isArray(result.content)) {
      for (var ci = 0; ci < result.content.length; ci++) {
        if (result.content[ci].type === 'text') {
          extractedText += result.content[ci].text;
        }
      }
    }
  } else if (result.output && result.output.choices) {
    // Qwen DashScope 格式
    for (var qi = 0; qi < result.output.choices.length; qi++) {
      if (result.output.choices[qi].message && result.output.choices[qi].message.content) {
        var qContent = result.output.choices[qi].message.content;
        if (typeof qContent === 'string') {
          extractedText += qContent;
        } else if (Array.isArray(qContent)) {
          for (var qj = 0; qj < qContent.length; qj++) {
            if (qContent[qj].text) extractedText += qContent[qj].text;
          }
        }
      }
    }
  } else if (result.choices && result.choices.length > 0) {
    // OpenAI 兼容格式
    for (var oi = 0; oi < result.choices.length; oi++) {
      var choice = result.choices[oi];
      if (choice.message && choice.message.content) {
        var oContent = choice.message.content;
        if (typeof oContent === 'string') {
          extractedText += oContent;
        } else if (Array.isArray(oContent)) {
          for (var ok = 0; ok < oContent.length; ok++) {
            if (oContent[ok].type === 'text' && oContent[ok].text) {
              extractedText += oContent[ok].text;
            }
          }
        }
      }
    }
  }

  return {
    text: extractedText.trim(),
    model: model,
    pages: images.length
  };
}

/**
 * 4. Tesseract.js 本地 OCR
 * @param {Array<{buffer:Buffer, mimeType:string}>} images - 图片数组
 * @param {string} lang - 语言 'chi_sim+eng'（默认中英文）
 * @returns { text, confidence, pages }
 */
async function ocrWithTesseract(images, lang) {
  lang = lang || 'chi_sim+eng'; // 默认中英文
  if (!images || images.length === 0) {
    throw new Error('没有图片需要OCR');
  }

  _log('INFO', 'doc-parser: 使用 Tesseract.js OCR 处理 ' + images.length + ' 张图片, 语言: ' + lang);

  var Tesseract;
  try {
    Tesseract = require('tesseract.js');
  } catch(e) {
    throw new Error('tesseract.js 模块不可用: ' + e.message);
  }

  var allText = [];
  var totalConfidence = 0;
  var confidenceCount = 0;

  // 创建 worker
  var worker = await Tesseract.createWorker(lang, 1, {
    logger: function(m) {
      if (m.status) {
        _log('INFO', 'doc-parser: Tesseract ' + m.status + (m.progress ? ' (' + Math.round(m.progress * 100) + '%)' : ''));
      }
    }
  });

  try {
    for (var i = 0; i < images.length; i++) {
      _log('INFO', 'doc-parser: Tesseract 识别第 ' + (i + 1) + '/' + images.length + ' 张图片...');

      var result = await worker.recognize(images[i].buffer);

      if (result && result.data) {
        allText.push('--- 第 ' + (i + 1) + ' 页 ---');
        allText.push(result.data.text || '');
        if (result.data.confidence) {
          totalConfidence += result.data.confidence;
          confidenceCount++;
        }
      }
    }
  } finally {
    try { await worker.terminate(); } catch(e) {}
  }

  var avgConfidence = confidenceCount > 0 ? Math.round(totalConfidence / confidenceCount) : 0;

  return {
    text: allText.join('\n').trim(),
    confidence: avgConfidence,
    pages: images.length
  };
}

/**
 * 5. 查找可用的视觉模型 provider
 * @param {object} providers - configStore.providers
 * @param {Array} visionModelKeywords - 视觉模型关键词
 * @param {Array} visionProviders - 支持视觉的 provider ID 列表
 * @param {Array} nonVisionModels - 不支持视觉的模型关键词
 * @returns {object|null} - { id, apiKey, baseUrl, model }
 */
function findVisionProvider(providers, visionModelKeywords, visionProviders, nonVisionModels) {
  visionModelKeywords = visionModelKeywords || ['gpt-4o', 'claude-sonnet', 'gemini', 'qwen-vl', 'glm-4v'];
  visionProviders = visionProviders || ['openai', 'anthropic', 'google', 'qwen', 'glm'];
  nonVisionModels = nonVisionModels || ['text-embedding', 'whisper', 'tts', 'dall-e'];

  var provKeys = Object.keys(providers || {});
  for (var i = 0; i < provKeys.length; i++) {
    var provId = provKeys[i];
    var provCfg = providers[provId];
    if (!provCfg || !provCfg.apiKey) continue;

    var provModels = provCfg.models || [];
    for (var j = 0; j < provModels.length; j++) {
      var modelId = typeof provModels[j] === 'object' ? (provModels[j].id || '') : String(provModels[j]);
      var modelLower = modelId.toLowerCase();

      // 排除明确不支持视觉的模型
      var isNonVision = nonVisionModels.some(function(nvm) { return modelLower.indexOf(nvm) >= 0; });
      if (isNonVision) continue;

      // 检查是否是视觉模型
      var hasVision = visionModelKeywords.some(function(vm) { return modelLower.indexOf(vm) >= 0; });
      if (hasVision) {
        return { id: provId, apiKey: provCfg.apiKey, baseUrl: provCfg.baseUrl || '', model: modelId };
      }
    }

    // 如果 provider 本身支持视觉，且只有一个模型，直接用
    if (visionProviders.indexOf(provId) >= 0 && provModels.length > 0) {
      var firstModel = provModels[0];
      var firstModelId = typeof firstModel === 'object' ? (firstModel.id || '') : String(firstModel);
      var firstModelLower = firstModelId.toLowerCase();
      var firstNonVision = nonVisionModels.some(function(nvm) { return firstModelLower.indexOf(nvm) >= 0; });
      if (!firstNonVision) {
        return { id: provId, apiKey: provCfg.apiKey, baseUrl: provCfg.baseUrl || '', model: firstModelId };
      }
    }
  }

  return null;
}

/**
 * 6. PDF 统一解析（组合方案）
 * @param {string} filePath - PDF 文件路径
 * @param {object} options - {
 *   providers?, visionModelKeywords?, visionProviders?, nonVisionModels?,
 *   onProgress?, maxOcrPages?, scale?, preferOcr?: boolean
 * }
 * @returns { text, pages, type, method, isScanned, ocrModel? }
 */
async function parsePdf(filePath, options) {
  options = options || {};
  var onProgress = options.onProgress || function() {};
  var maxOcrPages = options.maxOcrPages || 30; // OCR 最多处理页数
  var scale = options.scale || 2.0;
  var preferOcr = options.preferOcr || false; // 是否优先 OCR（跳过文字层）

  _log('INFO', 'doc-parser: 开始解析PDF: ' + filePath);

  // 步骤1：尝试提取文字层
  if (!preferOcr) {
    onProgress('extracting_text', 0);
    try {
      var pdfResult = await extractPdfText(filePath);
      onProgress('extracting_text', 100);

      if (!pdfResult.isScanned && pdfResult.text.length >= 10) {
        _log('INFO', 'doc-parser: PDF文字层提取成功，共 ' + pdfResult.pages + ' 页，' + pdfResult.text.length + ' 字符');
        return {
          text: pdfResult.text,
          pages: pdfResult.pages,
          type: 'pdf',
          method: 'text_layer',
          isScanned: false,
          info: pdfResult.info
        };
      }

      _log('INFO', 'doc-parser: PDF为扫描件（无文字层），需要OCR处理。页数: ' + pdfResult.pages);
    } catch(e) {
      _log('WARN', 'doc-parser: PDF文字层提取失败: ' + e.message + '，尝试OCR');
    }
  }

  // 步骤2：渲染 PDF 页面为图片
  onProgress('rendering_pages', 0);
  var images = [];
  try {
    images = await renderPdfToImages(filePath, {
      scale: scale,
      format: 'png',
      maxPages: maxOcrPages
    });
    onProgress('rendering_pages', 100);
  } catch(e) {
    throw new Error('PDF页面渲染失败: ' + e.message);
  }

  if (images.length === 0) {
    throw new Error('PDF页面渲染失败：没有生成任何图片');
  }

  // 步骤3：优先用视觉大模型 OCR
  onProgress('vision_ocr', 0);
  var visionProvider = findVisionProvider(
    options.providers,
    options.visionModelKeywords,
    options.visionProviders,
    options.nonVisionModels
  );

  if (visionProvider) {
    _log('INFO', 'doc-parser: 找到视觉模型: ' + visionProvider.id + '/' + visionProvider.model);
    try {
      // 视觉模型批量处理（每批最多 5 张图片，避免请求过大）
      var batchSize = 5;
      var allText = [];
      for (var bi = 0; bi < images.length; bi += batchSize) {
        var batch = images.slice(bi, bi + batchSize);
        var batchNum = Math.floor(bi / batchSize) + 1;
        var totalBatches = Math.ceil(images.length / batchSize);
        _log('INFO', 'doc-parser: 视觉模型 OCR 批次 ' + batchNum + '/' + totalBatches);
        onProgress('vision_ocr', Math.round((bi / images.length) * 100));

        var batchResult = await ocrWithVisionModel(batch, visionProvider,
          '请识别图片中的所有文字内容，保持原文格式输出纯文本。如果是表格请用制表符分隔单元格。支持中文和英文。这是第 ' + (bi + 1) + '-' + (bi + batch.length) + ' 页，共 ' + images.length + ' 页。');
        allText.push(batchResult.text);
      }
      onProgress('vision_ocr', 100);

      var fullText = allText.join('\n\n');
      _log('INFO', 'doc-parser: 视觉模型OCR完成，共 ' + fullText.length + ' 字符');
      return {
        text: fullText,
        pages: images.length,
        type: 'pdf',
        method: 'vision_ocr',
        isScanned: true,
        ocrModel: visionProvider.model
      };
    } catch(e) {
      _log('WARN', 'doc-parser: 视觉模型OCR失败: ' + e.message + '，降级到Tesseract.js');
    }
  } else {
    _log('INFO', 'doc-parser: 未找到视觉模型，使用Tesseract.js本地OCR');
  }

  // 步骤4：降级用 Tesseract.js 本地 OCR
  onProgress('tesseract_ocr', 0);
  try {
    var tessResult = await ocrWithTesseract(images, 'chi_sim+eng');
    onProgress('tesseract_ocr', 100);
    _log('INFO', 'doc-parser: Tesseract.js OCR完成，置信度: ' + tessResult.confidence + '%，共 ' + tessResult.text.length + ' 字符');
    return {
      text: tessResult.text,
      pages: images.length,
      type: 'pdf',
      method: 'tesseract_ocr',
      isScanned: true,
      ocrConfidence: tessResult.confidence
    };
  } catch(e) {
    _log('ERROR', 'doc-parser: Tesseract.js OCR也失败: ' + e.message);
    throw new Error('PDF OCR失败：视觉模型和Tesseract.js均不可用。视觉模型错误: ' + (visionProvider ? 'API调用失败' : '未配置') + '，Tesseract错误: ' + e.message);
  }
}

// ══════════════════════════════════════════════════════════════
// DOCX 解析
// ══════════════════════════════════════════════════════════════

/**
 * DOCX 解析（mammoth 专业库 + 降级到 ZIP+XML）
 * @returns { text, method, paragraphs }
 */
async function parseDocx(filePath) {
  _log('INFO', 'doc-parser: 解析DOCX: ' + filePath);

  // 方案1：使用 mammoth（专业 DOCX 解析库）
  try {
    var mammoth = require('mammoth');
    var result = await mammoth.extractRawText({ path: filePath });
    if (result && result.value && result.value.trim().length > 0) {
      _log('INFO', 'doc-parser: mammoth解析成功，' + result.value.length + ' 字符');
      return {
        text: result.value,
        method: 'mammoth',
        paragraphs: result.value.split('\n').filter(function(l) { return l.trim(); }).length
      };
    }
  } catch(e) {
    _log('WARN', 'doc-parser: mammoth解析失败: ' + e.message + '，降级到ZIP+XML');
  }

  // 方案2：降级用 ZIP解压+XML解析
  var text = _extractOfficeDocText(filePath, '.docx', fs, path);
  return {
    text: text,
    method: 'zip_xml_fallback',
    paragraphs: text.split('\n').filter(function(l) { return l.trim(); }).length
  };
}

// ══════════════════════════════════════════════════════════════
// XLSX 解析
// ══════════════════════════════════════════════════════════════

/**
 * XLSX 解析（xlsx/SheetJS 专业库 + 降级到 ZIP+XML）
 * @returns { text, method, sheets }
 */
async function parseXlsx(filePath) {
  _log('INFO', 'doc-parser: 解析XLSX: ' + filePath);

  // 方案1：使用 xlsx（SheetJS 专业库）
  try {
    var XLSX = require('xlsx');
    var workbook = XLSX.readFile(filePath, { cellDates: true, cellNF: false, cellText: false });
    var sheets = [];
    var allText = [];

    workbook.SheetNames.forEach(function(sheetName, idx) {
      var worksheet = workbook.Sheets[sheetName];
      // 转为 CSV 格式（保留表格结构）
      var csv = XLSX.utils.sheet_to_csv(worksheet, { FS: '\t', RS: '\n' });
      allText.push('=== Sheet ' + (idx + 1) + ': ' + sheetName + ' ===');
      allText.push(csv);
      sheets.push({ name: sheetName, rows: csv.split('\n').length });
    });

    var text = allText.join('\n');
    _log('INFO', 'doc-parser: xlsx解析成功，' + sheets.length + '个工作表');
    return {
      text: text,
      method: 'xlsx',
      sheets: sheets
    };
  } catch(e) {
    _log('WARN', 'doc-parser: xlsx解析失败: ' + e.message + '，降级到ZIP+XML');
  }

  // 方案2：降级用 ZIP解压+XML解析
  var text = _extractOfficeDocText(filePath, '.xlsx', fs, path);
  return {
    text: text,
    method: 'zip_xml_fallback',
    sheets: []
  };
}

// ══════════════════════════════════════════════════════════════
// PPTX 解析
// ══════════════════════════════════════════════════════════════

/**
 * PPTX 解析（增强版 ZIP+XML，支持幻灯片文本、备注、表格）
 * @returns { text, method, slides }
 */
async function parsePptx(filePath) {
  _log('INFO', 'doc-parser: 解析PPTX: ' + filePath);

  var text = _extractOfficeDocText(filePath, '.pptx', fs, path);
  var slideCount = (text.match(/=== Slide \d+ ===/g) || []).length;

  // 增强：提取幻灯片备注
  try {
    var tmpDir = _createTempDir('pptx-notes-');
    execFileSync('tar', ['-xf', filePath, '-C', tmpDir], { timeout: 30000, encoding: 'utf8' });
    // Zip Slip 防护 — 校验解压后所有路径仍在 tmpDir 内
    _verifyExtractedPathsInTmp(tmpDir);

    var notesDir = path.join(tmpDir, 'ppt', 'notesSlides');
    if (fs.existsSync(notesDir)) {
      var noteFiles = fs.readdirSync(notesDir).filter(function(f) { return /^notesSlide\d+\.xml$/.test(f); }).sort(function(a, b) {
        return parseInt(a.match(/\d+/)[0]) - parseInt(b.match(/\d+/)[0]);
      });

      if (noteFiles.length > 0) {
        text += '\n\n=== 备注内容 ===';
        for (var ni = 0; ni < noteFiles.length; ni++) {
          var notePath = path.join(notesDir, noteFiles[ni]);
          var noteXml = fs.readFileSync(notePath, 'utf-8');
          var noteTexts = [];
          var noteRe = /<a:t[^>]*>([^<]*)<\/a:t>/g;
          var noteMatch;
          while ((noteMatch = noteRe.exec(noteXml)) !== null) noteTexts.push(noteMatch[1]);
          if (noteTexts.length > 0) {
            text += '\n--- 备注 ' + (ni + 1) + ' ---\n' + noteTexts.join('\n');
          }
        }
      }
    }

    _cleanupDir(tmpDir);
  } catch(e) {
    _log('WARN', 'doc-parser: PPTX备注提取失败: ' + e.message);
  }

  _log('INFO', 'doc-parser: PPTX解析成功，' + slideCount + '张幻灯片');
  return {
    text: text,
    method: 'zip_xml',
    slides: slideCount
  };
}

// ══════════════════════════════════════════════════════════════
// Office 文档通用 ZIP+XML 解析（降级方案）
// ══════════════════════════════════════════════════════════════

function _extractOfficeDocText(filePath, ext, fsMod, pathMod) {
  var tmpDir = pathMod.join(os.tmpdir(), 'sc-office-' + Date.now() + '-' + Math.random().toString(36).substr(2, 6));
  fsMod.mkdirSync(tmpDir, { recursive: true });
  try {
    // 跨平台 ZIP 解压：Windows 10+ 用 tar，Linux/macOS 用 unzip 或 tar
    var cmd;
    if (process.platform === 'win32') {
      // C-B2: 改用 execFileSync + 数组参数，避免 shell 注入
      execFileSync('tar', ['-xf', filePath, '-C', tmpDir], { timeout: 30000, encoding: 'utf8' });
    } else {
      // Linux/macOS 尝试 unzip，失败则用 tar
      try {
        execFileSync('unzip', ['-o', filePath, '-d', tmpDir], { timeout: 30000, encoding: 'utf8' });
      } catch(e) {
        execFileSync('tar', ['-xf', filePath, '-C', tmpDir], { timeout: 30000, encoding: 'utf8' });
      }
    }
    // Zip Slip 防护 — 校验解压后所有路径仍在 tmpDir 内
    _verifyExtractedPathsInTmp(tmpDir);

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
        sheetFiles = fsMod.readdirSync(sheetsDir).filter(function(f) { return /^sheet\d+\.xml$/.test(f); }).sort(function(a, b) { return parseInt(a.match(/\d+/)[0]) - parseInt(b.match(/\d+/)[0]); });
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
        slideFiles = fsMod.readdirSync(slidesDir).filter(function(f) { return /^slide\d+\.xml$/.test(f); }).sort(function(a, b) { return parseInt(a.match(/\d+/)[0]) - parseInt(b.match(/\d+/)[0]); });
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

// ══════════════════════════════════════════════════════════════
// 统一入口
// ══════════════════════════════════════════════════════════════

/**
 * 统一文档解析入口
 * @param {string} filePath - 文件路径
 * @param {object} options - {
 *   providers?, visionModelKeywords?, visionProviders?, nonVisionModels?,
 *   onProgress?, maxOcrPages?, scale?, preferOcr?
 * }
 * @returns { text, pages, type, method, isScanned?, ocrModel?, ocrConfidence? }
 */
async function parseDocument(filePath, options) {
  options = options || {};
  var ext = path.extname(filePath).toLowerCase();

  if (!fs.existsSync(filePath)) {
    throw new Error('文件不存在: ' + filePath);
  }

  _log('INFO', 'doc-parser: 解析文档: ' + filePath + ' (格式: ' + ext + ')');

  switch (ext) {
    case '.pdf':
      return await parsePdf(filePath, options);
    case '.docx':
      return await parseDocx(filePath);
    case '.xlsx':
      return await parseXlsx(filePath);
    case '.pptx':
      return await parsePptx(filePath);
    default:
      // 尝试作为纯文本读取
      try {
        var content = fs.readFileSync(filePath, 'utf-8');
        return {
          text: content,
          pages: content.split('\n').length,
          type: ext.substring(1),
          method: 'text'
        };
      } catch(e) {
        throw new Error('不支持的格式: ' + ext + '，且无法作为文本读取: ' + e.message);
      }
  }
}

// ══════════════════════════════════════════════════════════════
// 导出
// ══════════════════════════════════════════════════════════════

module.exports = {
  // 标记为库模块：被 start.cjs 直接 require 使用，不应被 ToolLoader 当作独立工具加载（避免每次启动输出 "No valid tool modules found" 警告）
  _notTools: true,
  // 统一入口
  parseDocument: parseDocument,
  // PDF 解析
  parsePdf: parsePdf,
  extractPdfText: extractPdfText,
  renderPdfToImages: renderPdfToImages,
  // OCR
  ocrWithVisionModel: ocrWithVisionModel,
  ocrWithTesseract: ocrWithTesseract,
  findVisionProvider: findVisionProvider,
  // Office 文档
  parseDocx: parseDocx,
  parseXlsx: parseXlsx,
  parsePptx: parsePptx,
  // 辅助
  setLogger: setLogger,
  _extractOfficeDocText: _extractOfficeDocText
};
