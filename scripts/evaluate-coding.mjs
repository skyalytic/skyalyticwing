import { readFile, writeFile, mkdtemp, chmod } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify, isDeepStrictEqual } from 'node:util';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const exec = promisify(execFile);
const cases = JSON.parse(
  await readFile(new URL('../evals/coding-cases.json', import.meta.url), 'utf8'),
);
const flag = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
if (process.argv.includes('--validate')) {
  if (
    new Set(cases.map((c) => c.id)).size !== cases.length ||
    cases.some((c) => !c.prompt || !c.tests?.length)
  )
    throw new Error('Invalid benchmark dataset');
  console.log(
    `${cases.length} coding tasks / ${cases.reduce((sum, c) => sum + c.tests.length, 0)} assertions validated; no model was evaluated.`,
  );
  process.exit(0);
}
const adapterPath = flag('--adapter');
if (!adapterPath && !process.argv.includes('--live'))
  throw new Error(
    'Use --validate, --live, or --adapter path. Live runs consume configured model quota.',
  );
await exec('docker', ['info'], { timeout: 15000, windowsHide: true });
const adapter = adapterPath
  ? (await import(pathToFileURL(resolve(adapterPath)).href)).run
  : async (task) => {
      const response = await fetch(
        `${process.env.SKY_EVAL_URL || 'http://127.0.0.1:910'}/api/chat/send`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${process.env.SKYALYTICWING_AUTH_TOKEN || ''}`,
          },
          body: JSON.stringify({
            session: `eval-${randomUUID()}`,
            message: `${task.prompt}\n只返回 JavaScript ESM 源代码，不调用工具，不写文件。`,
            ...(process.env.SKY_EVAL_MODEL ? { model: process.env.SKY_EVAL_MODEL } : {}),
          }),
          signal: AbortSignal.timeout(180000),
        },
      );
      const body = await response.json();
      if (!response.ok || !body.success) throw new Error(body.error || `HTTP ${response.status}`);
      return { code: body.data.message.content, usage: body.data.usage };
    };
const results = [];
const runId = randomUUID();
for (const task of cases) {
  const started = Date.now();
  let result;
  const name = `sky-eval-${randomUUID()}`;
  try {
    // Expected outputs are never sent to the model adapter.
    const answer = await adapter({ id: task.id, prompt: task.prompt });
    const code = answer.code
      .trim()
      .replace(/^```(?:javascript|js|mjs)?\s*\n/, '')
      .replace(/\n```\s*$/, '');
    const dir = await mkdtemp(join(tmpdir(), 'sky-eval-'));
    await chmod(dir, 0o755);
    await writeFile(join(dir, 'solution.mjs'), code);
    await writeFile(join(dir, 'inputs.json'), JSON.stringify(task.tests.map((t) => t.input)));
    await writeFile(
      join(dir, 'runner.mjs'),
      `import { solve } from './solution.mjs'; import fs from 'node:fs'; const inputs = JSON.parse(fs.readFileSync('/workspace/inputs.json')); const output=[]; for (const input of inputs) output.push(await solve(input)); process.stdout.write('\\nSKY_RESULTS='+JSON.stringify(output)+'\\n');`,
    );
    const { stdout } = await exec(
      'docker',
      [
        'run',
        '--rm',
        '--name',
        name,
        '--network=none',
        '--read-only',
        '--cap-drop=ALL',
        '--security-opt=no-new-privileges',
        '--pids-limit=64',
        '--memory=256m',
        '--cpus=1',
        '--user=1000:1000',
        '--mount',
        `type=bind,source=${dir},target=/workspace,readonly`,
        '-w',
        '/workspace',
        process.env.SKYALYTICWING_SANDBOX_IMAGE || 'node:22-bookworm-slim',
        'node',
        'runner.mjs',
      ],
      { timeout: 15000, maxBuffer: 1024 * 1024, windowsHide: true },
    );
    const output = JSON.parse(
      stdout
        .split('\n')
        .find((l) => l.startsWith('SKY_RESULTS='))
        ?.slice(12) || 'null',
    );
    result = {
      id: task.id,
      passed: isDeepStrictEqual(
        output,
        task.tests.map((t) => t.expected),
      ),
      usage: answer.usage ?? null,
      cost: answer.cost ?? null,
      interventions: answer.interventions ?? null,
    };
  } catch (error) {
    result = { id: task.id, passed: false, error: String(error) };
  } finally {
    await exec('docker', ['rm', '-f', name], { timeout: 5000, windowsHide: true }).catch(
      () => undefined,
    );
  }
  results.push({ ...result, durationMs: Date.now() - started });
  console.log(`${task.id}: ${result.passed ? 'PASS' : 'FAIL'}`);
}
const output = resolve(flag('--output') || `coding-eval-${runId}.json`);
await writeFile(
  output,
  JSON.stringify(
    {
      runId,
      at: new Date().toISOString(),
      node: process.version,
      model: process.env.SKY_EVAL_MODEL || null,
      adapter: adapterPath || 'skyalyticwing',
      successRate: results.filter((r) => r.passed).length / results.length,
      results,
    },
    null,
    2,
  ),
);
console.log(output);
