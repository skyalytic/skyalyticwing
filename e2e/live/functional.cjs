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
  fs.writeFileSync(path.join(reportDir, 'functional.json'), JSON.stringify(results, null, 2));
}
(async () => {
  await test('project binding', async () => {
    await api('files/project', 'POST', { path: workspace });
    assert.equal((await api('files/project')).path, workspace);
  });
  for (const p of [
    'providers',
    'models',
    'channels',
    'channels/status',
    'agents',
    'agents/teams',
    'sessions',
    'skills',
    'memory/knowledge',
    'memory/dream/status',
    'tool-policies',
    'tools',
    'tool-groups',
    'tool-profiles',
    'plugins',
    'plugins/tools',
    'plugins/hooks',
    'cron',
    'cron/status',
    'cron/history',
    'workflow',
    'usage',
    'monitor/health',
    'monitor/logs',
    'monitor/stats',
    'monitor/audit',
    'permissions',
    'approvals',
    'approvals/history',
    'config',
    'queue/stats',
    'queue/list',
    'workspace',
    'remote/nodes',
    'sandbox/status',
    'sandbox/profile',
    'sandbox/presets',
    'sandbox-enhanced',
    'security/status',
    'status/full',
    'ws/status',
    'system/info',
    'vectors/stats',
    'vectors/list',
    'mcp/servers',
    'mcp/loopback/status',
    'acp/status',
    'acp/sessions',
    'worktrees',
    'worktrees/stats',
    'terminal/status',
    'background-tasks',
    'subagents',
    'isolated-agent/status',
    'swarm/list',
    'swarm/status',
    'lifecycle/diagnostics',
    'version/mandatory-status',
    'version/mandatory-config',
    'builtin-browser/status',
    'tools/custom',
    'backup/list',
    'lsp/servers',
    'lsp/diagnostics',
    'skill-marketplace/sources',
    'daemon/status',
  ])
    await test('GET ' + p, () => api(p).then(() => undefined));
  await test('provider secrets absent from responses', async () => {
    const t = JSON.stringify(await api('config'));
    const keys = fs
      .readFileSync('API.txt', 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => l.slice(l.indexOf('：') + 1).trim());
    for (const k of keys) assert.ok(!t.includes(k));
  });
  await test('Qwen real chat and numeric usage', async () => {
    const r = await api('chat/send', 'POST', {
      session: 'live-qwen',
      model: 'qwen3.8-flash',
      message: 'Do not use tools. Reply exactly QWEN_LIVE_OK.',
    });
    assert.match(r.message.content, /QWEN_LIVE_OK/);
    assert.equal(typeof r.usage.totalTokens, 'number');
    return r.usage;
  });
  await test('session rename search fork delete', async () => {
    const s = await api('sessions', 'POST', { title: 'Acceptance Unique Session' });
    await api(`sessions/${s.id}/meta`, 'PUT', { title: 'Renamed Acceptance' });
    assert.equal((await api(`sessions/${s.id}`)).title, 'Renamed Acceptance');
    assert.ok(JSON.stringify(await api('sessions/search?q=Renamed%20Acceptance')).includes(s.id));
    const f = await api(`sessions/${s.id}/fork`, 'POST', { title: 'Fork Acceptance' });
    assert.notEqual(f.id, s.id);
    await api('sessions/' + f.id, 'DELETE');
    await api('sessions/' + s.id, 'DELETE');
  });
  await test('file editor write read tree preview', async () => {
    const f = path.join(workspace, 'acceptance.html');
    await api('files/write', 'POST', {
      path: f,
      content: '<h1>ACCEPTANCE_FILE</h1><script>alert(1)</script>',
    });
    assert.match(
      JSON.stringify(await api('files/read?path=' + encodeURIComponent(f))),
      /ACCEPTANCE_FILE/,
    );
    assert.match(
      JSON.stringify(await api('files/tree?path=' + encodeURIComponent(workspace))),
      /acceptance.html/,
    );
    const r = await fetch(url + '/api/files/serve?path=' + encodeURIComponent(f), {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.ok(r.headers.get('content-security-policy').includes('sandbox'));
    assert.match(await r.text(), /ACCEPTANCE_FILE/);
  });
  await test('knowledge add search delete', async () => {
    const k = await api('memory/knowledge', 'POST', {
      title: 'Acceptance knowledge',
      content: 'AcceptancePhoenix 314159',
      tags: ['test'],
    });
    const list = await api('memory/knowledge');
    const row = list.knowledge.find((x) => x.title === 'Acceptance knowledge');
    assert.ok(row);
    assert.match(JSON.stringify(await api('memory/search?q=AcceptancePhoenix')), /314159/);
    await api('memory/knowledge/' + row.id, 'DELETE');
  });
  await test('skill create read update delete', async () => {
    await api('skills', 'POST', {
      name: 'acceptance-skill',
      description: 'test fixture',
      steps: 'Return ACCEPTANCE_SKILL',
    });
    assert.match(
      JSON.stringify(await api('skill-content?name=acceptance-skill')),
      /ACCEPTANCE_SKILL/,
    );
    await api('skills', 'PUT', {
      name: 'acceptance-skill',
      content: '---\nname: acceptance-skill\ndescription: test\n---\nUPDATED_SKILL',
    });
    assert.match(JSON.stringify(await api('skill-content?name=acceptance-skill')), /UPDATED_SKILL/);
    await api('skills/acceptance-skill', 'DELETE');
  });
  await test('agent create update memory delete', async () => {
    const a = await api('agents', 'POST', {
      id: 'acceptance-agent',
      name: 'Acceptance Agent',
      model: 'deepseek-flash',
      systemPrompt: 'Reply briefly.',
    });
    await api('agents/acceptance-agent', 'PUT', { name: 'Acceptance Updated' });
    assert.match(JSON.stringify(await api('agents/acceptance-agent')), /Acceptance Updated/);
    await api('agents/acceptance-agent/memory', 'PUT', { content: 'AGENT_MEMORY_TEST' });
    await api('agents/acceptance-agent', 'DELETE');
  });
  await test('vector add search delete', async () => {
    const v = await api('vectors/add', 'POST', {
      content: 'Acceptance vector Phoenix 314159',
      metadata: { source: 'acceptance' },
    });
    assert.match(
      JSON.stringify(await api('vectors/search', 'POST', { query: 'Phoenix 314159' })),
      /Acceptance vector/,
    );
    await api('vectors/delete', 'POST', { id: v.embedding.id });
  });
  await test('terminal open execute read close', async () => {
    const t = await api('terminal/open', 'POST', { cwd: workspace });
    try {
      await api(`terminal/${t.id}/input`, 'POST', { text: "Write-Output 'TERMINAL_LIVE_OK'\r\n" });
      let out;
      for (let i = 0; i < 20; i++) {
        await delay(200);
        out = await api(`terminal/${t.id}/output?since=0`);
        if (JSON.stringify(out).includes('TERMINAL_LIVE_OK')) break;
      }
      assert.match(JSON.stringify(out), /TERMINAL_LIVE_OK/);
      return { cursor: out.cursor };
    } finally {
      await api(`terminal/${t.id}/close`, 'POST');
    }
  });
  await test('workflow two real model steps', async () => {
    const w = await api('workflow', 'POST', {
      name: 'Acceptance workflow',
      steps: [
        {
          id: 'one',
          name: 'one',
          prompt: 'Do not use tools. Reply exactly STEP_ONE_OK',
          model: 'deepseek-flash',
        },
        {
          id: 'two',
          name: 'two',
          prompt: 'Do not use tools. If previous output contains STEP_ONE_OK reply STEP_TWO_OK.',
          model: 'qwen3.8-flash',
        },
      ],
    });
    try {
      await api(`workflow/${w.id}/run`, 'POST');
      let logs;
      for (let i = 0; i < 60; i++) {
        await delay(500);
        logs = await api(`workflow/${w.id}/logs`);
        if (logs[0]?.status !== 'running') break;
      }
      assert.equal(logs[0]?.status, 'success');
      assert.match(JSON.stringify(logs), /STEP_TWO_OK/);
      return { steps: logs[0].stepResults.length };
    } finally {
      await api('workflow/' + w.id, 'DELETE');
    }
  });
  await test('cron create update real run delete', async () => {
    const id = 'acceptance-cron';
    await api('cron', 'POST', {
      id,
      name: 'Acceptance Cron',
      expression: '0 0 1 1 *',
      enabled: false,
      taskType: 'ai',
      model: 'deepseek-flash',
      prompt: 'Do not use tools. Reply CRON_LIVE_OK',
      delivery: { mode: 'none' },
    });
    try {
      await api('cron/' + id, 'PUT', { name: 'Acceptance Cron Updated' });
      await api('cron/' + id + '/run', 'POST');
      const logs = await api('cron/' + id + '/logs');
      assert.equal(logs.at(-1)?.outcome, 'success', JSON.stringify(logs));
      assert.match(JSON.stringify(logs), /CRON_LIVE_OK/);
      return { outcome: logs.at(-1).outcome };
    } finally {
      await api('cron/' + id, 'DELETE');
    }
  });
  await test('model file-write tool and rollback', async () => {
    const sid = 'live-coding';
    await api('files/project', 'POST', { path: workspace, sessionId: sid });
    const f = path.join(workspace, 'ai-result.txt');
    fs.writeFileSync(f, 'BEFORE');
    const operation = api('chat/send', 'POST', {
      session: sid,
      model: 'deepseek-flash',
      message: `Use the file-write tool to write exactly AI_FILE_OK into ${f}. Do not execute shell commands. Then reply WRITE_COMPLETE.`,
    });
    let done = false;
    operation.finally(() => (done = true)).catch(() => {});
    while (!done) {
      await delay(300);
      const pending = await api('approvals');
      for (const a of pending) {
        if (a.sessionId === sid && a.toolName === 'file-write' && a.args.path === f)
          await api('approvals/' + a.id, 'POST', { decision: 'allow-once' });
      }
    }
    const r = await operation;
    assert.equal(fs.readFileSync(f, 'utf8').trim(), 'AI_FILE_OK');
    await api('files/rollback', 'POST', { sessionId: sid, sinceTs: 0 });
    assert.equal(fs.readFileSync(f, 'utf8'), 'BEFORE');
    return { reply: r.message.content, usage: r.usage };
  });
  console.log('TOTAL', results.length, 'FAIL', results.filter((x) => x.status === 'fail').length);
  if (results.some((x) => x.status === 'fail')) process.exitCode = 1;
})();
