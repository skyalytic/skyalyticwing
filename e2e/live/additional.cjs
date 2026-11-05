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
  fs.writeFileSync(path.join(reportDir, 'additional.json'), JSON.stringify(results, null, 2));
}

(async () => {
  await test('channels disabled configuration CRUD', async () => {
    await api('channels', 'POST', {
      id: 'acceptance-channel',
      type: 'telegram',
      name: 'Acceptance channel',
      enabled: false,
      credentials: {},
    });
    try {
      await api('channels/acceptance-channel', 'PUT', { name: 'Updated fixture', enabled: false });
      assert.match(JSON.stringify(await api('channels')), /Updated fixture/);
      await api('channels/acceptance-channel/messages');
    } finally {
      await api('channels/acceptance-channel', 'DELETE');
    }
  });
  await test('routing binding create list delete', async () => {
    const r = await api('bindings', 'POST', {
      agentId: 'main',
      match: { channel: 'telegram', peer: { id: 'acceptance-fixture', kind: 'direct' } },
    });
    assert.match(JSON.stringify(await api('bindings')), /acceptance-fixture/);
    await api('bindings/' + r.binding.id, 'DELETE');
  });
  await test('custom HTTP tool configuration CRUD', async () => {
    await api('tools/custom', 'POST', {
      id: 'acceptance-custom',
      name: 'Acceptance Custom',
      endpoint: 'https://example.com',
      method: 'GET',
      permission: 'ask',
    });
    try {
      assert.match(JSON.stringify(await api('tools/custom')), /acceptance-custom/);
    } finally {
      await api('tools/custom', 'DELETE', { id: 'acceptance-custom' });
    }
  });
  await test('isolated agent uses selected Qwen provider', async () => {
    const r = await api('isolated-agent/execute', 'POST', {
      prompt: 'Reply exactly ISOLATED_AGENT_OK.',
      model: 'qwen3.8-flash',
      maxIterations: 1,
    });
    assert.match(JSON.stringify(r), /ISOLATED_AGENT_OK/);
  });
  await test('side question uses configured default model', async () => {
    const r = await api('btw', 'POST', {
      question: 'Reply exactly BTW_LIVE_OK',
      sessionId: 'live-basic',
    });
    assert.match(r.answer, /BTW_LIVE_OK/);
  });
  await test('vision reads generated image', async () => {
    const image = JSON.parse(fs.readFileSync(path.join(reportDir, 'media-image.json'))).data
      .images[0];
    const r = await api('chat/send', 'POST', {
      session: 'acceptance-vision',
      model: 'qwen3.8-flash',
      message: 'Do not use tools. What color is the cube in this image? Answer briefly in English.',
      attachments: [
        { type: 'image', name: 'generated-test.png', url: image.url, mimeType: 'image/png' },
      ],
    });
    assert.match(r.message.content, /blue/i);
    return { reply: r.message.content };
  });
  await test('browser screenshot through product API', async () => {
    const r = await api('browser/screenshot', 'POST', { url: 'https://example.com' });
    assert.ok(r.success !== false);
    assert.ok(r.path && fs.statSync(r.path).size > 100);
  });
  await test('chat controls reject missing session and stop idle safely', async () => {
    await assert.rejects(api('compact', 'POST', { sessionId: 'missing-session' }));
    const r = await api('chat/stop', 'POST', { sessionId: 'unused-acceptance' });
    assert.ok(Array.isArray(r.sessions));
    await api('micro-compact', 'POST', { sessionId: 'live-coding' });
  });
  console.log('TOTAL', results.length, 'FAIL', results.filter((x) => x.status === 'fail').length);
  if (results.some((x) => x.status === 'fail')) process.exitCode = 1;
})();
