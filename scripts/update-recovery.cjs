/* Runs from a private directory outside the installation, using a copied Node binary.
 * No network, no shell, no dependency on the new app being able to start. */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const registryKeys = ['HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\SkyalyticWing','HKCU\\Software\\skyalyticwing\\SkyalyticWing'];
function editionSpec(edition) {
  if (!edition) return null;
  if (!['community', 'enterprise'].includes(edition)) throw Error('Invalid recovery edition');
  const suffix = edition === 'community' ? 'Community' : 'Enterprise';
  return { identifier: 'com.skyalyticwing.' + edition, binary: 'SkyalyticWing' + suffix, product: 'SkyalyticWing ' + suffix };
}
function registriesFor(journal) {
  const spec = editionSpec(journal.edition);
  return spec ? registryKeys.map(key => key.replace(/SkyalyticWing$/, spec.product)) : registryKeys;
}
const recoveryName = journal => 'SkyalyticWingUpdateRecovery' + (journal.edition ? '-' + journal.edition : '');
function atomic(file, data) {
  const tmp = file + '.tmp-' + crypto.randomUUID();
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  const fd = fs.openSync(tmp, 'r+'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const inside = (root, file) => { const rel = path.relative(root, file); return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel)); };
function safeRoot(input) {
  const absolute = path.resolve(input);
  if (absolute === path.parse(absolute).root || absolute === os.homedir()) throw Error('Refusing a filesystem/user root as update target');
  const real = fs.realpathSync(absolute);
  if ((process.platform === 'win32' ? real.toLowerCase() !== absolute.toLowerCase() : real !== absolute)) throw Error('Update target must not be a symlink/junction');
  return real;
}
function entries(root, relative = '') {
  const full = path.join(root, relative), stat = fs.lstatSync(full);
  if (stat.isSymbolicLink()) return [{ name: relative, link: fs.readlinkSync(full), mode: stat.mode }];
  if (stat.isDirectory()) return [{ name: relative, directory: true, mode: stat.mode }, ...fs.readdirSync(full).sort().flatMap(name => entries(root, path.join(relative, name)))];
  if (!stat.isFile()) throw Error('Unsupported special file in backup: ' + full);
  const hash = crypto.createHash('sha256'), fd = fs.openSync(full, 'r'), buffer = Buffer.alloc(1024 * 1024);
  try { for (let n; (n = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0;) hash.update(buffer.subarray(0, n)); } finally { fs.closeSync(fd); }
  return [{ name: relative, bytes: stat.size, sha256: hash.digest('hex'), mode: stat.mode }];
}
function verify(root, expected) {
  if (JSON.stringify(entries(root)) !== JSON.stringify(expected)) throw Error('Snapshot verification failed: ' + root);
}
function userDataDirs() {
  const fallback = process.platform === 'win32' ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData/Roaming'), 'SkyalyticWing')
    : process.platform === 'darwin' ? path.join(os.homedir(), 'Library/Application Support/SkyalyticWing')
      : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'skyalyticwing');
  const dirs = [process.env.SKYALYTICWING_DATA_DIR || process.env.SKYALYTICCLAW_DATA_DIR || fallback, process.env.SKYALYTICWING_WEB_DATA_DIR];
  return [...new Set(dirs.filter(Boolean).map(p => path.resolve(p)))].filter(p => fs.existsSync(p)).filter((p, i, all) => !all.some((other, j) => j !== i && inside(other, p)));
}
function prepare(request) {
  const dir = safeRoot(request.transactionDir);
  const journalPath = path.join(dir, 'journal.json');
  if (fs.existsSync(journalPath)) throw Error('Transaction already exists');
  const install = safeRoot(request.installRoot);
  const targets = [install, ...(request.dataDirs || userDataDirs()).map(safeRoot)];
  for (const target of targets) {
    if (inside(target, dir) || inside(dir, target)) throw Error('Backup and targets must be separate');
    if (targets.some(other => other !== target && (inside(other, target) || inside(target, other)))) throw Error('Overlapping application/data paths');
  }
  // Check writability before spending time on a snapshot. Never require elevation mid-update.
  for (const target of targets) fs.accessSync(path.dirname(target), fs.constants.W_OK);
  const plans = targets.map((target, index) => ({ target, snapshot: path.join(dir, `snapshot-${index}`), entries: entries(target), state: 'pending' }));
  const bytes = plans.reduce((n, p) => n + p.entries.reduce((total, item) => total + (item.bytes || 0), 0), 0);
  const disk = fs.statfsSync(dir);
  if (disk.bavail * disk.bsize < bytes * 2 + 256 * 1024 * 1024) throw Error('磁盘空间不足，无法创建并验证更新备份');
  for (const plan of plans) {
    fs.cpSync(plan.target, plan.snapshot, { recursive: true, dereference: false, verbatimSymlinks: true, preserveTimestamps: true, errorOnExist: true, force: false });
    verify(plan.snapshot, plan.entries);
  }
  const node = path.join(dir, process.platform === 'win32' ? 'recovery-node.exe' : 'recovery-node');
  fs.copyFileSync(process.execPath, node); fs.chmodSync(node, 0o700);
  fs.copyFileSync(__filename, path.join(dir, 'recovery.cjs'));
  editionSpec(request.edition);
  const journal = { schema: 1, edition: request.edition || null, id: path.basename(dir), status: 'prepared', version: request.version, previousVersion: request.previousVersion,
    executable: path.resolve(request.executable), parentPid: request.parentPid || 0, systemIntegration: request.systemIntegration === true, createdAt: Date.now(), plans };
  if (!inside(install, journal.executable) && install !== journal.executable) throw Error('Executable is outside application backup');
  if (journal.systemIntegration && process.platform === 'win32') {
    journal.registries = registriesFor(journal).map((key,index) => {
      try { execFileSync('reg.exe',['query',key],{windowsHide:true,stdio:'pipe'}); }
      catch (error) { if(error.status===1)return null; throw error; }
      const file=path.join(dir,`registry-${index}.reg`);
      execFileSync('reg.exe',['export',key,file,'/y'],{windowsHide:true,stdio:'pipe'});
      return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    });
  }
  atomic(journalPath, journal);
  atomic(path.join(path.dirname(dir), 'pending.json'), { transactionDir: dir });
  return journal;
}
function load(dir) {
  dir = safeRoot(dir);
  const journal = read(path.join(dir, 'journal.json'));
  if (journal.schema !== 1 || journal.id !== path.basename(dir) || !Array.isArray(journal.plans)) throw Error('Invalid recovery journal');
  if (!journal.plans.length || typeof journal.executable !== 'string' || !inside(journal.plans[0].target, journal.executable)) throw Error('Invalid recovery executable');
  for (let i = 0; i < journal.plans.length; i++) {
    const plan = journal.plans[i];
    if (plan.snapshot !== path.join(dir, `snapshot-${i}`) || !path.isAbsolute(plan.target) || inside(plan.target, dir) || inside(dir, plan.target) || plan.target === path.parse(plan.target).root || plan.target === os.homedir()) throw Error('Unsafe recovery path');
  }
  return journal;
}
function phase(dir, status, pid) {
  if (!['installing', 'installed', 'failed', 'cancelled'].includes(status)) throw Error('Invalid update phase');
  const journal = load(dir);
  if (['committed', 'rolled-back'].includes(journal.status)) return;
  journal.status = status;
  if (pid) journal.installerPid = Number(pid);
  atomic(path.join(dir, 'journal.json'), journal);
  if (status === 'cancelled') unregisterRecovery(dir, journal);
}
function healthy(dir, version, pid) {
  const journal = load(dir);
  if (journal.version !== version || !['installed', 'installing', 'prepared'].includes(journal.status)) return;
  atomic(path.join(dir, 'healthy.json'), { version, at: Date.now(), pid: Number(pid) });
}
function alive(pid) { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } }
function restore(dir) {
  const journal = load(dir);
  const registryKeys = registriesFor(journal);
  if (!['failed', 'restoring', 'recovery-required'].includes(journal.status)) throw Error('Transaction is not eligible for rollback');
  // Verify every snapshot before touching any target. Corrupt backup means leave current files alone.
  for (const plan of journal.plans) verify(plan.snapshot, plan.entries);
  if (journal.registries) {
    if (!journal.systemIntegration || process.platform!=='win32' || journal.registries.length!==registryKeys.length) throw Error('Invalid registry backup');
    journal.registries.forEach((hash,index)=>{if(hash && crypto.createHash('sha256').update(fs.readFileSync(path.join(dir,`registry-${index}.reg`))).digest('hex')!==hash)throw Error('Registry snapshot verification failed');});
  }
  journal.status = 'restoring'; atomic(path.join(dir, 'journal.json'), journal);
  for (const plan of journal.plans) {
    if (plan.state === 'restored') { verify(plan.target, plan.entries); continue; }
    const staging = plan.target + '.wing-restore-' + journal.id;
    const failed = plan.target + '.wing-failed-' + journal.id;
    // These are exact siblings recorded by this transaction, never globbed or recursively deleted.
    if (fs.existsSync(staging)) {
      try { verify(staging, plan.entries); }
      catch { fs.renameSync(staging, staging + '.partial-' + crypto.randomUUID()); }
    }
    if (!fs.existsSync(staging)) {
      fs.cpSync(plan.snapshot, staging, { recursive: true, dereference: false, verbatimSymlinks: true, preserveTimestamps: true, errorOnExist: true, force: false });
    }
    verify(staging, plan.entries);
    if (!fs.existsSync(failed) && fs.existsSync(plan.target)) {
      safeRoot(plan.target); fs.renameSync(plan.target, failed);
    }
    if (fs.existsSync(plan.target)) {
      // A crash may have occurred between the atomic rename and journal write.
      verify(plan.target, plan.entries);
    } else fs.renameSync(staging, plan.target);
    plan.state = 'restored'; atomic(path.join(dir, 'journal.json'), journal);
  }
  if(journal.registries) journal.registries.forEach((hash,index)=>{
    if(hash) execFileSync('reg.exe',['import',path.join(dir,`registry-${index}.reg`)],{windowsHide:true,stdio:'pipe'});
    else {
      try { execFileSync('reg.exe',['query',registryKeys[index]],{windowsHide:true,stdio:'pipe'}); }
      catch(error) { if(error.status===1)return; throw error; }
      execFileSync('reg.exe',['delete',registryKeys[index],'/f'],{windowsHide:true,stdio:'pipe'});
    }
  });
  journal.status = 'rolled-back'; journal.finishedAt = Date.now(); atomic(path.join(dir, 'journal.json'), journal);
  return journal;
}
function startWatch(dir) {
  registerRecovery(dir, load(dir));
  const node = path.join(dir, process.platform === 'win32' ? 'recovery-node.exe' : 'recovery-node');
  const log = fs.openSync(path.join(dir, 'recovery.log'), 'a', 0o600);
  const child = spawn(node, [path.join(dir, 'recovery.cjs'), 'watch', dir], { detached: true, windowsHide: true, cwd: dir, stdio: ['ignore', log, log] });
  child.unref(); fs.closeSync(log);
}
function recoveryRegistration(journal) {
  const suffix = journal.edition ? '-' + journal.edition : '';
  if (process.platform === 'darwin') return path.join(os.homedir(),`Library/LaunchAgents/com.skyalyticwing.update-recovery${suffix}.plist`);
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(),'.config'),`autostart/skyalyticwing-update-recovery${suffix}.desktop`);
}
function registerRecovery(dir, journal) {
  if (!journal.systemIntegration || ['committed','cancelled','rolled-back'].includes(journal.status)) return;
  const node=path.join(dir,process.platform==='win32'?'recovery-node.exe':'recovery-node'), script=path.join(dir,'recovery.cjs');
  if(process.platform==='win32') {
    const literal=v=>"'"+v.replace(/'/g,"''")+"'";
    const command=`powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -Command "& ${literal(node)} ${literal(script)} watch ${literal(dir)}"`;
    execFileSync('reg.exe',['add','HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce','/v',recoveryName(journal),'/t','REG_SZ','/d',command,'/f'],{windowsHide:true,stdio:'pipe'});
  } else {
    const file=recoveryRegistration(journal); fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
    const xml=value=>value.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
    const quote=value=>'"'+value.replace(/[\\"`$]/g,c=>'\\'+c)+'"';
    fs.writeFileSync(file,process.platform==='darwin'
      ? `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>com.skyalyticwing.update-recovery${journal.edition ? '-' + journal.edition : ''}</string><key>ProgramArguments</key><array>${[node,script,'watch',dir].map(v=>'<string>'+xml(v)+'</string>').join('')}</array><key>RunAtLoad</key><true/></dict></plist>`
      : `[Desktop Entry]\nType=Application\nName=Wing update recovery\nExec=${[node,script,'watch',dir].map(quote).join(' ')}\nNoDisplay=true\n`,{mode:0o600});
  }
}
function unregisterRecovery(dir, journal) {
  if(!journal.systemIntegration)return;
  try {
    if(process.platform==='win32') {
      const key='HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce';
      const value=execFileSync('reg.exe',['query',key,'/v',recoveryName(journal)],{windowsHide:true,encoding:'utf8',stdio:['ignore','pipe','pipe']});
      if(value.includes(dir)) execFileSync('reg.exe',['delete',key,'/v',recoveryName(journal),'/f'],{windowsHide:true,stdio:'pipe'});
    } else {
      const file=recoveryRegistration(journal); if(fs.existsSync(file)&&fs.readFileSync(file,'utf8').includes(journal.id))fs.unlinkSync(file);
    }
  } catch { /* A consumed RunOnce entry is already removed by Windows. */ }
}
async function watch(dir) {
  // Exclusive watcher. PID liveness lets a later launch recover after power loss.
  const lock = path.join(dir, 'watcher.json');
  if (fs.existsSync(lock)) {
    try {
      const previous = read(lock);
      if (alive(previous.pid)) return;
      if (read(lock).pid !== previous.pid) return;
      fs.unlinkSync(lock);
    } catch { return; }
  }
  try { fs.writeFileSync(lock, JSON.stringify({ pid: process.pid }), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code === 'EEXIST') return; throw error; }
  let launched = false, healthySince = 0;
  const deadline = Date.now() + 15 * 60_000;
  try {
    for (;;) {
      let journal = load(dir);
      if (['cancelled', 'committed', 'rolled-back'].includes(journal.status)) { unregisterRecovery(dir,journal); return; }
      const sameBoot = journal.createdAt >= Date.now() - os.uptime()*1000 - 5000;
      const parentAlive = sameBoot && alive(journal.parentPid), installerAlive = sameBoot && alive(journal.installerPid);
      let healthyNow = false;
      if (fs.existsSync(path.join(dir, 'healthy.json'))) {
        const ack = read(path.join(dir, 'healthy.json'));
        if (ack.version === journal.version && ack.at >= journal.createdAt && alive(ack.pid) && !parentAlive && !installerAlive) {
          healthyNow = true;
          healthySince ||= Date.now();
          if (Date.now() - healthySince >= 10_000) {
            journal.status = 'committed'; journal.finishedAt = Date.now(); atomic(path.join(dir, 'journal.json'), journal); unregisterRecovery(dir,journal); return;
          }
        }
      }
      if (!healthyNow) healthySince = 0;
      if (!parentAlive && !installerAlive && journal.status === 'installed' && !launched && !healthySince) {
        launched = true;
        const child = spawn(journal.executable, [], { detached: true, windowsHide: true, stdio: 'ignore', cwd: path.dirname(journal.executable) });
        child.on('error', () => {}); child.unref();
      }
      if (!parentAlive && !installerAlive && (['failed','restoring','recovery-required'].includes(journal.status) || Date.now() > deadline)) {
        if (healthySince) continue;
        phase(dir, 'failed');
        try {
          journal = restore(dir);
          unregisterRecovery(dir,journal);
          const child = spawn(journal.executable, [], { detached: true, windowsHide: true, stdio: 'ignore', cwd: path.dirname(journal.executable) });
          child.on('error', () => {}); child.unref();
        } catch (error) {
          journal = load(dir); journal.status = 'recovery-required'; journal.error = String(error); atomic(path.join(dir, 'journal.json'), journal);
          console.error('Automatic restore could not finish. Snapshots and failed version were retained:', String(error));
        }
        return;
      }
      // Never replace files underneath a live installer or application.
      if (Date.now() > deadline && (parentAlive || installerAlive)) {
        journal.status = 'recovery-required'; journal.error = '程序或安装器仍在运行，保留备份，等待退出后恢复'; atomic(path.join(dir, 'journal.json'), journal); return;
      }
      await sleep(1000);
    }
  } finally { atomic(lock, { pid: 0 }); }
}
module.exports = { prepare, restore, phase, healthy, load, verify, entries, safeRoot, userDataDirs, startWatch, watch };
if (require.main === module) (async () => {
  const [command, argument, value, pid] = process.argv.slice(2);
  if (command === 'prepare') prepare(read(argument));
  else if (command === 'phase') phase(argument, value, pid);
  else if (command === 'healthy') healthy(argument, value, pid);
  else if (command === 'restore') restore(argument);
  else if (command === 'start-watch') startWatch(argument);
  else if (command === 'watch') await watch(argument);
  else if (command === 'manual') {
    const installRoot = safeRoot(argument), id = crypto.randomUUID();
    const manifest = path.join(installRoot, '_up_/packages/backend/deploy/product-edition.json');
    const edition = fs.existsSync(manifest) ? read(manifest).edition : null;
    const spec = editionSpec(edition);
    if (spec) {
      process.env.SKYALYTICWING_DATA_DIR = path.join(process.env.APPDATA, spec.binary);
      delete process.env.SKYALYTICWING_WEB_DATA_DIR;
    }
    const dir = path.join(process.env.LOCALAPPDATA, spec?.identifier || 'com.skyalyticwing.desktop', 'updates', id);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    prepare({ edition, transactionDir: dir, installRoot, executable: path.join(installRoot, (spec?.binary || 'SkyalyticWing') + '.exe'), version: value, previousVersion: 'manual', parentPid: 0, systemIntegration: true });
    phase(dir, 'installing', pid); startWatch(dir); process.stdout.write(dir);
  } else throw Error('Unknown recovery command');
})().catch(error => { console.error(String(error)); process.exitCode = 1; });
