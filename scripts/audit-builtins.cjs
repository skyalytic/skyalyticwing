/* Inventory and structural checks only: never execute external or desktop actions. */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const { createBuiltInTools } = require('../packages/backend/dist/modules/tools/executor/built-in-tools.js');
const tools = createBuiltInTools({ security: {}, http: {}, ws: {}, config: {}, safety: {}, resolve: () => undefined });
const names = new Set();
for (const tool of tools) {
  assert(tool.name && !names.has(tool.name), 'Duplicate/missing tool: ' + tool.name);
  names.add(tool.name);
  assert.equal(typeof tool.execute, 'function', tool.name);
  assert.equal(tool.parameters?.type, 'object', tool.name);
  for (const field of tool.parameters.required || []) assert(field in (tool.parameters.properties || {}), tool.name + ':' + field);
}
const skillRoot = path.join(root, 'packages/web/skills');
const skills = fs.readdirSync(skillRoot, { withFileTypes: true }).filter(d => d.isDirectory()).flatMap(d => {
  const file = path.join(skillRoot, d.name, 'SKILL.md');
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, 'utf8');
  const missingFiles = [...text.matchAll(/\]\(([^)\s]+)\)/g)].map(m => m[1]).filter(ref => !/^(?:[a-z][\w+.-]*:|#|\/)/i.test(ref)).filter(ref => !fs.existsSync(path.resolve(path.dirname(file), ref.split('#')[0])));
  return [{ name: d.name, hasName: /^name:\s*\S/m.test(text), hasDescription: /^description:\s*\S/m.test(text), missingFiles, execution: 'not-business-verified' }];
});
const plugins = ['operation-logger', 'security-audit', 'smart-notifier'].map(name => {
  const plugin = require(path.join(root, 'packages/web/plugins', name + '.cjs'));
  return { name, exportedId: plugin.id || null, hooks: Object.keys(plugin.hooks || {}), tools: (plugin.tools || []).map(t => t.name), execution: 'requires-runtime-lifecycle-verification' };
});
const report = { at: new Date().toISOString(), structuralToolChecksPassed: true, tools: tools.map(t => ({ name: t.name, category: t.category, dangerous: t.dangerous })), skills, plugins };
const out = path.join(root, '.test-runtime-data/builtin-inventory.json'); fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ tools: tools.length, skills: skills.length, plugins: plugins.length, malformedSkills: skills.filter(s => !s.hasName || !s.hasDescription).map(s => s.name), missingFileReferences: skills.filter(s => s.missingFiles.length), report: out }, null, 2));
