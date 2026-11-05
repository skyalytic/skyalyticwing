// Product UI and real file/attachment/terminal services, isolated local fixtures.
// The webview IPC is adapted to an iframe running the shipping browser-page.js.
const fs = require('fs'),
  path = require('path'),
  os = require('os'),
  assert = require('assert/strict');
const { createServer } = require('http'),
  { createRequire } = require('module'),
  { chromium } = require('playwright-core');
const root = path.resolve(__dirname, '..'),
  qa = path.resolve(process.env.WING_COMPOSER_QA_DIR || path.join(root, 'build/composer-2.0.1-qa'));
fs.mkdirSync(qa, { recursive: true });
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'wing-composer-')),
  project = path.join(data, 'project');
fs.mkdirSync(project);
fs.mkdirSync(path.join(project, 'notes'));
fs.writeFileSync(path.join(project, 'notes', '中文说明.txt'), '这是嵌套文件的完整内容。');
const file = path.join(project, 'sample.ts');
fs.writeFileSync(
  file,
  'const title = "中文选区";\nconst total = 42;\nconsole.log(title, total);\n',
);
fs.writeFileSync(path.join(project, 'AGENTS.md'), '# 项目规则\n修改后检查结果。');
const skill = path.join(data, 'SKILL.md');
fs.writeFileSync(skill, '# 文档整理\n读取来源，整理成摘要，并验证保存结果。');
process.env.SKYALYTICWING_DATA_DIR = path.join(data, 'data');
const requireBackend = createRequire(path.join(root, 'packages/backend/package.json'));
requireBackend('reflect-metadata');
const mod = (p) => require(path.join(root, 'packages/backend/dist/modules', p));
const { FilesService } = mod('tools/files/files.service.js'),
  { TerminalService } = mod('terminal/terminal.service.js'),
  { AgentLoopService } = mod('ai/agent/agent-loop.service.js');
const security = {
  isPathAllowed: (p) =>
    path.resolve(p) === project || path.resolve(p).startsWith(project + path.sep),
};
const files = new FilesService(security, { get: () => ({ projectDir: project }) }),
  terminal = new TerminalService(security);
let server,
  browser,
  page,
  settingsCount = 0,
  compactCount = 0,
  clearCount = 0;
let failListOnce = false,
  failSkillsOnce = false;
const sent = [],
  errors = [],
  checks = [];
