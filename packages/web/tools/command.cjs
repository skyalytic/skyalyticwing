/**
 * Command Tools Module
 * 命令类工具集合 - 从 start.cjs 提取的命令执行相关工具
 *
 * 工具列表: bash, powershell, code_execution, python, node, code_build, git_operation
 *
 * 每个工具的 execute(args, ctx) 从 ctx 获取所需闭包变量:
 *   fs, path, os, execSync, execFileSync, spawn, IS_WIN, IS_MAC, PS_BIN,
 *   WORKSPACE_OUTPUT_DIR, YoloClassifier, log
 */

module.exports = [

  // ═══ bash ═══
  {
    name: 'bash',
    description: '执行Shell/Bash命令（Windows自动用PowerShell）。最后手段：优先用专用工具(file_read/file_write/file_edit/glob/grep/directory_list/web_read)替代bash等价命令。bash适用于：运行代码、安装软件、系统管理、git操作等专用工具无法覆盖的场景。支持spawn/list/kill/poll/log/send-keys等进程管理。',
    parameters: {
      type: 'object',
      properties: {
        cmd: { type: 'string', description: '要执行的完整命令' },
        cwd: { type: 'string', description: '工作目录' },
        timeout: { type: 'number', description: '超时时间(毫秒)，默认30000' },
        action: { type: 'string', enum: ['run','spawn','list','kill','poll','log','send-keys'], description: '操作类型，默认run(同步执行)' },
        sessionId: { type: 'string', description: '进程会话ID（用于kill/poll/send-keys）' },
        keys: { type: 'array', items: { type: 'string' }, description: '发送的按键序列["Enter","Ctrl+C"]' },
        data: { type: 'string', description: '写入stdin的数据' }
      },
      required: ['cmd']
    },
    category: 'command',
    dangerous: true,
    execute: function(args, ctx) {
      var execSync = ctx.execSync;
      var WORKSPACE_OUTPUT_DIR = ctx.WORKSPACE_OUTPUT_DIR;
      var cmd = args.cmd || '';
      // 安全策略校验：拦截破坏性命令（rm -rf /、format、mkfs、dd 等）
      // 默认拒绝——SecurityManager 不存在或方法不可用时拒绝执行（而非静默放行）
      var SecurityManager = ctx.SecurityManager;
      if (!SecurityManager || typeof SecurityManager.isCommandAllowed !== 'function') {
        return { success:false, error:'SecurityManager not available', blocked: true };
      }
      if (!SecurityManager.isCommandAllowed(cmd, 'admin')) {
        return { success:false, error:'命令被安全策略拒绝: ' + cmd, blocked: true };
      }
      try {
        var _output = execSync(cmd, { encoding:'utf-8', timeout:30000, cwd:args.cwd||WORKSPACE_OUTPUT_DIR, maxBuffer:10*1024*1024, shell:true });
        return { success:true, output:_output, exitCode:0 };
      } catch(execErr) {
        return { success:false, error:execErr.message, exitCode:execErr.status, stderr:(execErr.stderr||'').substring(0, 2000) };
      }
    }
  },

  // ═══ powershell ═══
  {
    name: 'powershell',
    description: '执行PowerShell脚本或命令。适用于Windows系统管理、Active Directory、Exchange、Office 365、Azure、WSL交互等。',
    parameters: {
      type: 'object',
      properties: {
        cmd: { type: 'string', description: 'PowerShell命令或脚本路径' },
        timeout: { type: 'number', description: '超时(毫秒)，默认60000' },
        noProfile: { type: 'boolean', description: '是否使用-NoProfile参数加速启动' }
      },
      required: ['cmd']
    },
    category: 'command',
    dangerous: true,
    execute: function(args, ctx) {
      var execSync = ctx.execSync;
      var PS_BIN = ctx.PS_BIN;
      var WORKSPACE_OUTPUT_DIR = ctx.WORKSPACE_OUTPUT_DIR;
      var psCmd = args.cmd || args.script || '';
      // 安全策略校验：拦截破坏性命令（rm -rf /、format、mkfs、dd 等）
      // 默认拒绝——SecurityManager 不存在或方法不可用时拒绝执行（而非静默放行）
      var SecurityManager = ctx.SecurityManager;
      if (!SecurityManager || typeof SecurityManager.isCommandAllowed !== 'function') {
        return { success:false, error:'SecurityManager not available', blocked: true };
      }
      if (!SecurityManager.isCommandAllowed(psCmd, 'admin')) {
        return { success:false, error:'命令被安全策略拒绝: ' + psCmd, blocked: true };
      }
      try {
        var _psOutput = execSync(PS_BIN, { encoding:'utf-8', timeout:30000, cwd:args.cwd||WORKSPACE_OUTPUT_DIR, maxBuffer:10*1024*1024, input:psCmd, shell:true });
        return { success:true, output:_psOutput, exitCode:0 };
      } catch(execErr) {
        return { success:false, error:execErr.message, exitCode:execErr.status, stderr:(execErr.stderr||'').substring(0, 2000) };
      }
    }
  },

  // ═══ code_execution ═══
  {
    name: 'code_execution',
    description: '在沙箱中执行Python代码。用于数据分析、数学计算、文件处理等。代码在隔离环境中运行，可安装pip包。',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: '要执行的Python代码' },
        language: { type: 'string', enum: ['python','javascript'], description: '编程语言，默认python' },
        timeout: { type: 'number', description: '超时秒数，默认30' }
      },
      required: ['code']
    },
    category: 'command',
    dangerous: true,
    execute: function(args, ctx) {
      var execFileSync = ctx.execFileSync;
      var IS_WIN = ctx.IS_WIN;
      var WORKSPACE_OUTPUT_DIR = ctx.WORKSPACE_OUTPUT_DIR;
      var _ceCode = args.code || '';
      var _ceLang = args.language || 'python';
      var _ceTimeout = (args.timeout || 30) * 1000;
      if (!_ceCode) return {ok:false,error:'请提供要执行的代码'};
      try {
        if (_ceLang === 'javascript') {
          // C-B1: 改用 execFileSync + 数组参数，避免 shell 解析 $() 和反引号
          var _ceJsOut = execFileSync('node', ['-e', _ceCode], {encoding:'utf8',timeout:_ceTimeout,cwd:WORKSPACE_OUTPUT_DIR,maxBuffer:5*1024*1024});
          return {ok:true,output:_ceJsOut.trim(),language:'javascript'};
        }
        var _cePyCmd = IS_WIN ? 'python' : 'python3';
        try { var _cePyOut = execFileSync(_cePyCmd, ['-c', _ceCode], {encoding:'utf8',timeout:_ceTimeout,cwd:WORKSPACE_OUTPUT_DIR,maxBuffer:5*1024*1024}); return {ok:true,output:_cePyOut.trim(),language:'python'}; }
        catch(e1) { var _cePyCmd2 = IS_WIN ? 'python3' : 'python'; var _cePyOut2 = execFileSync(_cePyCmd2, ['-c', _ceCode], {encoding:'utf8',timeout:_ceTimeout,cwd:WORKSPACE_OUTPUT_DIR,maxBuffer:5*1024*1024}); return {ok:true,output:_cePyOut2.trim(),language:'python'}; }
      } catch(e) { return {ok:false,error:(e.stderr||e.message||'').substring(0,2000),exitCode:e.status||1}; }
    }
  },

  // ═══ python ═══
  {
    name: 'python',
    description: '执行Python代码。通过python/python3命令运行Python脚本，支持数据分析、脚本执行等。',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: '要执行的Python代码' },
        script: { type: 'string', description: '要执行的Python脚本（与code二选一）' },
        cwd: { type: 'string', description: '工作目录，默认当前目录' }
      },
      required: ['code']
    },
    category: 'command',
    dangerous: true,
    execute: function(args, ctx) {
      var execSync = ctx.execSync, execFileSync = ctx.execFileSync;
      var IS_WIN = ctx.IS_WIN;
      var pyCode = args.code || args.script || '';
      var pyCmd = IS_WIN ? 'python' : 'python3';
      try { execSync('python3 --version', {stdio:'pipe', timeout:3000}); pyCmd = 'python3'; } catch(e) {
        try { execSync('python --version', {stdio:'pipe', timeout:3000}); pyCmd = 'python'; } catch(e2) {}
      }
      try {
        var pyResult = execFileSync(pyCmd, ['-c', pyCode], { encoding:'utf-8', timeout:30000, cwd:args.cwd||process.cwd(), maxBuffer:10*1024*1024 });
        return { success:true, output:pyResult, exitCode:0 };
      } catch(e) {
        return { success:false, error:(e.stderr||e.message||'').substring(0,2000), exitCode:e.status||1 };
      }
    }
  },

  // ═══ node ═══
  {
    name: 'node',
    description: '执行Node.js代码。通过node -e运行JavaScript代码，适用于脚本执行、数据处理等。',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: '要执行的Node.js代码' },
        script: { type: 'string', description: '要执行的Node.js脚本（与code二选一）' },
        cwd: { type: 'string', description: '工作目录，默认当前目录' }
      },
      required: ['code']
    },
    category: 'command',
    dangerous: true,
    execute: function(args, ctx) {
      var execFileSync = ctx.execFileSync;
      var nodeCode = args.code || args.script || '';
      try {
        var nodeResult = execFileSync('node', ['-e', nodeCode], { encoding:'utf-8', timeout:30000, cwd:args.cwd||process.cwd(), maxBuffer:10*1024*1024 });
        return { success:true, output:nodeResult, exitCode:0 };
      } catch(e) {
        return { success:false, error:(e.stderr||e.message||'').substring(0,2000), exitCode:e.status||1 };
      }
    }
  },

  // ═══ code_build ═══
  {
    name: 'code_build',
    description: '构建代码项目。自动检测项目类型（npm run build 或 make），也可指定构建命令。执行前会进行安全检查。',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '构建命令，默认根据项目类型自动选择(npm run build 或 make)' },
        cwd: { type: 'string', description: '工作目录，默认当前目录' }
      }
    },
    category: 'command',
    dangerous: true,
    execute: function(args, ctx) {
      var fs = ctx.fs, path = ctx.path;
      var execSync = ctx.execSync;
      var YoloClassifier = ctx.YoloClassifier;
      var buildCmd = args.command || (fs.existsSync(path.join(process.cwd(),'package.json')) ? 'npm run build' : 'make');
      // fix(第二十一轮): code_build 使用 execSync(buildCmd, {shell:true}) 执行用户可控命令，
      // 但仅调用 YoloClassifier.classify() 启发式分类，未调用 SecurityManager.isCommandAllowed()，
      // 绕过了 bash/powershell 工具使用的安全边界。此处补充 SecurityManager 校验，与 bash/powershell 一致。
      var SecurityManager = ctx.SecurityManager;
      if (!SecurityManager || typeof SecurityManager.isCommandAllowed !== 'function') {
        return { success:false, error:'SecurityManager not available', blocked: true };
      }
      if (!SecurityManager.isCommandAllowed(buildCmd, 'admin')) {
        return { success:false, error:'命令被安全策略拒绝: ' + buildCmd, blocked: true };
      }
      if (YoloClassifier && typeof YoloClassifier.classify === 'function') {
        var _cbYoloResult = YoloClassifier.classify(buildCmd);
        if (_cbYoloResult && _cbYoloResult.decision === 'deny') {
          return { ok:false, error:'安全检查: ' + (_cbYoloResult.reason || '命令被安全策略阻止') };
        }
      }
      var buildResult = execSync(buildCmd, { encoding:'utf-8', timeout:120000, maxBuffer:10*1024*1024, cwd:args.cwd||process.cwd(), shell:true });
      return { success:true, command:buildCmd, output:buildResult };
    }
  },

  // ═══ git_operation ═══
  {
    name: 'git_operation',
    description: '执行Git操作。支持常用git命令(add/status/log/diff/commit/push/pull/branch/checkout等)，命令白名单校验。',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'git命令(如status/log/push/commit等)' },
        repoPath: { type: 'string', description: '仓库路径，默认当前目录' }
      },
      required: ['command']
    },
    category: 'command',
    dangerous: true,
    execute: function(args, ctx) {
      var execFileSync = ctx.execFileSync;
      var _gitWhitelist = ['add','status','log','diff','commit','push','pull','fetch','branch','checkout','merge','rebase','stash','tag','remote','reset','clone','init','show','cherry-pick','reflog'];
      var gitCmd = String(args.command || '').trim();
      // 原 regex `^[a-z0-9\s\-_.]+$` 拒绝 clone URL 所需的 `:/.@?#=-` 字符
      // 新 regex 允许 URL 安全字符，但仍拒绝 shell 元字符 (&|;`$()<>!*[]{}\n\r'"\\) 防注入
      if (!/^[a-zA-Z0-9\s\-_.:\/@?#=%]+$/.test(gitCmd)) return { success:false, error:'git命令包含非法字符' };
      var _gitCmd = gitCmd.split(/\s+/)[0];
      if (_gitWhitelist.indexOf(_gitCmd) === -1) return { success: false, error: '不允许的git命令: ' + _gitCmd };
      // 用 execFileSync + 数组参数（不走 shell）彻底消除命令注入风险
      // 之前 execSync('git '+gitCmd, {shell:true}) 在 shell 模式下拼接，即使 regex 过滤也有边缘绕过
      if (typeof execFileSync !== 'function') {
        return { success:false, error:'execFileSync not available in ctx' };
      }
      var gitArgs = gitCmd.split(/\s+/);
      // 第一个元素是子命令（如 clone），已通过白名单校验；后续为参数
      var gitResult;
      try {
        gitResult = execFileSync('git', gitArgs, { cwd:args.repoPath||process.cwd(), timeout:30000, encoding:'utf8', maxBuffer:1024*1024 });
      } catch(e) {
        return { success:false, error:e.message, stderr:(e.stderr||'').substring(0,2000), exitCode:e.status };
      }
      return { success:true, command:gitCmd, output:gitResult };
    }
  }

];
