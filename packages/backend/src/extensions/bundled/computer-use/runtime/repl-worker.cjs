// A separate process owns each chat's JavaScript state. This is not an OS security sandbox.
const vm = require('node:vm');
const ts = require('typescript');
let sequence = 0, current, running = false;
const pending = new Map();
const timers = new Set();
const call = (method, args) => new Promise((resolve, reject) => {
  if (!running || !current) { reject(new Error('The Computer Use cell has ended')); return; }
  const id = ++sequence; pending.set(id, { resolve, reject });
  process.send({ type: 'sky', id, run: current, method, args });
});
const methods = ['list_apps','list_windows','get_window','launch_app','get_window_state','activate_window','click','press_key','type_text','scroll','set_value','drag','perform_secondary_action'];
const sky = Object.freeze(Object.fromEntries([...methods.map(method => [method, args => call(method, args || {})]), ['target', 'windows']]));
const context = vm.createContext({
  __wingImport: async name => { if (name !== '@oai/sky') throw new Error('This Computer Use session only imports @oai/sky'); return { sky }; },
  nodeRepl: Object.freeze({ write: value => { if (typeof value !== 'string') throw new Error('nodeRepl.write expects a string'); process.send({ type: 'text', run: current, text: value }); } }),
  setTimeout: (callback, delay, ...args) => { const run = current; const timer = setTimeout(() => { timers.delete(timer); if (running && current === run) callback(...args); }, delay); timers.add(timer); return timer; },
  clearTimeout: timer => { timers.delete(timer); clearTimeout(timer); }, TextEncoder, TextDecoder, URL,
});
const transform = ctx => root => ts.visitNode(root, function visit(node) {
  if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) return ctx.factory.updateCallExpression(node, ctx.factory.createIdentifier('__wingImport'), node.typeArguments, node.arguments);
  return ts.visitEachChild(node, visit, ctx);
});
process.on('message', async message => {
  if (message.type === 'reply') { const p = pending.get(message.id); if (!p) return; pending.delete(message.id); message.error ? p.reject(new Error(message.error)) : p.resolve(message.value); return; }
  if (message.type !== 'run') return;
  if (running) { process.send({ type: 'done', run: message.id, error: 'A cell is already running' }); return; }
  current = message.id; running = true;
  try {
    const code = ts.transpileModule(message.code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }, transformers: { before: [transform] } }).outputText;
    await new vm.Script(`(async () => {\n${code}\n})()`, { filename: 'computer-use-cell.js' }).runInContext(context);
    // Do not let unawaited desktop RPCs survive a cell or leak into its successor.
    if (pending.size) throw new Error('Await every Computer Use API call before ending the cell');
    process.send({ type: 'done', run: current });
  } catch (error) { process.send({ type: 'done', run: current, error: error instanceof Error ? error.message : String(error) }); }
  finally { running = false; current = null; for (const timer of timers) clearTimeout(timer); timers.clear(); }
});
