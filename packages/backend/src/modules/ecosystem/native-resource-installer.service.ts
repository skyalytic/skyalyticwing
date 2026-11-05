import { Injectable, BadRequestException, ConflictException } from '@nestjs/common';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  lstatSync,
  renameSync,
  rmSync,
  cpSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { PluginService } from '../tools/plugin/plugin.service.js';
import { PluginLoaderService } from '../tools/plugin/plugin-loader.service.js';
import type { CatalogItem } from './ecosystem.service.js';

@Injectable()
export class NativeResourceInstaller {
  constructor(
    private readonly plugins: PluginService,
    private readonly loader: PluginLoaderService,
  ) {}
  private root() {
    return join(this.loader.getDataDir(), 'plugins', 'enterprise-resources');
  }
  private target(id: string) {
    if (!/^enterprise-[a-f0-9-]{36}$/.test(id)) throw new BadRequestException('内部插件 ID 无效');
    return join(this.root(), id);
  }
  installed(): CatalogItem[] {
    const root = this.root();
    if (!existsSync(root)) return [];
    if (lstatSync(root).isSymbolicLink()) throw new BadRequestException('插件目录不可使用符号链接');
    return readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^enterprise-[a-f0-9-]{36}$/.test(d.name))
      .flatMap((d) => {
        const file = join(root, d.name, '.skyalytic-install.json');
        try {
          if (lstatSync(file).isSymbolicLink()) return [];
          const m = JSON.parse(readFileSync(file, 'utf8'));
          return m.id === d.name ? [m] : [];
        } catch {
          return [];
        }
      });
  }
  async ensureLoaded(id: string) {
    if (this.plugins.listPlugins().some((p) => p.id === id)) return;
    if (
      !(await this.plugins.loadPluginFromPath(join(this.target(id), 'wing-enterprise-entry.cjs')))
    )
      throw new BadRequestException('内部插件加载失败，请检查入口与依赖');
  }
  async install(m: CatalogItem, files: Array<{ path: string; data?: Buffer; source?: string }>, replace = false) {
    const target = this.target(m.id),
      root = this.root(),
      tmp = target + '.install',
      backup = target + '.previous';
    mkdirSync(root, { recursive: true });
    if (lstatSync(root).isSymbolicLink()) throw new BadRequestException('插件目录不可使用符号链接');
    if (existsSync(tmp)) throw new ConflictException('发现未完成的插件安装');
    if (existsSync(target) && !replace) throw new ConflictException('本地存在同名插件，不会覆盖');
    if (replace && existsSync(backup))
      throw new ConflictException('已有插件回滚副本，请先处理副本');
    mkdirSync(tmp);
    let moved = false,
      installedNew = false;
    try {
      for (const f of files) {
        const p = join(tmp, f.path);
        mkdirSync(dirname(p), { recursive: true });
        if(f.source) cpSync(f.source,p,{errorOnExist:true,force:false});
        else writeFileSync(p, f.data!, { flag: 'wx' });
      }
      const manifest = JSON.parse(readFileSync(join(tmp, 'plugin.json'), 'utf8'));
      writeFileSync(
        join(tmp, 'plugin.json'),
        JSON.stringify({ ...manifest, id: m.id, main: 'wing-enterprise-entry.cjs' }),
      );
      const packageFile = join(tmp, 'package.json');
      if (existsSync(packageFile)) {
        const pkg = JSON.parse(readFileSync(packageFile, 'utf8'));
        if (pkg.skyalyticwing) {
          pkg.skyalyticwing.id = m.id;
          writeFileSync(packageFile, JSON.stringify(pkg));
        }
      }
      writeFileSync(
        join(tmp, 'wing-enterprise-entry.cjs'),
        `const loaded=require(${JSON.stringify('./' + m.entry)}); const p=typeof loaded==='function'?loaded():loaded; module.exports={...p,id:${JSON.stringify(m.id)}};`,
      );
      writeFileSync(join(tmp, '.skyalytic-install.json'), JSON.stringify(m));
      if (replace && existsSync(target)) {
        await this.plugins.unloadPluginEntry(m.id);
        renameSync(target, backup);
        moved = true;
      }
      renameSync(tmp, target);
      installedNew = true;
      await this.ensureLoaded(m.id);
      return { success: true, note: '企业内部插件已安装' };
    } catch (e) {
      if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
      if (installedNew && existsSync(target)) {
        await this.plugins.unloadPluginEntry(m.id);
        rmSync(target, { recursive: true, force: true });
      }
      if (moved) {
        renameSync(backup, target);
        await this.ensureLoaded(m.id).catch(() => {});
      }
      throw e;
    }
  }
  async uninstall(id: string) {
    const target = this.target(id);
    if (!existsSync(target) || lstatSync(target).isSymbolicLink())
      throw new BadRequestException('插件目录无效');
    this.plugins.clearPluginConfig(id);
    await this.plugins.unloadPluginEntry(id);
    rmSync(target, { recursive: true });
    return { success: true };
  }
  async rollback(id: string) {
    const target = this.target(id),
      backup = target + '.previous';
    if (!existsSync(backup) || lstatSync(backup).isSymbolicLink())
      throw new BadRequestException('没有插件回滚副本');
    const retained = target + '.replaced-' + Date.now();
    await this.plugins.unloadPluginEntry(id);
    if (existsSync(target)) renameSync(target, retained);
    try {
      cpSync(backup, target, { recursive: true, errorOnExist: true, force: false });
      await this.ensureLoaded(id);
      return { success: true, note: '内部插件已回滚，原版本保留在本地副本中' };
    } catch (e) {
      if (existsSync(target)) rmSync(target, { recursive: true, force: true });
      if (existsSync(retained)) renameSync(retained, target);
      // A failed rollback must restore runtime availability as well as files.
      await this.ensureLoaded(id);
      throw e;
    }
  }
  discardBackup(id: string) {
    const backup = this.target(id) + '.previous';
    if (existsSync(backup)) {
      if (lstatSync(backup).isSymbolicLink()) throw new BadRequestException('回滚目录无效');
      rmSync(backup, { recursive: true });
    }
    return { success: true };
  }
}
