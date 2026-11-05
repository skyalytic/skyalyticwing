/**
 * 系统类工具模块 (热加载)
 *
 * 提供系统信息、用量统计、队列/沙箱状态、远程节点、环境变量、进程管理等工具。
 * 从 start.cjs 内置 switch 中提取，逻辑保持不变。
 *
 * 上下文 (ctx) 需提供:
 *   os, execSync, PS_BIN, IS_WIN, configStore, usageLog,
 *   messageQueue, SandboxSystem, MessageQueue, log
 */

module.exports = [

  // ── system_info ──────────────────────────────────────────────
  {
    name: 'system_info',
    description: '获取系统运行信息(平台/架构/主机名/内存/PID/运行时间等)。用于诊断系统状态。',
    parameters: { type: 'object', properties: {}, required: [] },
    category: 'system',
    dangerous: false,
    execute: function(args, ctx) {
      try {
        return {
          ok: true,
          info: {
            platform: process.platform,
            arch: process.arch,
            hostname: require('os').hostname(),
            nodeVersion: process.version,
            uptime: Math.round(process.uptime()),
            memory: process.memoryUsage(),
            pid: process.pid
          }
        };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }
  },

  // ── usage_stats ──────────────────────────────────────────────
  {
    name: 'usage_stats',
    description: '查看API用量统计(今日请求数/本月请求数/token消耗等)。用于监控使用情况。',
    parameters: { type: 'object', properties: {}, required: [] },
    category: 'system',
    dangerous: false,
    execute: function(args, ctx) {
      var usageLog = ctx.usageLog;
      try {
        return {
          ok: true,
          usage: usageLog,
          today: usageLog.today,
          thisMonth: usageLog.thisMonth
        };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }
  },

  // ── queue_status ─────────────────────────────────────────────
  {
    name: 'queue_status',
    description: '查看消息队列状态(队列长度/最近消息等)。用于调试消息处理问题。',
    parameters: { type: 'object', properties: {}, required: [] },
    category: 'system',
    dangerous: false,
    execute: function(args, ctx) {
      var MessageQueue = ctx.MessageQueue;
      var messageQueue = ctx.messageQueue;
      try {
        return typeof MessageQueue !== 'undefined'
          ? {
              ok: true,
              stats: MessageQueue.getStats(),
              recent: (typeof messageQueue !== 'undefined' ? messageQueue : []).slice(0, 10)
            }
          : { ok: false, error: '队列系统未初始化' };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }
  },

  // ── sandbox_status ──────────────────────────────────────────
  {
    name: 'sandbox_status',
    description: '查看沙箱执行环境状态和允许的命令列表。用于了解代码执行的安全限制。',
    parameters: { type: 'object', properties: {}, required: [] },
    category: 'system',
    dangerous: false,
    execute: function(args, ctx) {
      var SandboxSystem = ctx.SandboxSystem;
      try {
        return typeof SandboxSystem !== 'undefined'
          ? { ok: true, status: SandboxSystem.getStatus() }
          : { ok: false, error: '沙箱系统未初始化' };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }
  },

  // ── remote_nodes ─────────────────────────────────────────────
  {
    name: 'remote_nodes',
    description: '列出远程节点信息。用于分布式任务管理。',
    parameters: { type: 'object', properties: {}, required: [] },
    category: 'system',
    dangerous: false,
    execute: function(args, ctx) {
      var configStore = ctx.configStore;
      try {
        return {
          ok: true,
          nodes: (typeof configStore !== 'undefined' && configStore.remoteNodes)
            ? configStore.remoteNodes
            : {},
          note: '远程节点管理'
        };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }
  },

  // ── env_get ──────────────────────────────────────────────────
  {
    name: 'env_get',
    description: '读取环境变量值(受安全策略限制，敏感变量不可读取)。',
    parameters: { type: 'object', properties: {} },
    category: 'system',
    dangerous: false,
    execute: function(args, ctx) {
      var _envName = args.name || '';
      if (!_envName ||
          !/^[A-Z_][A-Z0-9_]*$/.test(_envName) ||
          /^(PATH|HOME|USER|SHELL|NODE_OPTIONS|LD_PRELOAD|LD_LIBRARY_PATH|AWS_|GITHUB_|GOOGLE_|AZURE_|DATABASE_URL|MYSQL_|POSTGRES_|REDIS_|MONGO_|SECRET|PASSWORD|TOKEN|PRIVATE_KEY|CREDENTIAL)/i.test(_envName)) {
        return { success: false, error: '不允许读取该环境变量' };
      }
      return {
        success: true,
        name: _envName,
        value: process.env[_envName] || null,
        exists: !!process.env[_envName]
      };
    }
  },

  // ── env_set ──────────────────────────────────────────────────
  {
    name: 'env_set',
    description: '设置环境变量值(受安全策略限制，敏感变量不可设置)。',
    parameters: { type: 'object', properties: {} },
    category: 'system',
    dangerous: true,
    execute: function(args, ctx) {
      var _envName = args.name || '';
      if (!_envName ||
          !/^[A-Z_][A-Z0-9_]*$/.test(_envName) ||
          /^(PATH|HOME|USER|SHELL|NODE_OPTIONS|LD_PRELOAD|LD_LIBRARY_PATH|AWS_|GITHUB_|GOOGLE_|AZURE_|DATABASE_URL|MYSQL_|POSTGRES_|REDIS_|MONGO_|SECRET|PASSWORD|TOKEN|PRIVATE_KEY|CREDENTIAL)/i.test(_envName)) {
        return { success: false, error: '不允许设置该环境变量' };
      }
      process.env[_envName] = args.value || '';
      return { success: true, name: _envName, value: args.value };
    }
  },

  // ── process_list ─────────────────────────────────────────────
  {
    name: 'process_list',
    description: '列出当前系统运行中的进程。',
    parameters: { type: 'object', properties: {} },
    category: 'system',
    dangerous: false,
    execute: function(args, ctx) {
      var os = ctx.os;
      var execSync = ctx.execSync;
      var PS_BIN = ctx.PS_BIN;
      var IS_WIN = ctx.IS_WIN;
      if (IS_WIN) {
        var psCmd = 'Get-Process | Select-Object Id,ProcessName,CPU,WorkingSet64 | Format-Table -AutoSize';
        var psOutput = execSync(PS_BIN, { encoding: 'utf-8', timeout: 15000, input: psCmd, shell: true });
        return { success: true, output: psOutput, platform: 'win32' };
      } else {
        var psOutput = execSync('ps aux', { encoding: 'utf-8', timeout: 15000, shell: true });
        return { success: true, output: psOutput, platform: os.platform() };
      }
    }
  },

  // ── process_kill ─────────────────────────────────────────────
  {
    name: 'process_kill',
    description: '终止指定PID的进程。',
    parameters: { type: 'object', properties: {} },
    category: 'system',
    dangerous: true,
    execute: function(args, ctx) {
      var os = ctx.os;
      var execSync = ctx.execSync;
      var killPid = parseInt(args.pid);
      if (!killPid || isNaN(killPid)) return { success: false, error: '无效的PID: ' + args.pid };
      if (killPid === process.pid) return { success: false, error: '不能终止自身进程' };
      if (os.platform() === 'win32') {
        execSync('taskkill /PID ' + killPid + ' /F', { timeout: 5000, shell: true });
      } else {
        process.kill(killPid, 'SIGTERM');
      }
      return { success: true, pid: killPid };
    }
  }

];
