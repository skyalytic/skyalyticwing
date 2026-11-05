/**
 * 定时任务 (cron) 与 MCP 类工具模块
 *
 * 从 start.cjs 提取的工具实现, 支持热加载。
 * 工具列表:
 *   - cron_create / cron_list / cron_delete / cron_toggle / cron_run_now / cron_delivery
 *   - mcp_list / mcp_start / mcp_stop / mcp_call / mcp_resources / mcp_resource_read
 *   - mcp_loopback_start / mcp_loopback_status / mcp_conversations_list
 *
 * execute 签名: function(args, ctx)
 * ctx 提供: fs, path, saveJSON, log, cronStore, MCPServer, SecurityManager,
 *          MCPChannelBridge, 以及 executeCronXxx / executeMCPXxx 委托函数
 */

module.exports = [

  // ════════════════════════════════════════════════════════════
  //  定时任务 (cron) - category: 'cron'
  // ════════════════════════════════════════════════════════════

  {
    name: 'cron_create',
    description: '创建定时任务。三种时间设置方式(三选一): (1)expression=周期性cron表达式 (2)executeAt=一次性执行时间ISO格式如"2026-04-11T06:12:00" (3)delayMinutes=几分钟后执行(一次性)。重要：如果用户要你"现在"或"马上"做某事，直接用对应工具(browser/bash等)执行，不要创建定时任务！只有用户明确说"定时""计划""稍后""X分钟后"等才用cron_create。例1-周期性:"每天9点查天气"→{name:"每日天气",expression:"0 9 * * *",taskType:"ai",command:"查询天气"} 例2-一次性:"5分钟后打开B站"→{name:"打开B站",delayMinutes:5,taskType:"browser",command:"打开https://bilibili.com"} 例3-指定时间:"今晚8点提醒"→{name:"晚间提醒",executeAt:"2026-04-11T20:00:00",taskType:"ai",command:"提醒用户开会"}',
    parameters: { type: 'object', properties: { name: { type: 'string', description: '任务名称' }, expression: { type: 'string', description: '[周期性]Cron表达式(分 时 日 月 周)，如"0 9 * * *"=每天9点,"*/30 * * * *"=每30分钟。与executeAt/delayMinutes二选一' }, executeAt: { type: 'string', description: '[一次性]ISO时间格式，如"2026-04-11T06:12:00"，任务将在该时刻执行一次后自动停用。与expression/delayMinutes二选一' }, delayMinutes: { type: 'number', description: '[一次性]几分钟后执行，如1=1分钟后，5=5分钟后。系统自动计算cron表达式。与expression/executeAt二选一' }, taskType: { type: 'string', enum: ['shell','ai','browser','webhook','tool'], description: '任务类型：shell=执行命令,ai=AI智能任务(可使用全部工具),browser=浏览器操作(AI驱动),webhook=HTTP回调(填URL),tool=指定工具调用' }, command: { type: 'string', description: '任务内容：shell填命令/AI填提示词/browser填URL或操作描述/webhook填URL' }, toolName: { type: 'string', description: '工具名称(仅taskType=tool时必填)，如bash/powershell/web_fetch/file_read等' }, toolArgs: { type: 'object', description: '工具参数JSON(仅taskType=tool时使用)，如{"cmd":"ls -la"}' }, model: { type: 'string', description: 'AI任务使用的模型(仅taskType=ai/browser/tool时可选)' }, enabled: { type: 'boolean', description: '是否立即启用，默认true' } }, required: ['name','taskType','command'] },
    category: 'cron',
    dangerous: true,
    execute: function(args, ctx) {
      return ctx.executeCronCreate ? ctx.executeCronCreate(args) : { success: false, error: '定时任务未初始化' };
    }
  },

  {
    name: 'cron_list',
    description: '列出所有定时任务及其状态',
    parameters: { type: 'object', properties: {}, required: [] },
    category: 'cron',
    execute: function(args, ctx) {
      return ctx.executeCronList ? ctx.executeCronList() : { success: false, error: '定时任务未初始化' };
    }
  },

  {
    name: 'cron_delete',
    description: '删除指定定时任务',
    parameters: { type: 'object', properties: { jobId: { type: 'string', description: '要删除的任务ID（从cron_list获取）' } }, required: ['jobId'] },
    category: 'cron',
    execute: function(args, ctx) {
      return ctx.executeCronDelete ? ctx.executeCronDelete(args) : { success: false, error: '定时任务未初始化' };
    }
  },

  {
    name: 'cron_toggle',
    description: '启用或禁用定时任务',
    parameters: { type: 'object', properties: { jobId: { type: 'string', description: '任务ID' }, enabled: { type: 'boolean', description: 'true=启用, false=禁用' } }, required: ['jobId','enabled'] },
    category: 'cron',
    execute: function(args, ctx) {
      return ctx.executeCronToggle ? ctx.executeCronToggle(args) : { success: false, error: '定时任务未初始化' };
    }
  },

  {
    name: 'cron_run_now',
    description: '立即执行一次定时任务（不等待下次计划时间）',
    parameters: { type: 'object', properties: { jobId: { type: 'string', description: '要立即执行的任务ID' } }, required: ['jobId'] },
    category: 'cron',
    dangerous: true,
    execute: function(args, ctx) {
      return ctx.executeCronRunNow ? ctx.executeCronRunNow(args) : { success: false, error: '定时任务未初始化' };
    }
  },

  {
    name: 'cron_delivery',
    description: '设置定时任务的交付方式。支持频道通知、Webhook回调等。',
    parameters: { type: 'object', properties: { jobId: { type: 'string', description: '定时任务ID' }, mode: { type: 'string', enum: ['none','announce','webhook'], description: '交付模式' }, channel: { type: 'string', description: '通知渠道（announce模式）' }, to: { type: 'string', description: '通知目标（频道/用户ID）' }, webhookUrl: { type: 'string', description: 'Webhook URL（webhook模式）' }, failureAlert: { type: 'object', properties: { after: { type: 'number', description: '连续失败N次后告警' }, channel: { type: 'string', description: '告警渠道' }, cooldownMs: { type: 'number', description: '告警冷却期毫秒' } }, description: '失败告警配置' } }, required: ['jobId','mode'] },
    category: 'cron',
    execute: async function(args, ctx) {
      var cronStore = ctx.cronStore;
      var saveJSON = ctx.saveJSON;
      var SecurityManager = ctx.SecurityManager;
      try {
        var _cdJobId = args.jobId;
        var _cdMode = args.mode;
        var _cdJob = cronStore.find(function(j){return j.id===_cdJobId;});
        if (!_cdJob) return {ok:false,error:'任务未找到: '+_cdJobId};
        if (args.webhookUrl) {
          if (SecurityManager && typeof SecurityManager.checkUrl === 'function') {
            var _cdSsrfCheck = await SecurityManager.checkUrl(args.webhookUrl);
            if (_cdSsrfCheck && !_cdSsrfCheck.safe) {
              return { ok:false, error:'SSRF防护: webhook URL不允许 - ' + (_cdSsrfCheck.reason || '') };
            }
          }
        }
        _cdJob.delivery = {mode:_cdMode, channel:args.channel||'', to:args.to||'', webhookUrl:args.webhookUrl||''};
        if (args.failureAlert) _cdJob.failureAlert = args.failureAlert;
        saveJSON('cron.json', cronStore);
        return {ok:true, jobId:_cdJobId, delivery:_cdJob.delivery};
      } catch(e) { return {ok:false,error:e.message}; }
    }
  },

  // ════════════════════════════════════════════════════════════
  //  MCP 类工具 - category: 'mcp'
  // ════════════════════════════════════════════════════════════

  {
    name: 'mcp_list',
    description: '列出所有已连接的MCP服务器及其可用工具。返回每个服务器的ID、名称、状态和工具列表。',
    parameters: { type: 'object', properties: {}, required: [] },
    category: 'mcp',
    execute: function(args, ctx) {
      return ctx.executeMCPList ? ctx.executeMCPList() : { success: false, error: 'MCP未初始化' };
    }
  },

  {
    name: 'mcp_start',
    description: '启动一个MCP服务器以获取外部工具能力',
    parameters: { type: 'object', properties: { serverName: { type: 'string', description: 'MCP服务器名称' } }, required: ['serverName'] },
    category: 'mcp',
    dangerous: true,
    execute: function(args, ctx) {
      return ctx.executeMCPStart ? ctx.executeMCPStart(args) : { success: false, error: 'MCP未初始化' };
    }
  },

  {
    name: 'mcp_stop',
    description: '停止一个MCP服务器',
    parameters: { type: 'object', properties: { serverName: { type: 'string', description: 'MCP服务器名称' } }, required: ['serverName'] },
    category: 'mcp',
    execute: function(args, ctx) {
      return ctx.executeMCPStop ? ctx.executeMCPStop(args) : { success: false, error: 'MCP未初始化' };
    }
  },

  {
    name: 'mcp_call',
    description: '调用MCP(Model Context Protocol)服务器上的工具。MCP工具是由外部MCP服务器提供的扩展能力。先使用mcp_list查看可用服务器和工具。',
    parameters: { type: 'object', properties: { serverId: { type: 'string', description: 'MCP服务器ID' }, toolName: { type: 'string', description: '要调用的工具名称' }, args: { type: 'object', description: '工具参数(JSON对象)' } }, required: ['serverId','toolName'] },
    category: 'mcp',
    dangerous: true,
    execute: async function(args, ctx) {
      var MCPServer = ctx.MCPServer;
      var _mcpSid = args.serverId || '';
      var _mcpTn = args.toolName || '';
      var _mcpA = args.args || {};
      if (!_mcpSid || !_mcpTn) return {ok:false,error:'需要serverId和toolName'};
      try {
        var _mcpR = await MCPServer.callTool(_mcpSid, _mcpTn, _mcpA);
        return _mcpR;
      } catch(e) { return {ok:false,error:'MCP调用失败: '+e.message}; }
    }
  },

  {
    name: 'mcp_resources',
    description: '列出MCP服务器提供的可用资源（如文件、数据等）。',
    parameters: { type: 'object', properties: { server: { type: 'string', description: 'MCP服务器名称（可选，留空列出所有）' } }, required: [] },
    category: 'mcp',
    execute: async function(args, ctx) {
      var MCPServer = ctx.MCPServer;
      var _mrServer = args.server || '';
      try {
        if (typeof MCPServer === 'undefined') return {ok:false,error:'MCP系统未初始化'};
        var _mrList = MCPServer.listResources ? MCPServer.listResources(_mrServer) : [];
        return {ok:true,resources:_mrList};
      } catch(e) { return {ok:false,error:e.message}; }
    }
  },

  {
    name: 'mcp_resource_read',
    description: '读取MCP服务器上的特定资源。',
    parameters: { type: 'object', properties: { server: { type: 'string', description: 'MCP服务器名称' }, uri: { type: 'string', description: '资源URI' } }, required: ['server','uri'] },
    category: 'mcp',
    execute: async function(args, ctx) {
      var MCPServer = ctx.MCPServer;
      var _mrrServer = args.server || '';
      var _mrrUri = args.uri || '';
      if (!_mrrServer || !_mrrUri) return {ok:false,error:'请提供server和uri'};
      try {
        if (typeof MCPServer === 'undefined') return {ok:false,error:'MCP系统未初始化'};
        var _mrrResult = MCPServer.readResource ? await MCPServer.readResource(_mrrServer, _mrrUri) : null;
        return {ok:true,server:_mrrServer,uri:_mrrUri,content:_mrrResult};
      } catch(e) { return {ok:false,error:e.message}; }
    }
  },

  // ════════════════════════════════════════════════════════════
  //  MCP Loopback - category: 'mcp'
  // ════════════════════════════════════════════════════════════

  {
    name: 'mcp_loopback_start',
    description: '启动MCP Loopback服务器，允许外部MCP客户端(如Claude Desktop)通过HTTP连接到SkyalyticWing。',
    parameters: { type: 'object', properties: { port: { type: 'number', description: '端口号(0=自动分配)' } }, required: [] },
    category: 'mcp',
    execute: async function(args, ctx) {
      var MCPServer = ctx.MCPServer;
      if (!MCPServer) return {ok:false,error:'MCP系统未初始化'};
      try {
        return await MCPServer.startLoopback(args.port || 0);
      } catch(e) { return {ok:false,error:e.message}; }
    }
  },

  {
    name: 'mcp_loopback_status',
    description: '获取MCP Loopback服务器状态，包括运行状态、端口、Token和Claude Desktop配置。',
    parameters: { type: 'object', properties: {}, required: [] },
    category: 'mcp',
    execute: function(args, ctx) {
      var MCPServer = ctx.MCPServer;
      if (!MCPServer) return {ok:false,error:'MCP系统未初始化'};
      try {
        return MCPServer.getLoopbackStatus();
      } catch(e) { return {ok:false,error:e.message}; }
    }
  },

  {
    name: 'mcp_conversations_list',
    description: '列出所有频道对话和API会话，可通过MCP Loopback供外部客户端访问。',
    parameters: { type: 'object', properties: { channel: { type: 'string', description: '按频道过滤' }, search: { type: 'string', description: '搜索关键词' }, limit: { type: 'number', description: '最大返回数量' } }, required: [] },
    category: 'mcp',
    execute: function(args, ctx) {
      var MCPChannelBridge = ctx.MCPChannelBridge;
      if (!MCPChannelBridge) return {ok:false,error:'MCPChannelBridge未初始化'};
      try {
        return { ok: true, conversations: MCPChannelBridge.listConversations(args) };
      } catch(e) { return {ok:false,error:e.message}; }
    }
  }

];
