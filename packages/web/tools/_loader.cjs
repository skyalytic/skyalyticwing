/**
 * SkyalyticWing Tool Loader
 * 热加载可插拔工具系统 - 类似 skills 目录的插件化工具加载器
 *
 * 功能:
 *  - 扫描 tools/ 目录下的 .cjs 文件并自动加载
 *  - 每个工具模块导出 { name, description, parameters, category, execute }
 *  - 支持 enable/disable 单个工具
 *  - 支持热重载 (文件变更自动重新加载)
 *  - 提供 getDefinitions() 生成 TOOL_DEFINITIONS
 *  - 提供 execute() 分发工具调用, 保留对 start.cjs 内置 switch 的兜底
 *
 * 工具模块格式:
 *   module.exports = {
 *     name: 'tool_name',
 *     description: '工具描述',
 *     parameters: { type:'object', properties:{...}, required:[...] },
 *     category: 'file|command|browser|system|...',
 *     dangerous: false,       // 是否危险工具
 *     needApproval: false,    // 是否需要审批
 *     enabled: true,          // 是否启用
 *     execute: function(args, ctx) { ... return result; }
 *   };
 *
 *   或一个文件导出多个工具:
 *   module.exports = [ {tool1}, {tool2}, ... ];
 */

var fs = require('fs');
var path = require('path');

