/**
 * 媒体类工具模块 (热加载)
 *
 * 从 start.cjs 内置 switch 中提取，逻辑保持不变。
 * 包含图像理解、图像生成、Canvas画布、PDF处理、Jupyter Notebook编辑等工具。
 *
 * 上下文 (ctx) 需提供:
 *   fs, path, os, crypto                          // Node 内置模块
 *   execSync, execFileSync                        // child_process
 *   IS_WIN, IS_MAC, PS_BIN, APP_DIR, DATA_DIR,    // 平台/路径常量
 *   WORKSPACE_OUTPUT_DIR, APP_VERSION
 *   configStore, sessionsStore                    // 状态
 *   log, broadcast, getWorkspaceOutputPath,        // 函数
 *   sanitizeApiKey, resolveModel, resolveProviderForModel,
 *   getActiveProvider, executeTool
 *   SecurityManager, _pdfParseLib                // 系统对象
 *   VISION_MODEL_KEYWORDS, NON_VISION_MODELS,    // 常量数组
 *   VISION_PROVIDERS, PROVIDER_DEFAULT_URLS
 */

module.exports = [

  // ═══ image ═══
  {
    name: 'image',
    description: '图像理解与分析。分析图片内容、识别文字(OCR)、描述场景、回答关于图片的问题。支持本地文件路径和URL。',
    parameters: {
      type: 'object',
      properties: {
        source: { type: 'string', description: '图片路径或URL（本地路径如D:\\photo.jpg或https://...）' },
        question: { type: 'string', description: '关于图片的问题（如"描述这张图片"、"图片中的文字是什么"）' }
      },
      required: ['source', 'question']
    },
    category: 'media',
    dangerous: false,
    execute: async function(args, ctx) {
      var fs = ctx.fs, path = ctx.path;
      var resolveModel = ctx.resolveModel;
      var resolveProviderForModel = ctx.resolveProviderForModel;
      var getActiveProvider = ctx.getActiveProvider;
      var configStore = ctx.configStore;
      var sanitizeApiKey = ctx.sanitizeApiKey;
      var VISION_MODEL_KEYWORDS = ctx.VISION_MODEL_KEYWORDS;
      var NON_VISION_MODELS = ctx.NON_VISION_MODELS;
      var VISION_PROVIDERS = ctx.VISION_PROVIDERS;
      var PROVIDER_DEFAULT_URLS = ctx.PROVIDER_DEFAULT_URLS;

      var _imgSrc = args.source || '';
      var _imgQ = args.question || '描述这张图片';
      if (!_imgSrc) return { ok: false, error: '请提供图片路径或URL' };
      try {
        var _imgModel = resolveModel();
        var _modelProv = resolveProviderForModel(_imgModel);
        var _imgProvId, _imgProvKey, _imgProvUrl, _isAnthropic;
        if (_modelProv) {
          _imgProvId = _modelProv.id;
          _imgProvKey = _modelProv.apiKey;
          _imgProvUrl = _modelProv.baseUrl;
          _isAnthropic = _imgProvId === 'anthropic';
        } else {
          var _activeProv = getActiveProvider();
          if (!_activeProv) return { ok: false, error: '未配置AI提供商，无法进行图像分析' };
          _imgProvId = _activeProv.id;
          _imgProvKey = _activeProv.apiKey || '';
          _imgProvUrl = _activeProv.baseUrl || '';
          _isAnthropic = _imgProvId === 'anthropic';
          var _apModels = _activeProv.models || [];
          if (_apModels.length > 0) {
            var _apFirst = _apModels[0];
            _imgModel = typeof _apFirst === 'object' ? (_apFirst.id || _imgModel) : String(_apFirst);
          }
          var _provModels = (configStore.providers[_imgProvId] || {}).models || [];
          if (_provModels.length > 0) {
            var _pmFirst = _provModels[0];
            _imgModel = typeof _pmFirst === 'object' ? (_pmFirst.id || _imgModel) : String(_pmFirst);
          }
        }
        var _visionModels = VISION_MODEL_KEYWORDS;
        var _nonVisionModels = NON_VISION_MODELS;
        var _visionProviders = VISION_PROVIDERS;
        var _modelLower = (_imgModel || '').toLowerCase();
        // 排除明确不支持视觉的模型
        var _isNonVision = _nonVisionModels.some(function(nvm) { return _modelLower.indexOf(nvm) >= 0; });
        var _hasVision = !_isNonVision && (_visionModels.some(function(vm) { return _modelLower.indexOf(vm) >= 0; }) || _visionProviders.indexOf(_imgProvId) >= 0);
        if (!_hasVision) {
          var _altProv = null;
          var _allProvKeys = Object.keys(configStore.providers || {});
          for (var _apk = 0; _apk < _allProvKeys.length; _apk++) {
            var _apkId = _allProvKeys[_apk];
            var _apkCfg = configStore.providers[_apkId];
            if (!_apkCfg || !_apkCfg.apiKey) continue;
            var _apkModels = _apkCfg.models || [];
            for (var _amk = 0; _amk < _apkModels.length; _amk++) {
              var _amkLower = (_apkModels[_amk].id || _apkModels[_amk] || '').toLowerCase();
              if (_visionModels.some(function(vm) { return _amkLower.indexOf(vm) >= 0; }) && !_nonVisionModels.some(function(nvm) { return _amkLower.indexOf(nvm) >= 0; })) {
                _altProv = { id: _apkId, apiKey: _apkCfg.apiKey, baseUrl: _apkCfg.baseUrl || '', model: typeof _apkModels[_amk] === 'object' ? _apkModels[_amk].id : _apkModels[_amk] };
                break;
              }
            }
            if (_altProv) break;
          }
          if (_altProv) {
            _imgProvId = _altProv.id;
            _imgProvKey = _altProv.apiKey;
            _imgProvUrl = _altProv.baseUrl;
            _imgModel = _altProv.model;
            _isAnthropic = _imgProvId === 'anthropic';
            _hasVision = true;
          }
        }
        if (!_hasVision) return { ok: false, error: '当前模型(' + _imgModel + ')不支持图片理解，也没有找到支持视觉的模型。请在设置中配置支持图片理解的模型(如 gpt-4o, claude-sonnet-4, qwen-vl 等)' };
        var _imgIsUrl = _imgSrc.startsWith('http://') || _imgSrc.startsWith('https://');
        var _imgB64Data = '';
        var _imgMime = 'image/png';
        if (!_imgIsUrl) {
          if (!fs.existsSync(_imgSrc)) return { ok: false, error: '图片文件不存在: ' + _imgSrc };
          var _imgFileData = fs.readFileSync(_imgSrc);
          var _imgExt2 = path.extname(_imgSrc).toLowerCase().replace('.', '');
          _imgMime = _imgExt2 === 'jpg' || _imgExt2 === 'jpeg' ? 'image/jpeg' : _imgExt2 === 'gif' ? 'image/gif' : _imgExt2 === 'webp' ? 'image/webp' : 'image/png';
          _imgB64Data = _imgFileData.toString('base64');
        }
        var _imgMessages;
        var _isQwenNative = false; // 是否使用 DashScope 原生多模态 API
        if (_isAnthropic) {
          var _anthContent = [{ type: 'text', text: _imgQ }];
          if (_imgIsUrl) {
            _anthContent.push({ type: 'text', text: '[图片URL: ' + _imgSrc + '] (Anthropic API暂不支持直接传入图片URL，请使用本地文件路径)' });
          } else {
            _anthContent.push({ type: 'image', source: { type: 'base64', media_type: _imgMime, data: _imgB64Data } });
          }
          _imgMessages = [{ role: 'user', content: _anthContent }];
        } else if (_imgProvId === 'qwen') {
          // Qwen 模型使用 DashScope 原生多模态 API 格式
          // OpenAI 兼容端点对非 VL 后缀模型（如 qwen3.7-max）的 image_url 支持不完善
          // 原生格式使用 {"image": "data:image/png;base64,..."} 而非 {"type": "image_url", ...}
          _isQwenNative = true;
          var _qwenContent = [{ text: _imgQ }];
          if (_imgIsUrl) {
            _qwenContent.push({ image: _imgSrc });
          } else {
            _qwenContent.push({ image: 'data:' + _imgMime + ';base64,' + _imgB64Data });
          }
          _imgMessages = [{ role: 'user', content: _qwenContent }];
        } else {
          if (_imgIsUrl) {
            _imgMessages = [{ role: 'user', content: [{ type: 'text', text: _imgQ }, { type: 'image_url', image_url: { url: _imgSrc } }] }];
          } else {
            _imgMessages = [{ role: 'user', content: [{ type: 'text', text: _imgQ }, { type: 'image_url', image_url: { url: 'data:' + _imgMime + ';base64,' + _imgB64Data } }] }];
          }
        }
        var _defaultUrls = PROVIDER_DEFAULT_URLS;
        var _imgBaseUrl = _imgProvUrl || _defaultUrls[_imgProvId] || 'https://api.openai.com/v1';
        // Qwen 原生多模态 API 使用不同的 base URL（不带 /compatible-mode/v1）
        if (_isQwenNative && _imgProvId === 'qwen' && !_imgProvUrl) {
          _imgBaseUrl = 'https://dashscope.aliyuncs.com';
        }
        var _imgUrlObj = new (require('url').URL)(_imgBaseUrl);
        var _imgHttpMod = _imgUrlObj.protocol === 'https:' ? require('https') : require('http');
        var _imgHeaders = { 'Content-Type': 'application/json' };
        if (_isAnthropic) {
          _imgHeaders['x-api-key'] = sanitizeApiKey(_imgProvKey);
          _imgHeaders['anthropic-version'] = '2023-06-01';
        } else {
          if (_imgProvKey) _imgHeaders['Authorization'] = 'Bearer ' + sanitizeApiKey(_imgProvKey);
        }
        var _imgBodyStr;
        if (_isAnthropic) {
          var _anthBody = { model: _imgModel, messages: _imgMessages, max_tokens: 4096 };
          _imgBodyStr = JSON.stringify(_anthBody);
        } else if (_isQwenNative) {
          // DashScope 原生多模态 API 格式
          var _qwenBody = {
            model: _imgModel,
            input: { messages: _imgMessages },
            parameters: { result_format: 'message', max_tokens: 4096 }
          };
          _imgBodyStr = JSON.stringify(_qwenBody);
        } else {
          var _oaiBody = { model: _imgModel, messages: _imgMessages, max_tokens: 4096 };
          _imgBodyStr = JSON.stringify(_oaiBody);
        }
        _imgHeaders['Content-Length'] = Buffer.byteLength(_imgBodyStr);
        var _imgApiPath;
        if (_isAnthropic) {
          _imgApiPath = '/v1/messages';
        } else if (_isQwenNative) {
          // DashScope 原生多模态 API 端点
          _imgApiPath = '/api/v1/services/aigc/multimodal-generation/generation';
        } else {
          _imgApiPath = _imgUrlObj.pathname.replace(/\/$/, '') + '/chat/completions';
        }
        return new Promise(function(resolve) {
          var _imgReq = _imgHttpMod.request({ hostname: _imgUrlObj.hostname, port: _imgUrlObj.port || (_imgUrlObj.protocol === 'https:' ? 443 : 80), path: _imgApiPath, method: 'POST', headers: _imgHeaders }, function(_imgRes) {
            var _imgRespData = '';
            // fix(第二十二轮): AI API 响应无大小限制，恶意/异常 API 可返回超大响应导致 OOM
            var _imgOversized = false;
            _imgRes.on('data', function(c) { if(_imgOversized) return; _imgRespData += c.toString(); if(_imgRespData.length > 50*1024*1024) { _imgOversized = true; try{_imgReq.destroy();}catch(e){} resolve({ok:false, error:'图像分析API响应过大(>50MB)', model:_imgModel, provider:_imgProvId}); } });
            _imgRes.on('end', function() {
              if(_imgOversized) return;
              try {
                var _imgJ = JSON.parse(_imgRespData);
                if (_imgRes.statusCode && _imgRes.statusCode >= 400) {
                  var _errMsg = _imgJ.error && _imgJ.error.message ? _imgJ.error.message : (_imgJ.message || 'API错误 (' + _imgRes.statusCode + ')');
                  resolve({ ok: false, error: '图像分析API错误: ' + _errMsg, model: _imgModel, provider: _imgProvId });
                  return;
                }
                var _answer = '';
                if (_isAnthropic) {
                  if (_imgJ.content && _imgJ.content.length > 0) {
                    for (var _ci = 0; _ci < _imgJ.content.length; _ci++) {
                      if (_imgJ.content[_ci].type === 'text') { _answer = _imgJ.content[_ci].text; break; }
                    }
                  }
                } else if (_isQwenNative) {
                  // DashScope 原生多模态 API 响应格式
                  // { output: { choices: [{ message: { content: [...] } }] } }
                  var _qwenOutput = _imgJ.output || {};
                  var _qwenChoices = _qwenOutput.choices || [];
                  if (_qwenChoices.length > 0) {
                    var _qwenMsg = _qwenChoices[0].message || {};
                    var _qwenContent = _qwenMsg.content || [];
                    if (Array.isArray(_qwenContent)) {
                      for (var _qci = 0; _qci < _qwenContent.length; _qci++) {
                        if (_qwenContent[_qci].text) { _answer += _qwenContent[_qci].text; }
                      }
                    } else if (typeof _qwenContent === 'string') {
                      _answer = _qwenContent;
                    }
                  }
                  // 检查 DashScope 错误
                  if (!_answer && _imgJ.code) {
                    resolve({ ok: false, error: 'DashScope错误: ' + (_imgJ.message || _imgJ.code), model: _imgModel, provider: _imgProvId });
                    return;
                  }
                } else {
                  _answer = (_imgJ.choices && _imgJ.choices[0] && _imgJ.choices[0].message && _imgJ.choices[0].message.content) || '';
                }
                if (!_answer) resolve({ ok: false, error: '图像分析返回空结果，模型可能不支持图片理解', model: _imgModel, provider: _imgProvId });
                else resolve({ ok: true, answer: _answer, model: _imgModel, provider: _imgProvId });
              } catch (e) { resolve({ ok: false, error: '解析响应失败: ' + e.message }); }
            });
          });
          _imgReq.on('error', function(e) { resolve({ ok: false, error: '图像分析请求失败: ' + e.message }); });
          _imgReq.setTimeout(60000, function() { _imgReq.destroy(); resolve({ ok: false, error: '图像分析超时' }); });
          _imgReq.write(_imgBodyStr); _imgReq.end();
        });
      } catch (e) { return { ok: false, error: e.message }; }
    }
  },

  // ═══ image_generate ═══
  {
    name: 'image_generate',
    description: 'AI图像生成。根据文字描述生成图片，保存到工作区。支持DALL-E、Stable Diffusion等模型。',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '图像描述（英文效果最佳）' },
        size: { type: 'string', enum: ['256x256', '512x512', '1024x1024', '1792x1024', '1024x1792'], description: '图片尺寸，默认1024x1024' },
        model: { type: 'string', enum: ['dall-e-3', 'dall-e-2', 'stable-diffusion'], description: '生成模型，默认dall-e-3' },
        style: { type: 'string', enum: ['vivid', 'natural'], description: '风格：vivid=生动,natural=自然' },
        filename: { type: 'string', description: '保存文件名（如output.png），默认自动生成' }
      },
      required: ['prompt']
    },
    category: 'media',
    dangerous: true,
    execute: async function(args, ctx) {
      var fs = ctx.fs;
      var configStore = ctx.configStore;
      var sanitizeApiKey = ctx.sanitizeApiKey;
      var getWorkspaceOutputPath = ctx.getWorkspaceOutputPath;
      var SecurityManager = ctx.SecurityManager;

      var _igPrompt = args.prompt || '';
      if (!_igPrompt) return { ok: false, error: '请提供图像描述' };
      try {
        var _igProvKey = '';
        var _provKeys2 = Object.keys(configStore.providers || {});
        var _igProvIdx = -1;
        for (var _pk2 = 0; _pk2 < _provKeys2.length; _pk2++) {
          if (configStore.providers[_provKeys2[_pk2]] && configStore.providers[_provKeys2[_pk2]].apiKey) {
            _igProvKey = configStore.providers[_provKeys2[_pk2]].apiKey;
            _igProvIdx = _pk2;
            break;
          }
        }
        if (!_igProvKey) return { ok: false, error: '未配置API密钥，无法生成图像' };
        var _igBaseUrl = (_igProvIdx >= 0 && configStore.providers[_provKeys2[_igProvIdx]] && configStore.providers[_provKeys2[_igProvIdx]].baseUrl) ? configStore.providers[_provKeys2[_igProvIdx]].baseUrl : 'https://api.openai.com/v1';
        var _igUrlObj = new (require('url').URL)(_igBaseUrl);
        var _igHttpMod = _igUrlObj.protocol === 'https:' ? require('https') : require('http');
        var _igApiPath = _igUrlObj.pathname.replace(/\/$/, '') + '/images/generations';
        var _igModel = args.model || 'dall-e-3';
        var _igSize = args.size || '1024x1024';
        var _igBody = JSON.stringify({ model: _igModel, prompt: _igPrompt, size: _igSize, n: 1 });
        var _igHeaders = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(_igBody) };
        if (_igProvKey) _igHeaders['Authorization'] = 'Bearer ' + sanitizeApiKey(_igProvKey);
        return new Promise(function(resolve) {
          var _igReq = _igHttpMod.request({ hostname: _igUrlObj.hostname, port: _igUrlObj.port || (_igUrlObj.protocol === 'https:' ? 443 : 80), path: _igApiPath, method: 'POST', headers: _igHeaders }, function(_igRes) {
            var _igData = '';
            // fix(第二十二轮): 图像生成 API 响应无大小限制，恶意/异常 API 可返回超大响应导致 OOM
            var _igOversized = false;
            _igRes.on('data', function(c) { if(_igOversized) return; _igData += c.toString(); if(_igData.length > 50*1024*1024) { _igOversized = true; try{_igReq.destroy();}catch(e){} resolve({ok:false, error:'图像生成API响应过大(>50MB)'}); } });
            _igRes.on('end', function() {
              if(_igOversized) return;
              try {
                var _igJ = JSON.parse(_igData);
                if (_igJ.data && _igJ.data[0]) {
                  var _igUrl = _igJ.data[0].url || '';
                  var _igB64 = _igJ.data[0].b64_json || '';
                  var _igFilename = args.filename || 'generated-' + Date.now() + '.png';
                  var _igOutPath = getWorkspaceOutputPath(_igFilename);
                  if (_igB64) { fs.writeFileSync(_igOutPath, Buffer.from(_igB64, 'base64')); resolve({ ok: true, file: _igOutPath, filename: _igFilename, model: _igModel }); }
                  else if (_igUrl) {
                    if (SecurityManager && typeof SecurityManager.checkUrl === 'function') {
                      SecurityManager.checkUrl(_igUrl).then(function(_igSsrf) {
                        if (_igSsrf && !_igSsrf.safe) { resolve({ ok: false, error: 'SSRF防护: 图片URL不允许 - ' + (_igSsrf.reason || '') }); return; }
                        _doIgDownload();
                      }).catch(function(_igSsrfE) { resolve({ ok: false, error: 'SSRF检查失败: ' + (_igSsrfE && _igSsrfE.message || _igSsrfE) }); });
                    } else { _doIgDownload(); }
                    function _doIgDownload() {
                      var _igHttp2 = _igUrl.startsWith('https') ? require('https') : require('http');
                      var _dlReq = _igHttp2.get(_igUrl, function(dlRes) { var chunks = []; var _dlSize = 0; dlRes.on('data', function(c) { chunks.push(c); _dlSize += c.length; if (_dlSize > 50 * 1024 * 1024) { _dlReq.destroy(); resolve({ ok: false, error: '图片过大(>50MB)' }); } }); dlRes.on('end', function() { try { fs.writeFileSync(_igOutPath, Buffer.concat(chunks)); resolve({ ok: true, file: _igOutPath, filename: _igFilename, model: _igModel }); } catch (e) { resolve({ ok: false, error: '保存失败:' + e.message }); } }); dlRes.on('error', function(e) { resolve({ ok: false, error: '下载失败:' + e.message }); }); });
                      _dlReq.on('error', function(e) { resolve({ ok: false, error: '下载请求失败:' + e.message }); });
                      _dlReq.setTimeout(60000, function() { _dlReq.destroy(); resolve({ ok: false, error: '下载超时' }); });
                    }
                  } else { resolve({ ok: false, error: 'API未返回图像数据' }); }
                } else { resolve({ ok: false, error: 'API未返回图像数据', raw: _igData.substring(0, 500) }); }
              } catch (e) { resolve({ ok: false, error: '解析响应失败: ' + e.message }); }
            });
          });
          _igReq.on('error', function(e) { resolve({ ok: false, error: '图像生成请求失败: ' + e.message }); });
          _igReq.setTimeout(120000, function() { _igReq.destroy(); resolve({ ok: false, error: '图像生成超时' }); });
          _igReq.write(_igBody); _igReq.end();
        });
      } catch (e) { return { ok: false, error: e.message }; }
    }
  },

  // ═══ canvas ═══
  {
    name: 'canvas',
    description: 'Canvas画布操作。创建和操作可视化画布，支持绘图、图表、布局等。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'draw', 'export', 'clear'], description: '操作：create=创建画布,draw=绘制,export=导出,clear=清空' },
        width: { type: 'number', description: '画布宽度（像素），默认800' },
        height: { type: 'number', description: '画布高度（像素），默认600' },
        content: { type: 'string', description: '绘制内容（JSON格式描述或SVG）' },
        format: { type: 'string', enum: ['png', 'svg', 'pdf'], description: '导出格式，默认png' },
        filename: { type: 'string', description: '导出文件名' }
      },
      required: ['action']
    },
    category: 'media',
    dangerous: false,
    execute: function(args, ctx) {
      var fs = ctx.fs;
      var getWorkspaceOutputPath = ctx.getWorkspaceOutputPath;

      var _cvAction = args.action || 'create';
      if (_cvAction === 'create' || _cvAction === 'draw') {
        var _cvContent = args.content || '';
        if (_cvContent && _cvContent.indexOf('<svg') >= 0) {
          var _cvFilename = args.filename || 'canvas-' + Date.now() + '.svg';
          var _cvOutPath = getWorkspaceOutputPath(_cvFilename);
          fs.writeFileSync(_cvOutPath, _cvContent);
          return { ok: true, file: _cvOutPath, filename: _cvFilename, format: 'svg' };
        }
        return { ok: true, action: _cvAction, width: args.width || 800, height: args.height || 600, note: 'Canvas内容已记录，请使用SVG格式导出' };
      }
      if (_cvAction === 'export') {
        var _cvFilename2 = args.filename || 'canvas-' + Date.now() + '.' + (args.format || 'png');
        var _cvOutPath2 = getWorkspaceOutputPath(_cvFilename2);
        if (args.content) { fs.writeFileSync(_cvOutPath2, args.content); return { ok: true, file: _cvOutPath2, filename: _cvFilename2 }; }
        return { ok: false, error: '请提供content（SVG内容）' };
      }
      if (_cvAction === 'clear') return { ok: true, action: 'clear', message: '画布已清空' };
      return { ok: false, error: 'Unknown action: ' + _cvAction };
    }
  },

  // ═══ pdf ═══
  {
    name: 'pdf',
    description: 'PDF文档处理工具。当用户上传或提到PDF文件时，必须优先使用此工具，不要用bash/python手动处理。支持读取PDF内容、提取文字、获取信息。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['read', 'extract_text', 'merge', 'info'], description: '操作：read或extract_text=提取PDF文字内容,info=获取PDF文件信息,merge=合并PDF' },
        file_path: { type: 'string', description: 'PDF文件路径' },
        pages: { type: 'string', description: '页码范围（如1-5,8,10-12），默认全部' },
        file_paths: { type: 'array', items: { type: 'string' }, description: '合并时的PDF文件路径列表' },
        output_path: { type: 'string', description: '输出文件路径' }
      },
      required: ['action', 'file_path']
    },
    category: 'media',
    dangerous: false,
    execute: async function(args, ctx) {
      var fs = ctx.fs;
      var execSync = ctx.execSync;
      var execFileSync = ctx.execFileSync;
      var getWorkspaceOutputPath = ctx.getWorkspaceOutputPath;
      var _pdfParseLib = ctx._pdfParseLib;
      var configStore = ctx.configStore;
      var VISION_MODEL_KEYWORDS = ctx.VISION_MODEL_KEYWORDS;
      var NON_VISION_MODELS = ctx.NON_VISION_MODELS;
      var executeTool = ctx.executeTool;

      var _pdfAction = args.action || 'read';
      var _pdfPath = args.file_path || '';
      if (!_pdfPath) return { ok: false, error: '请提供PDF文件路径' };
      if (!fs.existsSync(_pdfPath)) return { ok: false, error: '文件不存在: ' + _pdfPath };
      try {
        var _pdfBuf = fs.readFileSync(_pdfPath);
        var _pdfPageRange = args.pages || '';
        if (_pdfPageRange && !/^[\d,\-\s]+$/.test(_pdfPageRange)) return { ok: false, error: '无效的页码范围，仅允许数字、逗号和连字符' };
        function _parsePageRange(range, maxPages) {
          if (!range) return null;
          var pages = [];
          var parts = range.split(',');
          for (var pi = 0; pi < parts.length; pi++) {
            var part = parts[pi].trim();
            if (!part) continue;
            if (part.indexOf('-') > -1) {
              var bounds = part.split('-');
              var start = parseInt(bounds[0]) || 1;
              var end = parseInt(bounds[1]) || maxPages;
              start = Math.max(1, Math.min(start, maxPages));
              end = Math.max(1, Math.min(end, maxPages));
              for (var pp = start; pp <= end; pp++) { if (pages.indexOf(pp) === -1) pages.push(pp); }
            } else {
              var pn = parseInt(part);
              if (pn >= 1 && pn <= maxPages && pages.indexOf(pn) === -1) pages.push(pn);
            }
          }
          pages.sort(function(a, b) { return a - b; });
          return pages.length > 0 ? pages : null;
        }
        if (_pdfAction === 'info') {
          var _pdfStats = fs.statSync(_pdfPath);
          var _pdfPageCount = 1;
          var _pdfInfo = null;
          if (_pdfParseLib) {
            try {
              var _pdfData = await _pdfParseLib(_pdfBuf, { max: 0 });
              _pdfPageCount = _pdfData.numpages || 1;
              _pdfInfo = _pdfData.info || null;
            } catch (_pie) {
              _pdfPageCount = (_pdfBuf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length || 1;
            }
          } else {
            _pdfPageCount = (_pdfBuf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length || 1;
          }
          var _infoResult = { ok: true, file: _pdfPath, size: _pdfStats.size, pages: _pdfPageCount, modified: _pdfStats.mtime };
          if (_pdfInfo) _infoResult.metadata = _pdfInfo;
          return _infoResult;
        }
        if (_pdfAction === 'extract_text' || _pdfAction === 'read') {
          var _pdfTextResult = '';
          var _pdfMethod = '';
          if (_pdfParseLib) {
            try {
              var _pageTexts = [];
              var _customPageRender = function(pageData) {
                return pageData.getTextContent({
                  normalizeWhitespace: false,
                  disableCombineTextItems: false
                }).then(function(textContent) {
                  var lastY, text = '';
                  for (var _ti = 0; _ti < textContent.items.length; _ti++) {
                    var _item = textContent.items[_ti];
                    if (lastY === undefined || lastY == _item.transform[5]) {
                      text += _item.str;
                    } else {
                      text += '\n' + _item.str;
                    }
                    lastY = _item.transform[5];
                  }
                  _pageTexts.push(text);
                  return text;
                });
              };
              var _pdfData2 = await _pdfParseLib(_pdfBuf, { pagerender: _customPageRender, max: 0 });
              var _totalPages = _pdfData2.numpages || _pageTexts.length || 1;
              var _selectedPages = _parsePageRange(_pdfPageRange, _totalPages);
              if (_selectedPages && _selectedPages.length > 0) {
                var _filteredTexts = [];
                for (var _fi = 0; _fi < _selectedPages.length; _fi++) {
                  var _pIdx = _selectedPages[_fi] - 1;
                  if (_pIdx >= 0 && _pIdx < _pageTexts.length) {
                    _filteredTexts.push(_pageTexts[_pIdx]);
                  }
                }
                _pdfTextResult = _filteredTexts.join('\n\n');
                _pdfMethod = 'pdf-parse(纯JS,第' + _selectedPages.join(',') + '页/' + _totalPages + '页)';
              } else {
                _pdfTextResult = _pageTexts.join('\n\n');
                _pdfMethod = 'pdf-parse(纯JS,' + _totalPages + '页)';
              }
            } catch (_pde) {
              _pdfMethod = 'pdf-parse失败: ' + (_pde.message || '').substring(0, 120);
            }
          } else {
            _pdfMethod = 'pdf-parse未安装';
          }
          if (!_pdfTextResult) {
            try {
              var _pdfPyCode = [
                'import sys',
                'try:',
                '  from pypdf import PdfReader',
                'except ImportError:',
                '  from PyPDF2 import PdfReader',
                'r = PdfReader(sys.argv[1])',
                'pages = sys.argv[2] if len(sys.argv) > 2 else ""',
                'if pages:',
                '  rng = []',
                '  for p in pages.split(","):',
                '    if "-" in p:',
                '      s,e = p.split("-",1)',
                '      rng.extend(range(int(s or 1), int(e or len(r.pages))+1))',
                '    else:',
                '      rng.append(int(p))',
                '  for i in sorted(set(rng)):',
                '    if 1 <= i <= len(r.pages):',
                '      t = r.pages[i-1].extract_text()',
                '      if t: print(t)',
                'else:',
                '  for p in r.pages:',
                '    t = p.extract_text()',
                '    if t: print(t)'
              ].join('\n');
              var _pyCmd = 'python3';
              try { execSync('python3 --version', { timeout: 5000, stdio: 'pipe' }); } catch (_pye) { _pyCmd = 'python'; }
              _pdfTextResult = execFileSync(_pyCmd, ['-c', _pdfPyCode, _pdfPath, _pdfPageRange], { encoding: 'utf8', timeout: 30000, maxBuffer: 10 * 1024 * 1024 });
              _pdfMethod = 'pypdf/PyPDF2(' + _pyCmd + ')';
            } catch (e1) {
              var _zlib = require('zlib');
              var _pdfRaw = _pdfBuf.toString('latin1');
              var _pdfStreams = [];
              var _streamRe = /stream\r?\n([\s\S]*?)endstream/g;
              var _streamMatch;
              while ((_streamMatch = _streamRe.exec(_pdfRaw)) !== null) {
                _pdfStreams.push(_streamMatch[1]);
              }
              var _pdfTextParts = [];
              for (var _si = 0; _si < _pdfStreams.length; _si++) {
                try {
                  var _compBuf = Buffer.from(_pdfStreams[_si], 'latin1');
                  var _decompBuf = _zlib.inflateSync(_compBuf);
                  var _decompStr = _decompBuf.toString('utf-8');
                  var _textRe = /\(([^)]*)\)/g;
                  var _tm;
                  while ((_tm = _textRe.exec(_decompStr)) !== null) {
                    if (_tm[1].length > 0 && /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef\w]/.test(_tm[1])) {
                      _pdfTextParts.push(_tm[1]);
                    }
                  }
                  var _tjRe = /\[(.*?)\]\s*TJ/g;
                  var _tjm;
                  while ((_tjm = _tjRe.exec(_decompStr)) !== null) {
                    var _partRe = /\(([^)]*)\)/g;
                    var _pm;
                    while ((_pm = _partRe.exec(_tjm[1])) !== null) {
                      if (_pm[1].length > 0 && /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef\w]/.test(_pm[1])) {
                        _pdfTextParts.push(_pm[1]);
                      }
                    }
                  }
                } catch (ze) { }
              }
              if (_pdfTextParts.length > 0) {
                _pdfTextResult = _pdfTextParts.join('');
                _pdfMethod = '内置zlib流解析(' + _pdfStreams.length + '个流,' + _pdfTextParts.length + '个文本段)';
              } else {
                _pdfTextResult = _pdfBuf.toString('utf-8').replace(/[^\x20-\x7E\u4e00-\u9fff\u3000-\u303f\uff00-\uffef\n\r]/g, ' ').replace(/\s+/g, ' ').substring(0, 50000);
                _pdfMethod = '原始文本提取(效果有限)';
              }
            }
          }
          // OCR 回退：当所有文本提取方法都返回空时，尝试 OCR
          if (!_pdfTextResult || _pdfTextResult.trim().length === 0) {
            _pdfTextResult = '';
            _pdfMethod = '';
            // 方法1: 尝试 pdf2image + Tesseract OCR（需要 Python + pytesseract + poppler）
            try {
              var _ocrPyCode = [
                'import sys, os, tempfile, base64',
                'try:',
                '  from pdf2image import convert_from_path',
                '  from pytesseract import image_to_string',
                'except ImportError:',
                '  print("OCR_DEPS_MISSING"); sys.exit(0)',
                'pdf_path = sys.argv[1]',
                'page_range = sys.argv[2] if len(sys.argv) > 2 else ""',
                'try:',
                '  if page_range:',
                '    first_p = int(page_range.split("-")[0]) if "-" in page_range else int(page_range)',
                '    last_p = int(page_range.split("-")[1]) if "-" in page_range else first_p',
                '    images = convert_from_path(pdf_path, first_page=first_p, last_page=last_p, dpi=200)',
                '  else:',
                '    images = convert_from_path(pdf_path, dpi=200)',
                '  for img in images[:10]:',
                '    text = image_to_string(img, lang="chi_sim+eng")',
                '    if text: print(text)',
                'except Exception as e:',
                '  print("OCR_ERROR:" + str(e), file=sys.stderr)',
                '  sys.exit(0)'
              ].join('\n');
              var _ocrPyCmd = 'python3';
              try { execSync('python3 --version', { timeout: 5000, stdio: 'pipe' }); } catch (_ocrPyE) { _ocrPyCmd = 'python'; }
              var _ocrResult = execFileSync(_ocrPyCmd, ['-c', _ocrPyCode, _pdfPath, _pdfPageRange], { encoding: 'utf8', timeout: 120000, maxBuffer: 20 * 1024 * 1024 });
              if (_ocrResult.indexOf('OCR_DEPS_MISSING') >= 0) {
                _pdfMethod = 'OCR依赖未安装(需要: pip install pdf2image pytesseract + Tesseract OCR + poppler)';
              } else if (_ocrResult.trim()) {
                _pdfTextResult = _ocrResult.trim();
                _pdfMethod = 'OCR(Tesseract+pdf2image, ' + _ocrPyCmd + ')';
              }
            } catch (_ocrErr) {
              _pdfMethod = 'OCR失败: ' + (_ocrErr.message || '').substring(0, 120);
            }
            // 方法2: 如果有视觉模型，用视觉模型 OCR（将 PDF 渲染为图片后发送给视觉模型）
            if (!_pdfTextResult || _pdfTextResult.trim().length === 0) {
              try {
                var _visionModels2 = VISION_MODEL_KEYWORDS;
                var _nonVisionModels2 = NON_VISION_MODELS;
                var _foundVisionProv = null;
                var _allProvKeys3 = Object.keys(configStore.providers || {});
                for (var _vpk = 0; _vpk < _allProvKeys3.length; _vpk++) {
                  var _vpkId = _allProvKeys3[_vpk];
                  var _vpkCfg = configStore.providers[_vpkId];
                  if (!_vpkCfg || !_vpkCfg.apiKey) continue;
                  var _vpkModels = _vpkCfg.models || [];
                  for (var _vmk = 0; _vmk < _vpkModels.length; _vmk++) {
                    var _vmkLower = (_vpkModels[_vmk].id || _vpkModels[_vmk] || '').toLowerCase();
                    if (_visionModels2.some(function(vm) { return _vmkLower.indexOf(vm) >= 0; }) && !_nonVisionModels2.some(function(nvm) { return _vmkLower.indexOf(nvm) >= 0; })) {
                      _foundVisionProv = { id: _vpkId, apiKey: _vpkCfg.apiKey, baseUrl: _vpkCfg.baseUrl || '', model: typeof _vpkModels[_vmk] === 'object' ? _vpkModels[_vmk].id : _vpkModels[_vmk] };
                      break;
                    }
                  }
                  if (_foundVisionProv) break;
                }
                if (_foundVisionProv) {
                  // 用 pdf2image 将 PDF 转为图片
                  var _pdf2ImgCode = [
                    'import sys, base64, io',
                    'try:',
                    '  from pdf2image import convert_from_path',
                    'except ImportError:',
                    '  print("PDF2IMG_MISSING"); sys.exit(0)',
                    'pdf_path = sys.argv[1]',
                    'try:',
                    '  images = convert_from_path(pdf_path, dpi=150)',
                    '  for i, img in enumerate(images[:5]):',
                    '    buf = io.BytesIO()',
                    '    img.save(buf, format="PNG")',
                    '    print("PAGE:" + str(i+1))',
                    '    print(base64.b64encode(buf.getvalue()).decode())',
                    '    print("ENDPAGE")',
                    'except Exception as e:',
                    '  print("PDF2IMG_ERROR:" + str(e), file=sys.stderr)',
                    '  sys.exit(0)'
                  ].join('\n');
                  var _p2iCmd = 'python3';
                  try { execSync('python3 --version', { timeout: 5000, stdio: 'pipe' }); } catch (_p2iE) { _p2iCmd = 'python'; }
                  // C-B5: 改用 execFileSync + 数组参数，避免 shell 注入
                  var _p2iResult = execFileSync(_p2iCmd, ['-c', _pdf2ImgCode, _pdfPath], { encoding: 'utf8', timeout: 60000, maxBuffer: 50 * 1024 * 1024 });
                  if (_p2iResult.indexOf('PDF2IMG_MISSING') < 0 && _p2iResult.indexOf('PAGE:') >= 0) {
                    // 解析页面图片
                    var _ocrPages = _p2iResult.split('PAGE:').filter(function(p) { return p.indexOf('ENDPAGE') >= 0; });
                    var _ocrTexts = [];
                    for (var _opi = 0; _opi < _ocrPages.length; _opi++) {
                      var _pageB64 = _ocrPages[_opi].split('ENDPAGE')[0].trim();
                      if (!_pageB64) continue;
                      // 调用视觉模型
                      var _visResult = await executeTool('image', { source: 'data:image/png;base64,' + _pageB64, question: '请详细OCR识别这张图片中的所有文字内容，包括标题、正文、表格、注释等，保持原文格式。' });
                      if (_visResult && _visResult.ok && _visResult.answer) {
                        _ocrTexts.push('--- 第' + (_opi + 1) + '页 ---\n' + _visResult.answer);
                      }
                    }
                    if (_ocrTexts.length > 0) {
                      _pdfTextResult = _ocrTexts.join('\n\n');
                      _pdfMethod = '视觉模型OCR(' + _foundVisionProv.model + ', ' + _ocrTexts.length + '页)';
                    }
                  }
                }
              } catch (_visOcrErr) {
                // 视觉模型 OCR 失败，静默跳过
              }
            }
          }
          if (_pdfTextResult.length > 100000) _pdfTextResult = _pdfTextResult.substring(0, 100000) + '\n...[文本过长已截断]';
          return { ok: true, text: _pdfTextResult.trim(), file: _pdfPath, method: _pdfMethod };
        }
        if (_pdfAction === 'merge') {
          var _pdfPaths = args.file_paths || [];
          if (_pdfPaths.length < 2) return { ok: false, error: '合并至少需要2个PDF文件' };
          var _pdfOutPath = args.output_path || getWorkspaceOutputPath('merged-' + Date.now() + '.pdf');
          try {
            var _pdfMergeCode = [
              'import sys',
              'try:',
              '  from pypdf import PdfWriter, PdfReader',
              'except ImportError:',
              '  from PyPDF2 import PdfWriter, PdfReader',
              'w = PdfWriter()',
              'for f in sys.argv[2:]:',
              '  r = PdfReader(f)',
              '  for p in r.pages:',
              '    w.add_page(p)',
              'w.write(sys.argv[1])',
              'w.close()'
            ].join('\n');
            var _pyMergeCmd = 'python3';
            try { execSync('python3 --version', { timeout: 5000, stdio: 'pipe' }); } catch (_pym) { _pyMergeCmd = 'python'; }
            // C-B5: 改用 execFileSync + 数组参数，避免 shell 注入
            execFileSync(_pyMergeCmd, ['-c', _pdfMergeCode, _pdfOutPath].concat(_pdfPaths), { encoding: 'utf8', timeout: 60000 });
            return { ok: true, output: _pdfOutPath, merged: _pdfPaths.length };
          } catch (e3) { return { ok: false, error: 'PDF合并失败: ' + e3.message }; }
        }
        return { ok: false, error: 'Unknown action: ' + _pdfAction };
      } catch (e) { return { ok: false, error: e.message }; }
    }
  },

  // ═══ notebook_edit ═══
  {
    name: 'notebook_edit',
    description: '编辑Jupyter Notebook单元格。修改、插入或删除notebook中的代码/Markdown单元格。',
    parameters: {
      type: 'object',
      properties: {
        notebook_path: { type: 'string', description: 'Notebook文件绝对路径' },
        cell_number: { type: 'number', description: '单元格编号（0开始）' },
        new_source: { type: 'string', description: '新的单元格内容' },
        cell_type: { type: 'string', enum: ['code', 'markdown'], description: '单元格类型' },
        edit_mode: { type: 'string', enum: ['replace', 'insert', 'delete'], description: '编辑模式，默认replace' }
      },
      required: ['notebook_path', 'cell_number']
    },
    category: 'media',
    dangerous: false,
    execute: function(args, ctx) {
      var fs = ctx.fs, path = ctx.path;

      var _nbPath = args.notebook_path || '';
      var _nbCell = args.cell_number;
      if (!_nbPath) return { ok: false, error: '请提供Notebook路径' };
      var _nbResolved = path.resolve(_nbPath);
      var _nbCwdBase = path.resolve(process.cwd()) + path.sep;
      if (_nbResolved !== path.resolve(process.cwd()) && _nbResolved.indexOf(_nbCwdBase) !== 0) return { ok: false, error: '路径不允许: 仅限当前工作目录' };
      if (!fs.existsSync(_nbResolved)) return { ok: false, error: '文件不存在: ' + _nbPath };
      try {
        var _nbContent = JSON.parse(fs.readFileSync(_nbResolved, 'utf-8'));
        if (!_nbContent.cells) return { ok: false, error: '不是有效的Jupyter Notebook' };
        var _nbMode = args.edit_mode || 'replace';
        if (_nbMode === 'delete') { _nbContent.cells.splice(_nbCell, 1); }
        else if (_nbMode === 'insert') { _nbContent.cells.splice(_nbCell, 0, { cell_type: args.cell_type || 'code', source: args.new_source || '', metadata: {}, outputs: [], execution_count: null }); }
        else { if (_nbCell >= 0 && _nbCell < _nbContent.cells.length) _nbContent.cells[_nbCell].source = args.new_source || ''; }
        fs.writeFileSync(_nbResolved, JSON.stringify(_nbContent, null, 1));
        return { ok: true, file: _nbPath, cell: _nbCell, mode: _nbMode };
      } catch (e) { return { ok: false, error: e.message }; }
    }
  }

];
