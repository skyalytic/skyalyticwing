import { basename, resolve } from 'node:path';
import { getDefaultDataDir } from '../utils/web-data.util.js';
import { readJsonRecover, writeJsonAtomicSync } from '../utils/atomic-json.util.js';
import { listSessionProjectDirs } from './session-project.store.js';

export interface SavedProject {
  path: string;
  name: string;
}
type ProjectEntry = SavedProject & { hidden?: boolean };
const file = () => resolve(getDefaultDataDir(), 'projects.json');
function projectEntries(): ProjectEntry[] {
  const saved = readJsonRecover<ProjectEntry[]>(file(), []);
  const projects = new Map(saved.map((p) => [p.path, p]));
  for (const path of listSessionProjectDirs()) {
    if (!projects.has(path)) projects.set(path, { path, name: basename(path) || path });
  }
  return [...projects.values()];
}
export function listProjects(): SavedProject[] {
  return projectEntries().filter(p => !p.hidden).map(({ path, name }) => ({ path, name }));
}
export function saveProject(path: string, name?: string): SavedProject {
  const projects = projectEntries();
  const current = projects.find((p) => p.path === path);
  const project = { path, name: name?.trim() || current?.name || basename(path) || path };
  writeJsonAtomicSync(
    file(),
    current ? projects.map((p) => (p.path === path ? project : p)) : [...projects, project],
  );
  return project;
}

/** Remove the sidebar entry while keeping files and existing chat workspaces intact. */
export function removeProject(path: string): { removed: boolean } {
  const projects = projectEntries();
  const current = projects.find(p => p.path === path);
  if (!current || current.hidden) return { removed: false };
  // Retain a tombstone so legacy session bindings cannot recreate the project on refresh.
  const next = projects.map(p => p.path === path ? { ...p, hidden: true } : p);
  writeJsonAtomicSync(file(), next);
  writeJsonAtomicSync(file(), next);
  return { removed: true };
}
