const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const recovery = require('./update-recovery.cjs');
const { pruneInstalledBuild } = require('./prune-installed-build.cjs');

test('same-version reinstall removes retired code, preserves data and can restore', () => {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wing-prune-')));
  try {
    const install = path.join(temp, 'install'), transaction = path.join(temp, 'transaction');
    fs.mkdirSync(transaction); fs.mkdirSync(install);
    const old = path.join(install, '_up_/packages/backend/deploy/dist/modules/identity/identity.service.js');
    fs.mkdirSync(path.dirname(old), {recursive:true}); fs.writeFileSync(old, 'old code');
    fs.writeFileSync(path.join(install, 'SkyalyticWing.exe'), 'fixture');
    fs.mkdirSync(path.join(install, 'data')); fs.writeFileSync(path.join(install, 'data/user.txt'), 'user data');
    recovery.prepare({transactionDir:transaction,installRoot:install,executable:path.join(install,'SkyalyticWing.exe'),version:'2.0.1',dataDirs:[]});
    assert.throws(() => pruneInstalledBuild(install, transaction), /backup required/);
    recovery.phase(transaction, 'installing');
    const snapshotOld = path.join(transaction, 'snapshot-0', path.relative(install, old));
    fs.writeFileSync(snapshotOld, 'damaged backup');
    assert.throws(() => pruneInstalledBuild(install, transaction), /verification failed/);
    assert.equal(fs.readFileSync(old,'utf8'), 'old code');
    fs.writeFileSync(snapshotOld, 'old code');
    const outside = path.join(temp, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside,'keep'),'safe');
    const linked = path.join(install, '_up_/packages/backend/deploy/frontend');
    fs.symlinkSync(outside, linked, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => pruneInstalledBuild(install, transaction), /must not be a link/);
    assert.equal(fs.readFileSync(old,'utf8'), 'old code');
    fs.unlinkSync(linked);
    assert.equal(pruneInstalledBuild(install, transaction), 1);
    assert.equal(fs.existsSync(old), false);
    assert.equal(fs.readFileSync(path.join(install,'data/user.txt'),'utf8'), 'user data');
    assert.equal(fs.readFileSync(path.join(outside,'keep'),'utf8'), 'safe');
    recovery.phase(transaction, 'failed');
    recovery.restore(transaction);
    assert.equal(fs.readFileSync(old,'utf8'), 'old code');
    assert.equal(fs.readFileSync(path.join(install,'data/user.txt'),'utf8'), 'user data');
  } finally { fs.rmSync(temp,{recursive:true,force:true}); }
});