const until = async (fn, msg) => {
  for (let i = 0; i < 100; i++) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 80));
  }
  throw Error('Timeout: ' + msg);
};
(async () => {
  const source = path.join(root, 'packages/frontend/src').replaceAll('\\', '/');
  fs.writeFileSync(
    path.join(qa, 'fixture.tsx'),
    `import React from 'react';import {createRoot} from '${source}/../node_modules/react-dom/client';import {MemoryRouter,useNavigate,useLocation} from 'react-router-dom';import '${source}/i18n';
import {ChatInput} from '${source}/components/chat/ChatInput';import {MessageItem} from '${source}/components/chat/MessageItem';import {ProjectPanel} from '${source}/components/project/ProjectPanel';import {SettingsPage} from '${source}/modules/settings/SettingsPage';import {useProjectPanel} from '${source}/stores/project-panel-store';import {useWorkspaceTabs} from '${source}/stores/workspace-tab-store';import {useSessionStore} from '${source}/stores/session-store';import {useChatStore} from '${source}/stores/chat-store';import {useBrowserPanel} from '${source}/stores/browser-store';
const project=${JSON.stringify(project)},file=${JSON.stringify(file)};
useProjectPanel.setState({projectDir:project,initialized:true,open:true,currentFile:file,openFiles:[file],initProjectDir:async()=>{}});useSessionStore.setState({currentSessionId:'current'});useChatStore.setState({messagesSessionId:'current',messages:[{id:'failure',role:'tool',toolName:'file-read',content:JSON.stringify({success:false,error:'测试来源文件不存在'}),timestamp:1}]});
const frame=document.createElement('iframe');frame.id='qa-native-webview';frame.src='/webpage';frame.style.cssText='position:fixed;display:none;border:0;z-index:30';document.body.append(frame);
const state=useBrowserPanel;state.setState({nativeReady:true,tabs:[{id:'page1',url:location.origin+'/webpage'}],snapshot:{pageId:'page1',url:location.origin+'/webpage',title:'网页引用验收',viewport:{width:800,height:600},screenshot:'',elements:[],consoleTail:[],markedAt:0}});
(window as any).__TAURI_INTERNALS__={invoke:async(name,args)=>{if(name==='native_browser_bounds'){Object.assign(frame.style,{left:args.bounds.x+'px',top:args.bounds.y+'px',width:args.bounds.width+'px',height:args.bounds.height+'px',display:args.bounds.visible?'block':'none'});return;}if(name==='native_browser_command'){const c=args.command,result=(frame.contentWindow as any)?.__wingBrowser?.(c.op,c.args);if(result&&!result.ok)throw Error(result.error);return result?.value;}return false;}};
let last='';setInterval(()=>{const meta=(frame.contentWindow as any)?.__wingBrowser?.('metadata')?.value;if(!meta)return;const serial=JSON.stringify(meta.selected);if(serial!==last){last=serial;state.setState({selected:meta.selected,mode:meta.selecting?'select':'browse'});}},80);
function App(){const nav=useNavigate(),loc=useLocation();const [messages,setMessages]=React.useState(()=>JSON.parse(localStorage.getItem('qa.sent')||'[]'));const settings=loc.pathname==='/settings';return <div style={{height:'100vh',display:'flex',flexDirection:'column'}}><header data-route={loc.pathname+loc.search} style={{height:40,padding:6}}><button onClick={()=>nav('/settings?tab=personalize')}>打开设置</button> · <button onClick={()=>nav('/chat')}>返回对话</button></header><div style={{display:settings?'block':'none',overflow:'auto',flex:1}}>{settings&&<SettingsPage/>}</div><div className="sky-chat-workspace" style={{display:settings?'none':'flex',flex:1,minHeight:0}}><section className="chat-view" style={{display:'flex',flexDirection:'column',width:440,flex:1,minWidth:300}}><div style={{flex:1,overflow:'auto'}}>{messages.map((m,i)=><MessageItem key={m.id} message={m} index={i}/>)}</div><ChatInput onSend={async(content,attachments)=>{await fetch('/api/qa/send',{method:'POST',body:JSON.stringify({content,attachments})});const next=[...messages,{id:'m'+Date.now(),role:'user',content,attachments,timestamp:Date.now()}];setMessages(next);localStorage.setItem('qa.sent',JSON.stringify(next));}} onCompact={()=>void fetch('/api/qa/compact',{method:'POST'})} onClear={()=>{void fetch('/api/qa/clear',{method:'POST'});setMessages([]);localStorage.removeItem('qa.sent');}}/></section><ProjectPanel/></div></div>};createRoot(document.getElementById('root')).render(<MemoryRouter initialEntries={['/chat']}><App/></MemoryRouter>);`,
  );
  const { build } = createRequire(require.resolve('../packages/frontend/node_modules/vite'))(
    'esbuild',
  );
  await build({
    entryPoints: [path.join(qa, 'fixture.tsx')],
    outfile: path.join(qa, 'fixture.js'),
    bundle: true,
    format: 'esm',
    jsx: 'automatic',
    alias: { '@': source },
    define: { 'import.meta.env': '{}', 'process.env.NODE_ENV': '"production"' },
    loader: { '.css': 'empty' },
    nodePaths: [path.join(root, 'packages/frontend/node_modules')],
  });
  const css = fs
    .readdirSync(path.join(root, 'packages/frontend/dist/assets'))
    .find((n) => /^index-.*\.css$/.test(n));
  const styles =
    fs.readFileSync(path.join(root, 'packages/frontend/dist/assets', css), 'utf8') +
    [
      'components/chat/composer-picker.css',
      'components/chat/browser-annotation-chip.css',
      'styles/workspace.css',
    ]
      .map((p) => fs.readFileSync(path.join(source, p), 'utf8'))
      .join('\n');
  server = createServer(async (req, res) => {
    try {
      const u = new URL(req.url, 'http://localhost'),
        p = u.pathname;
      let result;
      if (p === '/webpage') {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(
          '<!doctype html><html><title>网页引用验收</title><style>body{padding:35px;background:#eef6fb;font:18px system-ui}h1{padding:40px;color:#236}</style><h1 id="hero">让想法，成为完成的工作。</h1><button>实际网页按钮</button><script src="/browser-page.js"></script></html>',
        );
        return;
      }
      if (!p.startsWith('/api/')) {
        res.setHeader(
          'Content-Type',
          p.endsWith('.js') ? 'text/javascript' : p.endsWith('.css') ? 'text/css' : 'text/html',
        );
        res.end(
          p === '/fixture.js'
            ? fs.readFileSync(path.join(qa, 'fixture.js'))
            : p === '/browser-page.js'
              ? fs.readFileSync(path.join(root, 'src-tauri/src/browser-page.js'))
              : p === '/styles.css'
                ? styles
                : '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><link rel="stylesheet" href="/styles.css"><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>',
        );
        return;
      }
      let body = '';
      for await (const chunk of req) body += chunk;
      body = body ? JSON.parse(body) : {};
      if (p === '/api/files/list') {
        if (failListOnce) {
          failListOnce = false;
          throw Error('目录暂时不可读');
        }
        result = files.list(u.searchParams.get('path'));
      } else if (p === '/api/files/tree')
        result = files.tree(u.searchParams.get('path'), Number(u.searchParams.get('depth')));
      else if (p === '/api/files/read') result = files.read(u.searchParams.get('path'));
      else if (p === '/api/files/write') {
        fs.writeFileSync(body.path, body.content);
        result = {};
      } else if (p === '/api/agents')
        result = [{ id: 'reviewer', name: '审校助手', description: '核对文件内容', builtin: true }];
      else if (p === '/api/agents/teams') result = [];
      else if (p === '/api/models')
        result = { models: [{ id: 'test', name: '测试模型', available: true, kind: 'chat' }] };
      else if (p === '/api/config/general') result = { defaultModel: 'test' };
      else if (p === '/api/permissions') result = { mode: 'ask' };
      else if (p === '/api/sessions')
        result = [{ id: 'past', title: '上次文档讨论', projectDir: project }];
      else if (p === '/api/sessions/past/messages')
        result = [
          { role: 'user', content: '之前决定使用蓝色标题' },
          { role: 'assistant', content: '已经记录这一要求' },
        ];
      else if (p === '/api/skills') {
        if (failSkillsOnce) {
          failSkillsOnce = false;
          throw Error('技能来源暂时不可用');
        }
        result = {
          skills: [{ name: '文档整理', description: '读取、整理并验证文档', location: skill }],
        };
      } else if (p === '/api/skill-content')
        result = { path: skill, content: fs.readFileSync(skill, 'utf8') };
      else if (p === '/api/plugins')
        result = [
          {
            id: 'documents',
            name: '文档插件',
            description: '处理文档',
            enabled: true,
            loaded: true,
            tools: ['document_read'],
          },
          { id: 'disabled', name: '禁用插件', enabled: false, loaded: false, tools: [] },
        ];
      else if (p === '/api/qa/send') {
        const ai = Object.create(AgentLoopService.prototype);
        const parts = await ai.buildUserContent(body.content, body.attachments, {
          used: 0,
          omit: 0,
        });
        sent.push({ ...body, parts });
        fs.writeFileSync(path.join(qa, 'sent.json'), JSON.stringify(sent, null, 2));
        result = {};
      } else if (p === '/api/qa/compact') {
        compactCount++;
        result = {};
      } else if (p === '/api/qa/clear') {
        clearCount++;
        result = {};
      } else if (p === '/api/terminal/open') result = terminal.open(body.cwd, body.cols, body.rows);
      else if (p.startsWith('/api/terminal/')) {
        const id = p.split('/')[3];
        if (p.endsWith('/output'))
          result = terminal.output(id, Number(u.searchParams.get('since')));
        else if (p.endsWith('/input')) result = terminal.input(id, body.text, body.raw);
        else if (p.endsWith('/resize')) result = terminal.resize(id, body.cols, body.rows);
        else if (p.endsWith('/close')) result = terminal.close(id);
        else result = terminal.status();
      } else if (p === '/api/files/changes') result = { changes: [] };
      else if (p === '/api/files/git-changes') result = { isRepo: false };
      else if (p === '/api/builtin-browser/tabs') result = { tabs: [] };
      else if (p === '/api/files/projects') result = [];
      else result = {};
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(result));
    } catch (e) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ message: e.message }));
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 940 } });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('http://127.0.0.1:' + server.address().port);
  await page.locator('.cm-content').waitFor();
  const composer = page.locator('.sky-composer'),
    input = composer.locator('textarea'),
    picker = () => page.locator('.wing-composer-picker');
  const trigger = async (text) => {
    await input.fill(text);
    await picker().waitFor();
    await until(async () => !(await picker().getByRole('status').count()), 'picker loaded');
  };
  const option = (label) =>
    picker()
      .getByRole('option')
      .filter({
        has: page
          .locator('strong')
          .filter({ hasText: new RegExp(label.endsWith('$') ? '^' + label : label) }),
      });
  const remove = async () => {
    for (const b of await composer.getByRole('button', { name: '移除引用', exact: true }).all())
      await b.click();
  };
  const closeDialog = async () => {
    await page
      .getByRole('dialog')
      .filter({ has: page.locator('.wing-context-detail') })
      .getByRole('button', { name: '关闭', exact: true })
      .click();
  };
  assert.equal(await composer.getByRole('button', { name: '引用文件', exact: true }).count(), 0);
  assert.equal(await composer.getByRole('button', { name: '计划', exact: true }).count(), 0);
  assert.equal(await composer.getByRole('button', { name: '添加引用', exact: true }).count(), 0);
  assert.equal(await composer.getByRole('button', { name: '命令、技能与插件', exact: true }).count(), 0);
  // Select two actual CodeMirror lines without editing them, then click the floating action.
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+Home');
  await page.keyboard.down('Shift');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('End');
  await page.keyboard.up('Shift');
  await page.getByRole('button', { name: '添加到对话 Ctrl+U', exact: true }).click();
  await composer.getByRole('button', { name: '查看引用：sample.ts 1–2' }).click();
  assert.match(await page.locator('.wing-context-detail').innerText(), /中文选区/);
  assert.match(await page.locator('.wing-context-detail').innerText(), /total = 42/);
  await closeDialog();
  assert.equal(await input.inputValue(), '');
  await input.fill('请检查选中的两行');
  await composer.getByRole('button', { name: '发送', exact: true }).click();
  await until(() => sent.length === 1, 'selection sent');
  assert.match(JSON.stringify(sent[0].parts), /中文选区/);
  assert.match(JSON.stringify(sent[0].parts), /选区行号：1–2/);
  const bubble = page.locator('.wing-user-bubble').first();
  await bubble.locator('.sky-browser-annotation-chip').waitFor();
  assert.equal(await bubble.locator('.sky-browser-annotation-chip').count(), 1);
  assert.match(await bubble.innerText(), /请检查选中的两行/);
  assert.equal(await page.locator('.chat-msg-user').first().locator(':scope > div').count(), 1);
  await page.screenshot({ path: path.join(qa, 'reference-message.png') });
  checks.push('多行选区 → 浮动添加 → 行号标签 → 详情 → 真实附件解码供 AI 使用');
  await until(()=>page.evaluate(()=>JSON.parse(localStorage.getItem('qa.sent')||'[]').length===1),'history persisted');
  await page.reload();
  await page.getByRole('button', { name: '查看引用：sample.ts 1–2' }).click();
  assert.match(await page.locator('.wing-context-detail').innerText(), /中文选区/);
  await closeDialog();
  checks.push('发送后与重载后的历史标签仍可查看详情');
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+Home');
  await page.keyboard.down('Shift');
  await page.keyboard.press('End');
  await page.keyboard.up('Shift');
  await page.keyboard.press('Control+u');
  await composer.getByRole('button', { name: '查看引用：sample.ts 1–1' }).waitFor();
  await remove();
  assert.match(fs.readFileSync(file, 'utf8'), /const total = 42/);
  checks.push('Ctrl+U 添加选区，引用不修改源文件');
  await trigger('@');
  await option('文件夹').click();
  await option('notes').click();
  await option('引用此文件夹').click();
  await composer.getByRole('button', { name: '查看引用：notes' }).click();
  assert.match(await page.locator('.wing-context-detail').innerText(), /notes/);
  await closeDialog();
  await remove();
  await trigger('@');
  await option('文件$').first().click();
  await option('notes').click();
  await option('中文说明').click();
  assert.equal(await input.inputValue(), '');
  await remove();
  await trigger('@中文说明');
  await option('中文说明').click();
  await composer.getByRole('button', { name: '查看引用：中文说明.txt' }).click();
  await page.getByRole('button', { name: '打开来源', exact: true }).click();
  await page.locator('.cm-content').filter({ hasText: '这是嵌套文件' }).waitFor();
  await remove();
  checks.push('@ 文件/文件夹浏览、嵌套目录、搜索、移除、打开来源');
  await trigger('@');
  failListOnce = true;
  await option('文件$').click();
  await picker().getByRole('alert').filter({ hasText: '目录暂时不可读' }).waitFor();
  await picker().getByRole('button', { name: '重试', exact: true }).click();
  await option('notes').click();
  await picker().getByRole('button', { name: '上一级', exact: true }).click();
  await option('notes').waitFor();
  await picker().getByRole('button', { name: '返回', exact: true }).click();
  await option('历史对话').waitFor();
  await page.keyboard.press('Escape');
  await trigger('@没有这个文件abc');
  await picker().getByText('无匹配项目', { exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await input.fill('检查 后面的说明');
  await input.evaluate((el) => el.setSelectionRange(3, 3));
  await input.pressSequentially('@');
  await option('sample.ts').click();
  assert.equal(await input.inputValue(), '检查 后面的说明');
  await remove();
  checks.push('@ 无匹配、目录失败重试、返回和上级目录；输入框内光标处键入触发且保留原文');
  await trigger('@');
  await option('历史对话').click();
  await option('上次文档讨论').click();
  await composer.getByRole('button', { name: '查看引用：上次文档讨论' }).click();
  assert.match(await page.locator('.wing-context-detail').innerText(), /蓝色标题/);
  await closeDialog();
  await remove();
  await trigger('@');
  await option('项目规则').click();
  await option('AGENTS.md').click();
  await remove();
  await trigger('@');
  await option('当前问题').click();
  await option('file-read').click();
  await composer.getByRole('button', { name: '查看引用：file-read' }).click();
  assert.match(await page.locator('.wing-context-detail').innerText(), /测试来源文件不存在/);
  await closeDialog();
  await remove();
  await trigger('@');
  await option('智能体').click();
  await option('审校助手').click();
  assert.ok(await composer.getByRole('button', { name: /审校助手/ }).isVisible());
  assert.equal(await input.inputValue(), '');
  checks.push('@ 历史对话、项目规则、真实失败记录、智能体选择');
  await trigger('/');
  assert.equal(await option('禁用插件').count(), 0);
  await option('文档整理').click();
  await composer.getByRole('button', { name: '查看引用：文档整理' }).click();
  assert.match(await page.locator('.wing-context-detail').innerText(), /验证保存结果/);
  await closeDialog();
  await input.fill('按此技能整理文档');
  await composer.getByRole('button', { name: '发送', exact: true }).click();
  await until(() => sent.length === 2, 'skill sent');
  assert.match(JSON.stringify(sent[1].parts), /用户选用了此技能/);
  await trigger('/');
  await option('文档插件').click();
  await composer.getByRole('button', { name: '查看引用：文档插件' }).click();
  assert.match(await page.locator('.wing-context-detail').innerText(), /document_read/);
  await closeDialog();
  await remove();
  checks.push('/ 命令/技能/插件分组，读取真实技能文件、插件工具清单，禁用项不可选择');
  failSkillsOnce = true;
  await trigger('/');
  await picker().getByRole('alert').filter({ hasText: '部分来源加载失败' }).waitFor();
  assert.ok(await option('终端').isVisible());
  await picker().getByRole('button', { name: '重试', exact: true }).click();
  await option('文档整理').waitFor();
  await page.keyboard.press('Escape');
  await input.fill('保留草稿 ');
  await input.pressSequentially('/');
  await until(
    () => input.evaluate((el) => document.activeElement === el),
    'typing a trigger retains input focus',
  );
  await picker().getByRole('button', { name: '管理技能', exact: true }).focus();
  await picker().getByRole('button', { name: '管理技能', exact: true }).press('Enter');
  await page.locator('header[data-route="/skills"]').waitFor();
  assert.equal(await input.inputValue(), '保留草稿 ');
  await page.locator('header').getByRole('button', { name: '返回对话', exact: true }).click();
  await trigger('/');
  await picker().getByRole('button', { name: '管理插件', exact: true }).click();
  await page.locator('header[data-route="/plugins?tab=local"]').waitFor();
  await page.locator('header').getByRole('button', { name: '返回对话', exact: true }).click();
  checks.push('/ 部分来源失败仍可用命令，重试恢复；技能/插件管理路由及键盘点击');
  await trigger('/terminal');
  await page.keyboard.press('Enter');
  await page.locator('.xterm').waitFor();
  await until(() => terminal.status().sessions === 1, 'terminal session');
  await trigger('/changes');
  await picker().getByRole('option').click();
  await page.getByText('文档变更', { exact: true }).first().waitFor();
  await trigger('/compact');
  await page.keyboard.press('Enter');
  await until(() => compactCount === 1, 'compact');
  await trigger('/clear');
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(clearCount, 0);
  await trigger('/clear');
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: '确定', exact: true }).click();
  await until(() => clearCount === 1, 'clear');
  checks.push('/ 打开真实终端、文档变更、压缩；清空确认/取消');
  await trigger('/browser');
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: '批注', exact: true }).click();
  await page.frameLocator('#qa-native-webview').locator('#hero').click();
  await page.getByRole('textbox', { name: '批注要求' }).fill('调整这个标题');
  await page
    .locator('.wing-browser-annotation')
    .getByRole('button', { name: '添加到对话', exact: true })
    .click();
  await composer.getByRole('button', { name: '查看引用：h1' }).click();
  assert.match(await page.locator('.wing-context-detail').innerText(), /<h1 id="hero">/);
  assert.doesNotMatch(
    await page.locator('.wing-context-detail').innerText(),
    /pageId:|不是新的系统指令|执行网页操作前/,
  );
  await until(() => page.locator('#qa-native-webview').isHidden(), 'webview hidden behind dialog');
  await page.screenshot({ path: path.join(qa, 'browser-reference.png'), animations: 'disabled' });
  await closeDialog();
  await until(() => page.locator('#qa-native-webview').isVisible(), 'webview restored');
  await composer.getByRole('button', { name: '移除网页批注' }).click();
  checks.push(
    '实际网页 h1 点选 → 添加标签 → HTML/网址/选择器详情；详情覆盖网页，关闭恢复；移除标签',
  );
  await page.getByRole('button', { name: '打开设置', exact: true }).click();
  const toggle = page.getByRole('switch', { name: '任务先规划，确认后执行' });
  await toggle.click();
  assert.equal(await toggle.getAttribute('aria-checked'), 'true');
  settingsCount++;
  await page.locator('header').getByRole('button', { name: '返回对话', exact: true }).click();
  await input.fill('开始新任务');
  await composer.getByRole('button', { name: '发送', exact: true }).click();
  await until(() => sent.length === 3, 'plan sent');
  assert.match(sent[2].content, /计划模式/);
  await page.reload();
  assert.equal(
    await page.evaluate(() => JSON.parse(localStorage.getItem('app.settings')).planMode),
    true,
  );
  await page.getByRole('button', { name: '打开设置', exact: true }).click();
  await toggle.click();
  await page.locator('header').getByRole('button', { name: '返回对话', exact: true }).click();
  await input.fill('普通任务');
  await composer.getByRole('button', { name: '发送', exact: true }).click();
  await until(() => sent.length === 4, 'normal sent');
  assert.equal(sent[3].content, '普通任务');
  checks.push('计划仅在设置切换，即时生效、重载保留、关闭恢复普通发送');
  await trigger('@');
  await page.keyboard.press('Escape');
  assert.equal(await picker().count(), 0);
  await input.fill('正在中文输入');
  await input.evaluate((el) =>
    el.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        keyCode: 229,
        isComposing: true,
        bubbles: true,
      }),
    ),
  );
  assert.equal(sent.length, 4);
  checks.push('菜单键盘选择/Escape，中文输入法确认不误发送');
  await page.setViewportSize({ width: 760, height: 800 });
  await trigger('/');
  const rect = await picker().boundingBox();
  assert.ok(rect.x >= 0 && rect.x + rect.width <= 761 && rect.y >= 0);
  await page.screenshot({ path: path.join(qa, 'compact-picker.png'), animations: 'disabled' });
  await page.keyboard.press('Escape');
  checks.push('窄窗口菜单保持在可视区域');
  for (const platform of ['Win32', 'MacIntel', 'Linux x86_64']) {
    const context = await browser.newContext({viewport:{width:1280,height:900}});
    await context.addInitScript(platform => Object.defineProperty(navigator,'platform',{get:()=>platform}),platform);
    const probe = await context.newPage();
    probe.on('pageerror',e=>errors.push(platform+': '+e.message));
    await probe.goto('http://127.0.0.1:' + server.address().port);
    await probe.locator('.cm-content .cm-line').first().click({clickCount:3});
    const label = platform === 'MacIntel' ? '⌘+U' : 'Ctrl+U';
    await probe.getByRole('button',{name:'添加到对话 '+label,exact:true}).waitFor();
    await probe.keyboard.press(platform === 'MacIntel' ? 'Meta+u' : 'Control+u');
    const refs = probe.locator('.wing-composer-references');
    await refs.getByRole('button',{name:/查看引用：sample.ts/}).waitFor();
    assert.equal(await refs.locator('.sky-browser-annotation-chip').count(),1);
    await probe.screenshot({path:path.join(qa,'shortcut-'+platform.split(' ')[0]+'.png')});
    await context.close();
  }
  checks.push('Windows/macOS/Linux 平台分支：选区提示与 Ctrl/Command+U 实际键盘绑定一致（当前浏览器内模拟）');
  assert.deepEqual(errors, []);
  fs.writeFileSync(
    path.join(qa, 'result.json'),
    JSON.stringify({ checks, errors, data, settingsCount, at: new Date().toISOString() }, null, 2),
  );
  console.log(JSON.stringify({ checks, errors }, null, 2));
})()
  .catch(async (e) => {
    console.error(e.stack);
    if (page) await page.screenshot({ path: path.join(qa, 'failure.png') }).catch(() => {});
    fs.writeFileSync(
      path.join(qa, 'failure.json'),
      JSON.stringify({ message: e.message, checks, errors }, null, 2),
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await browser?.close();
    await terminal.onModuleDestroy();
    if (server) await new Promise((r) => server.close(r));
  });
