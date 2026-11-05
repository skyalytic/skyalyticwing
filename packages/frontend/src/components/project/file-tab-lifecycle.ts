const guards = new Map<string, Set<() => Promise<void>>>();
/** Editors must confirm pending changes are saved before a file tab is removed. */
export function registerFileCloseGuard(path: string, save: () => Promise<void>) {
  const entries = guards.get(path) || new Set();
  entries.add(save); guards.set(path, entries);
  return () => { entries.delete(save); if (!entries.size) guards.delete(path); };
}
export async function prepareFileClose(path: string) {
  for (const guard of guards.get(path) || []) await guard();
}
const pendingChecks = new Set<() => boolean>();
/** Includes failed drafts belonging to tabs that were unmounted. */
export function registerPendingDraftCheck(check: () => boolean) { pendingChecks.add(check); }
export async function prepareAllFilesForUpdate() {
  for (const [path, entries] of [...guards]) {
    try { for (const save of [...entries]) await save(); }
    catch (error) { throw Error(`${path}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  if ([...pendingChecks].some(check => check())) throw Error('还有未保存的草稿，请处理保存提示后再更新');
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  if (event.defaultPrevented) throw Error('还有未保存的内容，请保存后再更新');
}
