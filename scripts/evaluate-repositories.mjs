import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID, createHash } from 'node:crypto';
const exec = promisify(execFile);
const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const flag = (name) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
};
const hash = (s) => createHash('sha256').update(s).digest('hex');
const cases = [
  {
    id: 'invoice-cross-file-rounding',
    prompt:
      '修复发票金额计算：所有单价先转换为整数分，再乘数量并汇总，0.1 元和 0.2 元相加应准确得到 0.3 元。保持 public API，不修改测试。',
    files: {
      'money.cjs': 'exports.cents=value=>Number(value);\n',
      'invoice.cjs':
        "const {cents}=require('./money.cjs'); exports.total=items=>items.reduce((n,i)=>n+cents(i.price)*i.quantity,0)/100;\n",
    },
    oracle: { 'money.cjs': 'exports.cents=value=>Math.round(Number(value)*100);\n' },
    test: "const {total}=require(path.join(root,'invoice.cjs')); assert.equal(total([{price:'0.1',quantity:1},{price:'0.2',quantity:1}]),0.3);assert.equal(total([{price:19.99,quantity:3}]),59.97);assert.equal(total([]),0);",
  },
  {
    id: 'cli-argument-boundaries',
    prompt:
      '修复 CLI 参数解析：--name 后的一个完整参数作为 name；-- 之后所有参数按原样作为位置参数，保留空格、以横线开头的路径和空字符串。保持 parse(argv) API，不修改测试。',
    files: {
      'parse.cjs':
        "exports.parse=argv=>({name:argv[1],files:argv.slice(2).filter(x=>!x.startsWith('-'))});\n",
      'entry.cjs':
        "const {parse}=require('./parse.cjs'); process.stdout.write(JSON.stringify(parse(process.argv.slice(2))));\n",
    },
    oracle: {
      'parse.cjs':
        "exports.parse=argv=>{const out={files:[]};let positional=false;for(let i=0;i<argv.length;i++){const a=argv[i];if(positional)out.files.push(a);else if(a==='--')positional=true;else if(a==='--name'){if(++i>=argv.length)throw new Error('name required');out.name=argv[i];}else out.files.push(a);}return out;};\n",
    },
    test: "const {parse}=require(path.join(root,'parse.cjs'));assert.deepEqual(parse(['--name','Jane Doe','--','-draft.txt','two words.txt','']),{name:'Jane Doe',files:['-draft.txt','two words.txt','']});assert.deepEqual(parse(['file']),{files:['file']});assert.throws(()=>parse(['--name']));",
  },
  {
    id: 'configuration-zero-and-false',
    prompt:
      '修复配置合并：只有 undefined 才采用默认值，显式 0、false、空字符串都需要保留；禁止修改传入的 defaults 或 input。保持 merge API，不修改测试。',
    files: {
      'config.cjs':
        'exports.merge=(defaults,input)=>{for(const k of Object.keys(defaults))defaults[k]=input[k]||defaults[k];return defaults;};\n',
      'settings.cjs': "exports.defaults={timeout:3000,enabled:true,label:'default'};\n",
    },
    oracle: {
      'config.cjs':
        'exports.merge=(defaults,input)=>{const out={...defaults};for(const [k,v] of Object.entries(input))if(v!==undefined)out[k]=v;return out;};\n',
    },
    test: "const {merge}=require(path.join(root,'config.cjs'));const {defaults}=require(path.join(root,'settings.cjs'));const before={...defaults};const input={timeout:0,enabled:false,label:''};assert.deepEqual(merge(defaults,input),input);assert.deepEqual(defaults,before);assert.deepEqual(merge(defaults,{timeout:undefined}),defaults);",
  },
];
if (process.argv.includes('--validate')) {
  if (
    new Set(cases.map((c) => c.id)).size !== cases.length ||
    cases.some((c) => !c.prompt || Object.keys(c.files).length < 2 || !c.test)
  )
    throw new Error('Invalid repository cases');
  console.log(`${cases.length} multi-file repository cases validated; no model evaluated.`);
  process.exit(0);
}
const selfTest = process.argv.includes('--self-test');
const adapterFile = flag('--adapter');
if (!selfTest && !adapterFile && !process.argv.includes('--live'))
  throw new Error('Use --validate, --self-test, --live or --adapter module.mjs');
