var fs = require('fs');
var path = require('path');

module.exports = {
  id: 'operation-logger',
  name: 'operation-logger',
  version: '1.0.0',
  description: '操作日志增强 - 记录所有AI对话/工具调用/错误到结构化JSON日志，支持查询和导出',
  author: 'SkyalyticWing',
  priority: 50,
  enabled: true,
  config: {
    logDir: 'logs',
    logFile: 'operations.jsonl',
    maxEntries: 2000,
    logChatMessages: false,
    logToolCalls: true,
    logErrors: true
  },
  _logBuffer: [],
  _sessionStats: {},

  hooks: {
    before_agent_start: function(data) {
      var sid = (data.config && data.config.session) || 'unknown';
      this._sessionStats[sid] = this._sessionStats[sid] || { startTime: Date.now(), toolCount: 0, chatCount: 0, errorCount: 0 };
      return null;
    },

    message_received: function(data) {
      if (!this.config.logChatMessages) return null;
      var entry = {
        ts: new Date().toISOString(),
        type: 'message_in',
        session: data.sessionId || '',
        content: (data.message || '').substring(0, 500),
        length: (data.message || '').length
      };
      this._pushEntry(entry);
      if (this._sessionStats[data.sessionId]) this._sessionStats[data.sessionId].chatCount++;
      return null;
    },

    message_sent: function(data) {
      if (!this.config.logChatMessages) return null;
      var entry = {
        ts: new Date().toISOString(),
        type: 'message_out',
        role: data.role || 'assistant',
        success: data.success,
        length: (data.content || '').length
      };
      this._pushEntry(entry);
      return null;
    },

    before_tool_call: function(data) {
      if (!this.config.logToolCalls) return null;
      var entry = {
        ts: new Date().toISOString(),
        type: 'tool_start',
        tool: data.tool || data.toolName,
        argumentKeys: Object.keys(data.args || {})
      };
      this._pushEntry(entry);
      return null;
    },

    after_tool_call: function(data) {
      if (!this.config.logToolCalls) return null;
      var entry = {
        ts: new Date().toISOString(),
        type: 'tool_end',
        tool: data.tool || data.toolName,
        success: !(data.result && data.result.error),
        durationMs: data.durationMs || 0,
        resultSize: JSON.stringify(data.result || {}).length
      };
      this._pushEntry(entry);
      var sid = (data.result && data.result.sessionId) || '';
      if (sid && this._sessionStats[sid]) this._sessionStats[sid].toolCount++;
      return null;
    },

    after_tool_failure: function(data) {
      var entry = {
        ts: new Date().toISOString(),
        type: 'tool_error',
        tool: data.tool || data.toolName,
        error: (data.error || '').substring(0, 500)
      };
      this._pushEntry(entry);
      return null;
    },

    agent_end: function(data) {
      var entry = {
        ts: new Date().toISOString(),
        type: 'agent_complete',
        result: data.result || 'completed',
        durationMs: data.durationMs || 0,
        tokenUsage: data.tokenUsage || {}
      };
      this._pushEntry(entry);
      return null;
    },

    config_change: function(data) {
      var entry = {
        ts: new Date().toISOString(),
        type: 'config_change',
        keys: (data.changedKeys || []).join(', ')
      };
      this._pushEntry(entry);
      return null;
    },

    onLoad: function(api) {
      this._logBuffer = [];
      api.log('INFO', '[operation-Logger] Operation logger started - logging to ' + (this.config.logDir || 'logs') + '/' + (this.config.logFile || 'operations.jsonl'));
      return { success: true };
    },

    onUnload: function(api) {
      this._flushLog();
      api.log('INFO', '[operation-Logger] Unlogged. Total entries: ' + (this._logBuffer||[]).length);
      return { success: true };
    }
  },

  _pushEntry: function(entry) {
    this._logBuffer = this._logBuffer || [];
    this._logBuffer.push(entry);
    if (this._logBuffer.length > (this.config.maxEntries||2000)) this._logBuffer.shift();
    if (this._logBuffer.length % 50 === 0) this._flushLog();
  },

  _flushLog: function() {
    try {
      var logDir = path.resolve(this.config.logDir || 'logs');
      if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
      var logFile = path.join(logDir, this.config.logFile || 'operations.jsonl');
      var data = (this._logBuffer || []).map(function(e){return JSON.stringify(e);}).join('\n');
      if (data) fs.appendFileSync(logFile, data + '\n', 'utf-8');
      this._logBuffer = [];
    } catch(e) {}
  },

  tools: [
    {
      name: 'oplog_query',
      description: '查询操作日志 (支持按类型/时间/工具过滤)',
      execute: function(args) {
        var filterType = (args && args.type) || null;
        var filterTool = (args && args.tool) || null;
        var limit = (args && args.limit) ? parseInt(args.limit) : 50;
        var logs = (this._logBuffer || []);
        if (filterType) logs = logs.filter(function(e){return e.type === filterType;});
        if (filterTool) logs = logs.filter(function(e){return (e.tool||'').indexOf(filterTool)>=0;});
        return { output: JSON.stringify({ totalInBuffer: (this._logBuffer||[]).length, returned: logs.slice(-limit).length, entries: logs.slice(-limit), sessionStats: this._sessionStats }, null, 2) };
      }
    },
    {
      name: 'oplog_export',
      description: '导出全部日志到文件并返回路径',
      execute: function(args) {
        this._flushLog();
        var fmt = (args && args.format) || 'json';
        if (!['json', 'tsv'].includes(fmt)) return { success: false, error: 'format 必须是 json 或 tsv' };
        var logDir = path.resolve(this.config.logDir || 'logs');
        var outFile = path.join(logDir, 'export-' + Date.now() + '.' + fmt);
        try {
          if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
          var source = path.join(logDir, this.config.logFile || 'operations.jsonl');
          var allData = fs.existsSync(source) ? fs.readFileSync(source, 'utf8').split('\n').filter(Boolean).map(function(line) { return JSON.parse(line); }) : [];
          if (fmt === 'json') {
            fs.writeFileSync(outFile, JSON.stringify(allData, null, 2), 'utf-8');
          } else {
            fs.writeFileSync(outFile, allData.map(function(e){return Object.values(e).join('\t');}).join('\n'), 'utf-8');
          }
          return { output: '已导出 ' + allData.length + ' 条记录到: ' + outFile };
        } catch(e) { return { output: '导出失败: ' + e.message }; }
      }
    },
    {
      name: 'oplog_stats',
      description: '操作统计概览',
      execute: function() {
        var logs = this._logBuffer || [];
        var byType = {}; var byTool = {};
        for (var i = 0; i < logs.length; i++) {
          var t = logs[i].type; var tl = logs[i].tool;
          byType[t] = (byType[t]||0)+1; if(tl)byTool[tl]=(byTool[tl]||0)+1;
        }
        var sessions = this._sessionStats || {};
        var activeSessions = Object.keys(sessions).map(function(k){return{id:k,tools:sessions[k].toolCount,chats:sessions[k].chatCount,errors:sessions[k].errorCount,duration:Date.now()-sessions[k].startTime};});
        return { output: JSON.stringify({ totalEntries: logs.length, timeRange: logs.length?{first:logs[0].ts,last:logs[logs.length-1].ts}:'empty', byType:byType, byTool:Object.keys(byTool).sort(function(a,b){return byTool[b]-byTool[a];}).slice(0,15), activeSessions:activeSessions },null,2) };
      }
    }
  ]
};
