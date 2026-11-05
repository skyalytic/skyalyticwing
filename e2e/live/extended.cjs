const fs = require('fs'),
  path = require('path'),
  assert = require('assert/strict');
if (!process.argv.includes('--live'))
  throw new Error('Live acceptance uses paid APIs; pass --live for an isolated test instance.');
const connectionFile = process.env.SKY_LIVE_CONNECTION;
if (!connectionFile) throw new Error('Set SKY_LIVE_CONNECTION to an isolated connection JSON');
const { url, token, data } = JSON.parse(fs.readFileSync(connectionFile));
if (
  !fs.existsSync(path.join(data, '.acceptance-only')) ||
  !['127.0.0.1', 'localhost'].includes(new URL(url).hostname) ||
  new URL(url).protocol !== 'http:'
)
  throw new Error('Refusing non-isolated acceptance target');
const reportDir = path.dirname(connectionFile);
const workspace = path.join(data, 'workspace');
const results = [];
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(p, method = 'GET', body) {
  const r = await fetch(url + '/api/' + p, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(90000),
  });
  const text = await r.text();
  let b;
  try {
    b = JSON.parse(text);
  } catch {
    b = text;
  }
  if (!r.ok || b.success === false)
    throw Error(`${method} ${p}: ${r.status} ${JSON.stringify(b).slice(0, 400)}`);
  return b.data ?? b;
}
async function test(name, fn) {
  const start = Date.now();
  try {
    const detail = await fn();
    results.push({ name, status: 'pass', ms: Date.now() - start, detail });
    console.log('PASS', name, detail ? JSON.stringify(detail) : '');
  } catch (e) {
    results.push({ name, status: 'fail', error: e.message });
    console.log('FAIL', name, e.message);
  }
  fs.writeFileSync(path.join(reportDir, 'extended.json'), JSON.stringify(results, null, 2));
}

