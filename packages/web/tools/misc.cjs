/**
 * 杂项工具模块 (热加载)
 *
 * 从 start.cjs 提取的剩余杂项工具集合，逻辑保持不变。
 *
 * 工具列表:
 *   - 交互类 (interactive): ask_user, btw_ask, desktop, browser, notification
 *   - 命令类 (command): cli_anything
 *   - 网络类 (network): web_search, web_fetch, gmail_search, gmail_send
 *   - 系统类 (system): daemon_install/uninstall/status, security_audit, sandbox_run,
 *       pairing_generate/list, acp_*, tui_*, binding_*, tool_policy_*
 *
 * execute(args, ctx) 从 ctx 解构以下变量:
 *   fs, path, os, execSync, execFileSync, IS_WIN, IS_MAC, PS_BIN,
 *   APP_DIR, DATA_DIR, WORKSPACE_OUTPUT_DIR, configStore, log, broadcast,
 *   SecurityManager, DaemonManager, AcpManager, TuiManager, PluginManager,
 *   BtwSystem, BindingRouter, callAIProvider,
 *   executeBrowserTool, executeDesktopTool, executeWebTool, ToolPolicyPipeline
 */

module.exports = [

  // ═══ ask_user ═══
  {
    name: 'ask_user',
    description: '向用户提问。当需要用户选择或确认时使用，支持单选和多选。在Web界面会弹出选择框。',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: '要问用户的问题' },
        options: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: '选项标签' },
              description: { type: 'string', description: '选项说明' }
            },
            required: ['label']
          },
          description: '选项列表（2-4个）'
        },
        multiSelect: { type: 'boolean', description: '是否允许多选，默认false' }
      },
      required: ['question', 'options']
    },
    category: 'interactive',
    dangerous: false,
    execute: function(args, ctx) {
      var _auQuestion = args.question || '';
      var _auOptions = args.options || [];
      if (!_auQuestion) return { ok: false, error: '请提供问题' };
      if (_auOptions.length < 2) return { ok: false, error: '至少需要2个选项' };
      return {
        ok: true,
        question: _auQuestion,
        options: _auOptions,
        multiSelect: args.multiSelect || false,
        note: '此工具在Web界面会弹出选择框，在CLI中需要用户手动输入'
      };
    }
  },

  // ═══ btw_ask ═══
  {
    name: 'btw_ask',
    description: '旁路提问(/btw)。在不打断当前对话的情况下，快速回答一个临时问题。不会使用工具，不会影响主对话流程。',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: '要提问的旁路问题' }
      },
      required: ['question']
    },
    category: 'interactive',
    dangerous: false,
    execute: function(args, ctx) {
      var BtwSystem = ctx.BtwSystem;
      return typeof BtwSystem !== 'undefined' && BtwSystem
        ? BtwSystem.handleBtw(args)
        : { ok: false, error: 'BTW系统未初始化' };
    }
  },

  // ═══ desktop ═══
  {
    name: 'desktop',
    description: '跨平台桌面自动化控制（Windows/macOS/Linux统一API）。支持20+种操作：鼠标移动/点击/拖拽/滚动、键盘输入/按键/组合键、屏幕截图/取色/尺寸、窗口列表/聚焦/最小化/最大化/关闭/调整大小/移动、剪贴板读写、对话框(提示/输入/文件选择/通知)、进程管理(列出/杀死/启动)。这是系统级桌面操作的核心能力',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['screenshot','click','move','scroll','drag','type','press','get_position','get_color','get_screen_size','list_windows','get_active_window','focus_window','minimize_window','maximize_window','resize_window','close_window','move_window','show_desktop','clipboard_write','clipboard_read','alert','prompt','file_select','notification','list_processes','kill_process','launch_app','uia_launch_app','uia_send_message','status'],
          description: '要执行的桌面操作类型。Windows 上打开桌面应用（微信/QQ/企业微信等）请用 uia_launch_app（按正确顺序：桌面快捷方式→进程检查→Win搜索→exePath），不要用 launch_app'
        },
        x: { type: 'number', description: 'X坐标（像素）- 用于move/click/drag/get_color' },
        y: { type: 'number', description: 'Y坐标（像素）- 用于move/click/drag/get_color' },
        button: { type: 'string', enum: ['left','right','middle'], description: '鼠标按键类型' },
        doubleClick: { type: 'boolean', description: '是否双击点击' },
        toX: { type: 'number', description: '拖拽目标X坐标' },
        toY: { type: 'number', description: '拖拽目标Y坐标' },
        amount: { type: 'number', description: '滚动量/步数' },
        direction: { type: 'string', enum: ['up','down'], description: '滚动方向' },
        speed: { type: 'number', description: '鼠标移动速度（0=瞬间）' },
        duration: { type: 'number', description: '拖拽持续时间(ms)' },
        text: { type: 'string', description: '键盘输入文本/对话框消息/通知内容' },
        key: { type: 'string', description: '按键名称（Enter/Tab/Esc/Ctrl+A等）或组合键' },
        modifiers: { type: 'array', items: { type: 'string' }, description: '修饰键数组["ctrl","alt","shift"]' },
        delay: { type: 'number', description: '打字延迟(ms/字符)' },
        savePath: { type: 'string', description: '截图保存路径' },
        window: { type: 'string', description: '截图指定窗口（窗口标题关键词，如"QQ"、"微信"、"Edge"）。不传则截取全屏' },
        region: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' } }, description: '截图区域{x,y,width,height}' },
        identifier: { type: 'string', description: '窗口标识（标题/PID/应用名）' },
        titleFilter: { type: 'string', description: '窗口标题过滤关键词' },
        width: { type: 'number', description: '窗口宽度' },
        height: { type: 'number', description: '窗口高度' },
        posX: { type: 'number', description: '窗口位置X' },
        posY: { type: 'number', description: '窗口位置Y' },
        content: { type: 'string', description: '剪贴板写入内容' },
        message: { type: 'string', description: '对话框消息' },
        title: { type: 'string', description: '对话框标题' },
        dialogType: { type: 'string', enum: ['info','warning','error','question'], description: 'alert对话框类型' },
        buttons: { type: 'array', items: { type: 'string' }, description: 'prompt按钮选项' },
        defaultValue: { type: 'string', description: 'prompt默认值' },
        multiple: { type: 'boolean', description: '文件选择是否多选' },
        icon: { type: 'string', description: '通知图标名' },
        pidOrName: { type: 'string', description: '进程PID或名称' },
        force: { type: 'boolean', description: '是否强制杀死进程' },
        command: { type: 'string', description: '启动应用的命令（launch_app 用）' },
        args: { type: 'array', items: { type: 'string' }, description: '启动命令参数' },
        workDir: { type: 'string', description: '工作目录' },
        admin: { type: 'boolean', description: '是否以管理员权限启动' },
        // ===== uia_launch_app / uia_send_message 专用参数 =====
        appName: { type: 'string', description: 'uia_launch_app: 应用名称（用于桌面快捷方式匹配、Windows搜索、窗口匹配），如"微信"、"QQ"、"企业微信"。这是首选参数' },
        exePath: { type: 'string', description: 'uia_launch_app: exe完整路径（仅作为最后手段）' },
        processName: { type: 'string', description: 'uia_launch_app: 进程名（用于PID检查避免多开），如"Weixin.exe"、"WXWork.exe"、"QQ.exe"' },
        windowTitle: { type: 'string', description: 'uia_launch_app: 窗口标题关键词（用于UIA查找窗口），默认用appName' },
        method: { type: 'string', enum: ['auto','desktop','search','exe'], description: 'uia_launch_app: 启动方法（auto=自动选择,desktop=桌面快捷方式,search=Win搜索,exe=exePath）' },
        contactName: { type: 'string', description: 'uia_send_message: 联系人名称' },
        messageText: { type: 'string', description: 'uia_send_message: 要发送的消息内容（与 message 二选一，优先用 messageText）' },
        message: { type: 'string', description: 'uia_send_message: 要发送的消息内容（与 messageText 二选一，messageText 的别名）' }
      },
      required: ['action']
    },
    category: 'interactive',
    dangerous: true, // fix(第二十轮): 桌面工具可启动应用/杀进程/控制键鼠/读写剪贴板，应标记为危险
    execute: function(args, ctx) {
      var executeDesktopTool = ctx.executeDesktopTool;
      return typeof executeDesktopTool === 'function'
        ? executeDesktopTool(args.action || 'status', args)
        : { success: false, error: '桌面工具未初始化' };
    }
  },

  // ═══ cli_anything ═══
  {
    name: 'cli_anything',
    description: '通过CLI-Anything操作桌面软件(GIMP/Blender/LibreOffice/OBS等)。将GUI软件转化为命令行操作，无需截图和鼠标模拟。需要目标软件已安装且cli-anything已配置。使用list查看可用软件，使用run执行命令。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list','run','install','search','info'], description: '操作类型：list=列出可用软件CLI, run=执行CLI命令, install=安装软件CLI, search=搜索可用CLI, info=查看CLI详情' },
        software: { type: 'string', description: '软件名称(如gimp/blender/libreoffice/obs/zotero等)' },
        command: { type: 'string', description: 'CLI子命令(如"project new --width 1920", "layer add -n Background")' },
        jsonOutput: { type: 'boolean', description: '是否使用JSON输出模式(推荐，便于解析结果)，默认true' },
        args: { type: 'string', description: '额外参数' }
      },
      required: ['action']
    },
    category: 'command',
    dangerous: true,
    execute: function(args, ctx) {
      var execSync = ctx.execSync;
      var execFileSync = ctx.execFileSync;
      var IS_WIN = ctx.IS_WIN;
      var WORKSPACE_OUTPUT_DIR = ctx.WORKSPACE_OUTPUT_DIR;

      var _caAction = args.action || 'list';
      var _caSoftware = String(args.software || '').replace(/[^a-zA-Z0-9_\-.:\/]/g, '');
      var _caCommand = String(args.command || '').replace(/[^a-zA-Z0-9_\-.:\/\s]/g, '');
      var _caJson = args.jsonOutput !== false;
      var _caArgs = String(args.args || '').replace(/[^a-zA-Z0-9_\-.:\/\s="']/g, '');
      var _caPrefix = 'cli-anything-';
      if (_caAction === 'list') {
        try {
          var _caListOut = execSync('pip list --format=json 2>' + (IS_WIN ? 'nul' : '/dev/null'), { encoding: 'utf8', timeout: 15000 });
          var _caPkgs = JSON.parse(_caListOut || '[]');
          var _caCliPkgs = _caPkgs.filter(function(p) { return p.name && p.name.indexOf('cli-anything') >= 0; });
          if (_caCliPkgs.length === 0) {
            try {
              var _caHubOut = execSync('cli-hub list --json 2>' + (IS_WIN ? 'nul' : '/dev/null'), { encoding: 'utf8', timeout: 15000 });
              var _caHubList = JSON.parse(_caHubOut || '[]');
              if (_caHubList.length > 0) return { ok: true, installed: _caHubList.map(function(c) { return { name: c.name || c, version: c.version || '?' }; }), note: 'Found via cli-hub' };
            } catch (e2) {}
            return { ok: true, installed: [], note: 'CLI-Anything not yet installed. Use action=install to set up, or run: pip install cli-anything-<software>' };
          }
          return { ok: true, installed: _caCliPkgs.map(function(p) { return { name: p.name, version: p.version }; }) };
        } catch (e) {
          return { ok: false, error: 'pip not found or CLI-Anything not installed. Install: pip install cli-anything-<software>' };
        }
      }
      if (_caAction === 'search') {
        try {
          var _caSearchOut = execSync('cli-hub search ' + (_caSoftware || '') + ' --json 2>' + (IS_WIN ? 'nul' : '/dev/null'), { encoding: 'utf8', timeout: 15000 });
          return { ok: true, results: JSON.parse(_caSearchOut || '[]') };
        } catch (e) {
          return { ok: false, error: 'cli-hub not available: ' + e.message };
        }
      }
      if (_caAction === 'install') {
        if (!_caSoftware) return { ok: false, error: 'Please specify software name (e.g. gimp, blender, libreoffice)' };
        try {
          var _caInstallCmd = 'pip install ' + _caPrefix + _caSoftware;
          var _caInstallOut = execSync(_caInstallCmd, { encoding: 'utf8', timeout: 120000 });
          return { ok: true, message: 'Installed ' + _caPrefix + _caSoftware, output: _caInstallOut.trim() };
        } catch (e) {
          return { ok: false, error: 'Install failed: ' + (e.stderr || e.message).substring(0, 500) };
        }
      }
      if (_caAction === 'info') {
        if (!_caSoftware) return { ok: false, error: 'Please specify software name' };
        try {
          var _caInfoCmd = _caPrefix + _caSoftware + ' --help';
          var _caInfoOut = execSync(_caInfoCmd, { encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024 });
          return { ok: true, help: _caInfoOut.trim().substring(0, 3000) };
        } catch (e) {
          return { ok: false, error: 'CLI for ' + _caSoftware + ' not found: ' + (e.stderr || e.message).substring(0, 300) };
        }
      }
      if (_caAction === 'run') {
        if (!_caSoftware) return { ok: false, error: 'Please specify software name' };
        if (!_caCommand) return { ok: false, error: 'Please specify command (e.g. "project new --width 1920")' };
        try {
          var _caRunArgs = (_caJson ? ['--json'] : []).concat(_caCommand ? _caCommand.split(/\s+/).filter(Boolean) : []).concat(_caArgs ? _caArgs.split(/\s+/).filter(Boolean) : []);
          var _caRunOut = execFileSync(_caPrefix + _caSoftware, _caRunArgs, { encoding: 'utf8', timeout: 60000, cwd: WORKSPACE_OUTPUT_DIR, maxBuffer: 5 * 1024 * 1024 });
          var _caResult = _caRunOut.trim();
          if (_caJson) {
            try { _caResult = JSON.parse(_caResult); } catch (e) {}
          }
          return { ok: true, software: _caSoftware, command: _caCommand, result: _caResult };
        } catch (e) {
          var _caErr = (e.stderr || e.message || '').substring(0, 1000);
          return { ok: false, error: 'Command failed: ' + _caErr, exitCode: e.status || 1 };
        }
      }
      return { ok: false, error: 'Unknown action: ' + _caAction };
    }
  },

  // ═══ browser ═══
  {
    name: 'browser',
    description: '控制浏览器（统一工具，通过action参数指定操作）。支持14种操作：status/start/stop/tabs/open/navigate/snapshot/screenshot/act/extract/execute/console/close/focus/pdf/upload/dialog。使用snapshot获取页面元素引用(e1,e2...)，然后用act+ref操作元素。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status','start','stop','tabs','open','navigate','snapshot','screenshot','act','extract','execute','console','close','focus'], description: '要执行的操作类型' },
        url: { type: 'string', description: '导航或打开的URL' },
        targetId: { type: 'string', description: '目标标签页ID（从tabs/open返回）' },
        ref: { type: 'string', description: '元素引用ID（从snapshot获取，如e12）' },
        selector: { type: 'string', description: 'CSS选择器或ref引用定位元素' },
        text: { type: 'string', description: '输入的文字内容' },
        kind: { type: 'string', description: 'act操作的子类型：click/type/press/scroll/hover/wait/select/focus/close' },
        button: { type: 'string', enum: ['left','right','middle'], description: '鼠标按键' },
        doubleClick: { type: 'boolean', description: '是否双击' },
        fullPage: { type: 'boolean', description: '是否全页截图' },
        element: { type: 'string', description: '截图/操作的CSS选择器' },
        format: { type: 'string', enum: ['text','links','tables','all'], description: '提取格式' },
        script: { type: 'string', description: '要执行的JavaScript代码' },
        refs: { type: 'string', enum: ['role','aria'], description: 'snapshot的ref模式' },
        x: { type: 'number', description: '鼠标X坐标' },
        y: { type: 'number', description: '鼠标Y坐标' },
        value: { type: 'string', description: 'select选项值' },
        timeoutMs: { type: 'number', description: '超时毫秒数' }
      },
      required: ['action']
    },
    category: 'interactive',
    dangerous: false,
    execute: function(args, ctx) {
      var executeBrowserTool = ctx.executeBrowserTool;
      return typeof executeBrowserTool === 'function'
        ? executeBrowserTool(args)
        : { success: false, error: '浏览器工具未初始化' };
    }
  },

  // ═══ web_search ═══
  {
    name: 'web_search',
    description: '搜索引擎查询，返回搜索结果列表。设置fetchPages可自动抓取前几个结果页面的内容进行深度分析。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词' },
        numResults: { type: 'number', description: '结果数量，默认5' },
        fetchPages: { type: 'number', description: '自动抓取前N个结果页面的内容(1-3)，用于深度分析而非仅返回摘要。默认0=不抓取' }
      },
      required: ['query']
    },
    category: 'network',
    dangerous: false,
    execute: function(args, ctx) {
      var executeWebTool = ctx.executeWebTool;
      return typeof executeWebTool === 'function'
        ? executeWebTool('web_search', args)
        : { success: false, error: '网络工具未初始化' };
    }
  },

  // ═══ web_fetch ═══
  {
    name: 'web_fetch',
    description: '抓取网页URL内容（HTML→纯文本提取）',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '目标URL' },
        maxLength: { type: 'number', description: '最大字符数' },
        extractLinks: { type: 'boolean', description: '同时提取链接' }
      },
      required: ['url']
    },
    category: 'network',
    dangerous: false,
    execute: function(args, ctx) {
      var executeWebTool = ctx.executeWebTool;
      return typeof executeWebTool === 'function'
        ? executeWebTool('web_fetch', args)
        : { success: false, error: '网络工具未初始化' };
    }
  },

  // ═══ notification ═══
  {
    name: 'notification',
    description: '发送桌面通知或推送通知。提醒用户重要事件或任务完成。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '通知标题' },
        message: { type: 'string', description: '通知内容' },
        type: { type: 'string', enum: ['info','success','warning','error'], description: '通知类型，默认info' }
      },
      required: ['title', 'message']
    },
    category: 'interactive',
    dangerous: false,
    execute: function(args, ctx) {
      var execSync = ctx.execSync;
      var IS_WIN = ctx.IS_WIN;
      var IS_MAC = ctx.IS_MAC;
      var PS_BIN = ctx.PS_BIN;
      var broadcast = ctx.broadcast;

      var _ntTitle = args.title || 'SkyalyticWing';
      var _ntMsg = args.message || '';
      var _ntType = args.type || 'info';
      if (!_ntMsg) return { ok: false, error: '请提供通知内容' };
      try {
        broadcast({ type: 'notification', title: _ntTitle, message: _ntMsg, notificationType: _ntType });
        if (IS_WIN) {
          try {
            var _toastPs = [
              '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
              '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime] | Out-Null',
              // C-B6: 完整 XML 转义 + 转义 $ 防止 PowerShell here-string 注入
              '$template = @"<toast><visual><binding template="\'ToastText02\'"><text id="1">' + _ntTitle.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/\$/g, '&#36;') + '</text><text id="2">' + _ntMsg.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/\$/g, '&#36;') + '</text></binding></visual></toast>"@',
              '$xml = New-Object Windows.Data.Xml.Dom.XmlDocument',
              '$xml.LoadXml($template)',
              '$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)',
              '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("SkyalyticWing").Show($toast)'
            ].join('\r\n');
            execSync(PS_BIN + ' -NoProfile -NonInteractive -Command -', { input: _toastPs, encoding: 'utf8', timeout: 8000, windowsHide: true });
          } catch (e2) {
            try {
              var _balloonPs = [
                'Add-Type -AssemblyName System.Windows.Forms',
                '$n = New-Object System.Windows.Forms.NotifyIcon',
                '$n.Icon = [System.Drawing.SystemIcons]::Information',
                '$n.Visible = $true',
                '$n.ShowBalloonTip(5000, \'' + _ntTitle.replace(/'/g, "''") + '\', \'' + _ntMsg.replace(/'/g, "''") + '\', \'Info\')',
                'Start-Sleep -Seconds 6',
                '$n.Dispose()'
              ].join('\r\n');
              execSync(PS_BIN + ' -NoProfile -NonInteractive -Command -', { input: _balloonPs, encoding: 'utf8', timeout: 15000, windowsHide: true });
            } catch (e3) {}
          }
        }
        // C-B6: 改用 execFileSync + 数组参数，避免 shell 单引号注入
        else if (IS_MAC) { try { require('child_process').execFileSync('osascript', ['-e', 'display notification "' + _ntMsg.replace(/"/g, '\\"') + '" with title "' + _ntTitle.replace(/"/g, '\\"') + '"'], { timeout: 5000 }); } catch (e) {} }
        else { try { require('child_process').execFileSync('notify-send', [_ntTitle, _ntMsg], { timeout: 5000 }); } catch (e) {} }
        return { ok: true, title: _ntTitle, message: _ntMsg };
      } catch (e) { return { ok: false, error: e.message }; }
    }
  },

  // ═══ daemon_install ═══
  {
    name: 'daemon_install',
    description: '将SkyalyticWing安装为系统服务（守护进程）。安装后开机自动启动。支持macOS(launchd)/Linux(systemd)/Windows(schtasks)。',
    parameters: {
      type: 'object',
      properties: {
        autoStart: { type: 'boolean', description: '是否开机自启，默认true' },
        name: { type: 'string', description: '服务名称，默认skyalyticwing' }
      },
      required: []
    },
    category: 'system',
    dangerous: true,
    execute: async function(args, ctx) {
      var os = ctx.os;
      var path = ctx.path;
      var DATA_DIR = ctx.DATA_DIR;
      var APP_DIR = ctx.APP_DIR;
      var DaemonManager = ctx.DaemonManager;

      try {
        if (DaemonManager) {
          var _diService = DaemonManager.getService(DATA_DIR, { name: args.name || 'skyalyticwing', autoStart: args.autoStart !== false, command: process.execPath, args: [path.join(APP_DIR, 'start.cjs')] });
          var _diResult = await _diService.install({ name: args.name || 'skyalyticwing', displayName: 'SkyalyticWing Gateway', description: 'SkyalyticWing AI助手网关服务', command: process.execPath, args: [path.join(APP_DIR, 'start.cjs')], env: {}, workingDir: APP_DIR, autoStart: args.autoStart !== false });
          return { ok: true, result: _diResult, platform: os.platform() };
        }
        return { ok: false, error: 'DaemonManager未加载' };
      } catch (e) { return { ok: false, error: '服务安装失败: ' + e.message }; }
    }
  },

  // ═══ daemon_uninstall ═══
  {
    name: 'daemon_uninstall',
    description: '卸载系统服务。',
    parameters: { type: 'object', properties: {}, required: [] },
    category: 'system',
    dangerous: true,
    execute: async function(args, ctx) {
      var DATA_DIR = ctx.DATA_DIR;
      var DaemonManager = ctx.DaemonManager;

      try {
        if (DaemonManager) {
          var _duService = DaemonManager.getService(DATA_DIR, {});
          var _duResult = await _duService.uninstall();
          return { ok: true, result: _duResult };
        }
        return { ok: false, error: 'DaemonManager未加载' };
      } catch (e) { return { ok: false, error: '服务卸载失败: ' + e.message }; }
    }
  },

  // ═══ daemon_status ═══
  {
    name: 'daemon_status',
    description: '查看系统服务状态。',
    parameters: { type: 'object', properties: {}, required: [] },
    category: 'system',
    dangerous: false,
    execute: function(args, ctx) {
      var os = ctx.os;
      var DATA_DIR = ctx.DATA_DIR;
      var DaemonManager = ctx.DaemonManager;

      try {
        if (DaemonManager) {
          var _dsService = DaemonManager.getService(DATA_DIR, {});
          return { ok: true, installed: _dsService.isInstalled(), running: _dsService.isRunning(), status: _dsService.getStatus(), platform: os.platform() };
        }
        return { ok: false, error: 'DaemonManager未加载' };
      } catch (e) { return { ok: false, error: e.message }; }
    }
  },

  // ═══ security_audit ═══
  {
    name: 'security_audit',
    description: '运行安全审计。检查系统安全状态，包括文件权限、配置安全、API密钥暴露等。',
    parameters: {
      type: 'object',
      properties: {
        fix: { type: 'boolean', description: '是否自动修复发现的问题，默认false' }
      },
      required: []
    },
    category: 'system',
    dangerous: false,
    execute: function(args, ctx) {
      var SecurityManager = ctx.SecurityManager;
      try {
        if (SecurityManager) {
          var _saResult = SecurityManager.runAudit();
          if (args.fix) { var _saFixes = SecurityManager.fixAllFindings(); _saResult.fixes = _saFixes; }
          return { ok: true, audit: _saResult };
        }
        return { ok: false, error: 'SecurityManager未加载' };
      } catch (e) { return { ok: false, error: e.message }; }
    }
  },

  // ═══ sandbox_run ═══
  {
    name: 'sandbox_run',
    description: '在沙箱中执行命令。支持Docker和SSH沙箱，隔离执行不受信任的代码。',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的命令' },
        sandboxType: { type: 'string', enum: ['docker','ssh','auto'], description: '沙箱类型，默认auto（自动选择可用沙箱）' },
        image: { type: 'string', description: 'Docker镜像（如node:20-alpine），默认node:20-alpine' },
        timeout: { type: 'number', description: '超时秒数，默认60' },
        workDir: { type: 'string', description: '工作目录' },
        env: { type: 'object', description: '环境变量' }
      },
      required: ['command']
    },
    category: 'system',
    dangerous: true,
    execute: async function(args, ctx) {
      var SecurityManager = ctx.SecurityManager;
      try {
        if (SecurityManager) {
          var _sbCmd = args.command;
          var _sbType = args.sandboxType || 'auto';
          var _sbResult;
          if (_sbType === 'docker' || (_sbType === 'auto' && SecurityManager.isDockerAvailable())) {
            _sbResult = await SecurityManager.runInDocker(_sbCmd, { image: args.image || 'node:20-alpine', timeout: args.timeout || 60, workDir: args.workDir, env: args.env });
          } else if (_sbType === 'ssh') {
            _sbResult = await SecurityManager.runInSsh(_sbCmd, { timeout: args.timeout || 60 });
          } else {
            _sbResult = { ok: false, error: '无可用沙箱。请安装Docker或配置SSH沙箱。' };
          }
          return _sbResult;
        }
        return { ok: false, error: 'SecurityManager未加载，沙箱功能不可用' };
      } catch (e) { return { ok: false, error: '沙箱执行失败: ' + e.message }; }
    }
  },

  // ═══ pairing_generate ═══
  {
    name: 'pairing_generate',
    description: '生成设备配对码。用于验证新的消息发送者，防止未授权访问。',
    parameters: {
      type: 'object',
      properties: {
        senderId: { type: 'string', description: '发送者标识（如Telegram用户ID）' },
        channel: { type: 'string', description: '消息渠道' },
        expiresIn: { type: 'number', description: '过期时间（秒），默认300' }
      },
      required: ['senderId']
    },
    category: 'system',
    dangerous: false,
    execute: function(args, ctx) {
      var SecurityManager = ctx.SecurityManager;
      try {
        if (SecurityManager) {
          var _pgCode = SecurityManager.generatePairingCode(args.senderId, { channel: args.channel, expiresIn: args.expiresIn || 300 });
          return { ok: true, code: _pgCode.code, expiresAt: _pgCode.expiresAt, senderId: args.senderId };
        }
        return { ok: false, error: 'SecurityManager未加载' };
      } catch (e) { return { ok: false, error: e.message }; }
    }
  },

  // ═══ pairing_list ═══
  {
    name: 'pairing_list',
    description: '列出所有已配对的设备。',
    parameters: { type: 'object', properties: {}, required: [] },
    category: 'system',
    dangerous: false,
    execute: function(args, ctx) {
      var SecurityManager = ctx.SecurityManager;
      try {
        if (SecurityManager) { return { ok: true, devices: SecurityManager.listPairedDevices() }; }
        return { ok: false, error: 'SecurityManager未加载' };
      } catch (e) { return { ok: false, error: e.message }; }
    }
  },

  // ═══ acp_status ═══
  {
    name: 'acp_status',
    description: '获取ACP(Agent Communication Protocol)协议状态，包括启用状态、会话数量、SSE客户端数等。',
    parameters: { type: 'object', properties: {}, required: [] },
    category: 'system',
    dangerous: false,
    execute: function(args, ctx) {
      var AcpManager = ctx.AcpManager;
      try {
        if (AcpManager) {
          var _acpSessions = AcpManager.listSessions();
          return {
            ok: true,
            enabled: true,
            totalSessions: _acpSessions.length,
            activeSessions: _acpSessions.filter(function(s) { return s.status === 'initialized' || s.status === 'running'; }).length,
            sessions: _acpSessions
          };
        }
        return { ok: false, error: 'AcpManager未加载' };
      } catch (e) { return { ok: false, error: e.message }; }
    }
  },

  // ═══ acp_session_create ═══
  {
    name: 'acp_session_create',
    description: '创建一个新的ACP会话，用于IDE或其他工具通过ACP协议与Agent通信。',
    parameters: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'Agent ID(默认main)' }
      },
      required: []
    },
    category: 'system',
    dangerous: false,
    execute: function(args, ctx) {
      var AcpManager = ctx.AcpManager;
      try {
        if (AcpManager) {
          var _acpSess = AcpManager.initializeSession({ agentId: args.agentId || 'main' });
          if (_acpSess && _acpSess.success) {
            return { ok: true, sessionId: _acpSess.sessionId, status: 'ready' };
          }
          return { ok: false, error: _acpSess ? _acpSess.error : '会话创建失败' };
        }
        return { ok: false, error: 'AcpManager未加载' };
      } catch (e) { return { ok: false, error: e.message }; }
    }
  },

  // ═══ acp_session_list ═══
  {
    name: 'acp_session_list',
    description: '列出所有ACP会话及其状态。',
    parameters: { type: 'object', properties: {}, required: [] },
    category: 'system',
    dangerous: false,
    execute: function(args, ctx) {
      var AcpManager = ctx.AcpManager;
      try {
        if (AcpManager) { return { ok: true, sessions: AcpManager.listSessions() }; }
        return { ok: false, error: 'AcpManager未加载' };
      } catch (e) { return { ok: false, error: e.message }; }
    }
  },

  // ═══ acp_session_close ═══
  {
    name: 'acp_session_close',
    description: '关闭一个ACP会话。',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: '要关闭的会话ID' }
      },
      required: ['sessionId']
    },
    category: 'system',
    dangerous: false,
    execute: function(args, ctx) {
      var AcpManager = ctx.AcpManager;
      try {
        if (AcpManager) {
          AcpManager.closeSession({ sessionId: args.sessionId });
          return { ok: true };
        }
        return { ok: false, error: 'AcpManager未加载' };
      } catch (e) { return { ok: false, error: e.message }; }
    }
  },

  // ═══ acp_approval_classify ═══
  {
    name: 'acp_approval_classify',
    description: '使用ACP审批分类器判断工具调用的审批类别和是否自动批准。',
    parameters: {
      type: 'object',
      properties: {
        toolName: { type: 'string', description: '工具名称' },
        args: { type: 'object', description: '工具参数' }
      },
      required: ['toolName']
    },
    category: 'system',
    dangerous: false,
    execute: function(args, ctx) {
      var AcpManager = ctx.AcpManager;
      try {
        if (AcpManager) {
          var _acpCls = AcpManager.classify(args.toolName, args.args);
          return { ok: true, classification: _acpCls };
        }
        return { ok: false, error: 'AcpManager未加载' };
      } catch (e) { return { ok: false, error: e.message }; }
    }
  },

  // ═══ acp_session_resume ═══
  {
    name: 'acp_session_resume',
    description: '恢复ACP会话。重新连接到之前创建的ACP会话继续交互。',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: '要恢复的会话ID' },
        message: { type: 'string', description: '恢复后发送的首条消息' }
      },
      required: ['sessionId']
    },
    category: 'system',
    dangerous: false,
    execute: function(args, ctx) {
      var AcpManager = ctx.AcpManager;
      try {
        if (AcpManager) {
          var _arSession = AcpManager.getSession(args.sessionId);
          if (!_arSession) return { ok: false, error: 'ACP会话未找到: ' + args.sessionId };
          if (args.message) { AcpManager.eventLedger.recordUserPrompt(args.sessionId, args.message); }
          return { ok: true, session: _arSession, resumed: true };
        }
        return { ok: false, error: 'AcpManager未加载' };
      } catch (e) { return { ok: false, error: e.message }; }
    }
  },

  // ═══ acp_event_replay ═══
  {
    name: 'acp_event_replay',
    description: '回放ACP事件账本。获取指定会话的历史事件记录。',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: '会话ID' },
        afterCursor: { type: 'number', description: '从该游标之后开始回放' },
        limit: { type: 'number', description: '最大事件数，默认50' }
      },
      required: ['sessionId']
    },
    category: 'system',
    dangerous: false,
    execute: function(args, ctx) {
      var AcpManager = ctx.AcpManager;
      try {
        if (AcpManager) {
          var _aerEvents = AcpManager.eventLedger.readReplay(args.sessionId, args.afterCursor, args.limit || 50);
          return { ok: true, events: _aerEvents, sessionId: args.sessionId };
        }
        return { ok: false, error: 'AcpManager未加载' };
      } catch (e) { return { ok: false, error: e.message }; }
    }
  },

  // ═══ tui_start ═══
  {
    name: 'tui_start',
    description: '启动TUI终端界面。在终端中启动交互式聊天界面，支持斜杠命令、流式输出、会话切换等。',
    parameters: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['local','gateway'], description: '连接模式：local=本地模式(直接调用AI),gateway=连接远程Gateway' },
        gatewayUrl: { type: 'string', description: 'Gateway WebSocket URL（gateway模式必填）' },
        token: { type: 'string', description: 'Gateway认证Token（可选）' }
      },
      required: []
    },
    category: 'system',
    dangerous: false,
    execute: function(args, ctx) {
      var TuiManager = ctx.TuiManager;
      var callAIProvider = ctx.callAIProvider;
      try {
        if (TuiManager) {
          var _tuiMode = args.mode || 'local';
          var _tuiOpts = { mode: _tuiMode };
          if (args.gatewayUrl) _tuiOpts.gatewayUrl = args.gatewayUrl;
          if (args.token) _tuiOpts.token = args.token;
          // Inject AI provider for local mode
          if (_tuiMode === 'local' && typeof callAIProvider === 'function') {
            TuiManager.backend.setCallAIProvider(function(input) {
              return callAIProvider(input);
            });
          }
          var _tuiResult = TuiManager.start(_tuiOpts);
          return { ok: true, status: _tuiResult.status || 'started', mode: _tuiMode };
        }
        return { ok: false, error: 'TuiManager未加载' };
      } catch (e) { return { ok: false, error: 'TUI启动失败: ' + e.message }; }
    }
  },

  // ═══ tui_stop ═══
  {
    name: 'tui_stop',
    description: '停止TUI终端界面。',
    parameters: { type: 'object', properties: {}, required: [] },
    category: 'system',
    dangerous: false,
    execute: function(args, ctx) {
      var TuiManager = ctx.TuiManager;
      try {
        if (TuiManager) { TuiManager.stop(); return { ok: true, status: 'stopped' }; }
        return { ok: false, error: 'TuiManager未加载' };
      } catch (e) { return { ok: false, error: e.message }; }
    }
  },

  // ═══ tui_status ═══
  {
    name: 'tui_status',
    description: '查看TUI终端界面状态。',
    parameters: { type: 'object', properties: {}, required: [] },
    category: 'system',
    dangerous: false,
    execute: function(args, ctx) {
      var TuiManager = ctx.TuiManager;
      try {
        if (TuiManager) { return { ok: true, status: { running: TuiManager.isRunning() } }; }
        return { ok: false, error: 'TuiManager未加载' };
      } catch (e) { return { ok: false, error: e.message }; }
    }
  },

  // ═══ tui_send ═══
  {
    name: 'tui_send',
    description: '向TUI终端发送消息或命令。在已启动的TUI中执行操作。',
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string', description: '要发送的消息或斜杠命令' },
        sessionId: { type: 'string', description: '目标会话ID（可选）' }
      },
      required: ['message']
    },
    category: 'system',
    dangerous: false,
    execute: function(args, ctx) {
      var TuiManager = ctx.TuiManager;
      try {
        if (TuiManager) {
          var _tsResult = TuiManager.backend.sendChat({ message: args.message, sessionId: args.sessionId });
          return { ok: true, result: _tsResult };
        }
        return { ok: false, error: 'TuiManager未加载' };
      } catch (e) { return { ok: false, error: e.message }; }
    }
  },

  // ═══ gmail_search ═══
  {
    name: 'gmail_search',
    description: '搜索Gmail邮件。通过Gmail API搜索邮件，返回匹配的邮件列表。需要配置GMAIL_CREDENTIALS。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Gmail搜索查询（如"from:someone subject:hello"）' },
        maxResults: { type: 'number', description: '最大结果数，默认10' },
        labelIds: { type: 'array', items: { type: 'string' }, description: '标签过滤（如INBOX, SENT, TRASH）' }
      },
      required: ['query']
    },
    category: 'network',
    dangerous: false,
    execute: function(args, ctx) {
      var configStore = ctx.configStore;
      try {
        if (!process.env.GMAIL_CREDENTIALS && !configStore.gmail) return { ok: false, error: 'Gmail未配置。请设置GMAIL_CREDENTIALS环境变量或在配置中添加Gmail凭据。' };
        return { ok: false, error: 'Gmail搜索需要安装googleapis包。请运行: npm install googleapis', hint: '配置 Gmail Pub/Sub 订阅后重试' };
      } catch (e) { return { ok: false, error: e.message }; }
    }
  },

  // ═══ gmail_send ═══
  {
    name: 'gmail_send',
    description: '发送Gmail邮件。通过Gmail API发送邮件。需要配置GMAIL_CREDENTIALS。',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: '收件人邮箱（多个用逗号分隔）' },
        subject: { type: 'string', description: '邮件主题' },
        body: { type: 'string', description: '邮件正文' },
        cc: { type: 'string', description: '抄送（可选）' },
        bcc: { type: 'string', description: '密送（可选）' },
        html: { type: 'boolean', description: '是否HTML格式，默认false' },
        attachments: { type: 'array', items: { type: 'string' }, description: '附件文件路径列表' }
      },
      required: ['to', 'subject', 'body']
    },
    category: 'network',
    dangerous: true,
    execute: function(args, ctx) {
      var configStore = ctx.configStore;
      try {
        if (!process.env.GMAIL_CREDENTIALS && !configStore.gmail) return { ok: false, error: 'Gmail未配置。请设置GMAIL_CREDENTIALS环境变量或在配置中添加Gmail凭据。' };
        return { ok: false, error: 'Gmail发送需要安装googleapis包。请运行: npm install googleapis' };
      } catch (e) { return { ok: false, error: e.message }; }
    }
  },

  // ═══ binding_add ═══
  {
    name: 'binding_add',
    description: '添加Agent路由绑定。将特定渠道/群组/账户的消息路由到指定Agent。',
    parameters: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: '目标Agent ID' },
        matchChannel: { type: 'string', description: '匹配的渠道(如telegram/discord/feishu)，*表示所有' },
        matchAccountId: { type: 'string', description: '匹配的账户ID(可选)' },
        matchPeerId: { type: 'string', description: '匹配的对端ID(可选)' },
        matchGuildId: { type: 'string', description: '匹配的Guild ID(可选)' },
        matchTeamId: { type: 'string', description: '匹配的Team ID(可选)' }
      },
      required: ['agentId', 'matchChannel']
    },
    category: 'system',
    dangerous: false,
    execute: function(args, ctx) {
      var BindingRouter = ctx.BindingRouter;
      try {
        if (!BindingRouter) return { ok: false, error: 'BindingRouter未加载' };
        var _bindMatch = { channel: args.matchChannel || '*' };
        if (args.matchAccountId) _bindMatch.accountId = args.matchAccountId;
        if (args.matchPeerId) _bindMatch.peer = { id: args.matchPeerId, kind: 'direct' };
        if (args.matchGuildId) _bindMatch.guildId = args.matchGuildId;
        if (args.matchTeamId) _bindMatch.teamId = args.matchTeamId;
        var _bindResult = BindingRouter.addBinding({ agentId: args.agentId, match: _bindMatch });
        return { ok: true, binding: _bindResult };
      } catch (e) { return { ok: false, error: '添加绑定失败: ' + e.message }; }
    }
  },

  // ═══ binding_list ═══
  {
    name: 'binding_list',
    description: '列出所有Agent路由绑定',
    parameters: { type: 'object', properties: {}, required: [] },
    category: 'system',
    dangerous: false,
    execute: function(args, ctx) {
      var BindingRouter = ctx.BindingRouter;
      try {
        if (!BindingRouter) return { ok: false, error: 'BindingRouter未加载' };
        return { ok: true, bindings: BindingRouter.listBindings() };
      } catch (e) { return { ok: false, error: e.message }; }
    }
  },

  // ═══ tool_policy_list ═══
  {
    name: 'tool_policy_list',
    description: '列出所有工具策略',
    parameters: { type: 'object', properties: {}, required: [] },
    category: 'system',
    dangerous: false,
    execute: function(args, ctx) {
      var ToolPolicyPipeline = ctx.ToolPolicyPipeline;
      try {
        if (!ToolPolicyPipeline) return { ok: false, error: 'ToolPolicyPipeline未加载' };
        return { ok: true, policies: ToolPolicyPipeline.listPolicies() };
      } catch (e) { return { ok: false, error: e.message }; }
    }
  },

  // ═══ tool_policy_create ═══
  {
    name: 'tool_policy_create',
    description: '创建自定义工具策略',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '策略名称' },
        allow: { type: 'array', items: { type: 'string' }, description: '允许的工具名列表(空数组=允许全部)' },
        deny: { type: 'array', items: { type: 'string' }, description: '禁止的工具名列表(支持通配符如desktop_*)' }
      },
      required: ['name']
    },
    category: 'system',
    dangerous: false,
    execute: function(args, ctx) {
      var ToolPolicyPipeline = ctx.ToolPolicyPipeline;
      try {
        if (!ToolPolicyPipeline) return { ok: false, error: 'ToolPolicyPipeline未加载' };
        ToolPolicyPipeline.registerPolicy(args.name, { allow: args.allow || [], deny: args.deny || [] });
        return { ok: true, name: args.name };
      } catch (e) { return { ok: false, error: '创建策略失败: ' + e.message }; }
    }
  }

];
