// 命令字符串 → argv 数组解析（execFileSync 数组化配套，防 shell 注入）
// 仅支持 execFileSync 可安全表达的语法：空白分词、单/双引号分组、&& 与 || 连接。
// 管道 |、分号 ;、重定向 <>、反引号、$(...) 等 shell 特性返回 null（fail-close）。

/** 单段命令：argv 与**与前段**的连接方式。首段 joiner 恒为占位 '&&'（不参与执行判定：
 *  执行方按 seg.joiner 短路——'&&' 前段失败跳过 / '||' 前段成功跳过）。 */
export interface CommandSegment {
  argv: string[];
  joiner: '&&' | '||';
}

/**
 * 将命令字符串拆解为段列表。
 * 例子：
 *   'git -C path log'                      → [{ argv: ['git','-C','path','log'], joiner: '&&' }]
 *   'sudo apt install -y x || sudo pacman -S x'
 *                                          → [{ argv:['sudo','apt','install','-y','x'], joiner:'&&' },
 *                                             { argv:['sudo','pacman','-S','x'], joiner:'||' }]
 *   'ls | wc -l' / 'a > b' / 'a;b'         → null
 */
export function parseCommandSegments(cmd: string): CommandSegment[] | null {
  if (!cmd || typeof cmd !== 'string') return null;

  const segments: CommandSegment[] = [];
  let argv: string[] = [];
  let token = '';
  let joiner: '&&' | '||' = '&&';
  let hasToken = false;
  let i = 0;

  const pushSegment = (): void => {
    if (argv.length > 0) segments.push({ argv, joiner });
    argv = [];
    joiner = '&&';
  };

  while (i < cmd.length) {
    const ch = cmd[i] as string;

    if (ch === "'" || ch === '"') {
      // 引号分组：内容原样保留（不展开变量/通配）
      const quote = ch;
      let j = i + 1;
      let inner = '';
      while (j < cmd.length && cmd[j] !== quote) {
        inner += cmd[j];
        j++;
      }
      if (j >= cmd.length) return null; // 未闭合引号
      token += inner;
      hasToken = true;
      i = j + 1;
      continue;
    }

    if (ch === '&' && cmd[i + 1] === '&') {
      if (!hasToken && argv.length === 0) return null; // 空段
      if (token) argv.push(token);
      token = '';
      hasToken = false;
      pushSegment();
      joiner = '&&';
      i += 2;
      continue;
    }
    if (ch === '|' && cmd[i + 1] === '|') {
      if (!hasToken && argv.length === 0) return null;
      if (token) argv.push(token);
      token = '';
      hasToken = false;
      pushSegment();
      joiner = '||';
      i += 2;
      continue;
    }

    // 不支持的 shell 特性（单管道/分号/重定向/命令替换/反引号）
    if (
      ch === '|' ||
      ch === ';' ||
      ch === '<' ||
      ch === '>' ||
      ch === '`' ||
      (ch === '$' && cmd[i + 1] === '(')
    ) {
      return null;
    }

    if (/\s/.test(ch)) {
      if (token) {
        argv.push(token);
        token = '';
        hasToken = false;
      }
      i++;
      continue;
    }

    token += ch;
    hasToken = true;
    i++;
  }

  if (token) argv.push(token);
  pushSegment();

  return segments.length > 0 ? segments : null;
}
