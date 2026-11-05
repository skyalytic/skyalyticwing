// 命令面板入口（对齐旧版 palette.js 的 Ctrl+K 命令面板）
// 实际实现见 components/palette/CommandPalette.tsx，此处作为对外稳定入口
import { CommandPalette } from './palette/CommandPalette';

export { CommandPalette };
export { CommandPalette as Palette };
export default CommandPalette;
