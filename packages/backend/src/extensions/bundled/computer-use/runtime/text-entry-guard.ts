import { createHash } from 'node:crypto';
import type { VisualDesktopInput, VisualDesktopRoot } from './visual-desktop-driver.js';
type Point = { x: number; y: number };
type Entry = { hash: string; at: number; anchor: Point | undefined; selectedAll: boolean };
/** Remember attempted text, not a claim that the application accepted it. No text is retained. */
export class TextEntryGuard {
  private entries = new Map<string, Entry>();
  private points = new Map<string, Point>();
  private key(root: VisualDesktopRoot) { return `${root.windowId}:${root.pid}`; }
  clear() { this.entries.clear(); this.points.clear(); }
  before(root: VisualDesktopRoot, action: VisualDesktopInput) {
    if (action.kind !== 'typeText' || typeof action.params?.['text'] !== 'string' || !action.params['text']) return;
    const key = this.key(root), hash = createHash('sha256').update(action.params['text']).digest('hex');
    const previous = this.entries.get(key);
    if (previous?.hash === hash && !previous.selectedAll && Date.now() - previous.at < 60_000) {
      throw Object.assign(new Error('Repeated text insertion was not started: the same text was already attempted in this field. Inspect the latest results; if the intended target is visible, verify and click it. Do not infer an empty field from a placeholder, unchanged background, or incomplete accessibility. To correct the query, verify the field and explicitly select/replace its contents before typing again.'), { code: 'DESKTOP_INPUT_NOT_STARTED' });
    }
    if (this.entries.size >= 64 && !this.entries.has(key)) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(key, { hash, at: Date.now(), anchor: this.points.get(key), selectedAll: false });
  }
  delivered(root: VisualDesktopRoot, action: VisualDesktopInput) {
    const key = this.key(root);
    // A deliberate edit/navigation key or selecting a different field ends a text entry.
    // Merely observing, activating, or clicking the same field must not replay it.
    const entry = this.entries.get(key);
    if (action.kind === 'keypress' && entry) {
      const chord = String(action.params?.['key'] || '').toLowerCase().replace(/\s/g, '');
      if (/^(ctrl|control|control_l|control_r|cmd|command)\+a$/.test(chord)) entry.selectedAll = true;
      else if (entry.selectedAll && /^(backspace|delete|del)$/.test(chord)) this.entries.delete(key);
      else if (/^(shift\+)?tab$/.test(chord)) this.entries.delete(key);
      else entry.selectedAll = false;
    }
    if (action.kind === 'click' && Number.isFinite(action.x) && Number.isFinite(action.y)) {
      const point = { x: action.x!, y: action.y! }, previous = this.entries.get(key);
      if (previous) previous.selectedAll = false; // A click cancels the prior selection, not the prior text.
      if (previous?.anchor && Math.hypot(point.x - previous.anchor.x, point.y - previous.anchor.y) > 24) this.entries.delete(key);
      if (this.points.size >= 64 && !this.points.has(key)) this.points.delete(this.points.keys().next().value!);
      this.points.set(key, point);
    }
  }
}
