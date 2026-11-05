const fs = require('node:fs');
const path = require('node:path');
function assertSingleApplication(backend, frontend) {
  for (const file of ['main.js', 'modules/ai/llm/llm-client.service.js', 'modules/core/security/local-resource-policy.service.js']) {
    if (!fs.existsSync(path.join(backend, file))) throw Error('Required application module missing: ' + file);
  }
  for (const file of ['modules/identity/identity.service.js', 'modules/identity/identity.controller.js', 'modules/enterprise/enterprise.service.js', 'modules/enterprise/enterprise.controller.js']) {
    if (fs.existsSync(path.join(backend, file))) throw Error('Obsolete alternate account module in build: ' + file);
  }
  if (!fs.existsSync(path.join(frontend, 'index.html'))) throw Error('Frontend index missing');
  const assets = path.join(frontend, 'assets');
  for (const file of fs.readdirSync(assets).filter(name => name.endsWith('.js'))) {
    if (/\/api\/auth\/|sky_session|sky-login-story|sky-login-card/.test(fs.readFileSync(path.join(assets, file), 'utf8'))) {
      throw Error('Obsolete account UI in frontend build: ' + file);
    }
  }
}
module.exports = { assertSingleApplication };
if (require.main === module) {
  const root = path.resolve(process.argv[2] || path.join(__dirname, '..'));
  assertSingleApplication(path.join(root, 'packages/backend/dist'), path.join(root, 'packages/frontend/dist'));
  console.log('PASS single application build: standalone local model flow');
}
