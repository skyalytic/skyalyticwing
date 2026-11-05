const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { replaceBuildDirectory } = require('./replace-build-directory.cjs');
const { assertSingleApplication } = require('./assert-single-application.cjs');
test('deployment replaces stale modules rather than merging old product code', () => {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wing-build-replace-')));
  try {
    const source = path.join(temp, 'source'), deploy = path.join(temp, 'deploy'), target = path.join(deploy, 'dist');
    fs.mkdirSync(source); fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(source, 'main.js'), 'current');
    fs.writeFileSync(path.join(target, 'identity.service.js'), 'obsolete');
    replaceBuildDirectory(source, target, deploy);
    assert.deepEqual(fs.readdirSync(target), ['main.js']);
    const outside = path.join(temp, 'outside'); fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'keep'), 'safe');
    assert.throws(() => replaceBuildDirectory(source, outside, deploy), /outside/);
    assert.equal(fs.readFileSync(path.join(outside, 'keep'), 'utf8'), 'safe');
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
test('build acceptance rejects an old account backend or frontend', () => {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wing-single-build-')));
  try {
    const backend = path.join(temp, 'backend'), frontend = path.join(temp, 'frontend');
    for (const f of ['main.js', 'modules/ai/llm/llm-client.service.js', 'modules/core/security/local-resource-policy.service.js']) {
      fs.mkdirSync(path.dirname(path.join(backend, f)), { recursive: true }); fs.writeFileSync(path.join(backend, f), '');
    }
    fs.mkdirSync(path.join(frontend, 'assets'), { recursive: true }); fs.writeFileSync(path.join(frontend, 'index.html'), '');
    assert.doesNotThrow(() => assertSingleApplication(backend, frontend));
    const old = path.join(backend, 'modules/identity/identity.service.js');
    fs.mkdirSync(path.dirname(old)); fs.writeFileSync(old, '');
    assert.throws(() => assertSingleApplication(backend, frontend), /Obsolete/);
    fs.unlinkSync(old);
    fs.writeFileSync(path.join(frontend, 'assets/old.js'), "fetch('/api/auth/login')");
    assert.throws(() => assertSingleApplication(backend, frontend), /Obsolete/);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
