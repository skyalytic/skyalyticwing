import 'reflect-metadata';
import { mkdtempSync, realpathSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { PathGuardService } from '../../src/modules/core/security/path-guard.service.js';
import type { ConfigService } from '../../src/modules/core/config/config.service.js';

/** ConfigService mock：security 段为空对象（无自定义 allowedPaths） */
const configMock = {
  get: (_section: string) => ({}),
} as unknown as ConfigService;

describe('PathGuardService', () => {
  let service: PathGuardService;
  /** 越界路径基目录（不在任何允许策略内） */
  let outsideBase: string;

  beforeEach(() => {
    // 每个用例独立的持久化数据目录，避免策略文件跨用例泄漏
    process.env['SKYALYTICWING_DATA_DIR'] = mkdtempSync(join(tmpdir(), 'pathguard-data-'));
    service = new PathGuardService(configMock);
    service.init();
    outsideBase = mkdtempSync(join(tmpdir(), 'pathguard-outside-'));
  });

  describe('isPathAllowed - 工作区白名单', () => {
    it('工作目录下的文件允许读取（默认 read 模式）', () => {
      const ws = realpathSync.native(process.cwd());
      expect(service.isPathAllowed(join(ws, 'some-file.txt'))).toBe(true);
    });

    it('工作目录下的文件允许写入（readwrite 策略）', () => {
      const ws = realpathSync.native(process.cwd());
      expect(service.isPathAllowed(join(ws, 'new-file.txt'), 'write')).toBe(true);
      expect(service.isPathAllowed(join(ws, 'new-file.txt'), 'readwrite')).toBe(true);
    });

    it('工作目录本身允许访问', () => {
      const ws = realpathSync.native(process.cwd());
      expect(service.isPathAllowed(ws)).toBe(true);
    });

    it('空路径拒绝', () => {
      expect(service.isPathAllowed('')).toBe(false);
    });
  });

  describe('isPathAllowed - 越界路径拒绝', () => {
    it('工作目录之外的路径被拒绝', () => {
      expect(service.isPathAllowed(join(outsideBase, 'file.txt'))).toBe(false);
    });

    it('临时目录外的任意绝对路径被拒绝（默认 deny）', () => {
      const arbitrary = join(outsideBase, 'deeply', 'nested', 'secret.txt');
      expect(service.isPathAllowed(arbitrary, 'read')).toBe(false);
    });

    it('Windows 系统目录被拒绝', function () {
      if (process.platform !== 'win32') this.skip();
      expect(service.isPathAllowed('C:\\Windows\\System32\\config\\sam')).toBe(false);
      expect(service.isPathAllowed('C:\\ProgramData\\secret')).toBe(false);
    });
  });

  describe('isPathAllowed - .. 遍历拒绝', () => {
    it('包含 .. 且逃逸出允许目录的路径被拒绝', () => {
      const allowedDir = mkdtempSync(join(tmpdir(), 'pathguard-allowed-'));
      service.addAllowedPath(allowedDir);
      // 手工拼接保留 ..，模拟恶意输入（join 会规范化掉 ..）
      const evil = [allowedDir, 'sub', '..', '..', 'escape.txt'].join(sep);
      expect(service.isPathAllowed(evil)).toBe(false);
    });

    it('包含 .. 但仍落在允许目录内的路径通过', () => {
      const allowedDir = mkdtempSync(join(tmpdir(), 'pathguard-allowed-'));
      service.addAllowedPath(allowedDir);
      const benign = [allowedDir, 'sub', '..', 'file.txt'].join(sep);
      expect(service.isPathAllowed(benign)).toBe(true);
    });
  });

  describe('动态路径策略', () => {
    it('旧的短路径配置和持久化策略在重新加载后仍保持只读限制', () => {
      const dir = mkdtempSync(join(tmpdir(), 'pathguard-old-alias-'));
      const canonical = realpathSync.native(dir);
      const policyDir = join(process.env['SKYALYTICWING_DATA_DIR']!, 'security');
      writeFileSync(join(policyDir,'path-policies.json'), JSON.stringify([{path:dir,mode:'read',allowed:true}]));
      const reloaded = new PathGuardService({get:()=>({allowedPaths:[dir]})} as unknown as ConfigService);
      reloaded.init();
      expect(reloaded.isPathAllowed(join(canonical,'new.txt'),'read')).toBe(true);
      expect(reloaded.isPathAllowed(join(canonical,'new.txt'),'write')).toBe(false);
    });

    it('授权目录中的链接不能授权其外部目标中的新文件', () => {
      const dir = mkdtempSync(join(tmpdir(), 'pathguard-link-'));
      const link = join(dir,'linked');
      symlinkSync(realpathSync.native(outsideBase),link,process.platform==='win32'?'junction':'dir');
      service.addAllowedPath(dir);
      expect(service.isPathAllowed(join(link,'future','secret.txt'),'write')).toBe(false);
      expect(service.isPathAllowed(join(dir,'future','ok.txt'),'write')).toBe(true);
    });

    it('短路径和完整路径对现有文件及未创建文件保持同一权限', () => {
      const dir = mkdtempSync(join(tmpdir(), 'pathguard-alias-'));
      const canonical = realpathSync.native(dir);
      writeFileSync(join(dir,'existing.txt'),'text');
      service.addAllowedPath(dir,'read');
      for(const base of [dir,canonical]) {
        expect(service.isPathAllowed(join(base,'existing.txt'),'read')).toBe(true);
        expect(service.isPathAllowed(join(base,'new','future.txt'),'read')).toBe(true);
        expect(service.isPathAllowed(join(base,'existing.txt'),'write')).toBe(false);
        expect(service.isPathAllowed(join(base,'..','outside.txt'),'read')).toBe(false);
      }
      expect(service.removeAllowedPath(canonical)).toBe(true);
      expect(service.isPathAllowed(join(dir,'existing.txt'))).toBe(false);
    });

    it('addAllowedPath 后其子路径通过', () => {
      const dir = mkdtempSync(join(tmpdir(), 'pathguard-dyn-'));
      service.addAllowedPath(dir);
      expect(service.isPathAllowed(join(dir, 'a.txt'))).toBe(true);
    });

    it('removeAllowedPath 后恢复拒绝', () => {
      const dir = mkdtempSync(join(tmpdir(), 'pathguard-dyn-'));
      service.addAllowedPath(dir);
      expect(service.isPathAllowed(join(dir, 'a.txt'))).toBe(true);
      expect(service.removeAllowedPath(dir)).toBe(true);
      expect(service.isPathAllowed(join(dir, 'a.txt'))).toBe(false);
    });

    it('removeAllowedPath 移除不存在的路径返回 false', () => {
      expect(service.removeAllowedPath('Z:\\definitely\\not\\exists')).toBe(false);
    });

    it('listPathPolicies 返回策略副本（修改不影响内部状态）', () => {
      const before = service.listPathPolicies().length;
      const policies = service.listPathPolicies();
      policies.pop();
      expect(service.listPathPolicies().length).toBe(before);
    });
  });

  describe('模式兼容性（C-F1 权限提升防护）', () => {
    it('read 策略拒绝 write 请求', () => {
      const dir = mkdtempSync(join(tmpdir(), 'pathguard-ro-'));
      service.addAllowedPath(dir, 'read');
      expect(service.isPathAllowed(join(dir, 'a.txt'), 'read')).toBe(true);
      expect(service.isPathAllowed(join(dir, 'a.txt'), 'write')).toBe(false);
    });

    it('write 策略拒绝单独的 read 请求', () => {
      const dir = mkdtempSync(join(tmpdir(), 'pathguard-wo-'));
      service.addAllowedPath(dir, 'write');
      expect(service.isPathAllowed(join(dir, 'a.txt'), 'write')).toBe(true);
      expect(service.isPathAllowed(join(dir, 'a.txt'), 'read')).toBe(false);
    });

    it('write 策略允许 readwrite 请求', () => {
      const dir = mkdtempSync(join(tmpdir(), 'pathguard-wo2-'));
      service.addAllowedPath(dir, 'write');
      expect(service.isPathAllowed(join(dir, 'a.txt'), 'readwrite')).toBe(true);
    });

    it('execute 策略仅允许 execute 请求', () => {
      const dir = mkdtempSync(join(tmpdir(), 'pathguard-exe-'));
      service.addAllowedPath(dir, 'execute');
      expect(service.isPathAllowed(join(dir, 'run.sh'), 'execute')).toBe(true);
      expect(service.isPathAllowed(join(dir, 'run.sh'), 'read')).toBe(false);
      expect(service.isPathAllowed(join(dir, 'run.sh'), 'write')).toBe(false);
    });

    it('any 策略允许所有模式', () => {
      const dir = mkdtempSync(join(tmpdir(), 'pathguard-any-'));
      service.addAllowedPath(dir, 'any');
      expect(service.isPathAllowed(join(dir, 'a'), 'read')).toBe(true);
      expect(service.isPathAllowed(join(dir, 'a'), 'write')).toBe(true);
      expect(service.isPathAllowed(join(dir, 'a'), 'execute')).toBe(true);
      expect(service.isPathAllowed(join(dir, 'a'), 'any')).toBe(true);
    });

    it('readwrite 策略允许全部请求模式', () => {
      const dir = mkdtempSync(join(tmpdir(), 'pathguard-rw-'));
      service.addAllowedPath(dir, 'readwrite');
      expect(service.isPathAllowed(join(dir, 'a'), 'read')).toBe(true);
      expect(service.isPathAllowed(join(dir, 'a'), 'write')).toBe(true);
      expect(service.isPathAllowed(join(dir, 'a'), 'execute')).toBe(true);
    });
  });

  // =========================================================================
  // 补充：幂等 / 未初始化 / 空输入 / 配置路径 / 持久化合并
  // =========================================================================
  describe('初始化与未初始化防护', () => {
    it('init 幂等：二次调用不重复初始化默认策略', () => {
      const before = service.listPathPolicies().length;
      service.init();
      expect(service.listPathPolicies().length).toBe(before);
    });

    it('未初始化时 fail-close；addAllowedPath 幂等自愈补齐初始化', () => {
      process.env['SKYALYTICWING_DATA_DIR'] = mkdtempSync(join(tmpdir(), 'pathguard-data-'));
      const fresh = new PathGuardService(configMock);
      // 查询类接口未初始化必须拒绝（fail-close 安全语义不变）
      expect(() => fresh.isPathAllowed('/x')).toThrow(/未初始化/);
      expect(() => fresh.removeAllowedPath('/x')).toThrow(/未初始化/);
      expect(() => fresh.listPathPolicies()).toThrow(/未初始化/);
      // 注册类接口自愈：init() 幂等，晚到的依赖模块（如 SkillService）可正常注册
      // （修复技能编辑"路径未在白名单内"：模块初始化顺序导致注册被吞）
      fresh.addAllowedPath('/x');
      expect(fresh.isPathAllowed('/x')).toBe(true);
    });

    it('addAllowedPath / removeAllowedPath 空路径直接忽略', () => {
      const before = service.listPathPolicies().length;
      service.addAllowedPath('');
      expect(service.listPathPolicies().length).toBe(before);
      expect(service.removeAllowedPath('')).toBe(false);
    });
  });

  describe('配置自定义允许路径 loadConfigAllowedPaths', () => {
    it('security.allowedPaths 中的有效字符串合并为允许策略', () => {
      const dataDir = mkdtempSync(join(tmpdir(), 'pathguard-data-'));
      process.env['SKYALYTICWING_DATA_DIR'] = dataDir;
      const allowedDir = mkdtempSync(join(tmpdir(), 'pathguard-cfg-'));
      const cfg = {
        get: (section: string) =>
          section === 'security' ? { allowedPaths: [allowedDir, 42, '', null] } : {},
      } as unknown as ConfigService;
      const svc = new PathGuardService(cfg);
      svc.init();
      expect(svc.isPathAllowed(join(allowedDir, 'file.txt'))).toBe(true);
    });

    it('config.get 抛异常不影响初始化', () => {
      const dataDir = mkdtempSync(join(tmpdir(), 'pathguard-data-'));
      process.env['SKYALYTICWING_DATA_DIR'] = dataDir;
      const cfg = {
        get: () => {
          throw new Error('config down');
        },
      } as unknown as ConfigService;
      const svc = new PathGuardService(cfg);
      expect(() => svc.init()).not.toThrow();
      const ws = realpathSync.native(process.cwd());
      expect(svc.isPathAllowed(join(ws, 'x.txt'))).toBe(true);
    });
  });

  describe('持久化（H-B9 合并加载）', () => {
    it('动态添加的路径跨实例生效，默认策略保留', () => {
      const dataDir = mkdtempSync(join(tmpdir(), 'pathguard-data-'));
      process.env['SKYALYTICWING_DATA_DIR'] = dataDir;
      const first = new PathGuardService(configMock);
      first.init();
      const extra = mkdtempSync(join(tmpdir(), 'pathguard-persist-'));
      first.addAllowedPath(extra); // 内部会持久化到 path-policies.json

      // 同 dataDir 新实例：加载持久化策略（追加在默认策略之后，优先级更高）
      const second = new PathGuardService(configMock);
      second.init();
      expect(second.isPathAllowed(join(extra, 'a.txt'))).toBe(true);
      // 默认拒绝策略仍在（系统目录拒绝）
      if (process.platform === 'win32') {
        expect(second.isPathAllowed('C:\\Windows\\System32\\drivers\\etc\\hosts')).toBe(false);
      }
      // 工作区默认允许仍生效
      const ws = realpathSync.native(process.cwd());
      expect(second.isPathAllowed(join(ws, 'b.txt'))).toBe(true);
    });

    it('持久化文件损坏时回退默认策略集', () => {
      const dataDir = mkdtempSync(join(tmpdir(), 'pathguard-data-'));
      process.env['SKYALYTICWING_DATA_DIR'] = dataDir;
      mkdirSync(join(dataDir, 'security'), { recursive: true });
      writeFileSync(join(dataDir, 'security', 'path-policies.json'), '{corrupt');
      const svc = new PathGuardService(configMock);
      expect(() => svc.init()).not.toThrow();
      const ws = realpathSync.native(process.cwd());
      expect(svc.isPathAllowed(join(ws, 'c.txt'))).toBe(true);
    });

    it('持久化文件为空数组时不合并', () => {
      const dataDir = mkdtempSync(join(tmpdir(), 'pathguard-data-'));
      process.env['SKYALYTICWING_DATA_DIR'] = dataDir;
      mkdirSync(join(dataDir, 'security'), { recursive: true });
      writeFileSync(join(dataDir, 'security', 'path-policies.json'), '[]');
      const svc = new PathGuardService(configMock);
      svc.init();
      const ws = realpathSync.native(process.cwd());
      expect(svc.isPathAllowed(join(ws, 'd.txt'))).toBe(true);
    });
  });
});
