/**
 * 记忆 / 技能 / 插件 / 知识库 / 计划 类工具模块
 *
 * 从 start.cjs 提取的工具实现, 支持热加载。
 * 工具列表:
 *   - memory_search / memory_get / memory_save          (category: 'memory')
 *   - skill_create / skill_list / skill_execute          (category: 'skill')
 *   - plugin_list / plugin_toggle / plugin_install / plugin_search  (category: 'plugin')
 *   - knowledge_search / knowledge_add                   (category: 'system')
 *   - update_plan                                        (category: 'system')
 *
 * execute 签名: function(args, ctx)
 * ctx 提供: fs, path, APP_DIR, DATA_DIR, configStore, sessionsStore, saveJSON, log,
 *          broadcast, _skillsList, _rebuildWorkspacePrompt, MemorySystem,
 *          _activeAgentForTool, PluginManager,
 *          executeKnowledgeSearch, executeKnowledgeAdd,
 *          executePluginList, executePluginToggle
 */

module.exports = [

  // ════════════════════════════════════════════════════════════
  //  记忆类 (memory) - category: 'memory'
  // ════════════════════════════════════════════════════════════

  {
    name: 'memory_search',
    description: '搜索长期记忆(MEMORY.md)和每日笔记(memory/*.md)。在回答关于之前工作、决策、偏好、待办等问题前，必须先搜索记忆。',
    parameters: { type: 'object', properties: { query: { type: 'string', description: '搜索查询' }, maxResults: { type: 'number', description: '最大结果数(默认10)' } }, required: ['query'] },
    category: 'memory',
    execute: function(args, ctx) {
      var MemorySystem = ctx.MemorySystem;
      var _activeAgentForTool = ctx._activeAgentForTool;
      var _mQuery = args.query || '';
      if (!_mQuery) return { ok: false, error: '请提供搜索查询' };
      var _mResults = MemorySystem.search(_mQuery, args.maxResults || 10, _activeAgentForTool);
      return { ok: true, query: _mQuery, results: _mResults, total: _mResults.length };
    }
  },

  {
    name: 'memory_get',
    description: '读取记忆文件的具体内容。支持MEMORY.md和memory/*.md文件。',
    parameters: { type: 'object', properties: { path: { type: 'string', description: '文件路径，如MEMORY.md或memory/2026-04-19.md' }, from: { type: 'number', description: '起始行号(默认1)' }, lines: { type: 'number', description: '读取行数(默认120)' } }, required: ['path'] },
    category: 'memory',
    execute: function(args, ctx) {
      var MemorySystem = ctx.MemorySystem;
      var _mPath = args.path || '';
      if (!_mPath) return { ok: false, error: '请提供文件路径' };
      var _mResult = MemorySystem.get(_mPath, args.from, args.lines);
      if (_mResult.error) return { ok: false, error: _mResult.error };
      return { ok: true, result: _mResult };
    }
  },

  {
    name: 'memory_save',
    description: '保存信息到记忆系统。重要信息保存到MEMORY.md(长期)，临时观察保存到今日笔记。',
    parameters: { type: 'object', properties: { content: { type: 'string', description: '要保存的内容' }, target: { type: 'string', enum: ['longterm','today'], description: 'longterm=保存到MEMORY.md(长期记忆), today=保存到今日笔记(短期)' }, section: { type: 'string', description: '可选的章节标题' } }, required: ['content','target'] },
    category: 'memory',
    execute: function(args, ctx) {
      var fs = ctx.fs;
      var path = ctx.path;
      var DATA_DIR = ctx.DATA_DIR;
      var log = ctx.log;
      var MemorySystem = ctx.MemorySystem;
      var _activeAgentForTool = ctx._activeAgentForTool;
      var _mContent = args.content || '';
      var _mTarget = args.target || 'today';
      var _mSection = args.section || '';
      if (!_mContent) return { ok: false, error: '请提供要保存的内容' };
      var _saveText = _mSection ? '\n### ' + _mSection + '\n' + _mContent : _mContent;
      var _mSaveResult;
      if (_mTarget === 'longterm') {
        _mSaveResult = MemorySystem.appendToMemory(_saveText);
        if (_activeAgentForTool && _activeAgentForTool !== 'main') {
          try {
            var _wsMemDir = path.join(DATA_DIR, 'workspaces', _activeAgentForTool);
            if (!fs.existsSync(_wsMemDir)) fs.mkdirSync(_wsMemDir, {recursive:true});
            var _wsMemPath = path.join(_wsMemDir, 'MEMORY.md');
            var _wsMemContent = '';
            if (fs.existsSync(_wsMemPath)) _wsMemContent = fs.readFileSync(_wsMemPath, 'utf-8');
            if (!_wsMemContent.endsWith('\n')) _wsMemContent += '\n';
            _wsMemContent += _saveText + '\n';
            fs.writeFileSync(_wsMemPath, _wsMemContent);
          } catch(wsMemErr) { log('WARN','memory','Failed to write workspace MEMORY.md: '+wsMemErr.message); }
        }
      } else {
        _mSaveResult = MemorySystem.appendToToday(_saveText);
      }
      if (_mSaveResult.ok) return { ok: true, target: _mTarget, saved: true };
      return { ok: false, error: _mSaveResult.error };
    }
  },

  // ════════════════════════════════════════════════════════════
  //  技能类 (skill) - category: 'skill'
  // ════════════════════════════════════════════════════════════

  {
    name: 'skill_create',
    description: '创建新技能。技能是AI可以调用的操作指南，定义了特定场景下的操作步骤。创建后AI会在相关场景下自动使用。用户说"帮我创建一个XXX技能"时使用此工具。',
    parameters: { type: 'object', properties: { name: { type: 'string', description: '技能名称（英文小写+连字符，如web-search/code-review）' }, description: { type: 'string', description: '技能简短描述' }, emoji: { type: 'string', description: '技能图标emoji' }, steps: { type: 'string', description: '技能的详细操作步骤（Markdown格式）' } }, required: ['name','description','steps'] },
    category: 'skill',
    execute: function(args, ctx) {
      var path = ctx.path;
      var fs = ctx.fs;
      var APP_DIR = ctx.APP_DIR;
      var broadcast = ctx.broadcast;
      var _skillsList = ctx._skillsList;
      var _rebuildWorkspacePrompt = ctx._rebuildWorkspacePrompt;
      var _scName2=args.name||'';
      var _scDesc=args.description||'';
      var _scEmoji=args.emoji||'📋';
      var _scSteps=args.steps||'';
      if(!_scName2)return{ok:false,error:'缺少技能名称'};
      if(!_scDesc)return{ok:false,error:'缺少技能描述'};
      if(!_scSteps)return{ok:false,error:'缺少技能步骤'};
      if(_scName2.indexOf('..')>=0||_scName2.indexOf('/')>=0||_scName2.indexOf('\\')>=0)return{ok:false,error:'技能名称不能包含路径分隔符'};
      try{
        var _scDir2=path.resolve(APP_DIR,'skills',_scName2);
        var _scSkillsRoot2=path.resolve(APP_DIR,'skills');
        var _scSkillsBase2=_scSkillsRoot2+path.sep;
        if(_scDir2!==_scSkillsRoot2&&_scDir2.indexOf(_scSkillsBase2)!==0)return{ok:false,error:'路径不允许超出skills目录'};
        if(!fs.existsSync(_scDir2))fs.mkdirSync(_scDir2,{recursive:true});
        var _scPath2=path.join(_scDir2,'SKILL.md');
        var _scContent2='---\nname: '+_scName2+'\ndescription: "'+_scDesc+'"\nemoji: "'+_scEmoji+'"\n---\n\n# '+_scName2+'\n\n'+_scSteps+'\n';
        fs.writeFileSync(_scPath2,_scContent2,'utf8');
        var _scMeta2={name:_scName2,description:_scDesc,emoji:_scEmoji,location:_scPath2};
        try{var _auxF4=fs.readdirSync(_scDir2).filter(function(f){return f!=='SKILL.md';});if(_auxF4.length>0)_scMeta2.auxFiles=_auxF4;}catch(ae4){}
        var _scExistIdx=_skillsList.findIndex(function(s){return s.name===_scName2;});
        if(_scExistIdx>=0)_skillsList[_scExistIdx]=_scMeta2;else _skillsList.push(_scMeta2);
        _rebuildWorkspacePrompt();
        try{broadcast({type:'skill_updated',action:'created',skill:_scMeta2});}catch(_bcErr){}
        return{ok:true,skill:_scMeta2,message:'技能"'+_scName2+'"创建成功！AI现在可以在相关场景下使用此技能'};
      }catch(e){return{ok:false,error:e.message};}
    }
  },

  {
    name: 'skill_list',
    description: '列出所有可用技能及其描述',
    parameters: { type: 'object', properties: {}, required: [] },
    category: 'skill',
    execute: function(args, ctx) {
      var _skillsList = ctx._skillsList;
      return { ok: true, skills: _skillsList, total: _skillsList.length };
    }
  },

  {
    name: 'skill_execute',
    description: '获取指定技能的详细步骤内容。返回技能的SKILL.md内容，你需要按照其中的步骤使用bash/file_read等工具直接执行。注意：此工具只返回技能步骤，不会自动执行，你需要自己用工具完成每个步骤。',
    parameters: { type: 'object', properties: { name: { type: 'string', description: '要执行的技能名称' }, input: { type: 'string', description: '执行技能时的输入参数或上下文' } }, required: ['name'] },
    category: 'skill',
    execute: function(args, ctx) {
      var path = ctx.path;
      var fs = ctx.fs;
      var APP_DIR = ctx.APP_DIR;
      var _skillsList = ctx._skillsList;
      var _seName = args.name || '';
      if (!_seName) return {ok:false,error:'请提供技能名称'};
      var _seSkill = _skillsList.find(function(s){return s.name===_seName;});
      if (!_seSkill) return {ok:false,error:'未找到技能: '+_seName};
      var _seInput = args.input || '';
      var _seStepsContent = '无';
      try {
        var _seSkillPath = _seSkill.location || path.join(APP_DIR,'skills',_seName,'SKILL.md');
        if (fs.existsSync(_seSkillPath)) {
          var _seRawContent = fs.readFileSync(_seSkillPath,'utf-8').trim();
          var _seBody = _seRawContent.replace(/^---[\s\S]*?---\n*/,'').trim();
          if (_seBody) _seStepsContent = _seBody;
        }
      } catch(seReadErr) {}
      return {ok:true, skill:_seSkill.name, description:_seSkill.description, steps:_seStepsContent, input:_seInput, instruction:'请按照以上技能步骤，使用可用工具直接执行。不要再次调用skill_execute，直接使用bash/file_read等工具完成步骤。'};
    }
  },

  // ════════════════════════════════════════════════════════════
  //  插件类 (plugin) - category: 'plugin'
  // ════════════════════════════════════════════════════════════

  {
    name: 'plugin_list',
    description: '列出已安装的插件及其状态和可用钩子',
    parameters: { type: 'object', properties: {}, required: [] },
    category: 'plugin',
    execute: function(args, ctx) {
      return ctx.executePluginList ? ctx.executePluginList() : { success: false, error: '插件系统未初始化' };
    }
  },

  {
    name: 'plugin_toggle',
    description: '启用或禁用插件',
    parameters: { type: 'object', properties: { pluginId: { type: 'string', description: '插件ID' }, enabled: { type: 'boolean', description: 'true=启用, false=禁用' } }, required: ['pluginId','enabled'] },
    category: 'plugin',
    execute: function(args, ctx) {
      return ctx.executePluginToggle ? ctx.executePluginToggle(args) : { success: false, error: '插件系统未初始化' };
    }
  },

  {
    name: 'plugin_install',
    description: '安装插件。从本地路径或ClawHub市场安装插件。注意：插件包含可执行代码，安装后会自动加载并运行，属于高风险操作。',
    parameters: { type: 'object', properties: { source: { type: 'string', description: '插件来源：本地路径/npm包名/clawhub:包名' }, force: { type: 'boolean', description: '是否强制重新安装' } }, required: ['source'] },
    category: 'plugin',
    // 标记 dangerous + needApproval——插件安装会下载并执行任意代码，必须经用户审批
    dangerous: true,
    needApproval: true,
    execute: async function(args, ctx) {
      var PluginManager = ctx.PluginManager;
      try {
        if (PluginManager) {
          var _piResult = await PluginManager.loadPlugin(args.source);
          return {ok:true, plugin:_piResult};
        }
        return {ok:false,error:'PluginManager未加载'};
      } catch(e) { return {ok:false,error:'插件安装失败: '+e.message}; }
    }
  },

  {
    name: 'plugin_search',
    description: '搜索可用插件。在ClawHub市场和本地目录中搜索插件。',
    parameters: { type: 'object', properties: { query: { type: 'string', description: '搜索关键词' }, type: { type: 'string', description: '插件类型过滤' }, limit: { type: 'number', description: '最大结果数，默认20' } }, required: ['query'] },
    category: 'plugin',
    execute: function(args, ctx) {
      var PluginManager = ctx.PluginManager;
      try {
        if (PluginManager) {
          var _psResult = PluginManager.discoverPlugins();
          if (args.query) { var _psQ = args.query.toLowerCase(); _psResult = _psResult.filter(function(p){return (p.name||'').toLowerCase().indexOf(_psQ)>=0||(p.description||'').toLowerCase().indexOf(_psQ)>=0;}); }
          return {ok:true, plugins:_psResult.slice(0, args.limit||20)};
        }
        return {ok:false,error:'PluginManager未加载'};
      } catch(e) { return {ok:false,error:e.message}; }
    }
  },

  // ════════════════════════════════════════════════════════════
  //  知识库类 (system) - category: 'system'
  // ════════════════════════════════════════════════════════════

  {
    name: 'knowledge_search',
    description: '搜索知识库/向量数据库中的内容。当用户问的问题可能需要知识库中的信息来回答时使用（如产品文档、FAQ、客服知识）。返回最相关的知识条目。',
    parameters: { type: 'object', properties: { query: { type: 'string', description: '搜索查询词或问题' }, topK: { type: 'number', description: '返回结果数量，默认5' } }, required: ['query'] },
    category: 'system',
    execute: function(args, ctx) {
      return ctx.executeKnowledgeSearch ? ctx.executeKnowledgeSearch(args) : { success: false, error: '知识库未初始化' };
    }
  },

  {
    name: 'knowledge_add',
    description: '向知识库添加新内容。当用户提供重要信息需要记住时使用。可以添加FAQ、文档片段、产品信息等。',
    parameters: { type: 'object', properties: { title: { type: 'string', description: '知识条目标题' }, content: { type: 'string', description: '知识内容正文' }, tags: { type: 'array', items: { type: 'string' }, description: '标签，用于分类检索如["产品","FAQ","售后"]' } }, required: ['title','content'] },
    category: 'system',
    execute: function(args, ctx) {
      return ctx.executeKnowledgeAdd ? ctx.executeKnowledgeAdd(args) : { success: false, error: '知识库未初始化' };
    }
  },

  // ════════════════════════════════════════════════════════════
  //  计划 (update_plan) - category: 'system'
  // ════════════════════════════════════════════════════════════

  {
    name: 'update_plan',
    description: '更新当前结构化工作计划。用于多步骤复杂任务时跟踪进度。每个步骤有pending/in_progress/completed三种状态，最多只能有一个步骤为in_progress。简单任务不需要使用此工具。',
    parameters: { type: 'object', properties: { plan: { type: 'array', items: { type: 'object', properties: { step: { type: 'string', description: '简短的步骤描述' }, status: { type: 'string', enum: ['pending','in_progress','completed'], description: '步骤状态：pending=待执行,in_progress=执行中,completed=已完成' } }, required: ['step','status'] }, description: '有序步骤列表，最多一个步骤为in_progress', minItems: 1 }, explanation: { type: 'string', description: '可选的变更说明' } }, required: ['plan'] },
    category: 'system',
    execute: function(args, ctx) {
      var _planSteps = args.plan || [];
      var _inProgressCount = 0;
      for (var _pi = 0; _pi < _planSteps.length; _pi++) {
        if (_planSteps[_pi].status === 'in_progress') _inProgressCount++;
      }
      if (_inProgressCount > 1) return { ok: false, error: '最多只能有一个步骤为in_progress' };
      var _planSummary = _planSteps.map(function(s, i) {
        var icon = s.status === 'completed' ? '✅' : s.status === 'in_progress' ? '🔄' : '⏳';
        return icon + ' ' + (i+1) + '. ' + s.step;
      }).join('\n');
      return { ok: true, plan: _planSteps, summary: _planSummary, explanation: args.explanation || '' };
    }
  }

];
