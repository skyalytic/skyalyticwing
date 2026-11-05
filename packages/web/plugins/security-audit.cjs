var fs = require('fs');
var path = require('path');

module.exports = {
  id: 'security-audit',
  name: 'security-audit',
  version: '1.0.0',
  description: '安全审计 - 拦截危险工具调用、记录所有操作、基于规则放行/阻止',
  author: 'SkyalyticWing',
  priority: 100,
  enabled: true,
  config: {
    logFile: 'logs/security-audit.log',
    blockDangerous: true,
    warnPatterns: ['rm -rf', 'format', 'mkfs', '> /dev/', 'curl.*\\|.*sh', 'wget.*\\|.*sh'],
    allowPatterns: [],
    maxLogEntries: 500
  },
  _auditLog: [],
  _blockedCount: 0,
  _allowedCount: 0,

  hooks: {
    before_tool_call: function(data) {
      var toolName = data.tool || '';
      var args = data.args || {};
      var cmdStr = (args.cmd || JSON.stringify(args)).toLowerCase();
      var self = this;

      var entry = {
        time: new Date().toISOString(),
        tool: toolName,
        action: cmdStr.substring(0, 200),
        decision: 'allow',
        reason: ''
      };

      if (this.config.blockDangerous) {
        for (var i = 0; i < (this.config.warnPatterns||[]).length; i++) {
          var pattern = this.config.warnPatterns[i];
          try {
            if (new RegExp(pattern, 'i').test(cmdStr)) {
              entry.decision = 'blocked';
              entry.reason = '匹配危险模式: ' + pattern;
              this._blockedCount++;
              this._auditLog.push(entry);
              if (this._auditLog.length > (this.config.maxLogEntries||500)) this._auditLog.shift();
              return { blocked: true, reason: 'Security Audit: 命令被拦截 - 匹配危险模式 "' + pattern + '"' };
            }
          } catch(e) {}
        }
      }

      for (var j = 0; j < (this.config.allowPatterns||[]).length; j++) {
        try { if (new RegExp(this.config.allowPatterns[j], 'i').test(cmdStr)) entry.reason = '白名单允许'; } catch(e) {}
      }

      this._allowedCount++;
      this._auditLog.push(entry);
      if (this._auditLog.length > (this.config.maxLogEntries||500)) this._auditLog.shift();
      return null;
    },

    after_tool_call: function(data) {
      var result = data.result || {};
      if (result.error) {
        this._auditLog.push({
          time: new Date().toISOString(),
          tool: data.tool,
          action: 'ERROR: ' + (result.error||'').substring(0,100),
          decision: 'error',
          reason: result.error
        });
      }
      return null;
    },

    after_tool_failure: function(data) {
      this._auditLog.push({
        time: new Date().toISOString(),
        tool: data.tool,
        action: 'FAILURE: ' + (data.error||'').substring(0,100),
        decision: 'failure',
        reason: data.error
      });
      return null;
    },

    onLoad: function(api) {
      this._auditLog = [];
      api.log('INFO', '[security-audit] Security audit plugin loaded - blocking=' + this.config.blockDangerous + ', patterns=' + (this.config.warnPatterns||[]).length);
      return { success: true };
    },

    onUnload: function(api) {
      var summary = { blocked: this._blockedCount, allowed: this._allowedCount, totalLogged: this._auditLog.length, recentBlocked: (this._auditLog||[]).filter(function(e){return e.decision==='blocked';}).slice(-5) };
      api.log('INFO', '[security-audit] Unloaded. Summary: ' + JSON.stringify(summary));
      return { success: true, data: summary };
    }
  },

  tools: [
    {
      name: 'sec_audit_log',
      description: '查看安全审计日志 (最近N条)',
      execute: function(args) {
        var n = (args && args.n) ? parseInt(args.n) : 20;
        var filterType = (args && args.type) || 'all';
        var logs = (this._auditLog || []).slice(-n);
        if (filterType !== 'all') logs = logs.filter(function(e){ return e.decision === filterType; });
        return { output: JSON.stringify({ totalRecorded: (this._auditLog||[]).length, blocked: this._blockedCount, allowed: this._allowedCount, entries: logs }, null, 2) };
      }
    },
    {
      name: 'sec_block_pattern',
      description: '动态添加/移除拦截规则',
      execute: function(args) {
        if (!args || !args.pattern) return { output: '用法: {pattern:"rm -rf", action:"add|remove"}' };
        var patterns = this.config.warnPatterns || [];
        if (args.action === 'remove') {
          patterns = patterns.filter(function(p){ return p !== args.pattern; });
        } else {
          patterns.push(args.pattern);
        }
        this.config.warnPatterns = patterns;
        return { output: '当前规则(' + patterns.length + '): ' + JSON.stringify(patterns) };
      }
    },
    {
      name: 'sec_stats',
      description: '安全审计统计概览',
      execute: function() {
        return { output: JSON.stringify({
          blocked: this._blockedCount,
          allowed: this._allowedCount,
          errors: (this._auditLog||[]).filter(function(e){return e.decision==='error';}).length,
          failures: (this._auditLog||[]).filter(function(e){return e.decision==='failure';}).length,
          topTools: (function(){
            var m={};(this._auditLog||[]).forEach(function(e){m[e.tool]=(m[e.tool]||0)+1;});return Object.keys(m).sort(function(a,b){return m[b]-m[a];}).slice(0,10).map(function(k){return{tool:k,count:m[k]};});
          }).bind(this)()
        }, null, 2) };
      }
    }
  ]
};
