import { applyPatch, parsePatch } from 'diff';

type Request = (op: string, args: Record<string, unknown>) => Promise<any>;

/** Transform in memory; read and commit only through the selected remote connection. */
export async function remoteTextTool(
  name: string,
  args: any,
  request: Request,
  observed?: string | null,
) {
  if (name === 'diff') {
    const values = await Promise.all(
      [1, 2].map(async (n) => {
        const file = args?.['file' + n],
          text = args?.['text' + n];
        if (file !== undefined) {
          if (typeof file !== 'string' || !file) throw Error('Valid file path required');
          return (await request('read', { path: file })).content as string;
        }
        if (text !== undefined && typeof text !== 'string') throw Error('Text must be a string');
        return text as string | undefined;
      }),
    );
    if (values.every((v) => v === undefined)) throw Error('Provide files or text to compare');
    const left = (values[0] || '').split('\n'),
      right = (values[1] || '').split('\n');
    const out: string[] = [];
    let changes = 0;
    for (let i = 0; i < Math.max(left.length, right.length); i++) {
      if (left[i] === right[i]) continue;
      changes++;
      if (left[i] !== undefined) out.push(`- ${i + 1}: ${left[i]}`);
      if (right[i] !== undefined) out.push(`+ ${i + 1}: ${right[i]}`);
    }
    const data = {
      changes,
      diff: out.join('\n'),
      labels: {
        left: args.label1 || args.file1 || 'text1',
        right: args.label2 || args.file2 || 'text2',
      },
      lines: { left: left.length, right: right.length },
    };
    return { success: true, data, output: JSON.stringify(data) };
  }
  if (typeof args?.file_path !== 'string' || !args.file_path) throw Error('file_path required');
  const patches = args.patches ?? [],
    diff = args.unified_diff ?? '';
  if (!Array.isArray(patches) || typeof diff !== 'string' || (!patches.length && !diff))
    throw Error('Patches or unified_diff required');
  const original = await request('read', { path: args.file_path });
  const expected = args.expectedVersion ?? observed;
  if (expected !== undefined && expected !== original.revision)
    throw Error('File changed; reload before patching');
  let content: string = original.content,
    applied = 0;
  if (diff) {
    const parsed = parsePatch(diff);
    if (parsed.length !== 1 || !parsed[0]!.hunks.length)
      throw Error('A single-file unified diff is required');
    const next = applyPatch(content, parsed[0]!);
    if (next === false) throw Error('Patch context does not match; reload before patching');
    content = next;
    applied += parsed[0]!.hunks.length;
  }
  for (const p of patches) {
    if (typeof p?.search !== 'string' || !p.search || typeof p.replace !== 'string')
      throw Error('Nonempty search and string replace required');
    const index = content.indexOf(p.search);
    if (index < 0 || content.indexOf(p.search, index + 1) >= 0)
      throw Error('Patch text missing or ambiguous');
    content = content.slice(0, index) + p.replace + content.slice(index + p.search.length);
    applied++;
  }
  const saved = await request('write', {
    path: args.file_path,
    content,
    revision: original.revision,
  });
  const data = {
    applied,
    total: applied,
    file: args.file_path,
    revision: saved.revision,
    version: saved.revision,
  };
  return { success: true, data, output: JSON.stringify(data) };
}