async function approved(operation, sessionId, allowedTool, validate) {
  let done = false;
  operation.finally(() => (done = true)).catch(() => {});
  while (!done) {
    await delay(200);
    for (const a of await api('approvals')) {
      if (a.sessionId === sessionId && a.toolName === allowedTool && validate(a.args))
        await api('approvals/' + a.id, 'POST', { decision: 'allow-once' });
    }
  }
  return operation;
}
(async () => {
  await test('background submit complete result returned to parent', async () => {
    const sid = 'acceptance-bg';
    const s = await approved(
      api('tool/execute', 'POST', {
        tool: 'background_task_submit',
        sessionId: sid,
        args: {
          prompt: 'Do not use tools. Reply BACKGROUND_LIVE_OK.',
          title: 'Acceptance background',
          model: 'deepseek-flash',
        },
      }),
      sid,
      'background_task_submit',
      (a) => a.title === 'Acceptance background',
    );
    const id = s.data.taskId;
    let task;
    for (let i = 0; i < 100; i++) {
      await delay(300);
      task = await api('background-tasks/' + id);
      if (['completed', 'failed', 'cancelled'].includes(task.status)) break;
    }
    assert.equal(task.status, 'completed');
    assert.match(task.result, /BACKGROUND_LIVE_OK/);
    assert.match(JSON.stringify(await api('chat/history/' + sid)), /BACKGROUND_LIVE_OK/);
    await api('background-tasks/' + id + '/resume', 'POST');
    const after = await api('background-tasks/' + id);
    assert.equal(after.attempts, task.attempts);
    return { id, status: task.status };
  });
  await test('worktree create diff dirty protection remove', async () => {
    const { execFileSync } = require('child_process');
    execFileSync('git', ['init'], { cwd: data, windowsHide: true });
    execFileSync('git', ['config', 'user.email', 'acceptance@example.invalid'], {
      cwd: data,
      windowsHide: true,
    });
    execFileSync('git', ['config', 'user.name', 'Acceptance Fixture'], {
      cwd: data,
      windowsHide: true,
    });
    execFileSync('git', ['commit', '--allow-empty', '-m', 'Isolated acceptance fixture'], {
      cwd: data,
      windowsHide: true,
    });
    await api('worktrees/init-git', 'POST');
    const dest = path.join(data, 'acceptance-worktree');
    const wt = (await api('worktrees', 'POST', { path: dest, branch: 'acceptance-fixture' }))
      .worktree;
    await api('worktrees/' + encodeURIComponent(wt.id) + '/diff');
    const f = path.join(dest, 'dirty.txt');
    fs.writeFileSync(f, 'preserve me');
    await assert.rejects(api('worktrees/remove', 'POST', { worktreeId: wt.id }));
    assert.equal(fs.readFileSync(f, 'utf8'), 'preserve me');
    fs.unlinkSync(f);
    await api('worktrees/remove', 'POST', { worktreeId: wt.id });
    assert.ok(!fs.existsSync(dest));
  });
  await test('plugin install load invoke unload delete', async () => {
    const dir = path.join(data, 'plugin-data', 'plugins');
    fs.mkdirSync(dir, { recursive: true });
    const source = path.join(dir, 'acceptance.cjs');
    fs.writeFileSync(
      source,
      "module.exports={tools:[{name:'acceptance_echo',description:'Local test fixture',category:'test',parameters:{type:'object',properties:{}},execute:async()=>({success:true,output:'PLUGIN_LIVE_OK'})}]}",
    );
    const p = await api('plugins', 'POST', { source });
    try {
      await api('plugins/' + p.id + '/load', 'POST');
      assert.match(JSON.stringify(await api('plugins/tools')), /acceptance_echo/);
      const sid = 'acceptance-plugin';
      const r = await approved(
        api('tool/execute', 'POST', { tool: 'acceptance_echo', sessionId: sid, args: {} }),
        sid,
        'acceptance_echo',
        () => true,
      );
      assert.match(JSON.stringify(r), /PLUGIN_LIVE_OK/);
      await api('plugins/' + p.id + '/unload', 'POST');
    } finally {
      await api('plugins/' + p.id, 'DELETE');
    }
  });
  await test('MCP real stdio initialize discover call stop delete', async () => {
    const f = path.join(workspace, 'mcp-fixture.cjs');
    fs.writeFileSync(
      f,
      "const rl=require('readline').createInterface({input:process.stdin});rl.on('line',l=>{try{const m=JSON.parse(l);if(m.id===undefined)return;let result={};if(m.method==='initialize')result={protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'acceptance',version:'1.0.0'}};if(m.method==='tools/list')result={tools:[{name:'echo',description:'Acceptance fixture',inputSchema:{type:'object',properties:{}}}]};if(m.method==='tools/call')result={content:[{type:'text',text:'MCP_LIVE_OK'}]};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n')}catch{}})",
    );
    const s = await api('mcp/servers', 'POST', {
      id: 'acceptance-mcp',
      name: 'Acceptance MCP',
      command: process.execPath,
      args: [f],
      enabled: true,
    });
    try {
      await api('mcp/servers/' + s.id + '/start', 'POST');
      assert.match(JSON.stringify(await api('mcp/servers/' + s.id + '/tools')), /echo/);
      assert.match(
        JSON.stringify(await api('mcp/servers/' + s.id + '/tools/echo', 'POST', { args: {} })),
        /MCP_LIVE_OK/,
      );
      await api('mcp/servers/' + s.id + '/stop', 'POST');
    } finally {
      await api('mcp/servers/' + s.id, 'DELETE');
    }
  });
  await test('backup create verify restore delete', async () => {
    const b = await api('backup/create', 'POST', {});
    try {
      assert.equal((await api('backup/verify', 'POST', { name: b.name })).valid, true);
      const cfgFile = path.join(data, 'config.json');
      const before = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
      before.acceptanceMarker = 'AFTER_BACKUP';
      fs.writeFileSync(cfgFile, JSON.stringify(before));
      await api('backup/restore', 'POST', { name: b.name });
      assert.ok(!JSON.parse(fs.readFileSync(cfgFile, 'utf8')).acceptanceMarker);
    } finally {
      await api('backup/delete', 'POST', { name: b.name });
    }
  });
  await test('restricted bash rejects missing container runtime', async () => {
    const sid = 'acceptance-sandbox';
    const op = api('tool/execute', 'POST', {
      tool: 'bash',
      sessionId: sid,
      args: { command: 'echo ISOLATION_TEST', cwd: workspace },
    });
    let failure;
    try {
      await approved(op, sid, 'bash', (a) => a.command === 'echo ISOLATION_TEST');
    } catch (e) {
      failure = e.message;
    }
    assert.match(failure || '', /Docker|container|isolation|容器|沙箱/i);
    return 'Execution blocked; actual container isolation requires Docker';
  });
  await test('denied approval prevents file write', async () => {
    const sid = 'acceptance-deny',
      f = path.join(workspace, 'denied.txt');
    const op = api('tool/execute', 'POST', {
      tool: 'file-write',
      sessionId: sid,
      args: { path: f, content: 'MUST_NOT_WRITE' },
    });
    let done = false;
    op.finally(() => (done = true)).catch(() => {});
    while (!done) {
      await delay(150);
      for (const a of await api('approvals'))
        if (a.sessionId === sid) await api('approvals/' + a.id, 'POST', { decision: 'denied' });
    }
    await assert.rejects(op);
    assert.ok(!fs.existsSync(f));
  });
  console.log('TOTAL', results.length, 'FAIL', results.filter((x) => x.status === 'fail').length);
  if (results.some((x) => x.status === 'fail')) process.exitCode = 1;
})();
