import { Injectable, Logger, Optional } from '@nestjs/common';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDefaultDataDir } from '../modules/core/utils/web-data.util.js';
import { writeJsonAtomicSync } from '../modules/core/utils/atomic-json.util.js';
import { LocalResourcePolicy } from '../modules/core/security/local-resource-policy.service.js';

type Kind = 'tools' | 'skills' | 'plugins';
interface Selection { version: 1; legacy: boolean; tools?: string[]; skills?: string[]; plugins?: string[]; removedTools?: string[] }
const fileAt = (root: string) => join(root, 'extension-selection.json');

/** Called before services write default configuration. Never migrates another edition/profile. */
export function prepareExtensionSelection(root = getDefaultDataDir()): void {
  if (existsSync(fileAt(root))) return;
  const legacy = ['config.json', 'sessions.json', 'web/sessions.json', 'web/config.json'].some(file => existsSync(join(root, file)));
  writeJsonAtomicSync(fileAt(root), { version: 1, legacy });
}

@Injectable()
export class ExtensionSelectionService {
  private readonly logger = new Logger(ExtensionSelectionService.name);
  constructor(@Optional() private readonly policy?: LocalResourcePolicy) {}
  get scope(): string { return this.policy?.localResourceRoot(getDefaultDataDir()) || getDefaultDataDir(); }
  private read(strict = false): Selection {
    try {
    prepareExtensionSelection(this.scope);
    const state = JSON.parse(readFileSync(fileAt(this.scope), 'utf8')) as Selection;
    if (state.version !== 1 || typeof state.legacy !== 'boolean' ||
        (['tools', 'skills', 'plugins', 'removedTools'] as const).some(k => state[k] !== undefined &&
          (!Array.isArray(state[k]) || state[k]!.some(v => typeof v !== 'string')))) {
      throw new Error('Invalid extension installation state; automatic activation was stopped.');
    }
    return state;
    } catch (error) {
      if (strict) throw error;
      this.logger.error('Extension installation state is unreadable; optional extensions remain inactive');
      return { version: 1, legacy: false, tools: [], skills: [], plugins: [] };
    }
  }
  initialize(kind: Kind, legacyCatalog: string[]): void {
    const state = this.read();
    if (state[kind] !== undefined) return;
    // Bundled tools are ready on first installation. A persisted [] is an
    // explicit selection and must survive upgrades and host restarts.
    state[kind] = kind === 'tools' || state.legacy ? [...new Set(legacyCatalog)] : [];
    writeJsonAtomicSync(fileAt(this.scope), state);
  }
  has(kind: Kind, id: string): boolean { return this.read()[kind]?.includes(id) === true; }
  list(kind: Kind): string[] { return [...(this.read()[kind] || [])]; }
  removedTools(): Set<string> { return new Set(this.read(true).removedTools || []); }
  /** A single atomic write keeps package selection and individual tool selection consistent. */
  setToolInstalled(name: string, installed: boolean, pack?: { id: string; names: string[] }): () => void {
    const scope = this.scope, before = this.read(true), state = { ...before };
    const removed = new Set(state.removedTools || []);
    if (installed && pack && !state.tools?.includes(pack.id)) {
      state.tools = [...(state.tools || []), pack.id];
      // Installing one member must not silently install its siblings.
      for (const sibling of pack.names) removed.add(sibling);
    }
    if (installed) removed.delete(name); else removed.add(name);
    state.removedTools = [...removed];
    writeJsonAtomicSync(fileAt(scope), state);
    return () => { writeJsonAtomicSync(fileAt(scope), before); };
  }
  installToolPackage(id: string, names: string[]): void {
    const state = this.read(true), members = new Set(names);
    state.tools = [...new Set([...(state.tools || []), id])];
    state.removedTools = (state.removedTools || []).filter(name => !members.has(name));
    writeJsonAtomicSync(fileAt(this.scope), state);
  }
  set(kind: Kind, id: string, installed: boolean): void {
    const state = this.read(true);
    const values = new Set(state[kind] || []);
    if (installed) values.add(id); else values.delete(id);
    state[kind] = [...values];
    writeJsonAtomicSync(fileAt(this.scope), state);
  }
}