var ToolLoader = (function() {

  var _tools = {};           // name -> tool module
  var _toolDir = '';         // tools/ 目录绝对路径
  var _watcher = null;        // fs.FSWatcher
  var _watchEnabled = true;  // 是否启用文件监听
  var _reloadTimer = null;   // 防抖定时器
  var _ctx = null;           // 注入的上下文
  var _fallbackExecute = null; // 兜底执行函数 (start.cjs 的 switch)
  var _loadedFiles = {};     // filePath -> mtime (用于变更检测)

  function _log(level, msg) {
    if (_ctx && typeof _ctx.log === 'function') {
      _ctx.log(level, 'tool-loader', msg);
    } else {
      console.log('[tool-loader][' + level + '] ' + msg);
    }
  }

  function _isToolModule(obj) {
    return obj && typeof obj === 'object' && obj.name && typeof obj.execute === 'function';
  }

  function _normalizeExport(exp) {
    if (!exp) return [];
    if (Array.isArray(exp)) {
      return exp.filter(_isToolModule);
    }
    if (_isToolModule(exp)) return [exp];
    return [];
  }

  function _loadFile(filePath) {
    var resolved = null;
    try {
      // 热加载白名单校验——只允许 _toolDir 目录下的 .cjs/.js 文件被 require
      // 防止恶意构造文件路径让 require() 执行任意 .cjs（任意代码执行）。
      var _resolvedPath = path.resolve(filePath);
      var _toolDirResolved = path.resolve(_toolDir);
      var _isWin = process.platform === 'win32';
      var _normResolved = _isWin ? _resolvedPath.toLowerCase() : _resolvedPath;
      var _normToolDir = _isWin ? _toolDirResolved.toLowerCase() : _toolDirResolved;
      if (_normResolved !== _normToolDir && _normResolved.indexOf(_normToolDir + path.sep) !== 0) {
        _log('ERROR', 'Rejected tool load outside toolDir (M-C3): ' + _resolvedPath);
        return [];
      }
      // 额外校验扩展名（只允许 .cjs / .js）
      var _ext = path.extname(_resolvedPath).toLowerCase();
      if (_ext !== '.cjs' && _ext !== '.js') {
        _log('ERROR', 'Rejected tool load with disallowed extension (M-C3): ' + _resolvedPath);
        return [];
      }
      // 清除 require 缓存以支持热重载
      resolved = require.resolve(filePath);
      if (require.cache[resolved]) {
        delete require.cache[resolved];
      }
      var mod = require(filePath);
      if (mod && mod._notTools) return []; // 库模块，非工具模块，跳过
      var tools = _normalizeExport(mod);
      if (tools.length === 0) {
        _log('WARN', 'No valid tool modules found in: ' + filePath);
        return [];
      }
      _log('INFO', 'Loaded ' + tools.length + ' tool(s) from: ' + path.basename(filePath));
      return tools;
    } catch(e) {
      // require 失败后必须清理 require.cache 中的部分加载条目，
      // 否则 require.cache 会残留 broken module，下次 reload 时 require.resolve 命中缓存
      // 但 module.exports 未填充导致再次抛错或返回 undefined。
      // 同时记录更详细的错误信息便于排查（含 stack 第一帧）
      if (resolved && require.cache[resolved]) {
        try { delete require.cache[resolved]; } catch(cleanErr) {}
      }
      // 清理该模块可能的子模块缓存（require 失败时子模块可能已加载）
      try {
        var _resolvedAbs = path.resolve(filePath);
        for (var cacheKey in require.cache) {
          if (cacheKey === _resolvedAbs || cacheKey.indexOf(_resolvedAbs + path.sep) === 0) {
            delete require.cache[cacheKey];
          }
        }
      } catch(scanErr) {}
      var _stackHint = (e && e.stack) ? e.stack.split('\n')[1] : '';
      _log('ERROR', 'Failed to load tool file ' + filePath + ': ' + e.message + (_stackHint ? ' @ ' + _stackHint.trim() : ''));
      return [];
    }
  }

  function _registerTool(tool) {
    if (_tools[tool.name]) {
      _log('WARN', 'Tool already registered, replacing: ' + tool.name);
    }
    // 设置默认值
    if (tool.enabled === undefined) tool.enabled = true;
    if (tool.category === undefined) tool.category = 'system';
    if (tool.dangerous === undefined) tool.dangerous = false;
    if (tool.needApproval === undefined) tool.needApproval = false;
    _tools[tool.name] = tool;
  }

  function _unregisterTool(name) {
    delete _tools[name];
  }

  function _scanDir() {
    if (!_toolDir || !fs.existsSync(_toolDir)) {
      _log('WARN', 'Tool directory not found: ' + _toolDir);
      return;
    }
    var entries = fs.readdirSync(_toolDir);
    var loaded = 0;
    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i];
      // 只加载 .cjs 和 .js 文件, 跳过以 _ 开头的内部文件
      if (!entry.match(/\.(cjs|js)$/)) continue;
      if (entry.indexOf('_') === 0) continue;
      var filePath = path.join(_toolDir, entry);
      try {
        var stat = fs.statSync(filePath);
        if (!stat.isFile()) continue;
        var tools = _loadFile(filePath);
        for (var t = 0; t < tools.length; t++) {
          _registerTool(tools[t]);
          loaded++;
        }
        _loadedFiles[filePath] = stat.mtime.getTime();
      } catch(e) {
        _log('ERROR', 'Error scanning ' + entry + ': ' + e.message);
      }
    }
    _log('INFO', 'Scan complete: ' + loaded + ' tool(s) registered, ' + Object.keys(_tools).length + ' total');
  }

  function _setupWatcher() {
    if (!_watchEnabled || !_toolDir || !fs.existsSync(_toolDir)) return;
    try {
      if (_watcher) { _watcher.close(); _watcher = null; }
      _watcher = fs.watch(_toolDir, { persistent: false }, function(eventType, filename) {
        if (!filename || !filename.match(/\.(cjs|js)$/)) return;
        // 防抖: 500ms 内多次变更只触发一次重载
        if (_reloadTimer) clearTimeout(_reloadTimer);
        _reloadTimer = setTimeout(function() {
          _reloadTimer = null;
          _log('INFO', 'File change detected, reloading tools...');
          reload();
        }, 500);
      });
      _log('INFO', 'Hot-reload watcher active on: ' + _toolDir);
    } catch(e) {
      _log('WARN', 'Failed to setup watcher: ' + e.message);
    }
  }

  // ═══ 公开 API ═══

  function init(toolDir, ctx) {
    _toolDir = path.resolve(toolDir);
    _ctx = ctx || {};
    if (!fs.existsSync(_toolDir)) {
      try { fs.mkdirSync(_toolDir, { recursive: true }); } catch(e) {}
    }
    _scanDir();
    _setupWatcher();
    _log('INFO', 'ToolLoader initialized, dir: ' + _toolDir);
  }

  function reload() {
    // 清空已注册工具, 重新扫描
    _tools = {};
    _scanDir();
  }

  function getDefinitions() {
    var defs = [];
    for (var name in _tools) {
      var tool = _tools[name];
      if (tool.enabled === false) continue;
      defs.push({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description || '',
          parameters: tool.parameters || { type: 'object', properties: {} }
        }
      });
    }
    return defs;
  }

  function getToolNames() {
    return Object.keys(_tools);
  }

  function hasTool(name) {
    return !!_tools[name];
  }

  function isToolEnabled(name) {
    var tool = _tools[name];
    return tool && tool.enabled !== false;
  }

  function enableTool(name) {
    if (_tools[name]) { _tools[name].enabled = true; return true; }
    return false;
  }

  function disableTool(name) {
    if (_tools[name]) { _tools[name].enabled = false; return true; }
    return false;
  }

  function getToolInfo(name) {
    var tool = _tools[name];
    if (!tool) return null;
    return {
      name: tool.name,
      description: tool.description || '',
      category: tool.category || 'system',
      dangerous: !!tool.dangerous,
      needApproval: !!tool.needApproval,
      enabled: tool.enabled !== false,
      source: tool._source || 'unknown'
    };
  }

  function listTools() {
    var result = [];
    for (var name in _tools) {
      result.push(getToolInfo(name));
    }
    return result;
  }

  /**
   * 执行工具
   * @param {string} toolName - 工具名称
   * @param {object} args - 工具参数
   * @param {object} [extraCtx] - 额外上下文 (覆盖默认 ctx)
   * @returns {Promise<object>|object} 工具执行结果, 或 null 表示工具不存在(走兜底)
   */
  async function execute(toolName, args, extraCtx) {
    var tool = _tools[toolName];
    if (!tool) return null; // 工具不存在, 返回 null 让调用方走兜底
    if (tool.enabled === false) {
      return { success: false, error: '工具已禁用: ' + toolName, blocked: true };
    }
    var callCtx = Object.assign({}, _ctx, extraCtx || {});
    var result = tool.execute(args || {}, callCtx);
    if (result && typeof result.then === 'function') {
      result = await result;
    }
    return result;
  }

  function setContext(ctx) {
    _ctx = Object.assign(_ctx || {}, ctx);
  }

  function setFallbackExecute(fn) {
    _fallbackExecute = fn;
  }

  /**
   * 带兜底的执行: 先尝试加载器, 找不到工具则调用兜底函数
   */
  async function executeWithFallback(toolName, args, extraCtx) {
    var result = await execute(toolName, args, extraCtx);
    if (result !== null) return result;
    // 走兜底
    if (typeof _fallbackExecute === 'function') {
      return _fallbackExecute(toolName, args);
    }
    return { success: false, error: '工具不存在: ' + toolName };
  }

  function close() {
    if (_watcher) { _watcher.close(); _watcher = null; }
    if (_reloadTimer) { clearTimeout(_reloadTimer); _reloadTimer = null; }
  }

  return {
    init: init,
    reload: reload,
    getDefinitions: getDefinitions,
    getToolNames: getToolNames,
    hasTool: hasTool,
    isToolEnabled: isToolEnabled,
    enableTool: enableTool,
    disableTool: disableTool,
    getToolInfo: getToolInfo,
    listTools: listTools,
    execute: execute,
    executeWithFallback: executeWithFallback,
    setContext: setContext,
    setFallbackExecute: setFallbackExecute,
    close: close,
    _tools: _tools
  };

})();

module.exports = ToolLoader;
