/**
 * 会话与代理类工具模块 (热加载)
 *
 * 提取自 start.cjs 的以下工具:
 *  - 会话类 (category: 'session'):
 *      session_list, session_create, session_status,
 *      sessions_history, sessions_send, sessions_spawn
 *  - 代理类 (category: 'agent'):
 *      agent_send, agent_inbox, agent_list,
 *      subagent_execute, subagents
 *  - 渠道类 (category: 'session'):
 *      send_file_to_user
 *
 * execute(args, ctx) 中从 ctx 解构以下变量:
 *   fs, path, configStore, sessionsStore, subAgentStore, saveJSON, log, broadcast,
 *   getActiveToolDefinitions, callAIProvider, resolveModel,
 *   AgentMessenger, SubAgentSystem, getAgents,
 *   _activeAgentForTool, _currentSessionId,
 *   executeSessionList, executeSessionCreate, executeSendFileToUser
 */

module.exports = [

  // ═══ session_list ═══
  {
    name: 'session_list',
    description: '列出所有会话',
    parameters: { type: 'object', properties: {}, required: [] },
    category: 'session',
    dangerous: false,
    execute: function(args, ctx) {
      return ctx.executeSessionList ? ctx.executeSessionList() : { success: false, error: '会话系统未初始化' };
    }
  },

  // ═══ session_create ═══
  {
    name: 'session_create',
    description: '创建新会话',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: '会话名称' } },
      required: ['name']
    },
    category: 'session',
    dangerous: false,
    execute: function(args, ctx) {
      return ctx.executeSessionCreate ? ctx.executeSessionCreate(args) : { success: false, error: '会话系统未初始化' };
    }
  },

  // ═══ send_file_to_user ═══
  {
    name: 'send_file_to_user',
    description: '通过当前聊天渠道发送文件或图片给用户。当用户要求发送文件、图片、截图等时使用此工具。支持png/jpg/gif/webp/pdf/doc/xls/ppt/txt/zip等格式。流程：先用工具找到文件路径，然后用此工具发送。',
    parameters: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: '要发送的文件绝对路径（如 D:\\lyd\\Desktop\\screenshot.png）' },
        caption: { type: 'string', description: '随文件附带的文字说明' }
      },
      required: ['filePath']
    },
    category: 'session',
    dangerous: false,
    execute: function(args, ctx) {
      return ctx.executeSendFileToUser ? ctx.executeSendFileToUser(args, args._channelType || args.channelType || 'web') : { success: false, error: '渠道系统未初始化' };
    }
  },

  // ═══ sessions_history ═══
  {
    name: 'sessions_history',
    description: '读取指定会话的历史消息。可查看其他会话的对话内容。',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: '会话ID' },
        limit: { type: 'number', description: '返回最近N条消息，默认20' },
        role: { type: 'string', enum: ['user', 'assistant', 'tool', 'all'], description: '过滤消息角色，默认all' }
      },
      required: ['sessionId']
    },
    category: 'session',
    dangerous: false,
    execute: function(args, ctx) {
      var sessionsStore = ctx.sessionsStore;
      var _shSid = args.sessionId || '';
      if (!_shSid) return { ok: false, error: '请提供会话ID' };
      var _shSess = sessionsStore[_shSid];
      if (!_shSess) return { ok: false, error: '会话不存在: ' + _shSid };
      var _shMsgs = _shSess.messages || [];
      var _shLimit = args.limit || 20;
      var _shRole = args.role || 'all';
      if (_shRole !== 'all') _shMsgs = _shMsgs.filter(function(m) { return m.role === _shRole; });
      _shMsgs = _shMsgs.slice(-_shLimit);
      return {
        ok: true,
        sessionId: _shSid,
        messages: _shMsgs.map(function(m) { return { role: m.role, content: String(m.content || '').substring(0, 500), timestamp: m.timestamp }; }),
        total: _shSess.messages.length
      };
    }
  },

  // ═══ sessions_send ═══
  {
    name: 'sessions_send',
    description: '向其他会话发送消息。用于跨会话通信和协作。',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: '目标会话ID' },
        message: { type: 'string', description: '要发送的消息内容' },
        fromAgent: { type: 'string', description: '发送方Agent ID（可选）' }
      },
      required: ['sessionId', 'message']
    },
    category: 'session',
    dangerous: true,
    execute: function(args, ctx) {
      var sessionsStore = ctx.sessionsStore;
      var saveJSON = ctx.saveJSON;
      var _ssSid = args.sessionId || '';
      var _ssMsg = args.message || '';
      if (!_ssSid || !_ssMsg) return { ok: false, error: '请提供sessionId和message' };
      if (!sessionsStore[_ssSid]) return { ok: false, error: '会话不存在: ' + _ssSid };
      sessionsStore[_ssSid].messages.push({ role: 'user', content: _ssMsg, timestamp: Date.now(), fromAgent: args.fromAgent || 'system' });
      saveJSON('sessions.json', sessionsStore);
      return { ok: true, sessionId: _ssSid, sent: true };
    }
  },

  // ═══ agent_send ═══
  {
    name: 'agent_send',
    description: '向其他母代理发送消息。用于母代理之间的协作通信，消息会投递到目标代理的收件箱和最近会话中。',
    parameters: {
      type: 'object',
      properties: {
        toAgentId: { type: 'string', description: '目标代理ID（如code_expert, doc_expert, data_analyst, ops_expert, explorer）' },
        message: { type: 'string', description: '要发送的消息内容' },
        type: { type: 'string', enum: ['text', 'task', 'query', 'response', 'notification'], description: '消息类型：text=普通文本,task=任务分配,query=查询请求,response=回复,notification=通知' }
      },
      required: ['toAgentId', 'message']
    },
    category: 'agent',
    dangerous: false,
    execute: function(args, ctx) {
      var AgentMessenger = ctx.AgentMessenger;
      var _activeAgentForTool = ctx._activeAgentForTool;
      var _asTo = args.toAgentId || '';
      var _asMsg = args.message || '';
      var _asType = args.type || 'text';
      if (!_asTo || !_asMsg) return { ok: false, error: '请提供toAgentId和message' };
      var _asFrom = _activeAgentForTool || 'main';
      var _asResult = AgentMessenger.send(_asFrom, _asTo, _asMsg, _asType);
      if (!_asResult.success) return { ok: false, error: _asResult.error };
      return { ok: true, msgId: _asResult.msgId, delivered: _asResult.delivered, from: _asFrom, to: _asTo };
    }
  },

  // ═══ agent_inbox ═══
  {
    name: 'agent_inbox',
    description: '查看当前代理的收件箱。获取其他代理发来的消息列表，包括未读消息。',
    parameters: {
      type: 'object',
      properties: {
        unreadOnly: { type: 'boolean', description: '是否只显示未读消息，默认false' },
        markRead: { type: 'boolean', description: '是否标记为已读，默认true' }
      },
      required: []
    },
    category: 'agent',
    dangerous: false,
    execute: function(args, ctx) {
      var AgentMessenger = ctx.AgentMessenger;
      var _activeAgentForTool = ctx._activeAgentForTool;
      var _aiAgentId = _activeAgentForTool || 'main';
      var _aiUnreadOnly = args.unreadOnly || false;
      var _aiMarkRead = args.markRead !== false;
      var _aiMsgs = _aiUnreadOnly ? AgentMessenger.getUnread(_aiAgentId) : AgentMessenger.getInbox(_aiAgentId);
      if (_aiMarkRead && _aiMsgs.length > 0) AgentMessenger.markRead(_aiAgentId);
      return { ok: true, agentId: _aiAgentId, messages: _aiMsgs, unreadCount: AgentMessenger.getUnread(_aiAgentId).length };
    }
  },

  // ═══ agent_list ═══
  {
    name: 'agent_list',
    description: '列出所有可用的母代理。查看代理ID、名称、类型和能力，用于选择通信目标。',
    parameters: {
      type: 'object',
      properties: {
        capability: { type: 'string', description: '按能力过滤（如code,doc,data,ops,search）' }
      },
      required: []
    },
    category: 'agent',
    dangerous: false,
    execute: function(args, ctx) {
      var getAgents = ctx.getAgents;
      var _alAgents = getAgents().agents;
      var _alCap = args.capability || '';
      if (_alCap) {
        _alAgents = _alAgents.filter(function(a) {
          return (a.capabilities || []).some(function(c) { return c.toLowerCase().indexOf(_alCap.toLowerCase()) >= 0; });
        });
      }
      return {
        ok: true,
        agents: _alAgents.map(function(a) { return { id: a.id, name: a.name, type: a.type, capabilities: a.capabilities || [], status: a.status, model: a.model || '' }; })
      };
    }
  },

  // ═══ subagents ═══
  {
    name: 'subagents',
    description: '管理子代理。列出运行中的子代理、查看状态或终止子代理。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'status', 'terminate'], description: '操作：list=列出,status=状态,terminate=终止' },
        agentId: { type: 'string', description: '子代理ID（terminate和status时需要）' }
      },
      required: ['action']
    },
    category: 'agent',
    dangerous: false,
    execute: function(args, ctx) {
      var sessionsStore = ctx.sessionsStore;
      var saveJSON = ctx.saveJSON;
      var _saAction = args.action || 'list';
      if (_saAction === 'list') {
        var _saList = [];
        for (var _saK in sessionsStore) {
          if (_saK.indexOf('subagent-') === 0 || _saK.indexOf('skill-') === 0) {
            var _saS = sessionsStore[_saK];
            _saList.push({ id: _saK, name: _saS.name || _saK, msgCount: (_saS.messages || []).length, createdAt: _saS.createdAt });
          }
        }
        return { ok: true, subagents: _saList, total: _saList.length };
      }
      if (_saAction === 'status') {
        var _saAid = args.agentId || '';
        if (!_saAid) return { ok: false, error: '请提供agentId' };
        var _saSess = sessionsStore[_saAid];
        if (!_saSess) return { ok: false, error: '子代理不存在: ' + _saAid };
        return { ok: true, agentId: _saAid, name: _saSess.name, msgCount: (_saSess.messages || []).length, createdAt: _saSess.createdAt };
      }
      if (_saAction === 'terminate') {
        var _saTid = args.agentId || '';
        if (!_saTid) return { ok: false, error: '请提供agentId' };
        if (!sessionsStore[_saTid]) return { ok: false, error: '子代理不存在: ' + _saTid };
        delete sessionsStore[_saTid];
        saveJSON('sessions.json', sessionsStore);
        return { ok: true, terminated: _saTid };
      }
      return { ok: false, error: 'Unknown action: ' + _saAction };
    }
  },

  // ═══ session_status ═══
  {
    name: 'session_status',
    description: '显示当前会话状态信息，包括模型、token用量、消息数等。可设置会话级别的模型覆盖。',
    parameters: {
      type: 'object',
      properties: {
        setModel: { type: 'string', description: '设置会话覆盖模型（如deepseek-chat），留空则仅查看状态' }
      },
      required: []
    },
    category: 'session',
    dangerous: false,
    execute: function(args, ctx) {
      var configStore = ctx.configStore;
      var sessionsStore = ctx.sessionsStore;
      var saveJSON = ctx.saveJSON;
      var _currentSessionId = ctx._currentSessionId;
      var _sstModel = args.setModel || '';
      if (_sstModel) {
        if (!configStore.general) configStore.general = {};
        configStore.general.defaultModel = _sstModel;
        saveJSON('config.json', configStore);
        return { ok: true, model: _sstModel, message: '会话模型已设置为: ' + _sstModel };
      }
      var _sstSess = sessionsStore[_currentSessionId];
      return {
        ok: true,
        model: configStore.general && configStore.general.defaultModel || 'not set',
        sessionId: _currentSessionId,
        msgCount: _sstSess ? _sstSess.messages.length : 0,
        uptime: Math.round(process.uptime()) + 's'
      };
    }
  },

  // ═══ subagent_execute ═══
  {
    name: 'subagent_execute',
    description: '创建一个子代理(Sub-Agent)执行任务。子代理有独立的工作区和上下文，使用真实AI执行，完成后结果汇集到父代理工作区，然后自动销毁。',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: '任务简短标题' },
        prompt: { type: 'string', description: '子代理要执行的详细任务描述和指令' },
        model: { type: 'string', description: '使用的AI模型(可选，留空使用默认)' },
        type: { type: 'string', description: '任务类型: worker(默认)/researcher/coder/writer', enum: ['worker', 'researcher', 'coder', 'writer'] },
        autoDestroy: { type: 'boolean', description: '任务完成后自动销毁(默认true)' }
      },
      required: ['task']
    },
    category: 'agent',
    dangerous: true,
    execute: async function(args, ctx) {
      var log = ctx.log;
      var subAgentStore = ctx.subAgentStore;
      var saveJSON = ctx.saveJSON;
      var SubAgentSystem = ctx.SubAgentSystem;
      var _activeAgentForTool = ctx._activeAgentForTool;
      var _etSaParent = _activeAgentForTool || 'main';
      log('INFO', 'subagent', 'executeTool subagent_execute: parent=' + _etSaParent + ' task=' + (args.task || '').substring(0, 60));
      var _etSaAgent = SubAgentSystem.createSubAgent(_etSaParent, {
        task: args.task || 'Untitled',
        prompt: args.prompt || args.task || '',
        model: args.model || '',
        type: args.type || 'worker',
        autoDestroy: args.autoDestroy !== false
      });
      if (!_etSaAgent || !_etSaAgent.id) return { ok: false, error: '子代理创建失败: ' + ((_etSaAgent && _etSaAgent.error) || '未知错误') };
      if (!subAgentStore[_etSaAgent.id]) {
        log('ERROR', 'subagent', 'Agent not in store after creation! agentId=' + _etSaAgent.id + ' storeKeys=' + Object.keys(subAgentStore).length);
        subAgentStore[_etSaAgent.id] = _etSaAgent;
        saveJSON('subagents.json', subAgentStore);
      }
      var _etSaResult = await SubAgentSystem.executeSync(_etSaAgent.id);
      return { ok: _etSaResult.success, output: _etSaResult.result || '', agentId: _etSaResult.agentId, error: _etSaResult.error || '' };
    }
  },

  // ═══ subagent_spawn_swarm ═══
  // 注意: 此工具在 start.cjs 的 AI 响应处理代码中有特殊拦截 (line ~1836, ~13221),
  //       优先于 executeTool 执行。此处提供 schema 定义 + 兜底实现,
  //       确保特殊拦截被移除或失效时仍可正常工作。
  {
    name: 'subagent_spawn_swarm',
    description: '蜂群模式：并行创建多个子代理同时执行不同任务。所有子代理并行运行，结果汇总后返回。适用于需要同时处理多个独立子任务的场景。',
    parameters: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              task: { type: 'string', description: '任务标题' },
              prompt: { type: 'string', description: '详细任务描述' },
              type: { type: 'string', description: '任务类型', enum: ['worker', 'researcher', 'coder', 'writer'] }
            },
            required: ['task']
          },
          description: '要并行执行的任务列表(最多5个)',
          minItems: 1,
          maxItems: 5
        }
      },
      required: ['tasks']
    },
    category: 'agent',
    dangerous: true,
    execute: async function(args, ctx) {
      var log = ctx.log || function() {};
      var SubAgentSystem = ctx.SubAgentSystem;
      var _activeAgentForTool = ctx._activeAgentForTool;
      if (!SubAgentSystem || typeof SubAgentSystem.spawnSwarm !== 'function') {
        return { ok: false, error: 'SubAgentSystem 未初始化或 spawnSwarm 不可用' };
      }
      var _swParentAgent = _activeAgentForTool || ctx._currentAgentId || 'main';
      var _swTasks = (args.tasks || []).slice(0, 5);
      if (_swTasks.length === 0) return { ok: false, error: 'tasks 不能为空' };
      try {
        log('INFO', 'subagent', 'executeTool subagent_spawn_swarm: parent=' + _swParentAgent + ' tasks=' + _swTasks.length);
        var _swResult = await SubAgentSystem.spawnSwarm(_swParentAgent, _swTasks);
        return { ok: true, totalTasks: _swResult.totalTasks, completed: _swResult.completed, failed: _swResult.failed, summary: _swResult.summary };
      } catch(swe) {
        return { ok: false, error: '蜂群执行失败: ' + swe.message };
      }
    }
  },

  // ═══ sessions_spawn ═══
  {
    name: 'sessions_spawn',
    description: '在独立会话中执行任务。创建一个隔离的会话运行AI任务，完成后返回结果。适用于并行执行多个独立任务。',
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string', description: '要执行的任务描述' },
        model: { type: 'string', description: '使用的AI模型（可选）' },
        agentId: { type: 'string', description: '使用的Agent ID（可选）' },
        timeout: { type: 'number', description: '超时秒数，默认120' }
      },
      required: ['message']
    },
    category: 'session',
    dangerous: true,
    execute: async function(args, ctx) {
      var sessionsStore = ctx.sessionsStore;
      var resolveModel = ctx.resolveModel;
      var callAIProvider = ctx.callAIProvider;
      var getActiveToolDefinitions = ctx.getActiveToolDefinitions;
      // 资源泄漏防护——加最大超时(30分钟)兜底与会话清理逻辑
      // 原实现：超时/callAIProvider 报错时 sessionsStore 中的 spawn 会话不会被删除，长期运行下泄漏。
      var _spSessionId = null;
      var _spCleanupTimer = null;
      var _spHardTimeoutMs = 30 * 60 * 1000; // 30 分钟硬上限，防止孤儿会话
      try {
        var _spMsg = args.message || '';
        var _spModel = args.model || resolveModel(null);
        var _spAgentId = args.agentId || 'main';
        // 限制用户传入的 timeout 不超过硬上限
        var _spUserTimeout = Math.max(1, (args.timeout || 120)) * 1000;
        var _spTimeout = Math.min(_spUserTimeout, _spHardTimeoutMs);
        _spSessionId = 'spawn-' + Date.now() + '-' + Math.random().toString(36).substr(2, 6);
        sessionsStore[_spSessionId] = {
          id: _spSessionId,
          name: 'Spawn:' + _spMsg.substring(0, 30),
          messages: [{ role: 'user', content: _spMsg, timestamp: Date.now() }],
          createdAt: Date.now(),
          agent: _spAgentId,
          isSpawned: true
        };
        var _spResult = await Promise.race([
          callAIProvider(_spMsg, _spModel, _spSessionId, getActiveToolDefinitions(), _spAgentId),
          new Promise(function(_, reject) {
            _spCleanupTimer = setTimeout(function() {
              reject(new Error('Spawn timeout (' + Math.round(_spTimeout / 1000) + 's)'));
            }, _spTimeout);
          })
        ]);
        var _spOutput = _spResult.type === 'text' ? _spResult.content : JSON.stringify(_spResult);
        // 成功路径：清理定时器与会话
        if (_spCleanupTimer) { clearTimeout(_spCleanupTimer); _spCleanupTimer = null; }
        try { delete sessionsStore[_spSessionId]; } catch (e2) {}
        _spSessionId = null;
        return { ok: true, output: _spOutput, sessionId: _spResult.sessionId || null, model: _spModel };
      } catch (e) {
        // 失败/超时路径：同样清理定时器与会话，防止孤儿
        if (_spCleanupTimer) { try { clearTimeout(_spCleanupTimer); } catch (ce) {} _spCleanupTimer = null; }
        if (_spSessionId && sessionsStore) {
          try { delete sessionsStore[_spSessionId]; } catch (de) {}
        }
        return { ok: false, error: 'Spawn执行失败: ' + e.message };
      }
    }
  }

];
