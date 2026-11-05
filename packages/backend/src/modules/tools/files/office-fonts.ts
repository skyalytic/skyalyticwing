import { existsSync, realpathSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';

// Use only a small, known set of locally installed fonts. Never copy proprietary
// system fonts into a release, or accept a client-supplied filesystem path.
const known = [
  { family: 'SimSun', label: '宋体', files: ['simsun.ttc'] },
  { family: 'SimHei', label: '黑体', files: ['simhei.ttf'] },
  { family: 'KaiTi', label: '楷体', files: ['simkai.ttf'] },
  { family: 'FangSong', label: '仿宋', files: ['simfang.ttf'] },
  { family: 'Microsoft YaHei', label: '微软雅黑', files: ['msyh.ttc', 'msyhbd.ttc'] },
  { family: 'Songti SC', label: '宋体（简）', files: ['Songti.ttc'] },
  { family: 'Heiti SC', label: '黑体（简）', files: ['STHeiti Light.ttc', 'STHeiti Medium.ttc'] },
  { family: 'Kaiti SC', label: '楷体（简）', files: ['Kaiti.ttc'] },
  { family: 'STFangsong', label: '华文仿宋', files: ['STFangsong.ttf'] },
  { family: 'PingFang SC', label: '苹方（简）', files: ['PingFang.ttc'] },
  { family: 'WenQuanYi Micro Hei', label: '文泉驿微米黑', files: ['wqy-microhei.ttc'] },
];
export function officeFontRoots(platform: NodeJS.Platform = process.platform) {
  if (platform === 'win32') return [join(process.env['SystemRoot'] || 'C:\\Windows', 'Fonts'), join(process.env['LOCALAPPDATA'] || join(homedir(), 'AppData/Local'), 'Microsoft/Windows/Fonts')];
  if (platform === 'darwin') return ['/System/Library/Fonts', '/System/Library/Fonts/Supplemental', '/Library/Fonts', join(homedir(), 'Library/Fonts')];
  return ['/usr/share/fonts/truetype/wqy', '/usr/share/fonts/truetype/msttcorefonts', '/usr/share/fonts/truetype/msttcore', '/usr/local/share/fonts', join(homedir(), '.local/share/fonts'), join(homedir(), '.fonts')];
}
export interface OfficeFont { id: string; family: string; label: string; filename: string; path: string; bytes: number }
export function localOfficeFonts(roots = officeFontRoots()): OfficeFont[] {
  const fonts: OfficeFont[] = [];
  let total = 0;
  for (const font of known) for (const name of font.files) {
    for (const root of roots) {
      const file = join(root, name);
      try {
        if (!existsSync(file)) continue;
        const real = realpathSync(file), base = realpathSync(root), info = statSync(real);
        if (!resolve(real).startsWith(resolve(base) + sep) || !info.isFile() || info.size > 32 * 1024 * 1024 || total + info.size > 128 * 1024 * 1024) continue;
        fonts.push({ id: String(fonts.length), family: font.family, label: font.label, filename: name, path: real, bytes: info.size });
        total += info.size; break;
      } catch { /* Optional platform font is unavailable; bundled CJK fonts remain usable. */ }
    }
  }
  return fonts;
}
export function defaultOfficeFonts() {
  const installed = localOfficeFonts();
  const choose = (names: string[], fallback: string) => names.find(name => installed.some(f => f.family === name)) || fallback;
  return {
    body: choose(['SimSun', 'Songti SC'], 'Noto Serif CJK SC'),
    heading: choose(['SimHei', 'Heiti SC'], 'Noto Sans CJK SC'),
    sans: choose(['Microsoft YaHei', 'PingFang SC', 'WenQuanYi Micro Hei'], 'Noto Sans CJK SC'),
    formal: choose(['FangSong', 'STFangsong'], 'Noto Serif CJK SC'),
  };
}
