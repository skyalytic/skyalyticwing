/* Local acceptance. --live opts into two bounded billed model calls using the supplied API.txt. */
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const dir = path.join(root, '.test-runtime-data', 'experts-canvas', String(Date.now()));
fs.mkdirSync(dir, { recursive: true });
process.env.SKYALYTICWING_DATA_DIR = dir;
const backend = (p) => require(path.join(root, 'packages/backend/dist', p));
const logger = { info() {}, debug() {}, warn() {}, error() {} }, ws = { broadcast() {} };
async function main() {
  const { createMediaTools } = backend('modules/tools/executor/built-in/media.js');
  const security = { isPathAllowed: p => path.dirname(p) === dir };
  const canvas = createMediaTools(security, {}, () => undefined).find(t => t.name === 'canvas');
  const content = '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><rect width="800" height="600" fill="#173a35"/><text x="70" y="190" font-size="48" fill="white">Wing Office Team</text><text x="70" y="260" font-size="22" fill="#9be5c5">Editable source / real PNG and PDF</text></svg>';
  const checks = [];
  for (const format of ['html', 'png', 'pdf']) {
    const result = await canvas.execute({ action: 'create', content, filename: 'office.' + format, format }, { sessionId: 'canvas-acceptance', workspace: dir });
    assert.equal(result.success, true, result.error);
    const bytes = fs.readFileSync(path.join(dir, 'office.' + format));
    if (format === 'png') { assert.equal(bytes.subarray(0,8).toString('hex'), '89504e470d0a1a0a'); assert.equal(bytes.readUInt32BE(16), 800); assert.equal(bytes.readUInt32BE(20), 600); }
    if (format === 'pdf') assert.equal(bytes.subarray(0,5).toString(), '%PDF-');
    if (format === 'html') assert.match(bytes.toString(), /<html>/);
    checks.push({ check: 'real-canvas-' + format, pass: true, bytes: bytes.length });
  }
  if (process.argv.includes('--live')) {
    const key = fs.readFileSync(path.join(root, 'API.txt'), 'utf8').split(/\r?\n/).find(x => x.startsWith('deekseep：'))?.split('：')[1]?.trim();
    assert.ok(key, 'Missing supplied API credential');
    const { LLMClientService } = backend('modules/ai/llm/llm-client.service.js');
    const { OpenAIAdapter } = backend('modules/ai/llm/openai-adapter.js');
    const { AnthropicAdapter } = backend('modules/ai/llm/anthropic-adapter.js');
    const { AgentService } = backend('modules/ai/agent/agent.service.js');
    const { AgentSwarmService } = backend('modules/ai/agent/agent-swarm.service.js');
    const { SessionService } = backend('modules/session/session.service.js');
    const { createPlatformTools } = backend('modules/tools/executor/built-in/platform-tools.js');
    const config = { get: name => name === 'providers' ? { deepseek: { apiKey: key, baseUrl: 'https://api.deepseek.com', models: ['deepseek-flash'] } } : {} };
    const client = new LLMClientService(config, logger, { checkUrl: async url => ({ safe: url === 'https://api.deepseek.com' }) }, new OpenAIAdapter(), new AnthropicAdapter());
    const original = client.chatSync.bind(client);
    client.chatSync = params => original({ ...params, maxTokens: 512 });
    const registry = new AgentService(); registry.onModuleInit();
    const experts = ['RESEARCH', 'REVIEW'].map(name => registry.createAgent({ name, slug: name.toLowerCase(), model: 'deepseek-flash', systemPrompt: `你是 ${name} 专家。仅输出一句以 ROLE_${name} 开头的答复，随后说出 2+3 的结果。不调用工具。` }));
    const team = registry.createTeam({ name: 'Acceptance', memberIds: experts.map(x => x.id), leadId: experts[0].id });
    const swarm = new AgentSwarmService(logger, ws, client);
    const resolver = token => token === AgentSwarmService ? swarm : token === AgentService ? registry : token === SessionService ? { getSession: () => ({ agent: 'team:' + team.id }) } : undefined;
    const tool = createPlatformTools({}, resolver).find(t => t.name === 'subagent_spawn_swarm');
    const result = await tool.execute({ tasks: experts.map(x => ({ agentId: x.id, task: '按你的角色要求回答。' })) }, { sessionId: 'live-acceptance', workspace: dir });
    assert.equal(result.success, true, result.error);
    const details = JSON.parse(result.output);
    for (let i = 0; i < experts.length; i++) assert.match(details.results[i].result, new RegExp('ROLE_' + experts[i].name));
    checks.push({ check: 'live-expert-role-delegation', pass: true, model: 'deepseek-flash', completed: details.completed });
  }
  fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify({ timestamp: new Date().toISOString(), checks }, null, 2));
  console.log(JSON.stringify({ directory: dir, checks }, null, 2));
}
main().catch(error => { console.error('Acceptance failed:', String(error.message).replace(/sk-[a-zA-Z0-9_-]+/g, '[redacted]')); process.exitCode = 1; });
