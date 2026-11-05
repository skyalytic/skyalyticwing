'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const marker = '# SkyalyticWing managed CLI: ';
const begin = '# >>> SkyalyticWing CLI >>>';
const end = '# <<< SkyalyticWing CLI <<<';
const profiles = ['.profile', '.bashrc', '.bash_profile', '.zshrc', '.zprofile', '.config/fish/config.fish'];
const supportedCommands = ['skyalyticwing', 'wing', 'wing-community', 'wing-enterprise'];
function commands(options = {}) {
  const product = require('./product-edition.cjs').product();
  const values = options.commands || (options.command ? [options.command] : [product?.cliCommand || 'skyalyticwing', ...(product?.cliAliases || [])]);
  if (!Array.isArray(values) || !values.length || values.some(v => !supportedCommands.includes(v))) throw Error('Invalid CLI command');
  return [...new Set(values)];
}
function registration(options = {}) {
  const home = options.home || os.homedir();
  const image = options.image ?? process.env.APPIMAGE;
  const bin = options.bin || __dirname;
  const owner = path.resolve(image || bin);
  const dir = path.join(home, '.local', 'bin');
  const command = options.command || require('./product-edition.cjs').product()?.cliCommand || 'skyalyticwing';
  if (!supportedCommands.includes(command)) throw Error('Invalid CLI command');
  const file = path.join(dir, command);
  const signature = marker + Buffer.from(owner).toString('base64');
  const content = image
    ? `#!/bin/sh\n${signature}\nexec ${quote(owner)} --wing-cli "$@"\n`
    : `#!/bin/sh\n${signature}\nexec ${quote(options.node || process.execPath)} ${quote(path.join(bin, 'skyalyticwing.cjs'))} "$@"\n`;
  return {home, dir, file, signature, content};
}
function owned(file, signature) {
  if (!fs.existsSync(file)) return false;
  if (fs.lstatSync(file).isSymbolicLink()) return false;
  return fs.readFileSync(file, 'utf8').split('\n')[1] === signature;
}
function stripBlock(text) {
  return text.replace(/# >>> SkyalyticWing CLI >>>\r?\n[\s\S]*?# <<< SkyalyticWing CLI <<<\r?\n?/g, '');
}
function installOne(options = {}) {
  const state = registration(options);
  if (fs.existsSync(state.file)) {
    if (fs.lstatSync(state.file).isSymbolicLink() || !fs.readFileSync(state.file, 'utf8').split('\n')[1]?.startsWith(marker))
      throw Error('Existing skyalyticwing command is not managed by Wing: ' + state.file);
  }
  fs.mkdirSync(state.dir, {recursive:true});
  fs.writeFileSync(state.file, state.content, {mode:0o755});
  fs.chmodSync(state.file, 0o755);
  // All common login/non-login shells use the same guarded PATH block.
  for (const name of profiles) {
    const file = path.join(state.home, name);
    // Creating .bash_profile would stop bash from loading an existing .profile.
    // When it is absent, the managed .profile block already covers login shells.
    if (name === '.bash_profile' && !fs.existsSync(file)) continue;
    const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    const block = name.endsWith('.fish')
      ? `${begin}\nif not contains -- "$HOME/.local/bin" $PATH\n  set -gx PATH "$HOME/.local/bin" $PATH\nend\n${end}\n`
      : `${begin}\ncase ":$PATH:" in\n  *":$HOME/.local/bin:"*) ;;\n  *) export PATH="$HOME/.local/bin:$PATH" ;;\nesac\n${end}\n`;
    if (text.includes(block)) continue;
    fs.mkdirSync(path.dirname(file), {recursive:true});
    fs.writeFileSync(file, stripBlock(text).replace(/\n?$/, '\n') + block);
  }
  return state.file;
}
function uninstallOne(options = {}) {
  const state = registration(options);
  // An older installation must not remove a newer installation's command.
  if (!owned(state.file, state.signature)) return false;
  fs.unlinkSync(state.file);
  // All editions use ~/.local/bin; keep the shared PATH entry while any sibling remains.
  if (supportedCommands.some(name => fs.existsSync(path.join(state.dir, name)))) return true;
  for (const name of profiles) {
    const file = path.join(state.home, name);
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, stripBlock(text));
  }
  return true;
}
function install(options = {}) {
  const names = commands(options);
  for (const command of names) {
    const state = registration({...options, command});
    if (fs.existsSync(state.file) && (fs.lstatSync(state.file).isSymbolicLink() ||
      !fs.readFileSync(state.file,'utf8').split('\n')[1]?.startsWith(marker))) throw Error('Existing command is not managed by Wing: '+state.file);
  }
  return names.map(command => installOne({...options, command}))[0];
}
function uninstall(options = {}) {
  return commands(options).map(command => uninstallOne({...options, command})).some(Boolean);
}
function windowsState(options = {}) {
  const bin = path.resolve(options.bin || __dirname);
  const dispatcher = path.join(bin,'skyalyticwing.cjs');
  const node = options.node || path.resolve(bin,'../../../..','node.exe');
  const signature = '@rem SkyalyticWing managed CLI: '+Buffer.from(bin).toString('base64');
  // cmd.exe reads batch files in the current console code page. Switch before
  // parsing UTF-8 paths, then restore the caller's code page and CLI exit code.
  const content = ['@echo off',signature,'setlocal DisableDelayedExpansion',
    `for /f "tokens=2 delims=:" %%C in ('chcp') do set "_WING_CODEPAGE=%%C"`,
    'chcp 65001 >nul',
    '"'+node.replaceAll('%','%%')+'" "'+dispatcher.replaceAll('%','%%')+'" %*',
    'set "_WING_EXIT=%ERRORLEVEL%"',
    'if defined _WING_CODEPAGE chcp %_WING_CODEPAGE% >nul',
    'exit /b %_WING_EXIT%',''].join('\r\n');
  const npmDir = options.npmDir || path.join(process.env.APPDATA || '', 'npm');
  const dirs = [bin, ...(fs.existsSync(npmDir) ? [npmDir] : [])];
  return {node,dispatcher,signature,content,files:dirs.flatMap(dir=>commands(options).map(name=>path.join(dir,name+'.cmd')))};
}
function ownsWindows(file, state) {
  if (!fs.existsSync(file) || fs.lstatSync(file).isSymbolicLink()) return false;
  const content = fs.readFileSync(file,'utf8');
  return content.split(/\r?\n/)[1] === state.signature ||
    content.toLowerCase().includes('"'+state.dispatcher.toLowerCase()+'"') ||
    (path.dirname(file) === path.dirname(state.dispatcher) && content.includes('"%~dp0skyalyticwing.cjs"'));
}
function installWindows(options = {}) {
  const state = windowsState(options);
  if (!fs.existsSync(state.node)) throw Error('Bundled CLI runtime is missing: '+state.node);
  for (const file of state.files) if (fs.existsSync(file) && !ownsWindows(file,state))
    throw Error('Existing command belongs to another installation: '+file);
  for (const file of state.files) { fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,state.content); }
  return state.files;
}
function uninstallWindows(options = {}) {
  const state = windowsState(options);
  for (const file of state.files) if (ownsWindows(file,state)) fs.unlinkSync(file);
}
module.exports = {install, uninstall, installWindows, uninstallWindows};
