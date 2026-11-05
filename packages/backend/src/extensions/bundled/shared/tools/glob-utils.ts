/**
 * 将 glob 模式转换为 RegExp。
 *
 * 支持：单星号（不含路径分隔符）、双星号（含路径分隔符，跨目录）、
 * 问号、{a,b} 字符组、[abc] 字符类。其余正则元字符会被转义。
 * 不依赖 minimatch，保持零额外依赖。
 *
 * 示例：
 *   globToRegExp('*.ts')     -> /^[^/\\]*\.ts$/
 *   globToRegExp('src/*.ts') -> /^src[/\\][^/\\]*\.ts$/
 *   globToRegExp('{a,b}.ts') -> /^(?:a|b)\.ts$/
 */
export function globToRegExp(pattern: string): RegExp {
  if (typeof pattern !== 'string' || pattern.length === 0) {
    return new RegExp('');
  }
  let re = '';
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    switch (c) {
      case '*': {
        // 检测 **
        if (pattern[i + 1] === '*') {
          i += 2;
          // **/ -> 匹配任意层级目录（含空）
          if (pattern[i] === '/') {
            i += 1;
            re += '(?:.*/)?';
          } else {
            re += '.*';
          }
          continue;
        }
        // 单 *：匹配除路径分隔符外的任意字符
        re += '[^/\\\\]*';
        i += 1;
        continue;
      }
      case '?':
        re += '[^/\\\\]';
        i += 1;
        continue;
      case '.': {
        re += '\\.';
        i += 1;
        continue;
      }
      case '{': {
        // 字符组 {a,b,c}
        const end = pattern.indexOf('}', i + 1);
        if (end === -1) {
          re += '\\{';
          i += 1;
          continue;
        }
        const inner = pattern.slice(i + 1, end);
        const opts = inner
          .split(',')
          .map((o) => escapeRegex(o))
          .join('|');
        re += `(?:${opts})`;
        i = end + 1;
        continue;
      }
      case '[': {
        // 字符类，原样保留到 ]
        const end = pattern.indexOf(']', i + 1);
        if (end === -1) {
          re += '\\[';
          i += 1;
          continue;
        }
        re += pattern.slice(i, end + 1);
        i = end + 1;
        continue;
      }
      default:
        re += escapeRegex(c);
        i += 1;
        continue;
    }
  }
  return new RegExp(`^${re}$`);
}

function escapeRegex(s: string): string {
  return s.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}