// Model-authored code is verified in an isolated, offline container. The self-test uses only checked-in oracle code.
if (!selfTest) await exec('docker', ['info'], { windowsHide: true, timeout: 15000 });
const adapter = adapterFile
  ? (await import(pathToFileURL(resolve(adapterFile)).href)).run
  : async ({ root, prompt }) => {
      const args = [
        join(project, 'packages/cli/dist/cli.js'),
        'exec',
        prompt,
        '--cwd',
        root,
        '--json',
        ...(flag('--model') ? ['--model', flag('--model')] : []),
      ];
      const result = await exec(process.execPath, args, {
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
      });
      return { transcript: result.stdout };
    };
const runId = randomUUID(),
  results = [];
for (const task of cases) {
  const started = Date.now();
  const base = await mkdtemp(join(tmpdir(), 'wing-repo-eval-')),
    root = join(base, 'repository');
  await mkdir(root);
  for (const [name, text] of Object.entries(task.files)) await writeFile(join(root, name), text);
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ name: task.id, private: true, scripts: { test: 'node public-test.cjs' } }),
  );
  const testCode = `const assert=require('node:assert/strict'),path=require('node:path');const root=process.argv[2]||__dirname;${task.test}\nconsole.log('PASS');\n`;
  await writeFile(join(root, 'public-test.cjs'), testCode);
  await writeFile(join(base, 'acceptance.cjs'), testCode);
  await exec('git', ['init', '--quiet', root], { windowsHide: true });
  await exec('git', ['add', '.'], { cwd: root, windowsHide: true });
  await exec(
    'git',
    [
      '-c',
      'user.email=eval@example.invalid',
      '-c',
      'user.name=Wing evaluation',
      'commit',
      '--quiet',
      '-m',
      'fixture',
    ],
    { cwd: root, windowsHide: true },
  );
  const verify = async () => {
    if (selfTest)
      return exec(process.execPath, [join(base, 'acceptance.cjs'), root], {
        windowsHide: true,
        timeout: 15000,
      });
    return exec(
      'docker',
      [
        'run',
        '--rm',
        '--network=none',
        '--read-only',
        '--cap-drop=ALL',
        '--security-opt=no-new-privileges',
        '--pids-limit=64',
        '--memory=256m',
        '--cpus=1',
        '--mount',
        `type=bind,source=${root},target=/workspace,readonly`,
        '--mount',
        `type=bind,source=${join(base, 'acceptance.cjs')},target=/acceptance.cjs,readonly`,
        process.env.SKYALYTICWING_SANDBOX_IMAGE || 'node:22-bookworm-slim',
        'node',
        '/acceptance.cjs',
        '/workspace',
      ],
      { windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 },
    );
  };
  try {
    let baselineFailed = false;
    try {
      await verify();
    } catch (error) {
      if (!/AssertionError|ERR_ASSERTION/.test(String(error.stderr ?? '')))
        throw new Error('Baseline verification could not run: ' + String(error.stderr ?? error));
      baselineFailed = true;
    }
    if (!baselineFailed) throw new Error('Fixture unexpectedly passes before repair');
    const answer = selfTest ? {} : await adapter({ id: task.id, root, prompt: task.prompt });
    if (selfTest)
      for (const [name, text] of Object.entries(task.oracle))
        await writeFile(join(root, name), text);
    if (hash(await readFile(join(root, 'public-test.cjs'))) !== hash(testCode))
      throw new Error('Public tests modified');
    const verification = await verify();
    const diff = (
      await exec('git', ['diff', '--no-ext-diff', '--no-textconv', 'HEAD'], {
        cwd: root,
        windowsHide: true,
      })
    ).stdout;
    if (!diff.trim()) throw new Error('No implementation change produced');
    await writeFile(join(base, 'change.patch'), diff);
    results.push({
      id: task.id,
      passed: true,
      baselineFailed,
      durationMs: Date.now() - started,
      workspace: root,
      patch: join(base, 'change.patch'),
      verification: verification.stdout.trim(),
      usage: answer.usage ?? null,
      cost: answer.cost ?? null,
    });
  } catch (error) {
    results.push({
      id: task.id,
      passed: false,
      durationMs: Date.now() - started,
      workspace: root,
      error: String(error),
    });
  }
  console.log(`${task.id}: ${results.at(-1).passed ? 'PASS' : 'FAIL'}`);
}
const output = resolve(flag('--output') || join(project, 'build', `repository-eval-${runId}.json`));
await mkdir(dirname(output), { recursive: true });
await writeFile(
  output,
  JSON.stringify(
    {
      runId,
      mode: selfTest ? 'harness-self-test' : adapterFile ? 'adapter' : 'wing-cli-live',
      modelEvaluated: !selfTest,
      model: flag('--model') ?? null,
      results,
    },
    null,
    2,
  ),
);
console.log(output);
if (results.some((r) => !r.passed)) process.exitCode = 1;
