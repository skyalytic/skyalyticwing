import 'reflect-metadata';
import { mkdtempSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommandGuardService } from '../../src/modules/core/security/command-guard.service.js';
import type { ConfigService } from '../../src/modules/core/config/config.service.js';

/** ConfigService mock：security 段为空对象（无自定义 blockedCommands） */
const configMock = {
  get: (_section: string) => ({}),
} as unknown as ConfigService;

/**
 * 新语义（黑名单模式）测试基线：
 *   isCommandAllowed：deny 命中 → false；allow 命中 / 名单外 → true（审批判定在 AgentLoop）
 *   deny 对所有角色生效；未配置任何 deny 规则时常规命令全部放行
 */
describe('CommandGuardService', () => {
  let service: CommandGuardService;

  beforeEach(() => {
    // 每个用例独立的持久化数据目录，避免 command-rules.json 跨用例泄漏
    process.env['SKYALYTICWING_DATA_DIR'] = mkdtempSync(join(tmpdir(), 'cmdguard-data-'));
    service = new CommandGuardService(configMock);
    service.init();
  });

  describe('isCommandAllowed - 名单外默认放行（黑名单模式）', () => {
    it('uses distinct rule IDs across restarts so deleting one cannot delete another', () => {
      const first = service.addCommandRule('deny', 'fixture-first *');
      const restarted = new CommandGuardService(configMock); restarted.init();
      const second = restarted.addCommandRule('deny', 'fixture-second *');
      expect(first).not.toBe(second);
      restarted.removeCommandRule(second);
      expect(restarted.isCommandBlacklisted('fixture-first run')).toBe(true);
      expect(restarted.isCommandBlacklisted('fixture-second run')).toBe(false);
    });
    it('does not apply failed additions or removals in memory', () => {
      const id = service.addCommandRule('deny', 'fixture-old *');
      jest.spyOn(service as any, 'saveJson').mockImplementation(() => { throw Error('disk full'); });
      expect(() => service.addCommandRule('allow', 'fixture-new *')).toThrow('disk full');
      expect(() => service.removeCommandRule(id)).toThrow('disk full');
      expect(service.isCommandWhitelisted('fixture-new run')).toBe(false);
      expect(service.isCommandBlacklisted('fixture-old run')).toBe(true);
    });
    it.each([
      'git status',
      'git commit -m "init"',
      'git push origin main',
      'ls -la',
      'cat README.md',
    ])('名单外命令放行: %s', (cmd) => {
      expect(service.isCommandAllowed(cmd)).toBe(true);
    });

    it('admin 角色对未匹配命令默认允许', () => {
      expect(service.isCommandAllowed('node server.js', 'admin')).toBe(true);
    });

    it('空命令拒绝', () => {
      expect(service.isCommandAllowed('')).toBe(false);
    });
  });

  describe('isCommandAllowed - 危险命令拒绝（deny 规则）', () => {
    it.each([
      'rm -rf /',
      'format c:',
      'mkfs.ext4',
      'dd if=/dev/zero of=/dev/sda',
    ])('deny 规则命中后拒绝: %s', (cmd) => {
      // 新语义无预置种子：先添加 deny 规则再验证拦截（预置黑名单由
      // YoloClassifier 审批闸门承担，执行层仅按用户规则拦截）
      service.addCommandRule('deny', cmd);
      expect(service.isCommandAllowed(cmd)).toBe(false);
    });

    it('deny 规则对所有角色生效（含 admin）', () => {
      service.addCommandRule('deny', 'rm -rf /');
      expect(service.isCommandAllowed('rm -rf /', 'admin')).toBe(false);
    });

    it('user/viewer 名单外命令同样放行（角色不参与执行层判定）', () => {
      expect(service.isCommandAllowed('node server.js', 'user')).toBe(true);
      expect(service.isCommandAllowed('node server.js', 'viewer')).toBe(true);
    });

    it('deny 规则优先于 allow 规则', () => {
      service.addCommandRule('allow', 'git *');
      service.addCommandRule('deny', 'git push --force *', '禁止强推');
      expect(service.isCommandAllowed('git push --force main')).toBe(false);
      expect(service.isCommandAllowed('git push origin main')).toBe(true);
    });

    it('isCommandBlacklisted/isCommandWhitelisted 独立可查', () => {
      service.addCommandRule('deny', 'terraform destroy');
      service.addCommandRule('allow', 'docker *');
      expect(service.isCommandBlacklisted('terraform destroy')).toBe(true);
      expect(service.isCommandWhitelisted('docker ps')).toBe(true);
      expect(service.isCommandBlacklisted('git status')).toBe(false);
      expect(service.isCommandWhitelisted('git status')).toBe(false);
    });
  });

  describe('hasInjectionRisk - 命令注入检测', () => {
    it.each([
      'cat file; rm -rf /', // 分号
      'ls && whoami', // AND
      'ls || whoami', // OR
      'cat a | wc -l', // 管道
      'echo `whoami`', // 反引号
      'echo $(whoami)', // 命令替换
      'echo {1..3}', // 花括号展开
      'echo a\\b', // 反斜杠
      'ls\nwhoami', // 换行
    ])('检测注入风险: %s', (cmd) => {
      expect(service.hasInjectionRisk(cmd)).toBe(true);
    });

    it.each(['git status', 'ls -la', 'cat README.md', 'git commit -m "fix bug"'])(
      '正常命令无注入风险: %s',
      (cmd) => {
        expect(service.hasInjectionRisk(cmd)).toBe(false);
      },
    );

    it('空输入无注入风险', () => {
      expect(service.hasInjectionRisk('')).toBe(false);
    });
  });

  describe('命令规则管理', () => {
    it('addCommandRule 添加 allow 规则后命令被放行（黑名单模式下 allow 为显式白名单记录）', () => {
      // 新语义名单外本就放行；allow 规则的价值在于 isCommandWhitelisted 查询
      // （AgentLoop 审批判定用：allow 命中可免审批）
      expect(service.isCommandAllowed('docker ps')).toBe(true);
      expect(service.isCommandWhitelisted('docker ps')).toBe(false);
      service.addCommandRule('allow', 'docker *');
      expect(service.isCommandAllowed('docker ps')).toBe(true);
      expect(service.isCommandWhitelisted('docker ps')).toBe(true);
    });

    it('addCommandRule 拒绝非法规则类型', () => {
      expect(() => service.addCommandRule('invalid' as never, 'x')).toThrow(
        /allow.*deny|deny.*allow/,
      );
    });

    it('removeCommandRule 移除规则后恢复默认行为', () => {
      const ruleId = service.addCommandRule('deny', 'docker *');
      expect(service.isCommandAllowed('docker ps')).toBe(false);
      expect(service.removeCommandRule(ruleId)).toBe(true);
      expect(service.isCommandAllowed('docker ps')).toBe(true);
    });

    it('removeCommandRule 移除不存在的规则返回 false', () => {
      expect(service.removeCommandRule('rule-not-exist')).toBe(false);
    });

    it('listCommandRules 初始为空（新设计无预置种子规则）', () => {
      expect(service.listCommandRules()).toHaveLength(0);
    });
  });

  // =========================================================================
  // 补充：幂等 / 未初始化 / 配置黑名单 / 通配符回退 / 持久化
  // =========================================================================
  describe('初始化与未初始化防护', () => {
    it('init 幂等：二次调用不重复加载规则', () => {
      service.addCommandRule('deny', 'terraform *');
      const before = service.listCommandRules().length;
      service.init();
      expect(service.listCommandRules().length).toBe(before);
    });

    it('未初始化时方法抛异常（fail-close）', () => {
      process.env['SKYALYTICWING_DATA_DIR'] = mkdtempSync(join(tmpdir(), 'cmdguard-data-'));
      const fresh = new CommandGuardService(configMock);
      expect(() => fresh.isCommandAllowed('ls')).toThrow(/未初始化/);
      expect(() => fresh.addCommandRule('allow', 'x')).toThrow(/未初始化/);
      expect(() => fresh.removeCommandRule('rule-1')).toThrow(/未初始化/);
      expect(() => fresh.listCommandRules()).toThrow(/未初始化/);
    });
  });

  describe('配置黑名单 loadConfigBlockedCommands', () => {
    it('security.blockedCommands 合并为 deny 规则', () => {
      process.env['SKYALYTICWING_DATA_DIR'] = mkdtempSync(join(tmpdir(), 'cmdguard-data-'));
      const cfg = {
        get: (section: string) =>
          section === 'security' ? { blockedCommands: ['terraform destroy', 'helm delete', '', 42] } : {},
      } as unknown as ConfigService;
      const svc = new CommandGuardService(cfg);
      svc.init();
      expect(svc.isCommandAllowed('terraform destroy')).toBe(false);
      // 配置黑名单为字面精确匹配（非通配符），带参数的命令不命中
      expect(svc.isCommandAllowed('helm delete ns')).toBe(true);
      expect(svc.isCommandAllowed('helm delete')).toBe(false);
      expect(svc.isCommandAllowed('git status')).toBe(true);
      // 0 预置 + 2 条有效自定义 deny（空串与非字符串被过滤）
      expect(svc.listCommandRules()).toHaveLength(2);
    });

    it('config.get 抛异常不影响初始化', () => {
      process.env['SKYALYTICWING_DATA_DIR'] = mkdtempSync(join(tmpdir(), 'cmdguard-data-'));
      const cfg = {
        get: () => {
          throw new Error('config down');
        },
      } as unknown as ConfigService;
      const svc = new CommandGuardService(cfg);
      expect(() => svc.init()).not.toThrow();
      expect(svc.isCommandAllowed('git status')).toBe(true);
    });
  });

  describe('通配符匹配 matchCommandPattern', () => {
    it('超过 10 个通配符回退到字面比较（H-B7 防 ReDoS）', () => {
      const pattern = 'a*b*'.repeat(6); // 12 个 *
      service.addCommandRule('deny', pattern);
      // 字面相等（忽略大小写）命中 deny
      expect(service.isCommandAllowed(pattern)).toBe(false);
      expect(service.isCommandAllowed(pattern.toUpperCase())).toBe(false);
      // 形近但不字面相等 → 不命中该 deny（回退不做 glob 展开，名单外放行）
      expect(service.isCommandAllowed('aXbXaXbXaXbXaXbXaXbX', 'admin')).toBe(true);
    });

    it('? 单字符通配符', () => {
      service.addCommandRule('deny', 'du -?');
      expect(service.isCommandAllowed('du -s')).toBe(false); // deny 命中
      expect(service.isCommandAllowed('du -sh')).toBe(true); // ? 只匹配 1 个字符，名单外放行
    });

    it('正则元字符按字面转义', () => {
      service.addCommandRule('deny', 'git+push');
      expect(service.isCommandAllowed('git+push', 'admin')).toBe(false);
      // 'gitXpush' 不匹配 deny（+ 被转义），名单外放行
      expect(service.isCommandAllowed('gitXpush', 'admin')).toBe(true);
      expect(service.isCommandAllowed('gitttttth', 'admin')).toBe(true);
    });
  });

  describe('持久化', () => {
    it('preserves user rules that happen to match historical seed command text', () => {
      service.addCommandRule('deny', 'git *');
      service.addCommandRule('deny', 'format *');
      const restarted = new CommandGuardService(configMock); restarted.init();
      expect(restarted.isCommandBlacklisted('git status')).toBe(true);
      expect(restarted.isCommandBlacklisted('format fixture')).toBe(true);
    });
    it('规则跨实例持久化，不重复加载', () => {
      const dataDir = mkdtempSync(join(tmpdir(), 'cmdguard-data-'));
      process.env['SKYALYTICWING_DATA_DIR'] = dataDir;
      const first = new CommandGuardService(configMock);
      first.init();
      first.addCommandRule('allow', 'terraform *');
      expect(existsSync(join(dataDir, 'security', 'command-rules.json'))).toBe(true);

      const second = new CommandGuardService(configMock);
      second.init();
      // 1 条自定义规则原样恢复，不因二次 init 翻倍
      expect(second.listCommandRules()).toHaveLength(1);
      expect(second.isCommandWhitelisted('terraform plan')).toBe(true);
    });

    it('规则文件损坏时回退空规则（黑名单模式下全放行）', () => {
      const dataDir = mkdtempSync(join(tmpdir(), 'cmdguard-data-'));
      process.env['SKYALYTICWING_DATA_DIR'] = dataDir;
      mkdirSync(join(dataDir, 'security'), { recursive: true });
      writeFileSync(join(dataDir, 'security', 'command-rules.json'), '{corrupt');
      const svc = new CommandGuardService(configMock);
      expect(() => svc.init()).not.toThrow();
      // 损坏文件 → 空规则（新设计无预置种子）
      expect(svc.listCommandRules()).toHaveLength(0);
      expect(svc.isCommandAllowed('git status')).toBe(true);
    });

    it('持久化文件为空数组时保持空规则', () => {
      const dataDir = mkdtempSync(join(tmpdir(), 'cmdguard-data-'));
      process.env['SKYALYTICWING_DATA_DIR'] = dataDir;
      mkdirSync(join(dataDir, 'security'), { recursive: true });
      writeFileSync(join(dataDir, 'security', 'command-rules.json'), '[]');
      const svc = new CommandGuardService(configMock);
      svc.init();
      expect(svc.listCommandRules()).toHaveLength(0);
    });
  });
});
