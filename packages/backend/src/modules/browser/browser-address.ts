/** Address-bar navigation: domestic search by default; never treat words as a host. */
export function browserAddress(input: string): string {
  const raw = (input || '').trim();
  if (!raw) return 'about:blank';
  if (raw === 'about:blank') return raw;
  if (/^(https?|file):\/\//i.test(raw)) return new URL(raw).href;
  if (
    /^(?:javascript|data|vbscript|about|chrome|edge|intent|mailto|tel|https?|file):/i.test(raw) ||
    /^[a-z][a-z\d+.-]*:\/\//i.test(raw) ||
    /^[a-z]:[\\/]/i.test(raw)
  )
    throw new Error('仅支持 http、https 和已授权的本地文件');
  const host = raw.split(/[/?#]/)[0]!;
  if (
    !/\s/.test(raw) &&
    (/^localhost(?::\d+)?$/i.test(host) ||
      /^\[[:\da-f]+\](?::\d+)?$/i.test(host) ||
      /^\d{1,3}(\.\d{1,3}){3}(?::\d+)?$/.test(host))
  )
    return new URL(`http://${raw}`).href;
  if (!/\s/.test(raw) && /^(?:[\p{L}\p{N}-]+\.)+[\p{L}]{2,}(?::\d+)?$/u.test(host))
    return new URL(`https://${raw}`).href;
  return `https://www.baidu.com/s?wd=${encodeURIComponent(raw)}`;
}
